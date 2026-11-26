import { createHash } from 'node:crypto';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';
import { assertTreeAccess } from '@/server/utils/tree/treeCatalog';
import { shuffleQuizItems } from './quizQuestions.js';

function fail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function canonicalId(value, label) {
  const text = typeof value === 'number' || typeof value === 'string' ? String(value).trim() : '';
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))
    || Number(text) < 1 || Number(text) > 2147483647) {
    fail(`${label} must be a positive numeric ID.`);
  }
  return String(Number(text));
}

function timestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) fail('Source update metadata is invalid. Refresh the tree catalog.', 409);
  return date.toISOString();
}

function catalogTrees(includedTrees) {
  const trees = new Map();
  for (const tree of Array.isArray(includedTrees) ? includedTrees : []) {
    const id = canonicalId(tree?.id, 'Catalog tree ID');
    if (!trees.has(id)) trees.set(id, tree);
  }
  return trees;
}

// Return the canonical ID, never a broader catalog or a cached authorization decision.
export async function assertQuizSourceAccess({ principal, visibility, includedTrees, treeId }) {
  const id = canonicalId(treeId, 'Tree ID');
  if (!catalogTrees(includedTrees).has(id)) {
    fail('The selected tree is not in the current searchable tree catalog.', 403);
  }
  try {
    await assertTreeAccess(id, { principal, visibility });
  } catch (error) {
    if (error?.message === 'Tree was not found for the active application instance') {
      fail('The selected tree is no longer readable in the current visibility scope.', 403);
    }
    throw error;
  }
  return id;
}

function scopedRequest(treeId) {
  return new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier());
}

export async function listQuizTrees({ principal, visibility, includedTrees }) {
  const trees = [];
  for (const [id, tree] of catalogTrees(includedTrees)) {
    await assertQuizSourceAccess({ principal, visibility, includedTrees, treeId: id });
    let updatedAt = tree.updatedAt;
    if (updatedAt == null) {
      const result = await withSqlConnection(() => scopedRequest(id).query(`
        SELECT ti.updated_at AS updatedAt
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id AND ti.deleted_at IS NULL
          AND ai.app_identifier = @application_identifier;
      `));
      if (!result.recordset[0]) fail('The selected tree changed. Refresh the tree catalog.', 409);
      updatedAt = result.recordset[0].updatedAt;
    }
    trees.push({
      id, optionId: `tree-${id}`,
      label: String(tree.name ?? tree.displayName ?? `Tree ${id}`),
      updatedAt: timestamp(updatedAt),
    });
  }
  trees.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
    || Number(b.id) - Number(a.id));
  return { trees: trees.slice(0, 20), total: trees.length, limitedToRecent: trees.length > 20 };
}

async function readNodes(treeId, rootsOnly = false) {
  const result = await withSqlConnection(() => scopedRequest(treeId).query(`
    SELECT tn.id, tn.parent_id AS parentId, tn.text AS title,
      tn.is_leaf_node AS isLeafNode, tn.sort_order AS sortOrder
    FROM tree_nodes tn
    INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
    INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
    WHERE tn.tree_instance_id = @tree_instance_id AND tn.deleted_at IS NULL
      AND ti.deleted_at IS NULL AND ai.app_identifier = @application_identifier
      ${rootsOnly ? 'AND tn.parent_id IS NULL' : ''}
    ORDER BY tn.sort_order, tn.id;
  `));
  return result.recordset.map((node) => ({
    id: canonicalId(node.id, 'Node ID'),
    parentId: node.parentId == null ? null : canonicalId(node.parentId, 'Parent ID'),
    title: String(node.title ?? ''), isLeafNode: Boolean(node.isLeafNode),
    sortOrder: node.sortOrder == null ? null : Number(node.sortOrder),
  })).sort((a, b) => {
    if (a.sortOrder == null && b.sortOrder != null) return -1;
    if (a.sortOrder != null && b.sortOrder == null) return 1;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || Number(a.id) - Number(b.id);
  });
}

export async function listQuizRoots(options) {
  const treeId = await assertQuizSourceAccess(options);
  const { filter = null } = options;
  if (filter !== null && (typeof filter !== 'string' || filter.length > 200)) {
    fail('Root title filter must be a string of at most 200 characters.');
  }
  const roots = (await readNodes(treeId, true)).filter((node) => node.parentId === null);
  const needle = (filter ?? '').toLowerCase();
  const matching = roots.filter((node) => node.title.toLowerCase().includes(needle));
  return {
    treeId,
    roots: matching.length > 20 ? [] : matching.map(({ id, title }) => ({
      id, optionId: `root-${id}`, label: title,
    })),
    total: roots.length, matching: matching.length, requiresNarrowing: matching.length > 20,
  };
}

async function readLeafDetails(treeId, leafIds) {
  const details = new Map();
  for (let offset = 0; offset < leafIds.length; offset += 500) {
    const ids = leafIds.slice(offset, offset + 500);
    const result = await withSqlConnection(() => {
      const request = scopedRequest(treeId);
      ids.forEach((id, index) => request.input(`leaf_${index}`, sql.Int, Number(id)));
      return request.query(`
      SELECT tn.id,
        CAST(CASE WHEN COALESCE(tnd.is_secret, 0) = 1 OR tnd.secret_metadata IS NOT NULL
          THEN 1 ELSE 0 END AS BIT) AS isSecret,
        CASE WHEN COALESCE(tnd.is_secret, 0) = 0 AND tnd.secret_metadata IS NULL
          THEN tnd.notes ELSE NULL END AS notes,
        tnd.updated_at AS revision,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM tree_node_detail_files files
          WHERE files.tree_node_id = tn.id AND files.deleted_at IS NULL
        ) THEN 1 ELSE 0 END AS BIT) AS hasAttachments
      FROM tree_nodes tn
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      LEFT JOIN tree_node_details tnd ON tnd.tree_node_id = tn.id
      WHERE tn.tree_instance_id = @tree_instance_id AND tn.deleted_at IS NULL
        AND tn.is_leaf_node = 1 AND ti.deleted_at IS NULL
        AND ai.app_identifier = @application_identifier
        AND tn.id IN (${ids.map((_, index) => `@leaf_${index}`).join(', ')});
    `);
    });
    for (const row of result.recordset) details.set(String(row.id), row);
  }
  return details;
}

export async function prepareQuizSources(options) {
  const treeId = await assertQuizSourceAccess(options);
  if (!Array.isArray(options.rootIds) || options.rootIds.length === 0) {
    fail('Select at least one root topic for the quiz.');
  }
  const requested = new Set(options.rootIds.map((id) => canonicalId(id, 'Root ID')));
  const nodes = await readNodes(treeId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  if (byId.size !== nodes.length) fail('Source topology changed. Select the roots again.', 409);
  for (const id of requested) {
    if (!byId.has(id) || byId.get(id).parentId !== null) {
      fail(`Root ${id} must be a current parentless node in the selected tree.`);
    }
  }
  const roots = nodes.filter((node) => requested.has(node.id));
  const children = new Map();
  for (const node of nodes) {
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(node);
  }
  const visited = new Set();
  const topology = [];
  const selectedLeaves = [];
  const stack = roots.slice().reverse().map((node) => ({ node, rootId: node.id, titles: [] }));
  while (stack.length) {
    const { node, rootId, titles } = stack.pop();
    if (visited.has(node.id)) fail('Source topology changed. Select the roots again.', 409);
    visited.add(node.id);
    const pathTitles = [...titles, node.title];
    topology.push(node);
    const descendants = children.get(node.id) ?? [];
    if (node.isLeafNode && descendants.length) {
      fail('A source leaf has children. Repair the tree before preparing a quiz.', 409);
    }
    if (node.isLeafNode) selectedLeaves.push({ node, rootId, path: pathTitles.join(' > ') });
    for (const child of descendants.slice().reverse()) {
      stack.push({ node: child, rootId, titles: pathTitles });
    }
  }
  const details = await readLeafDetails(treeId, selectedLeaves.map(({ node }) => node.id));
  const leaves = [];
  const excludedLeaves = [];
  const revisions = [];
  for (const { node, rootId, path } of selectedLeaves) {
    const detail = details.get(node.id);
    if (!detail) fail('Source leaves changed. Select the roots again.', 409);
    const revision = timestamp(detail.revision);
    revisions.push({ id: node.id, revision });
    const notes = typeof detail.notes === 'string' ? detail.notes : '';
    const reason = detail.isSecret ? 'secret-backed'
      : !notes.trim() ? (detail.hasAttachments ? 'attachment-only' : 'empty-notes') : null;
    if (reason) {
      excludedLeaves.push({ id: node.id, reason });
    } else {
      leaves.push({ id: node.id, rootId, title: node.title, path, notes, revision });
    }
  }
  if (!leaves.length) {
    fail('Selected roots contain no eligible leaves; select roots containing nonempty ordinary-note leaves.');
  }
  let selectedIds;
  if (options.selectedLeafIds !== undefined) {
    const ids = options.selectedLeafIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 45 ||
        new Set(ids).size !== ids.length || ids.some((id) => !leaves.some((leaf) => leaf.id === id))) {
      fail('Selected quiz notes changed. Prepare a fresh quiz.', 409);
    }
    selectedIds = new Set(ids);
  } else {
    selectedIds = new Set((leaves.length > 45 ? shuffleQuizItems(leaves).slice(0, 45) : leaves).map((leaf) => leaf.id));
  }
  const sampledLeaves = leaves.filter((leaf) => selectedIds.has(leaf.id));
  excludedLeaves.push(...leaves.filter((leaf) => !selectedIds.has(leaf.id))
    .map((leaf) => ({ id: leaf.id, reason: 'random-sample-limit' })));
  for (const leaf of sampledLeaves) {
    if (leaf.notes.length > 8000) {
      fail(`Leaf ${leaf.id} contains ${leaf.notes.length} characters; shorten its notes to at most 8000 characters or choose another root.`);
    }
  }
  const size = sampledLeaves.reduce((sum, leaf) => sum + leaf.notes.length, 0);
  if (size > 100000) {
    fail(`Selected notes contain ${size} characters; choose fewer roots or shorten notes to at most 100000 characters in total.`);
  }
  await assertQuizSourceAccess({ ...options, treeId });
  const rootIds = roots.map(({ id }) => id);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ treeId, rootIds, topology, leaves: sampledLeaves, excludedLeaves, revisions }))
    .digest('hex');
  return { treeId, rootIds, leaves: sampledLeaves, excludedLeaves, fingerprint };
}
