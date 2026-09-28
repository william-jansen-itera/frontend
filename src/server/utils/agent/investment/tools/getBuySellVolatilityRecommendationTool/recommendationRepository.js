import {
  buildVolatilityAnalysisPath,
  getRequiredInvestmentPersistenceTreeId,
  VOLATILITY_ANALYSIS_LOG_FILE_NAME,
  VOLATILITY_ANALYSIS_STATE_FILE_NAME,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  readSingleInvestmentTextAttachmentByFileName,
  replaceInvestmentLeafAttachment,
} from '@/server/utils/agent/investment/investmentTreeRepository';

function normalizeTicker(ticker) {
  return String(ticker ?? '').trim().toUpperCase();
}

function parseStoredRecommendationState(text) {
  try {
    const parsedState = JSON.parse(String(text ?? ''));
    return parsedState && typeof parsedState === 'object' && !Array.isArray(parsedState)
      ? parsedState
      : null;
  } catch {
    return null;
  }
}

async function loadRecommendationDocument(fileName, normalizedTicker) {
  return readSingleInvestmentTextAttachmentByFileName({
    treeId: getRequiredInvestmentPersistenceTreeId(),
    pathSegments: buildVolatilityAnalysisPath(normalizedTicker),
    fileName,
  });
}

export async function loadStoredRecommendationArtifacts(ticker) {
  const normalizedTicker = normalizeTicker(ticker);

  if (!normalizedTicker) {
    throw new Error('Ticker is required to load stored recommendations.');
  }

  const [stateDocument, logDocument] = await Promise.all([
    loadRecommendationDocument(VOLATILITY_ANALYSIS_STATE_FILE_NAME, normalizedTicker),
    loadRecommendationDocument(VOLATILITY_ANALYSIS_LOG_FILE_NAME, normalizedTicker),
  ]);

  return {
    ticker: normalizedTicker,
    stateDocument,
    logDocument,
    parsedState: parseStoredRecommendationState(stateDocument?.text),
  };
}

export async function loadStoredRecommendationEventEntries(ticker) {
  const { parsedState } = await loadStoredRecommendationArtifacts(ticker);
  return Array.isArray(parsedState?.eventEntries) ? parsedState.eventEntries : [];
}

export async function persistStoredRecommendationArtifacts({
  ticker,
  stateText,
  logText,
  updatedBy = null,
  existingStateText = null,
  existingLogText = null,
}) {
  const normalizedTicker = normalizeTicker(ticker);

  if (!normalizedTicker) {
    throw new Error('Ticker is required to persist recommendations.');
  }

  const treeId = getRequiredInvestmentPersistenceTreeId();
  const pathSegments = buildVolatilityAnalysisPath(normalizedTicker);

  if (existingLogText !== logText) {
    await replaceInvestmentLeafAttachment({
      treeId,
      pathSegments,
      fileName: VOLATILITY_ANALYSIS_LOG_FILE_NAME,
      contentType: 'text/plain; charset=utf-8',
      content: logText,
      updatedBy,
    });
  }

  if (existingStateText !== stateText) {
    await replaceInvestmentLeafAttachment({
      treeId,
      pathSegments,
      fileName: VOLATILITY_ANALYSIS_STATE_FILE_NAME,
      contentType: 'application/json; charset=utf-8',
      content: stateText,
      updatedBy,
    });
  }
}