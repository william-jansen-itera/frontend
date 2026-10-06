import {
  ensureInvestmentTreePath,
  findInvestmentTreePathNode,
  readSingleInvestmentTextAttachmentByFileName,
  replaceInvestmentLeafAttachment,
} from '@/server/utils/agent/investment/investmentTreeRepository';

export const PERSONAL_CACHE_TREE_OPTIONS = Object.freeze({
  allowPrivate: true,
  allowDescription: true,
  allowPublishedDescription: true,
});

export async function ensurePersonalCacheLeafPath({ treeId, pathSegments }) {
  return ensureInvestmentTreePath({
    treeId,
    pathSegments,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}

export async function findPersonalCacheLeafPathNode({ treeId, pathSegments }) {
  return findInvestmentTreePathNode({
    treeId,
    pathSegments,
  });
}

export async function readPersonalCacheTextAttachmentByFileName({ treeId, pathSegments, fileName }) {
  return readSingleInvestmentTextAttachmentByFileName({
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
  return replaceInvestmentLeafAttachment({
    treeId,
    pathSegments,
    fileName,
    contentType,
    content,
    updatedBy,
    treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
  });
}