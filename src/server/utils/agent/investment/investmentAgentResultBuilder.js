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
  buildStockPricePath,
  buildVolatilityAnalysisPath,
  getRequiredInvestmentPersistenceTreeId,
  STOCK_PRICE_CSV_FILE_NAME,
  VOLATILITY_ANALYSIS_STATE_FILE_NAME,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  INVESTMENT_FAMILY,
} from '@/server/utils/agent/investment/investmentAgentCatalog';
import {
  getInvestmentRepositoryCitation,
} from '@/server/utils/agent/investment/investmentTreeRepository';
import {
  GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL,
} from '@/server/utils/agent/investment/tools/getBuySellVolatilityRecommendationTool';
import { GET_STOCK_PRICE_TOOL } from '@/server/utils/agent/investment/tools/getStockPriceTool';
import { GET_VOLATILITY_EVENTS_TOOL } from '@/server/utils/agent/investment/tools/reviewVolatilityEventsTool';

function dedupeCitations(citations) {
  const citationsByKey = new Map();

  citations.forEach((citation) => {
    const key = [
      citation?.treeId,
      citation?.nodeId,
      Array.isArray(citation?.attachmentFileNames) ? citation.attachmentFileNames.join('|') : '',
    ].join('::');

    if (!citationsByKey.has(key)) {
      citationsByKey.set(key, citation);
    }
  });

  return Array.from(citationsByKey.values());
}

async function buildRepositoryCitationEntry(toolName, result) {
  const normalizedResult = getAgentToolResultData(result);
  const normalizedTicker = String(normalizedResult?.ticker ?? '').trim().toUpperCase();

  if (!normalizedTicker) {
    return null;
  }

  const treeId = getRequiredInvestmentPersistenceTreeId();
  const repositoryTarget = toolName === GET_STOCK_PRICE_TOOL
    ? {
      pathSegments: buildStockPricePath(normalizedTicker),
      fileName: STOCK_PRICE_CSV_FILE_NAME,
    }
    : toolName === GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL || toolName === GET_VOLATILITY_EVENTS_TOOL
      ? {
        pathSegments: buildVolatilityAnalysisPath(normalizedTicker),
        fileName: VOLATILITY_ANALYSIS_STATE_FILE_NAME,
      }
      : null;

  if (!repositoryTarget) {
    return null;
  }

  try {
    const citation = await getInvestmentRepositoryCitation({
      treeId,
      pathSegments: repositoryTarget.pathSegments,
      fileName: repositoryTarget.fileName,
    });

    return citation
      ? {
        toolName,
        ...citation,
      }
      : null;
  } catch {
    return null;
  }
}

async function buildInvestmentCitations(finalToolInvocations) {
  const citations = await Promise.all(
    (finalToolInvocations ?? []).map((invocation) => buildRepositoryCitationEntry(invocation?.toolName, invocation?.output)),
  );

  return dedupeCitations(citations.filter(Boolean));
}

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
  const citations = await captureTimingEntry(
    debug?.timings?.phases?.citationAssembly ?? null,
    async () => buildInvestmentCitations(finalToolInvocations),
  );

  if (debug) {
    setCuratedToolMessages(debug);
    debug.family = {
      citations: serializeDebugValue(citations),
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
    citations,
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
    citations: Array.isArray(familyResult.citations) ? familyResult.citations : [],
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