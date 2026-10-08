import {
  appendDebugStep,
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
  buildPortfolioHoldingsPath,
  PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
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
import { UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL } from '@/server/utils/agent/investment/tools/updatePortfolioHoldingsTool';
import { GET_VOLATILITY_EVENTS_TOOL } from '@/server/utils/agent/investment/tools/reviewVolatilityEventsTool';

const PERSONAL_CACHE_TREE_OPTIONS = {
  allowPrivate: true,
  allowDescription: true,
  allowPublishedDescription: true,
};

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

  if (toolName === UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL) {
    const treeId = Number.parseInt(String(normalizedResult?.treeId ?? ''), 10);

    if (!Number.isInteger(treeId) || treeId <= 0) {
      return null;
    }

    try {
      const citation = await getInvestmentRepositoryCitation({
        treeId,
        pathSegments: buildPortfolioHoldingsPath(),
        fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
        treeOptions: PERSONAL_CACHE_TREE_OPTIONS,
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

function appendPortfolioFileLink(answer, finalToolInvocations) {
  const latestPortfolioUpdate = [...(finalToolInvocations ?? [])]
    .reverse()
    .find((invocation) => invocation?.toolName === UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL);
  const latestPortfolioData = getAgentToolResultData(latestPortfolioUpdate?.output);
  const fileLink = String(latestPortfolioData?.fileLink ?? '').trim();
  const fileName = String(latestPortfolioData?.fileName ?? '').trim() || PORTFOLIO_HOLDINGS_CSV_FILE_NAME;
  const normalizedAnswer = String(answer ?? '').trim();

  if (!fileLink) {
    return answer;
  }

  const linkMarkdown = `[Open ${fileName}](${fileLink})`;

  return normalizedAnswer.includes(fileLink) || normalizedAnswer.includes(linkMarkdown)
    ? answer
    : `${normalizedAnswer}\n\n${linkMarkdown}`.trim();
}

export async function buildInvestmentFamilyResult({
  finalResponse,
  finalToolInvocations,
  normalizedFollowUpSelection,
  openAIClient,
  normalizedMessage,
  debug,
}) {
  appendDebugStep(debug, 'response shaping started');
  const turnClassification = await captureTimingEntry(
    debug?.timings?.phases?.responseShaping ?? null,
    async () => classifyAgentTurn({
      finalResponse,
      finalToolInvocations,
      normalizedFollowUpSelection,
      openAIClient,
      normalizedMessage,
      permissionToBroadenDetectionEnabled: false,
      debug,
    }),
  );
  appendDebugStep(debug, 'response shaping completed', {
    turnType: turnClassification?.turnType ?? null,
  });
  const {
    answer,
    followUpOptions,
    priorToolInvocations,
    responseToolInvocations,
    turnType,
  } = turnClassification;
  const recommendation = getLatestRecommendation(finalToolInvocations);
  const answerWithFileLink = appendPortfolioFileLink(answer, finalToolInvocations);
  const citations = await captureTimingEntry(
    debug?.timings?.phases?.citationAssembly ?? null,
    async () => buildInvestmentCitations(finalToolInvocations),
  );
  appendDebugStep(debug, 'citation assembly completed', {
    citationCount: Array.isArray(citations) ? citations.length : null,
  });

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
      answer: answerWithFileLink,
    });
  }

  const familyResult = buildAgentFamilyResult({
    sourceToolFamily: INVESTMENT_FAMILY,
    turnType,
    answer: answerWithFileLink,
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