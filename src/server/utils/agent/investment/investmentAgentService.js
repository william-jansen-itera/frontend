import { getProjectClient, getRequiredFoundryConfig } from '@/server/utils/foundryAgentClient';
import { buildInitialAgentInput } from '@/server/utils/agent/agentConversationInput';
import {
  attachDebugToError,
  createAgentDebugState,
} from '@/server/utils/agent/agentDebug';
import { runAgentFamilyExecution } from '@/server/utils/agent/agentFamilyExecution';
import { normalizeFollowUpSelection } from '@/server/utils/agent/agentTurnClassifier';
import {
  buildInvestmentAgentInstructions,
  INVESTMENT_FAMILY,
  buildInvestmentRuntimeContext,
} from '@/server/utils/agent/investment/investmentAgentCatalog';
import {
  buildInvestmentFamilyResult,
  buildInvestmentResponse,
} from '@/server/utils/agent/investment/investmentAgentResultBuilder';

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

export async function invokeInvestmentAgent({
  message,
  history = [],
  principal = null,
  followUpSelection = null,
  includeDebug = false,
}) {
  const normalizedFollowUpSelection = normalizeFollowUpSelection(followUpSelection);
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the investment family');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const { modelDeploymentName } = getRequiredFoundryConfig();
  const { handlerMap, tools } = buildInvestmentRuntimeContext({ includeDebug });
  const normalizedHistory = normalizeHistory(history);
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction: null,
    normalizedHistory,
    normalizedMessage,
  });
  const debug = includeDebug
    ? createAgentDebugState({
      sourceToolFamily: INVESTMENT_FAMILY,
      normalizedMessage,
      normalizedFollowUpSelection,
      initialInput,
      phaseNames: ['responseShaping'],
      extraTimings: {
        broaderAnswerDetection: null,
        broaderAnswerReview: null,
      },
    })
    : null;
  const requestStartedAtMs = includeDebug ? Date.now() : null;

  try {
    const { response, toolInvocations, modelCalls } = await runAgentFamilyExecution({
      openAIClient,
      responseConfig: {
        type: 'direct_model',
        model: modelDeploymentName,
        instructions: buildInvestmentAgentInstructions(),
        tools,
      },
      initialInput,
      handlerMap,
      debug,
      includeDebug,
    });

    if (debug) {
      debug.timings.modelCalls.push(...modelCalls);
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    const { familyResult } = await buildInvestmentFamilyResult({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      debug,
    });

    return buildInvestmentResponse({ familyResult, principal, debug });
  } catch (error) {
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    throw attachDebugToError(error, debug);
  }
}
