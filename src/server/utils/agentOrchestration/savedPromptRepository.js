import { createHash } from 'node:crypto';
import {
  deletePersonalCachePath,
  findPersonalCacheLeafPathNode,
  getPersonalCacheContext,
  replacePersonalCacheNotes,
} from '@/server/utils/agentOrchestration/personalCacheTreeRepository';
import { sql, withSqlConnection } from '@/server/utils/sql';

function promptCollectionPath(family) {
  return ['Chat', 'Prompts', family];
}

export async function savePrompt({ principal, family, content }) {
  const { personalCacheTreeId: treeId, updatedBy } = await getPersonalCacheContext(principal);
  const prompts = await listPromptCollection({ treeId, principal, family });
  const existingPrompt = prompts.find((prompt) => prompt.content === content);
  if (existingPrompt) {
    return existingPrompt;
  }

  const hash = createHash('sha256').update(content).digest('hex');
  const existingTitles = new Set(prompts.map((prompt) => prompt.id));
  let prefixLength = 8;
  let id = `Prompt ${hash.slice(0, prefixLength)}`;
  while (existingTitles.has(id)) {
    prefixLength += 4;
    if (prefixLength > hash.length) {
      throw new Error('Could not allocate a unique saved-prompt title.');
    }
    id = `Prompt ${hash.slice(0, prefixLength)}`;
  }
  await replacePersonalCacheNotes({
    treeId,
    principal,
    pathSegments: [...promptCollectionPath(family), id],
    notes: content,
    updatedBy,
  });
  return { id, content };
}

export async function listSavedPrompts({ principal, family }) {
  const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
  return listPromptCollection({ treeId, principal, family });
}

export async function deleteSavedPrompt({ principal, family, id }) {
  const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
  const prompts = await listPromptCollection({ treeId, principal, family });
  if (!prompts.some((prompt) => prompt.id === id)) {
    return false;
  }
  return deletePersonalCachePath({
    treeId,
    principal,
    pathSegments: [...promptCollectionPath(family), id],
  });
}

async function listPromptCollection({ treeId, principal, family }) {
  const parent = await findPersonalCacheLeafPathNode({
    treeId,
    principal,
    pathSegments: promptCollectionPath(family),
  });
  if (!parent || parent.isLeafNode) {
    return [];
  }

  return withSqlConnection(async (pool) => {
    const result = await pool.request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('parent_id', sql.Int, Number(parent.id))
      .query(`
        SELECT nodes.[text] AS id, details.notes AS content
        FROM tree_nodes nodes
        INNER JOIN tree_node_details details ON details.tree_node_id = nodes.id
        WHERE nodes.tree_instance_id = @tree_instance_id
          AND nodes.parent_id = @parent_id
          AND nodes.deleted_at IS NULL
          AND nodes.is_leaf_node = 1
          AND details.is_secret = 0
        ORDER BY nodes.id DESC;
      `);
    return result.recordset;
  });
}
