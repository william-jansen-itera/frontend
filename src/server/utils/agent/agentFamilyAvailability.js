import {
  getAgentFamilyRegistration,
  listAgentFamilyRegistrations,
  listRegisteredAgentFamilies,
} from '@/server/utils/agent/agentFamilyRegistry';
import { listAgentFamilyStates } from '@/server/utils/agent/agentFamilyStateRepository';

function normalizeFamilyName(family) {
  return String(family ?? '').trim();
}

function indexFamilyStates(states) {
  const stateMap = new Map();

  states.forEach((state) => {
    const family = normalizeFamilyName(state?.family);

    if (family) {
      stateMap.set(family, state);
    }
  });

  return stateMap;
}

function buildPromptAgentSummary(registration, definedTools) {
  const supportsPromptAgentPublishing = Boolean(registration?.supportsPromptAgentPublishing);

  return {
    supportsPromptAgentPublishing,
    promptAgentStatus: supportsPromptAgentPublishing ? 'unknown' : 'unsupported',
    promptAgentName: null,
    lastPublishedAt: null,
    toolCount: Array.isArray(definedTools) ? definedTools.filter((tool) => tool?.includedInPromptAgent !== false).length : null,
    excludedTreeCount: null,
    statusError: null,
  };
}

function buildAvailabilitySummary({ isActive, promptAgentStatus, requiresPublishedPromptAgent }) {
  if (!isActive && promptAgentStatus === 'not_published') {
    return {
      availabilityStatus: 'unpublished',
      isAvailable: false,
    };
  }

  if (!isActive) {
    return {
      availabilityStatus: 'deactivated',
      isAvailable: false,
    };
  }

  if (promptAgentStatus === 'status_error' || promptAgentStatus === 'error') {
    return {
      availabilityStatus: 'status_error',
      isAvailable: false,
    };
  }

  if (requiresPublishedPromptAgent && promptAgentStatus !== 'published') {
    return {
      availabilityStatus: promptAgentStatus === 'not_published' ? 'not_published' : 'pending',
      isAvailable: false,
    };
  }

  if (!requiresPublishedPromptAgent && promptAgentStatus === 'unsupported') {
    return {
      availabilityStatus: 'active',
      isAvailable: true,
    };
  }

  return {
    availabilityStatus: 'active',
    isAvailable: true,
  };
}

export async function buildAgentFamilyStatus(registration, options = {}) {
  const includeTools = options.includeTools !== false;
  const stateMap = options.stateMap ?? indexFamilyStates(await listAgentFamilyStates());
  const family = normalizeFamilyName(registration?.family);
  const definedTools = includeTools && typeof registration?.listDefinedTools === 'function'
    ? await registration.listDefinedTools()
    : [];
  const promptAgentSummary = buildPromptAgentSummary(registration, definedTools);
  const persistedState = stateMap.get(family) ?? null;
  const isActive = persistedState?.isActive !== false;
  const requiresPublishedPromptAgent = registration?.requiresPublishedPromptAgent !== false;
  const baseStatus = {
    family,
    label: String(registration?.label ?? family).trim(),
    description: String(registration?.description ?? '').trim() || null,
    tools: Array.isArray(definedTools) ? definedTools : [],
    requiresPublishedPromptAgent,
    isActive,
    activeStateReason: persistedState?.reason ?? null,
    activeStateUpdatedAt: persistedState?.updatedAt ?? null,
    activeStateUpdatedByObjectId: persistedState?.updatedByObjectId ?? null,
    activeStateUpdatedByUserDetails: persistedState?.updatedByUserDetails ?? null,
    ...promptAgentSummary,
  };

  if (!promptAgentSummary.supportsPromptAgentPublishing || typeof registration?.getPromptAgentPublishStatus !== 'function') {
    return {
      ...baseStatus,
      ...buildAvailabilitySummary({
        isActive,
        promptAgentStatus: baseStatus.promptAgentStatus,
        requiresPublishedPromptAgent,
      }),
    };
  }

  try {
    const status = await registration.getPromptAgentPublishStatus();
    const mergedStatus = {
      ...baseStatus,
      promptAgentStatus: String(status?.promptAgentStatus ?? 'unknown').trim() || 'unknown',
      promptAgentName: String(status?.promptAgentName ?? '').trim() || null,
      lastPublishedAt: status?.lastPublishedAt ?? null,
      toolCount: Number.isInteger(status?.toolCount) ? status.toolCount : baseStatus.toolCount,
      excludedTreeCount: Number.isInteger(status?.excludedTreeCount) ? status.excludedTreeCount : null,
    };

    return {
      ...mergedStatus,
      ...buildAvailabilitySummary({
        isActive,
        promptAgentStatus: mergedStatus.promptAgentStatus,
        requiresPublishedPromptAgent,
      }),
    };
  } catch (error) {
    return {
      ...baseStatus,
      promptAgentStatus: 'status_error',
      statusError: error instanceof Error ? error.message : 'Prompt agent status could not be loaded.',
      ...buildAvailabilitySummary({
        isActive,
        promptAgentStatus: 'status_error',
        requiresPublishedPromptAgent,
      }),
    };
  }
}

export async function listAgentFamilyStatuses(options = {}) {
  const registrations = listAgentFamilyRegistrations();
  const stateMap = indexFamilyStates(await listAgentFamilyStates());

  return Promise.all(registrations.map((registration) => buildAgentFamilyStatus(registration, {
    includeTools: options.includeTools,
    stateMap,
  })));
}

export async function getAgentFamilyStatus(family, options = {}) {
  const registration = getAgentFamilyRegistration(family);

  if (!registration) {
    return null;
  }

  const stateMap = options.stateMap ?? indexFamilyStates(await listAgentFamilyStates());
  return buildAgentFamilyStatus(registration, {
    includeTools: options.includeTools,
    stateMap,
  });
}

export async function listAvailableAgentFamilyStatuses(options = {}) {
  const statuses = await listAgentFamilyStatuses(options);
  return statuses.filter((status) => status?.isAvailable);
}

export async function resolveAgentFamilySelection(family) {
  const normalizedFamily = normalizeFamilyName(family);
  const availableStatuses = await listAvailableAgentFamilyStatuses({ includeTools: false });

  if (availableStatuses.length === 0) {
    throw new Error('No agent families are currently available. Publish and activate at least one family before using chat.');
  }

  if (!normalizedFamily) {
    return availableStatuses[0];
  }

  const exactMatch = availableStatuses.find((status) => status.family === normalizedFamily);

  if (exactMatch) {
    return exactMatch;
  }

  const knownFamilies = listRegisteredAgentFamilies();

  if (!knownFamilies.includes(normalizedFamily)) {
    return availableStatuses[0];
  }

  return availableStatuses[0];
}