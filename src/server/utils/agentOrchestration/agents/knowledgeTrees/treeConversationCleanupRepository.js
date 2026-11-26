import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { permanentlyDeletePersonalCacheSubtree } from '@/server/utils/tree/treePathRepository';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

async function findInactiveConversations({ treeId, ownerObjectId, conversationId, stateNodeId = null, transaction = null }) {
  const request = transaction ? new sql.Request(transaction) : new sql.Request();
  return request
    .input('tree_id', sql.Int, Number(treeId))
    .input('owner', sql.NVarChar(100), ownerObjectId)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('current_conversation_id', sql.NVarChar(100), conversationId)
    .input('state_node_id', sql.Int, stateNodeId)
    .query(`
      SELECT TOP (20) conversation.id AS conversationNodeId, state_node.id AS stateNodeId
      FROM tree_nodes conversation
      INNER JOIN tree_nodes conversations ON conversations.id = conversation.parent_id
        AND conversations.tree_instance_id = conversation.tree_instance_id
      INNER JOIN tree_nodes family ON family.id = conversations.parent_id
        AND family.tree_instance_id = conversation.tree_instance_id
      INNER JOIN tree_nodes state_node ON state_node.parent_id = conversation.id
        AND state_node.tree_instance_id = conversation.tree_instance_id
      INNER JOIN tree_node_details details ON details.tree_node_id = state_node.id
      INNER JOIN tree_instance tree ON tree.id = conversation.tree_instance_id
      INNER JOIN application_instance app ON app.id = tree.application_instance_id
      WHERE tree.id = @tree_id AND tree.deleted_at IS NULL AND tree.is_private = 1
        AND LOWER(LTRIM(RTRIM(tree.display_name))) = N'personal cache'
        AND tree.owner_object_id = @owner AND app.app_identifier = @application_identifier
        AND family.parent_id IS NULL AND family.text = N'Knowledge Trees'
        AND family.deleted_at IS NULL AND family.is_leaf_node = 0
        AND conversations.text = N'Conversations'
        AND conversations.deleted_at IS NULL AND conversations.is_leaf_node = 0
        AND conversation.deleted_at IS NULL AND conversation.is_leaf_node = 0
        AND conversation.text <> @current_conversation_id
        AND state_node.text = N'State' AND state_node.is_leaf_node = 1
        AND state_node.deleted_at IS NULL
        ${stateNodeId === null ? '' : 'AND state_node.id = @state_node_id'}
        AND details.updated_at <= DATEADD(HOUR, -24, SYSUTCDATETIME())
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.schemaVersion') = N'1'
        AND JSON_VALUE(CASE WHEN ISJSON(details.notes) = 1 THEN details.notes END, '$.conversationId') = conversation.text
        AND NOT EXISTS (
          SELECT 1 FROM tree_nodes extra
          WHERE extra.tree_instance_id = @tree_id
            AND ((extra.parent_id = conversation.id AND extra.id <> state_node.id)
              OR extra.parent_id = state_node.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM tree_node_detail_files files
          WHERE files.tree_node_id IN (conversation.id, state_node.id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM tree_node_details branch_details
          WHERE branch_details.tree_node_id = conversation.id
        )
      ORDER BY details.updated_at, conversation.id;
    `);
}

export async function cleanupInactiveTreeConversations({ treeId, principal, conversationId }) {
  const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
  if (!ownerObjectId) {
    throw new Error('An authenticated principal is required to clean up conversation state.');
  }
  const scope = { treeId, ownerObjectId, conversationId };
  return withSqlConnection(async () => {
    const candidates = await findInactiveConversations(scope);
    let deleted = 0;
    for (const candidate of candidates.recordset) {
      const transaction = new sql.Transaction();
      try {
        await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
        for (const resource of [
          `tree-path:${treeId}`,
          `personal-cache-note:${treeId}:${candidate.stateNodeId}`,
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
            throw new Error('Could not lock conversation state for cleanup.');
          }
        }
        // A selected conversation may have resumed while cleanup waited for its locks.
        const current = await findInactiveConversations({
          ...scope, stateNodeId: candidate.stateNodeId, transaction,
        });
        if (current.recordset[0]?.conversationNodeId === candidate.conversationNodeId) {
          const removed = await permanentlyDeletePersonalCacheSubtree({
            treeId, rootNodeId: candidate.conversationNodeId, ownerObjectId, transaction,
          });
          if (!removed) throw new Error('Could not delete the inactive conversation state.');
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
