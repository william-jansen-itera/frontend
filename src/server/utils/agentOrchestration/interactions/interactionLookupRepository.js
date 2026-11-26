import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

export async function findLatestActiveInteractionId({ treeId, principal, workflow }) {
  const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
  if (!ownerObjectId) {
    throw new Error('An authenticated principal is required to find saved interactions.');
  }
  const result = await withSqlConnection(async () => new sql.Request()
    .input('tree_id', sql.Int, Number(treeId))
    .input('owner', sql.NVarChar(100), ownerObjectId)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('workflow', sql.NVarChar(100), workflow)
    .query(`
      SELECT TOP (1) interaction.text AS interactionId
      FROM tree_nodes interaction
      INNER JOIN tree_nodes by_id ON by_id.id = interaction.parent_id
        AND by_id.tree_instance_id = interaction.tree_instance_id
      INNER JOIN tree_nodes interactions ON interactions.id = by_id.parent_id
        AND interactions.tree_instance_id = interaction.tree_instance_id
      INNER JOIN tree_node_details details ON details.tree_node_id = interaction.id
      INNER JOIN tree_instance tree ON tree.id = interaction.tree_instance_id
      INNER JOIN application_instance app ON app.id = tree.application_instance_id
      WHERE tree.id = @tree_id AND tree.deleted_at IS NULL AND tree.is_private = 1
        AND LOWER(LTRIM(RTRIM(tree.display_name))) = N'personal cache'
        AND tree.owner_object_id = @owner AND app.app_identifier = @application_identifier
        AND interactions.parent_id IS NULL AND interactions.text = N'Interactions'
        AND interactions.deleted_at IS NULL AND interactions.is_leaf_node = 0
        AND by_id.text = N'By Interaction ID'
        AND by_id.deleted_at IS NULL AND by_id.is_leaf_node = 0
        AND interaction.deleted_at IS NULL AND interaction.is_leaf_node = 1
        AND details.updated_at > DATEADD(HOUR, -24, SYSUTCDATETIME())
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.schemaVersion') = N'1'
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.id') = interaction.text
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.workflow') = @workflow
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.status') = N'active'
        AND NOT EXISTS (SELECT 1 FROM tree_nodes child WHERE child.parent_id = interaction.id)
        AND NOT EXISTS (SELECT 1 FROM tree_node_detail_files files WHERE files.tree_node_id = interaction.id)
      ORDER BY details.updated_at DESC, interaction.id DESC;
    `));
  return result.recordset[0]?.interactionId ?? null;
}
