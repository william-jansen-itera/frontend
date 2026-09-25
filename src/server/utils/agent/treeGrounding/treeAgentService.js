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
  getHostedAgent,
} from '@/server/utils/agent/treeGrounding/treeAgentCatalog';
import {
  buildTreeGroundingFamilyResult,
  buildTreeGroundingResponse,
} from '@/server/utils/agent/treeGrounding/treeAgentResultBuilder';

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
export async function invokeTreeSearchAgent({ message, history = [], principal = null, visibility = 'public', followUpSelection = null, includeDebug = false }) {
  const normalizedFollowUpSelection = normalizeFollowUpSelection(followUpSelection);
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the agent');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const agent = await getHostedAgent();
  const { handlerMap, includedTrees } = await buildRuntimeTreeToolContext({
    principal,
    visibility,
    enforceAccess: true,
    includeDebug,
  });
  const normalizedHistory = normalizeHistory(history);
  const allowedToolInstruction = buildAllowedToolInstruction(includedTrees);
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction,
    normalizedHistory,
    normalizedMessage,
  });
  const debug = includeDebug
    ? createAgentDebugState({
      sourceToolFamily: 'treeGrounding',
      normalizedMessage,
      normalizedFollowUpSelection,
      initialInput,
      phaseNames: ['citationAssembly', 'responseShaping'],
      extraTimings: {
        broaderAnswerDetection: createDebugTimingEntry(),
        broaderAnswerReview: createDebugTimingEntry({ executed: false }),
      },
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
    const { familyResult } = await buildTreeGroundingFamilyResult({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      debug,
      agent,
    });
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    return buildTreeGroundingResponse({ familyResult, agent, principal, debug });
  } catch (error) {
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }
    throw attachDebugToError(error, debug);
  }
}