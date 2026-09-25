import { invokeTreeSearchAgent } from '@/server/utils/agent/treeGrounding/treeAgentService';
import { invokeInvestmentAgent } from '@/server/utils/agent/investment/investmentAgentService';
import { INVESTMENT_FAMILY } from '@/server/utils/agent/investment/investmentAgentCatalog';
import { TREE_GROUNDING_FAMILY } from '@/server/utils/agent/treeGrounding/treeAgentCatalog';

const FAMILY_REGISTRY = new Map([
  [INVESTMENT_FAMILY, {
    family: INVESTMENT_FAMILY,
    invoke: invokeInvestmentAgent,
  }],
  [TREE_GROUNDING_FAMILY, {
    family: TREE_GROUNDING_FAMILY,
    invoke: invokeTreeSearchAgent,
  }],
]);

export function listRegisteredAgentFamilies() {
  return Array.from(FAMILY_REGISTRY.keys());
}

export function getAgentFamilyRegistration(family) {
  const normalizedFamily = String(family ?? '').trim();

  if (!normalizedFamily) {
    return FAMILY_REGISTRY.get(TREE_GROUNDING_FAMILY) ?? null;
  }

  return FAMILY_REGISTRY.get(normalizedFamily) ?? null;
}
