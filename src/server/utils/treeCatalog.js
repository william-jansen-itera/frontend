import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';

const MAX_NON_LEAF_TITLES = 64;
const MAX_LEAF_TITLE_EXEMPLARS = 48;
const MAX_BREADCRUMB_EXEMPLARS = 48;
const MAX_ATTACHMENT_FILE_NAME_EXEMPLARS = 32;

export async function getTreeList() {
  const query = `
    SELECT
      CAST(ti.id AS VARCHAR(10)) AS id,
      COALESCE(NULLIF(ti.display_name, ''), root_node.text, CONCAT('Tree ', ti.id)) AS name
    FROM tree_instance ti
    INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
    OUTER APPLY (
      SELECT TOP 1 tn.text
      FROM tree_nodes tn
      WHERE tn.tree_instance_id = ti.id AND tn.parent_id IS NULL
      ORDER BY tn.sort_order, tn.id
    ) root_node
    WHERE ai.app_identifier = @application_identifier
    ORDER BY COALESCE(NULLIF(ti.display_name, ''), root_node.text, CONCAT('Tree ', ti.id));`;

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