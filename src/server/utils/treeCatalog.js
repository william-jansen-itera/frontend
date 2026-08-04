import { sql, withSqlConnection, getRequiredApplicationIdentifier } from '@/server/utils/sql';

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