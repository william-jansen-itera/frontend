import {
  buildAgentOutputDebug,
  buildFamilyDebugPayload,
  captureTimingEntry,
  serializeDebugValue,
  setCuratedToolMessages,
} from '@/server/utils/agent/agentDebug';
import {
  classifyAgentTurn,
} from '@/server/utils/agent/agentTurnClassifier';
import { buildAgentFamilyResult } from '@/server/utils/agent/agentFamilyResult';
import { getAgentToolResultData } from '@/server/utils/agent/agentToolResult';
import { getRequiredFoundryConfig } from '@/server/utils/foundryAgentClient';
import {
  INVESTMENT_FAMILY,
} from '@/server/utils/agent/investment/investmentAgentCatalog';
import {
  GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL,
} from '@/server/utils/agent/investment/tools/getBuySellVolatilityRecommendationTool';

function buildInvestmentAgentDescriptor() {
  const { modelDeploymentName } = getRequiredFoundryConfig();

  return {
    id: null,
    name: INVESTMENT_FAMILY,
    version: modelDeploymentName,
  };
}

function getLatestRecommendation(toolInvocations) {
  const latestRecommendation = [...(toolInvocations ?? [])]
    .reverse()
    .find((invocation) => invocation?.toolName === GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL);

  return getAgentToolResultData(latestRecommendation?.output) ?? null;
}

export async function buildInvestmentFamilyResult({
  finalResponse,
  finalToolInvocations,
  normalizedFollowUpSelection,
  openAIClient,
  normalizedMessage,
  debug,
}) {
  const turnClassification = await captureTimingEntry(
    debug?.timings?.phases?.responseShaping ?? null,
    async () => classifyAgentTurn({
      finalResponse,
      finalToolInvocations,
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      debug,
    }),
  );
  const {
    answer,
    followUpOptions,
    priorToolInvocations,
    responseToolInvocations,
    turnType,
  } = turnClassification;
  const recommendation = getLatestRecommendation(finalToolInvocations);

  if (debug) {
    setCuratedToolMessages(debug);
    debug.family = {
      recommendation: serializeDebugValue(recommendation),
      turnType,
    };
    debug.agentOutput = buildAgentOutputDebug({
      agent: buildInvestmentAgentDescriptor(),
      response: finalResponse,
      answer,
    });
  }

  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: INVESTMENT_FAMILY,
    turnType,
    answer,
    toolsUsed: Array.from(new Set(responseToolInvocations.map((invocation) => invocation.toolName))),
    followUpOptions,
    familyPayload: {
      responseToolInvocations,
      priorToolInvocations,
      recommendation,
    },
    ...(debug ? { debug: buildFamilyDebugPayload(debug) } : {}),
  });

  return {
    familyResult,
  };
}

export function buildInvestmentResponse({ familyResult, principal, debug }) {
  const responseToolInvocations = Array.isArray(familyResult?.familyPayload?.responseToolInvocations)
    ? familyResult.familyPayload.responseToolInvocations
    : [];
  const priorToolInvocations = Array.isArray(familyResult?.familyPayload?.priorToolInvocations)
    ? familyResult.familyPayload.priorToolInvocations
    : [];

  return {
    schemaVersion: familyResult.schemaVersion,
    sourceToolFamily: familyResult.sourceToolFamily,
    answer: familyResult.answer,
    agent: buildInvestmentAgentDescriptor(),
    toolsUsed: familyResult.toolsUsed,
    toolInvocations: responseToolInvocations,
    priorToolInvocations,
    turnType: familyResult.turnType,
    followUpOptions: Array.isArray(familyResult.followUpOptions) ? familyResult.followUpOptions : [],
    citations: [],
    familyPayload: familyResult.familyPayload ?? null,
    principal: principal
      ? {
        userId: principal.userId ?? null,
        userDetails: principal.userDetails ?? null,
      }
      : null,
    debug: debug ?? undefined,
  };
}