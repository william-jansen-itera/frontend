import { getProjectClient } from '@/server/utils/foundryAgentClient';
import { buildAgentPersonalCacheContext } from '@/server/utils/agent/agentPersonalCache';
import { buildInitialAgentInput } from '@/server/utils/agent/agentConversationInput';
import {
  attachDebugToError,
  appendDebugStep,
  createAgentDebugState,
} from '@/server/utils/agent/agentDebug';
import { runAgentFamilyExecution } from '@/server/utils/agent/agentFamilyExecution';
import { normalizeFollowUpSelection } from '@/server/utils/agent/agentTurnClassifier';
import {
  getPublishedInvestmentPromptAgent,
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
  requestId = null,
}) {
  const normalizedFollowUpSelection = normalizeFollowUpSelection(followUpSelection);
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the investment family');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  let debug = null;

  if (includeDebug) {
    debug = createAgentDebugState({
      sourceToolFamily: INVESTMENT_FAMILY,
      normalizedMessage,
      normalizedFollowUpSelection,
      initialInput: null,
      phaseNames: ['citationAssembly', 'responseShaping'],
      extraTimings: {
        broaderAnswerDetection: null,
        broaderAnswerReview: null,
      },
      logContext: {
        requestId,
        family: INVESTMENT_FAMILY,
      },
      loggingEnabled: includeDebug,
    });
    appendDebugStep(debug, 'investment agent invocation started');
  }

  const agent = await getPublishedInvestmentPromptAgent();
  appendDebugStep(debug, 'published prompt agent loaded', {
    agentName: agent?.name ?? null,
  });
  const agentPersonalCacheContext = await buildAgentPersonalCacheContext(principal);
  appendDebugStep(debug, 'personal cache context loaded', {
    personalCacheTreeId: agentPersonalCacheContext?.personalCacheTreeId ?? null,
  });
  const { handlerMap, tools } = buildInvestmentRuntimeContext({
    includeDebug,
    updatedBy: agentPersonalCacheContext.updatedBy,
    personalCacheTreeId: agentPersonalCacheContext.personalCacheTreeId,
  });
  appendDebugStep(debug, 'investment runtime context built', {
    toolCount: Array.isArray(tools) ? tools.length : null,
  });
  const normalizedHistory = normalizeHistory(history);
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction: null,
    normalizedHistory,
    normalizedMessage,
  });
  if (debug) {
    debug.curatedAgentInput.initialMessages = initialInput;
    appendDebugStep(debug, 'initial agent input built', {
      historyMessageCount: normalizedHistory.length,
    });
  }
  const requestStartedAtMs = includeDebug ? Date.now() : null;

  try {
    appendDebugStep(debug, 'agent family execution started');
    const { response, toolInvocations, modelCalls } = await runAgentFamilyExecution({
      openAIClient,
      responseConfig: {
        type: 'agent_reference',
        agentName: agent.name,
      },
      initialInput,
      handlerMap,
      handlerContext: {
        ...agentPersonalCacheContext,
        debug,
      },
      debug,
      includeDebug,
    });
    appendDebugStep(debug, 'agent family execution completed', {
      toolInvocationCount: toolInvocations.length,
      finalResponseId: response?.id ?? null,
    });

    if (debug) {
      debug.timings.modelCalls.push(...modelCalls);
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    appendDebugStep(debug, 'investment result builder started');
    const { familyResult } = await buildInvestmentFamilyResult({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      debug,
      agent,
    });
    appendDebugStep(debug, 'investment result builder completed', {
      citationCount: Array.isArray(familyResult?.citations) ? familyResult.citations.length : null,
      toolsUsedCount: Array.isArray(familyResult?.toolsUsed) ? familyResult.toolsUsed.length : null,
    });

    appendDebugStep(debug, 'investment response built');
    return buildInvestmentResponse({ familyResult, principal, debug });
  } catch (error) {
    if (debug) {
      appendDebugStep(debug, 'investment agent invocation failed', {
        errorMessage: error instanceof Error ? error.message : String(error ?? 'Agent request failed'),
      });
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    throw attachDebugToError(error, debug);
  }
}
