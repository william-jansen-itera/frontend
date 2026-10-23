import {
  deleteTreePath,
  ensureTreePath,
  findTreePathNode,
  readSingleTreeTextAttachmentByFileName,
  replaceTreeLeafAttachment,
} from '@/server/utils/tree/treePathRepository';
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

export async function readPersonalCacheTextAttachmentByFileName({ treeId, principal, pathSegments, fileName }) {
  await assertPersonalCacheOwner({ treeId, principal });
  return readSingleTreeTextAttachmentByFileName({
    treeId,
    pathSegments,
    fileName,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}

export async function replacePersonalCacheTextAttachment({
  treeId,
  principal,
  pathSegments,
  fileName,
  contentType,
  content,
  updatedBy = null,
}) {
  await assertPersonalCacheOwner({ treeId, principal });
  return replaceTreeLeafAttachment({
    treeId,
    pathSegments,
    fileName,
    contentType,
    content,
    updatedBy,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}

export async function deletePersonalCachePath({ treeId, principal, pathSegments, updatedBy = null }) {
  await assertPersonalCacheOwner({ treeId, principal });
  return deleteTreePath({
    treeId,
    pathSegments,
    updatedBy,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}