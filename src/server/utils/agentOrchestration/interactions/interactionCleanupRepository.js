import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { permanentlyDeletePersonalCacheSubtree } from '@/server/utils/tree/treePathRepository';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

async function findInactiveInteractions({ treeId, ownerObjectId, interactionId, nodeId = null, transaction = null }) {
  const request = transaction ? new sql.Request(transaction) : new sql.Request();
  return request
    .input('tree_id', sql.Int, Number(treeId))
    .input('owner', sql.NVarChar(100), ownerObjectId)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('current_interaction_id', sql.NVarChar(100), interactionId)
    .input('node_id', sql.Int, nodeId)
    .query(`
      SELECT TOP (20) interaction.id AS interactionNodeId
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
        AND interaction.text <> @current_interaction_id
        ${nodeId === null ? '' : 'AND interaction.id = @node_id'}
        AND details.updated_at <= DATEADD(HOUR, -24, SYSUTCDATETIME())
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.schemaVersion') = N'1'
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.id') = interaction.text
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.status')
          IN (N'active', N'completed', N'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM tree_nodes child
          WHERE child.parent_id = interaction.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM tree_node_detail_files files
          WHERE files.tree_node_id = interaction.id
        )
      ORDER BY details.updated_at, interaction.id;
    `);
}

export async function cleanupInactiveInteractions({ treeId, principal, interactionId }) {
  const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
  if (!ownerObjectId) {
    throw new Error('An authenticated principal is required to clean up interaction state.');
  }
  const scope = { treeId, ownerObjectId, interactionId };
  return withSqlConnection(async () => {
    const candidates = await findInactiveInteractions(scope);
    let deleted = 0;
    for (const candidate of candidates.recordset) {
      const transaction = new sql.Transaction();
      try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        for (const resource of [
          `tree-path:${treeId}`,
          `personal-cache-note:${treeId}:${candidate.interactionNodeId}`,
        ]) {
          const lock = await new sql.Request(transaction)
            .input('resource', sql.NVarChar(255), resource)
            .query(`
              DECLARE @result INT;
              EXEC @result = sys.sp_getapplock @Resource = @resource,
                @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
              SELECT @result AS result;
            `);
          if (!Number.isInteger(lock.recordset[0]?.result) || lock.recordset[0].result < 0) {
            throw new Error('Could not lock interaction state for cleanup.');
          }
        }
        // Retain a record updated while cleanup waited for the shared path/note locks.
        const current = await findInactiveInteractions({
          ...scope, nodeId: candidate.interactionNodeId, transaction,
        });
        if (current.recordset[0]?.interactionNodeId === candidate.interactionNodeId) {
          const removed = await permanentlyDeletePersonalCacheSubtree({
            treeId, rootNodeId: candidate.interactionNodeId, ownerObjectId, transaction,
          });
          if (!removed) throw new Error('Could not delete the inactive interaction state.');
          deleted += 1;
        }
        await transaction.commit();
      } catch (error) {
        if (transaction._aborted !== true) await transaction.rollback();
        throw error;
      }
    }
    return deleted;
  });
}
