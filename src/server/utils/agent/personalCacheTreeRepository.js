import {
  ensureTreePath,
  findTreePathNode,
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

export async function readPersonalCacheNotes({ treeId, principal, pathSegments }) {
  const leafNode = await findPersonalCacheLeafPathNode({ treeId, principal, pathSegments });

  if (!leafNode) {
    return null;
  }

  const record = await withSqlConnection(async () => queryTreeNodeDetailRecord(treeId, leafNode.id));
  return record?.notes || null;
}

export async function replacePersonalCacheNotes({ treeId, principal, pathSegments, notes, updatedBy = null }) {
  const leafNode = await ensurePersonalCacheLeafPath({ treeId, principal, pathSegments });
  await withSqlConnection(async () => upsertTreeNodeDetails({ nodeId: leafNode.id, notes, updatedBy }));
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
      const rootNode = await new sql.Request(transaction)
        .input('tree_instance_id', sql.Int, Number(treeId))
        .input('root_node_id', sql.Int, Number(nodeId))
        .query(`
          SELECT TOP 1 id FROM dbo.tree_nodes
          WHERE tree_instance_id = @tree_instance_id
            AND id = @root_node_id
            AND deleted_at IS NULL;
        `);

      if (rootNode.recordset[0]) {
        const attachments = await new sql.Request(transaction)
          .input('tree_instance_id', sql.Int, Number(treeId))
          .input('root_node_id', sql.Int, Number(nodeId))
          .query(`
            WITH Subtree AS (
              SELECT id FROM dbo.tree_nodes
              WHERE tree_instance_id = @tree_instance_id AND id = @root_node_id
              UNION ALL
              SELECT child.id FROM dbo.tree_nodes child
              INNER JOIN Subtree parent ON child.parent_id = parent.id
              WHERE child.tree_instance_id = @tree_instance_id
            )
            SELECT files.blob_name AS blobName
            FROM dbo.tree_node_detail_files files
            INNER JOIN Subtree subtree ON subtree.id = files.tree_node_id;
          `);
        for (const attachment of attachments.recordset) {
          if (await deleteNodeAttachmentBlobIfExists(attachment.blobName)) {
            deletedBlobNames.push(attachment.blobName);
          }
        }

        const result = await new sql.Request(transaction)
          .input('tree_instance_id', sql.Int, Number(treeId))
          .input('root_node_id', sql.Int, Number(nodeId))
          .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
          .input('owner_object_id', sql.NVarChar(100), ownerObjectId)
          .query(`
            DELETE node
            FROM dbo.tree_nodes node
            INNER JOIN dbo.tree_instance ti ON ti.id = node.tree_instance_id
            INNER JOIN dbo.application_instance ai ON ai.id = ti.application_instance_id
            WHERE node.id = @root_node_id
              AND node.tree_instance_id = @tree_instance_id
              AND node.deleted_at IS NULL
              AND ti.deleted_at IS NULL
              AND ti.is_private = 1
              AND LOWER(LTRIM(RTRIM(ti.display_name))) = N'personal cache'
              AND ti.owner_object_id = @owner_object_id
              AND ai.app_identifier = @application_identifier;
          `);
        deleted = result.rowsAffected[0] > 0;

        if (!deleted) {
          throw new Error('Personal cache node was not found for this user.');
        }
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