import { getProjectClient } from '@/server/utils/foundryAgentClient';
import { buildInitialAgentInput } from '@/server/utils/agent/agentConversationInput';
import {
  attachDebugToError,
  createAgentDebugState,
  createDebugTimingEntry,
} from '@/server/utils/agent/agentDebug';
import { runAgentFamilyExecution } from '@/server/utils/agent/agentFamilyExecution';
import { normalizeFollowUpSelection } from '@/server/utils/agent/agentTurnClassifier';
import {
  buildAllowedToolInstruction,
  buildRuntimeTreeToolContext,
  buildVisibilityScopeContext,
  buildVisibilityScopeInstruction,
  getPublishedKnowledgeTreesPromptAgent,
} from '@/server/utils/agent/knowledgeTrees/treeAgentCatalog';
import {
  buildKnowledgeTreesFamilyResult,
  buildKnowledgeTreesResponse,
} from '@/server/utils/agent/knowledgeTrees/treeAgentResultBuilder';

const DEFAULT_HISTORY_LIMIT = 8;

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => {
      const role = entry?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(entry?.content ?? '').trim();

      if (!content) {
        return null;
      }

      return {
        type: 'message',
        role,
        content,
      };
    })
    .filter(Boolean);
}

// runs initial agent invocation
// starts the tool loop
// and classifies the turn type (eg. default, no_result_offer_broadening, broader_answer)
export async function invokeKnowledgeTreesAgent({ message, history = [], principal = null, visibility = 'public', followUpSelection = null, includeDebug = false }) {
  const normalizedFollowUpSelection = normalizeFollowUpSelection(followUpSelection);
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the agent');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const agent = await getPublishedKnowledgeTreesPromptAgent();
  const { handlerMap, includedTrees } = await buildRuntimeTreeToolContext({
    principal,
    visibility,
    enforceAccess: true,
    includeDebug,
  });
  const visibilityScope = buildVisibilityScopeContext({
    visibility,
    includedTrees,
  });
  const normalizedHistory = normalizeHistory(history);
  const allowedToolInstruction = [
    buildVisibilityScopeInstruction(visibilityScope),
    buildAllowedToolInstruction(includedTrees),
  ].filter(Boolean).join('\n\n');
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction,
    normalizedHistory,
    normalizedMessage,
  });
  const debug = includeDebug
    ? createAgentDebugState({
      sourceToolFamily: 'knowledgeTrees',
      normalizedMessage,
      normalizedFollowUpSelection,
      initialInput,
      phaseNames: ['citationAssembly', 'responseShaping'],
      extraTimings: {
        broaderAnswerDetection: createDebugTimingEntry(),
        broaderAnswerReview: createDebugTimingEntry({ executed: false }),
      },
      loggingEnabled: includeDebug,
    })
    : null;
  const requestStartedAtMs = includeDebug ? Date.now() : null;

  try {
    const { response, toolInvocations, modelCalls } = await runAgentFamilyExecution({
      openAIClient,
      responseConfig: {
        type: 'agent_reference',
        agentName: agent.name,
      },
      initialInput,
      handlerMap,
      debug,
      includeDebug,
    });
    if (debug) {
      debug.timings.modelCalls.push(...modelCalls);
    }
    const { familyResult } = await buildKnowledgeTreesFamilyResult({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      principal,
      visibilityScope,
      debug,
      agent,
    });
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    return buildKnowledgeTreesResponse({ familyResult, agent, principal, debug });
  } catch (error) {
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }
    throw attachDebugToError(error, debug);
  }
}
