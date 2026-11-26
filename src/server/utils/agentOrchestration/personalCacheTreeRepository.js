import {
  ensureTreePath,
  findTreePathNode,
  listPersonalCacheSubtreeAttachments,
  permanentlyDeletePersonalCacheSubtree,
} from '@/server/utils/tree/treePathRepository';
import { deleteNodeAttachmentBlobIfExists, restoreNodeAttachmentBlobIfDeleted } from '@/server/utils/blobStorage';
import { ensurePersonalCacheTree, getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { queryTreeNodeDetailRecord, upsertTreeNodeDetails } from '@/server/utils/tree/treeRecordRepository';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

export const PERSONAL_CACHE_TREE_OPTIONS = Object.freeze({
  allowPrivate: true,
  allowDescription: true,
  allowPublishedDescription: true,
});

export async function getPersonalCacheContext(principal) {
  const personalCacheTree = await ensurePersonalCacheTree(principal);

  return {
    principal,
    updatedBy: getAuditMetadata(principal),
    personalCacheTree,
    personalCacheTreeId: personalCacheTree.id,
  };
}

async function assertPersonalCacheOwner({ treeId, principal }) {
  const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;

  if (!ownerObjectId) {
    throw new Error('An authenticated principal is required to access personal cache.');
  }

  const result = await withSqlConnection(async () => new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('owner_object_id', sql.NVarChar(100), ownerObjectId)
    .query(`
      SELECT TOP 1 ti.id
      FROM tree_instance ti
      INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
      WHERE ti.id = @tree_instance_id
        AND ai.app_identifier = @application_identifier
        AND ti.deleted_at IS NULL
        AND ti.is_private = 1
        AND LOWER(LTRIM(RTRIM(ti.display_name))) = N'personal cache'
        AND ti.owner_object_id = @owner_object_id;
    `));

  if (!result.recordset[0]) {
    throw new Error('Personal cache tree was not found for this user.');
  }
}

export async function ensurePersonalCacheLeafPath({ treeId, principal, pathSegments }) {
  await assertPersonalCacheOwner({ treeId, principal });
  return ensureTreePath({
    treeId,
    pathSegments,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}

export async function findPersonalCacheLeafPathNode({ treeId, principal, pathSegments }) {
  await assertPersonalCacheOwner({ treeId, principal });
  return findTreePathNode({
    treeId,
    pathSegments,
  });
}

export async function listPersonalCacheChildLeaves({ treeId, principal, pathSegments }) {
  const parentNode = await findPersonalCacheLeafPathNode({ treeId, principal, pathSegments });

  if (!parentNode || parentNode.isLeafNode) {
    return [];
  }

  const result = await withSqlConnection(async () => new sql.Request()
    .input('tree_instance_id', sql.Int, Number(treeId))
    .input('parent_id', sql.Int, Number(parentNode.id))
    .query(`
      SELECT [text]
      FROM tree_nodes
      WHERE tree_instance_id = @tree_instance_id
        AND parent_id = @parent_id
        AND deleted_at IS NULL
        AND is_leaf_node = 1;
    `));

  return result.recordset.map((node) => node.text);
}

function expiredChatState() {
  return Object.assign(new Error(
    'This saved chat state expired after 24 hours of inactivity or is no longer available. Reload chat to start a new conversation. Check previous action outcomes before retrying.',
  ), { status: 410, code: 'CHAT_STATE_EXPIRED' });
}

async function queryPersonalCacheNoteRecord({ treeId, nodeId, principal, transaction = null, expireAfterInactivity }) {
  const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
  const request = transaction ? new sql.Request(transaction) : new sql.Request();
  const current = await request
    .input('tree_id', sql.Int, Number(treeId))
    .input('node_id', sql.Int, Number(nodeId))
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('owner', sql.NVarChar(100), ownerObjectId)
    .query(`
      SELECT details.notes,
        CASE WHEN details.updated_at <= DATEADD(HOUR, -24, SYSUTCDATETIME())
          THEN 1 ELSE 0 END AS expired
      FROM tree_nodes nodes
      INNER JOIN tree_instance tree ON tree.id = nodes.tree_instance_id
      INNER JOIN application_instance app ON app.id = tree.application_instance_id
      LEFT JOIN tree_node_details details ON details.tree_node_id = nodes.id
      WHERE nodes.id = @node_id AND nodes.tree_instance_id = @tree_id
        AND nodes.deleted_at IS NULL AND nodes.is_leaf_node = 1
        AND tree.deleted_at IS NULL AND tree.is_private = 1
        AND LOWER(LTRIM(RTRIM(tree.display_name))) = N'personal cache'
        AND tree.owner_object_id = @owner AND app.app_identifier = @application_identifier;
    `);
  const record = current.recordset[0];
  if (expireAfterInactivity && record?.expired) {
    throw expiredChatState();
  }
  return record;
}

export async function readPersonalCacheNotes({ treeId, principal, pathSegments, expireAfterInactivity = false }) {
  const leafNode = await findPersonalCacheLeafPathNode({ treeId, principal, pathSegments });

  if (!leafNode) {
    return null;
  }

  const record = await withSqlConnection(async () => expireAfterInactivity
    ? queryPersonalCacheNoteRecord({ treeId, nodeId: leafNode.id, principal, expireAfterInactivity })
    : queryTreeNodeDetailRecord(treeId, leafNode.id));
  return record?.notes || null;
}

export async function replacePersonalCacheNotes({ treeId, principal, pathSegments, notes, updatedBy = null }) {
  const leafNode = await ensurePersonalCacheLeafPath({ treeId, principal, pathSegments });
  await withSqlConnection(async () => upsertTreeNodeDetails({ nodeId: leafNode.id, notes, updatedBy }));
}

export async function mutatePersonalCacheNotes({
  treeId, principal, pathSegments, mutate, updatedBy = null, expireAfterInactivity = false, createIfMissing = true,
}) {
  const leaf = await (createIfMissing ? ensurePersonalCacheLeafPath : findPersonalCacheLeafPathNode)({
    treeId, principal, pathSegments,
  });
  if (!leaf) {
    if (expireAfterInactivity) throw expiredChatState();
    throw new Error('Personal-cache record was not found for this user.');
  }
  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();
    try {
      await transaction.begin();
      const lock = await new sql.Request(transaction)
        .input('resource', sql.NVarChar(255), `personal-cache-note:${treeId}:${leaf.id}`)
        .query(`
          DECLARE @result INT;
          EXEC @result = sys.sp_getapplock @Resource = @resource,
            @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 15000;
          SELECT @result AS result;
        `);
      if (!Number.isInteger(lock.recordset[0]?.result) || lock.recordset[0].result < 0) {
        throw new Error('Could not lock the personal-cache record.');
      }
      const current = await queryPersonalCacheNoteRecord({
        treeId, nodeId: leaf.id, principal, transaction, expireAfterInactivity,
      });
      if (!current) {
        if (expireAfterInactivity) throw expiredChatState();
        throw new Error('Personal-cache record was not found for this user.');
      }
      const change = mutate(current.notes ?? null);
      if (!change || typeof change.notes !== 'string') {
        throw new Error('A personal-cache mutation must synchronously return notes and a result.');
      }
      await upsertTreeNodeDetails({ nodeId: Number(leaf.id), notes: change.notes, updatedBy, transaction });
      await transaction.commit();
      return change.result;
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      throw error;
    }
  });
}

export async function deletePersonalCachePath({ treeId, principal, pathSegments, updatedBy = null }) {
  await assertPersonalCacheOwner({ treeId, principal });
  const pathNode = await withSqlConnection(async () => findTreePathNode({ treeId, pathSegments }));

  if (!pathNode) {
    return false;
  }

  return permanentlyDeletePersonalCacheNode({ treeId, principal, nodeId: pathNode.id });
}

export async function permanentlyDeletePersonalCacheNode({ treeId, principal, nodeId }) {
  await assertPersonalCacheOwner({ treeId, principal });
  const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();
    const deletedBlobNames = [];
    let deleted = false;

    try {
      await transaction.begin();
      const attachments = await listPersonalCacheSubtreeAttachments({ treeId, rootNodeId: nodeId, transaction });

      if (attachments) {
        for (const attachment of attachments) {
          if (await deleteNodeAttachmentBlobIfExists(attachment.blobName)) {
            deletedBlobNames.push(attachment.blobName);
          }
        }

        deleted = await permanentlyDeletePersonalCacheSubtree({
          treeId,
          rootNodeId: nodeId,
          ownerObjectId,
          transaction,
        });
      }

      await transaction.commit();
    } catch (error) {
      if (transaction._aborted !== true) {
        await transaction.rollback();
      }

      await Promise.allSettled(deletedBlobNames.map((blobName) => restoreNodeAttachmentBlobIfDeleted(blobName)));
      throw error;
    }

    return deleted;
  });
}