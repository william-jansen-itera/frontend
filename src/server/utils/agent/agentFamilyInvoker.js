import {
  getAgentFamilyRegistration,
  listRegisteredAgentFamilies,
} from '@/server/utils/agent/agentFamilyRegistry';
import { resolveAgentFamilySelection } from '@/server/utils/agent/agentFamilyAvailability';

export { resolveAgentFamilySelection } from '@/server/utils/agent/agentFamilyAvailability';

export function normalizeAgentFamilySelection(family) {
  return String(family ?? '').trim();
}

export async function invokeAgentFamily({ family, familyStatus = null, ...options }) {
  const resolvedFamily = familyStatus ?? await resolveAgentFamilySelection(family);
  const registration = getAgentFamilyRegistration(resolvedFamily.family);

  if (!registration?.invoke) {
    const availableFamilies = listRegisteredAgentFamilies();
    throw new Error(
      `Unsupported agent family "${resolvedFamily.family}". Available families: ${availableFamilies.join(', ')}`,
    );
  }

  return registration.invoke(options);
}
