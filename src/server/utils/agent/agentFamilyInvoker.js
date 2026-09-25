import {
  getAgentFamilyRegistration,
  listRegisteredAgentFamilies,
} from '@/server/utils/agent/agentFamilyRegistry';
import { TREE_GROUNDING_FAMILY } from '@/server/utils/agent/treeGrounding/treeAgentCatalog';

export function normalizeAgentFamilySelection(family) {
  const normalizedFamily = String(family ?? '').trim();

  return normalizedFamily || TREE_GROUNDING_FAMILY;
}

export async function invokeAgentFamily({ family, ...options }) {
  const normalizedFamily = normalizeAgentFamilySelection(family);
  const registration = getAgentFamilyRegistration(normalizedFamily);

  if (!registration?.invoke) {
    const availableFamilies = listRegisteredAgentFamilies();
    throw new Error(
      `Unsupported agent family "${normalizedFamily}". Available families: ${availableFamilies.join(', ')}`,
    );
  }

  return registration.invoke(options);
}
