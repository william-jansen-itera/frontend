import {
  deleteTreePath,
  ensureTreePath,
  findTreePathNode,
  readSingleTreeTextAttachmentByFileName,
  replaceTreeLeafAttachment,
} from '@/server/utils/tree/treePathRepository';

export const PERSONAL_CACHE_TREE_OPTIONS = Object.freeze({
  allowPrivate: true,
  allowDescription: true,
  allowPublishedDescription: true,
});

export async function ensurePersonalCacheLeafPath({ treeId, pathSegments }) {
  return ensureTreePath({
    treeId,
    pathSegments,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}

export async function findPersonalCacheLeafPathNode({ treeId, pathSegments }) {
  return findTreePathNode({
    treeId,
    pathSegments,
  });
}

export async function readPersonalCacheTextAttachmentByFileName({ treeId, pathSegments, fileName }) {
  return readSingleTreeTextAttachmentByFileName({
    treeId,
    pathSegments,
    fileName,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}

export async function replacePersonalCacheTextAttachment({
  treeId,
  pathSegments,
  fileName,
  contentType,
  content,
  updatedBy = null,
}) {
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

export async function deletePersonalCachePath({ treeId, pathSegments, updatedBy = null }) {
  return deleteTreePath({
    treeId,
    pathSegments,
    updatedBy,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}