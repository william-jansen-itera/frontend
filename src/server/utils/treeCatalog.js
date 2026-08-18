import { randomUUID } from 'crypto';
import { deleteNodeAttachmentBlobIfExists } from '@/server/utils/blobStorage';
import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';

const MAX_NON_LEAF_TITLES = 64;
const MAX_LEAF_TITLE_EXEMPLARS = 48;
const MAX_BREADCRUMB_EXEMPLARS = 48;
const MAX_ATTACHMENT_FILE_NAME_EXEMPLARS = 32;
const DEFAULT_TREE_MAX_DEPTH = '3';

function normalizeTreeName(name) {
  return String(name ?? '').trim();
}

function normalizeTreeDescription(description) {
  return String(description ?? '').trim();
}

function buildTreeKey(name) {
  const normalizedBase = normalizeTreeName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
  const keyBase = normalizedBase || 'tree';

  return `${keyBase}-${randomUUID().slice(0, 8)}`;
}

async function getScopedApplicationInstanceId() {
  const result = await new sql.Request()
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      SELECT TOP 1 ai.id
      FROM application_instance ai
      WHERE ai.app_identifier = @application_identifier;
    `);

  const applicationInstanceId = result.recordset[0]?.id;

  if (!applicationInstanceId) {
    throw new Error('Application instance was not found for the configured application identifier');
  }

  return Number(applicationInstanceId);
}

async function assertScopedTree(treeId) {
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      SELECT TOP 1
        ti.id,
        ti.display_name AS displayName,
        ti.description,
        CAST(COALESCE(ti.description_published_to_agent, 0) AS BIT) AS isDescriptionPublished
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ti.id = @tree_instance_id
        AND ai.app_identifier = @application_identifier;
    `);

  const tree = result.recordset[0] ?? null;

  if (!tree) {
    throw new Error('Tree was not found for the active application instance');
  }

  return tree;
}

async function getScopedTreeAttachmentBlobs(treeId) {
  const result = await new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      SELECT files.blob_name AS blobName
      FROM tree_node_detail_files files
      INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
      INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ti.id = @tree_instance_id
        AND ai.app_identifier = @application_identifier;
    `);

  return result.recordset;
}

export async function getTreeList() {
  const query = `
    SELECT
      CAST(ti.id AS VARCHAR(10)) AS id,
      COALESCE(NULLIF(ti.display_name, ''), root_node.text, CONCAT('Tree ', ti.id)) AS name,
      CAST(COALESCE(ti.description, '') AS NVARCHAR(MAX)) AS description,
      CAST(COALESCE(ti.description_published_to_agent, 0) AS BIT) AS isDescriptionPublished
    FROM tree_instance ti
    INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
    OUTER APPLY (
      SELECT TOP 1 tn.text
      FROM tree_nodes tn
      WHERE tn.tree_instance_id = ti.id AND tn.parent_id IS NULL
      ORDER BY tn.sort_order, tn.id
    ) root_node
    WHERE ai.app_identifier = @application_identifier
    ORDER BY ti.updated_at DESC, ti.id DESC;`;

  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .query(query);

    return result.recordset;
  });
}

export async function getAllowedTreeIds() {
  const treeList = await getTreeList();
  return treeList.map((tree) => String(tree.id));
}

export async function createTree({ name }) {
  const normalizedName = normalizeTreeName(name);

  if (!normalizedName) {
    throw new Error('Tree name is required');
  }

  return withSqlConnection(async () => {
    const applicationInstanceId = await getScopedApplicationInstanceId();
    const insertResult = await new sql.Request()
      .input('application_instance_id', sql.Int, applicationInstanceId)
      .input('tree_key', sql.NVarChar(100), buildTreeKey(normalizedName))
      .input('display_name', sql.NVarChar(200), normalizedName)
      .query(`
        DECLARE @createdTrees TABLE (createdTreeId INT);

        INSERT INTO tree_instance (application_instance_id, tree_key, display_name, is_active)
        OUTPUT INSERTED.id INTO @createdTrees (createdTreeId)
        VALUES (@application_instance_id, @tree_key, @display_name, 1);

        SELECT createdTreeId FROM @createdTrees;
      `);

    const treeInstanceId = Number(insertResult.recordset[0]?.createdTreeId);

    if (!treeInstanceId) {
      throw new Error('Tree could not be created');
    }

    await new sql.Request()
      .input('tree_instance_id', sql.Int, treeInstanceId)
      .input('setting_key', sql.NVarChar(100), 'nodes.max_depth')
      .input('setting_value', sql.NVarChar(500), DEFAULT_TREE_MAX_DEPTH)
      .query(`
        INSERT INTO tree_setting (tree_instance_id, setting_key, setting_value)
        VALUES (@tree_instance_id, @setting_key, @setting_value);
      `);

    return {
      id: String(treeInstanceId),
      name: normalizedName,
      description: '',
      isDescriptionPublished: false,
    };
  });
}

export async function updateTreeTitle({ treeId, name }) {
  const normalizedName = normalizeTreeName(name);

  if (!normalizedName) {
    throw new Error('Tree name is required');
  }

  return withSqlConnection(async () => {
    await assertScopedTree(treeId);

    const updateResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('display_name', sql.NVarChar(200), normalizedName)
      .query(`
        UPDATE ti
        SET display_name = @display_name,
            updated_at = SYSUTCDATETIME()
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier;
      `);

    if (!updateResult.rowsAffected[0]) {
      throw new Error('Tree was not found for the active application instance');
    }

    return {
      id: String(treeId),
      name: normalizedName,
    };
  });
}

export async function updateTreeDescription({ treeId, description }) {
  const normalizedDescription = normalizeTreeDescription(description);

  return withSqlConnection(async () => {
    const scopedTree = await assertScopedTree(treeId);
    const nextDescription = normalizedDescription;

    const updateResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .input('description', sql.NVarChar(sql.MAX), nextDescription)
      .query(`
        UPDATE ti
        SET description = @description,
            description_published_to_agent = 0,
            updated_at = SYSUTCDATETIME()
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier;
      `);

    if (!updateResult.rowsAffected[0]) {
      throw new Error('Tree was not found for the active application instance');
    }

    return {
      id: String(treeId),
      name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
      description: nextDescription,
      isDescriptionPublished: false,
    };
  });
}

export async function updateTreeDescriptions(treeDescriptions) {
  const normalizedUpdates = Array.isArray(treeDescriptions)
    ? treeDescriptions
      .map((entry) => ({
        treeId: Number.parseInt(String(entry?.treeId ?? ''), 10),
        description: normalizeTreeDescription(entry?.description),
      }))
      .filter((entry) => Number.isFinite(entry.treeId))
    : [];

  if (normalizedUpdates.length === 0) {
    return [];
  }

  return withSqlConnection(async () => {
    for (const entry of normalizedUpdates) {
      await updateTreeDescription(entry);
    }

    return normalizedUpdates.map((entry) => ({
      treeId: String(entry.treeId),
      description: entry.description,
    }));
  });
}

export async function updateTreeDescriptionPublishedStates(treeStates) {
  const normalizedStates = Array.isArray(treeStates)
    ? treeStates
      .map((entry) => ({
        treeId: Number.parseInt(String(entry?.treeId ?? ''), 10),
        isDescriptionPublished: Boolean(entry?.isDescriptionPublished),
      }))
      .filter((entry) => Number.isFinite(entry.treeId))
    : [];

  if (normalizedStates.length === 0) {
    return [];
  }

  return withSqlConnection(async () => {
    for (const entry of normalizedStates) {
      await new sql.Request()
        .input('tree_instance_id', sql.Int, entry.treeId)
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .input('description_published_to_agent', sql.Bit, entry.isDescriptionPublished)
        .query(`
          UPDATE ti
          SET description_published_to_agent = @description_published_to_agent,
              updated_at = SYSUTCDATETIME()
          FROM tree_instance ti
          INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
          WHERE ti.id = @tree_instance_id
            AND ai.app_identifier = @application_identifier;
        `);
    }

    return normalizedStates.map((entry) => ({
      treeId: String(entry.treeId),
      isDescriptionPublished: entry.isDescriptionPublished,
    }));
  });
}

export async function deleteTree({ treeId }) {
  return withSqlConnection(async () => {
    await assertScopedTree(treeId);

    const attachments = await getScopedTreeAttachmentBlobs(treeId);

    for (const attachment of attachments) {
      await deleteNodeAttachmentBlobIfExists(attachment.blobName);
    }

    const deleteResult = await new sql.Request()
      .input('tree_instance_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
      .query(`
        DELETE ti
        FROM tree_instance ti
        INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
        WHERE ti.id = @tree_instance_id
          AND ai.app_identifier = @application_identifier;
      `);

    if (!deleteResult.rowsAffected[0]) {
      throw new Error('Tree was not found for the active application instance');
    }

    return { success: true };
  });
}

export async function getTreeRoutingProfiles() {
  const treeList = await getTreeList();

  if (treeList.length === 0) {
    return [];
  }

  const nodeQuery = `
    WITH RecursiveTree AS (
      SELECT
        ti.id AS tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        tn.is_leaf_node,
        0 AS depth,
        CAST(RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      INNER JOIN tree_nodes tn ON tn.tree_instance_id = ti.id
      WHERE ai.app_identifier = @application_identifier
        AND tn.parent_id IS NULL

      UNION ALL

      SELECT
        rt.tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        tn.is_leaf_node,
        rt.depth + 1 AS depth,
        CAST(rt.path + '-' + RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(rt.breadcrumb + N' > ' + tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_nodes tn
      INNER JOIN RecursiveTree rt ON tn.parent_id = rt.id
    )
    SELECT
      CAST(tree_id AS VARCHAR(10)) AS treeId,
      CAST(id AS VARCHAR(10)) AS nodeId,
      depth,
      text,
      CAST(is_leaf_node AS bit) AS isLeafNode,
      breadcrumb,
      path
    FROM RecursiveTree
    ORDER BY tree_id, path;`;

  const attachmentQuery = `
    WITH RecursiveTree AS (
      SELECT
        ti.id AS tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        0 AS depth,
        CAST(RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      INNER JOIN tree_nodes tn ON tn.tree_instance_id = ti.id
      WHERE ai.app_identifier = @application_identifier
        AND tn.parent_id IS NULL

      UNION ALL

      SELECT
        rt.tree_id,
        tn.id,
        tn.parent_id,
        tn.text,
        rt.depth + 1 AS depth,
        CAST(rt.path + '-' + RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS path,
        CAST(rt.breadcrumb + N' > ' + tn.text AS NVARCHAR(MAX)) AS breadcrumb
      FROM tree_nodes tn
      INNER JOIN RecursiveTree rt ON tn.parent_id = rt.id
    )
    SELECT
      CAST(rt.tree_id AS VARCHAR(10)) AS treeId,
      CAST(rt.id AS VARCHAR(10)) AS nodeId,
      CAST(rt.text AS NVARCHAR(255)) AS nodeText,
      CAST(rt.breadcrumb AS NVARCHAR(MAX)) AS breadcrumb,
      rt.depth,
      CAST(files.original_file_name AS NVARCHAR(260)) AS fileName,
      files.created_at AS createdAt
    FROM RecursiveTree rt
    INNER JOIN tree_node_detail_files files ON files.tree_node_id = rt.id
    ORDER BY rt.tree_id, rt.path, files.created_at DESC, files.id DESC;`;

  function uniqueByValue(values, maxItems) {
    const uniqueValues = [];
    const seenValues = new Set();

    values.forEach((value) => {
      const normalizedValue = String(value ?? '').trim();

      if (!normalizedValue) {
        return;
      }

      const key = normalizedValue.toLowerCase();

      if (seenValues.has(key)) {
        return;
      }

      seenValues.add(key);
      uniqueValues.push(normalizedValue);
    });

    return uniqueValues.slice(0, maxItems);
  }

  return withSqlConnection(async () => {
    const [nodeResult, attachmentResult] = await Promise.all([
      new sql.Request()
      .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .query(nodeQuery),
      new sql.Request()
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .query(attachmentQuery),
    ]);

    const nodesByTreeId = new Map();
    const attachmentsByTreeId = new Map();

    nodeResult.recordset.forEach((row) => {
      const treeId = String(row.treeId);

      if (!nodesByTreeId.has(treeId)) {
        nodesByTreeId.set(treeId, []);
      }

      nodesByTreeId.get(treeId).push({
        nodeId: String(row.nodeId),
        depth: Number(row.depth),
        text: String(row.text ?? '').trim(),
        isLeafNode: Boolean(row.isLeafNode),
        breadcrumb: String(row.breadcrumb ?? '').trim(),
        path: String(row.path ?? ''),
      });
    });

    attachmentResult.recordset.forEach((row) => {
      const treeId = String(row.treeId);

      if (!attachmentsByTreeId.has(treeId)) {
        attachmentsByTreeId.set(treeId, []);
      }

      attachmentsByTreeId.get(treeId).push({
        nodeId: String(row.nodeId),
        nodeText: String(row.nodeText ?? '').trim(),
        breadcrumb: String(row.breadcrumb ?? '').trim(),
        depth: Number(row.depth),
        fileName: String(row.fileName ?? '').trim(),
      });
    });

    return treeList.map((tree) => {
      const nodes = nodesByTreeId.get(String(tree.id)) ?? [];
      const attachments = attachmentsByTreeId.get(String(tree.id)) ?? [];
      const topLevelTopics = nodes
        .filter((node) => node.depth === 1)
        .map((node) => node.text)
        .filter(Boolean)
        .slice(0, 6);
      const supportingTopics = nodes
        .filter((node) => node.depth === 2)
        .map((node) => node.text)
        .filter(Boolean)
        .slice(0, 10);
      const nonLeafTitles = uniqueByValue(
        nodes.filter((node) => !node.isLeafNode).map((node) => node.text),
        MAX_NON_LEAF_TITLES,
      );
      const leafNodes = [...nodes]
        .filter((node) => node.isLeafNode)
        .sort((left, right) => {
          if (right.depth !== left.depth) {
            return right.depth - left.depth;
          }

          return String(left.path ?? '').localeCompare(String(right.path ?? ''));
        });
      const leafTitleExemplars = uniqueByValue(leafNodes.map((node) => node.text), MAX_LEAF_TITLE_EXEMPLARS);
      const breadcrumbExemplars = uniqueByValue(leafNodes.map((node) => node.breadcrumb), MAX_BREADCRUMB_EXEMPLARS);
      const attachmentFileNameExemplars = uniqueByValue(
        attachments.map((attachment) => attachment.fileName),
        MAX_ATTACHMENT_FILE_NAME_EXEMPLARS,
      );

      return {
        ...tree,
        topLevelTopics,
        supportingTopics,
        nonLeafTitles,
        leafTitleExemplars,
        breadcrumbExemplars,
        attachmentFileNameExemplars,
      };
    });
  });
}

export async function getTreeRoutingProfile(treeId) {
  const scopedTree = await assertScopedTree(treeId);
  const treeProfiles = await getTreeRoutingProfiles();
  const matchingTree = treeProfiles.find((tree) => String(tree.id) === String(treeId));

  if (!matchingTree) {
    return {
      id: String(scopedTree.id),
      name: String(scopedTree.displayName ?? '').trim() || `Tree ${treeId}`,
      description: normalizeTreeDescription(scopedTree.description),
      topLevelTopics: [],
      supportingTopics: [],
      nonLeafTitles: [],
      leafTitleExemplars: [],
      breadcrumbExemplars: [],
      attachmentFileNameExemplars: [],
    };
  }

  return matchingTree;
}