import {
  ensurePersonalCacheTree,
  getAuditMetadata,
} from '@/server/utils/tree/treeCatalog';

export async function buildAgentPersonalCacheContext(principal) {
  const personalCacheTree = await ensurePersonalCacheTree(principal);

  return {
    principal,
    updatedBy: getAuditMetadata(principal),
    personalCacheTree,
    personalCacheTreeId: personalCacheTree?.id ?? null,
  };
}