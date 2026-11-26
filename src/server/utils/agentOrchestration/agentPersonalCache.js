import { getPersonalCacheContext } from '@/server/utils/agentOrchestration/personalCacheTreeRepository';

export async function buildAgentPersonalCacheContext(principal) {
  return getPersonalCacheContext(principal);
}