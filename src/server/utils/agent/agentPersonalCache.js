import { getPersonalCacheContext } from '@/server/utils/agent/personalCacheTreeRepository';

export async function buildAgentPersonalCacheContext(principal) {
  return getPersonalCacheContext(principal);
}