import {
  buildInvestmentToolResult,
  normalizeTicker,
} from '@/server/utils/agent/investment/tools/investmentToolShared';
import {
  buildVolatilityAnalysisPath,
  getRequiredInvestmentPersistenceTreeId,
  VOLATILITY_ANALYSIS_LOG_FILE_NAME,
  VOLATILITY_ANALYSIS_STATE_FILE_NAME,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import { loadVolatilityRuntimeConfig } from '@/server/utils/agent/investment/volatilityConfigRepository';
import {
  readSingleInvestmentTextAttachmentByFileName,
  replaceInvestmentLeafAttachment,
} from '@/server/utils/agent/investment/investmentTreeRepository';
import { runVolatilityHarvestAnalysis } from '@/server/utils/agent/investment/tools/getBuySellVolatilityRecommendationTool/volatilityEngine';

export const GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL = 'get_buy_sell_volatility_recommendation';

function buildEventLogLine(eventEntry) {
  const maSuffix = Number.isFinite(eventEntry?.movingAverage)
    ? `, MA: ${eventEntry.movingAverage.toFixed(2)}`
    : '';
  const baseLine = `Date: ${eventEntry?.date ?? 'Unknown'} | Close: ${eventEntry?.close ?? 'Unknown'} | Mode: ${eventEntry?.mode ?? 'Unknown'} | Rotations: ${eventEntry?.rotationsUsed ?? 0} | Shares: ${eventEntry?.shares ?? 0}${maSuffix}`;

  if (!Array.isArray(eventEntry?.details) || eventEntry.details.length === 0) {
    return baseLine;
  }

  return `${baseLine} | ${eventEntry.details.join(' | ')}`;
}

export const getBuySellVolatilityRecommendationToolOutputSchema = {
  type: 'object',
  properties: {
    ticker: {
      type: 'string',
    },
    signal: {
      type: 'string',
      enum: ['buy', 'hold', 'sell'],
    },
    noOfShares: {
      type: 'integer',
    },
    rationale: {
      type: 'string',
    },
    whatToLookFor: {
      type: 'string',
    },
    receivedWindow: {
      type: 'integer',
    },
    analyzedWindow: {
      type: 'integer',
    },
    analyzedStartDate: {
      type: ['string', 'null'],
    },
    analyzedEndDate: {
      type: ['string', 'null'],
    },
    effectiveConfiguration: {
      type: 'object',
      properties: {
        maxRotations: { type: 'integer' },
        rotationSize: { type: 'number' },
        useMaGate: { type: 'boolean' },
        maPeriod: { type: ['integer', 'null'] },
        maxHistoryDays: { type: 'integer' },
        volatilityThreshold: { type: 'number' },
        startShareCount: { type: 'integer' },
      },
      required: ['maxRotations', 'rotationSize', 'useMaGate', 'maPeriod', 'maxHistoryDays', 'volatilityThreshold', 'startShareCount'],
      additionalProperties: false,
    },
    finalState: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['NEUTRAL', 'VOLATILITY'],
        },
        currentShareCount: {
          type: 'integer',
        },
        currentProfit: {
          type: 'number',
        },
        currentMovingAverage: {
          type: ['number', 'null'],
        },
        volatility: {
          type: 'object',
          properties: {
            crashPeak: { type: ['number', 'null'] },
            episodeLow: { type: ['number', 'null'] },
            syntheticBase: { type: ['number', 'null'] },
            rotationsUsed: { type: 'integer' },
            rerotationThreshold: { type: ['number', 'null'] },
            rotationBlockValue: { type: 'number' },
            rotationShares: {
              type: 'array',
              items: { type: 'integer' },
            },
            rotationPrices: {
              type: 'array',
              items: { type: 'number' },
            },
          },
          required: ['crashPeak', 'episodeLow', 'syntheticBase', 'rotationsUsed', 'rerotationThreshold', 'rotationBlockValue', 'rotationShares', 'rotationPrices'],
          additionalProperties: false,
        },
      },
      required: ['mode', 'currentShareCount', 'currentProfit', 'currentMovingAverage', 'volatility'],
      additionalProperties: false,
    },
    eventEntries: {
      type: 'array',
      description: 'Chronological engine event objects that explain each volatility-harvesting analysis event including triggered rotation and re-rotation for the analyzed date.',
      items: {
        type: 'object',
        properties: {
          date: {
            type: ['string', 'null'],
          },
          close: {
            type: ['number', 'null'],
          },
          mode: {
            type: ['string', 'null'],
            enum: ['NEUTRAL', 'VOLATILITY', null],
          },
          rotationsUsed: {
            type: 'integer',
          },
          shares: {
            type: 'integer',
          },
          movingAverage: {
            type: ['number', 'null'],
          },
          details: {
            type: 'array',
            description: 'Chronological event-detail messages captured for that day. A single item may itself be a pipe-delimited summary string.',
            items: {
              type: 'string',
            },
          },
          eventType: {
            type: 'string',
            enum: ['rotation', 're-rotation', 'none'],
          },
        },
        required: ['date', 'close', 'mode', 'rotationsUsed', 'shares', 'movingAverage', 'details', 'eventType'],
        additionalProperties: false,
      },
    },
  },
  required: ['ticker', 'signal', 'noOfShares', 'rationale', 'whatToLookFor', 'receivedWindow', 'analyzedWindow', 'analyzedStartDate', 'analyzedEndDate', 'effectiveConfiguration', 'finalState', 'eventEntries'],
  additionalProperties: false,
};

export const getBuySellVolatilityRecommendationToolDefinition = {
  type: 'function',
  name: GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL,
  description: 'Produce a buy, hold, or sell volatility-harvesting signal from closing-price history that was fetched earlier.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      ticker: {
        type: 'string',
        description: 'Stock ticker symbol, such as MSFT or AAPL.',
      },
      priceHistory: {
        type: 'array',
        description: 'Closing-price history to analyze, ideally returned by get_stock_price for the user-confirmed analysis window.',
        items: {
          type: 'object',
          properties: {
            date: {
              type: 'string',
            },
            close: {
              type: 'number',
            },
          },
          required: ['date', 'close'],
          additionalProperties: false,
        },
      },
    },
    required: ['ticker', 'priceHistory'],
    additionalProperties: false,
  },
};

function buildRecommendationLogText({ ticker, output }) {
  const lines = [
    `Ticker: ${ticker}`,
    `Signal: ${output.signal}`,
    `Shares: ${output.noOfShares}`,
    `Rationale: ${output.rationale}`,
    `What to look for: ${output.whatToLookFor}`,
    `Received rows: ${output.receivedWindow}`,
    `Analyzed rows: ${output.analyzedWindow}`,
    `Engine mode: ${output.finalState.mode}`,
    `Rotations used: ${output.finalState.volatility.rotationsUsed}`,
    `Current share count: ${output.finalState.currentShareCount}`,
    `Current profit: ${output.finalState.currentProfit}`,
    `Max history days: ${output.effectiveConfiguration.maxHistoryDays}`,
    '',
    'Events:',
  ];

  if (Array.isArray(output.eventEntries) && output.eventEntries.length > 0) {
    output.eventEntries.forEach((eventEntry) => {
      lines.push(`- ${buildEventLogLine(eventEntry)}`);
    });
  } else {
    lines.push('- No engine events were emitted.');
  }

  return lines.join('\n');
}

function buildRecommendationStateDocument(output) {
  return JSON.stringify(output, null, 2);
}

function formatThresholdPrice(value) {
  return Number.isFinite(value) ? value.toFixed(2) : null;
}

function buildWhatToLookFor({ recommendation, analysisState, analysisResult, runtimeConfig }) {
  const latestEntry = analysisResult?.trimmedHistory?.[analysisResult.trimmedHistory.length - 1] ?? null;
  const latestClose = Number(latestEntry?.close);
  const lastAction = analysisState?.lastAction ?? null;
  const rotationsUsed = Number(analysisState?.volatility?.rotationsUsed ?? 0);
  const maxRotationsReached = analysisState?.mode === 'VOLATILITY'
    && rotationsUsed >= runtimeConfig.maxRotations;
  const rotationTriggerClose = Number.isFinite(latestClose)
    ? latestClose * (1 - runtimeConfig.volatilityThreshold)
    : null;
  const rerotationThreshold = Number.isFinite(analysisState?.volatility?.rerotationThreshold)
    ? analysisState.volatility.rerotationThreshold
    : null;
  const maGateSuffix = runtimeConfig.useMaGate && Number.isFinite(analysisState?.currentMa)
    ? ` The MA gate is active, so a rotation also requires the triggering close to remain above the ${runtimeConfig.maPeriod}-day moving average (${analysisState.currentMa.toFixed(2)}).`
    : runtimeConfig.useMaGate
      ? ' The MA gate is active; if enough history is available, a triggering close must also remain above the configured moving average.'
      : '';

  if (!Number.isFinite(latestClose)) {
    return 'Watch the next closing price against the configured volatility and rerotation thresholds.';
  }

  if (recommendation?.signal === 'sell' || analysisState?.mode === 'NEUTRAL') {
    return `A new rotation would require the next close to fall to ${formatThresholdPrice(rotationTriggerClose)} or lower from the latest close of ${formatThresholdPrice(latestClose)}.${maGateSuffix}`;
  }

  if (runtimeConfig.useMaGate && lastAction?.maGateBlocked) {
    return `The last close met the volatility drop trigger, but the MA gate blocked a rotation because the close (${formatThresholdPrice(lastAction.close)}) was at or below the ${runtimeConfig.maPeriod}-day moving average (${formatThresholdPrice(lastAction.movingAverage)}). A future rotation still requires a close at ${formatThresholdPrice(rotationTriggerClose)} or lower while also remaining above that moving average.`;
  }

  if (maxRotationsReached || lastAction?.maxRotationsReached) {
    return `The episode is already at the configured maximum of ${runtimeConfig.maxRotations} rotation(s). The next actionable threshold is re-rotation at ${formatThresholdPrice(rerotationThreshold)} or higher from the latest close of ${formatThresholdPrice(latestClose)}.`;
  }

  const parts = [];

  if (Number.isFinite(rotationTriggerClose)) {
    parts.push(`another rotation would require a close at ${formatThresholdPrice(rotationTriggerClose)} or lower`);
  }

  if (Number.isFinite(rerotationThreshold)) {
    parts.push(`re-rotation would trigger at ${formatThresholdPrice(rerotationThreshold)} or higher`);
  }

  return `From the latest close of ${formatThresholdPrice(latestClose)}, ${parts.join(', and ')}.${maGateSuffix}`;
}

function deriveNoOfShares(recommendation, analysisState) {
  if (recommendation?.signal === 'sell') {
    return Number(analysisState?.lastAction?.noOfShares ?? 0);
  }

  if (recommendation?.signal === 'buy') {
    return Number(analysisState?.lastAction?.noOfShares ?? 0);
  }

  return 0;
}

export function buildGetBuySellVolatilityRecommendationHandler({ includeDebug = false, updatedBy = null } = {}) {
  return async function getBuySellVolatilityRecommendationHandler({ ticker, priceHistory }) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedHistory = Array.isArray(priceHistory) ? priceHistory : [];
    const runtimeConfig = await loadVolatilityRuntimeConfig(normalizedTicker);
    const analysisResult = runVolatilityHarvestAnalysis(normalizedHistory, runtimeConfig);
    const recommendation = analysisResult.recommendation;
    const noOfShares = deriveNoOfShares(recommendation, analysisResult.state);
    const whatToLookFor = buildWhatToLookFor({
      recommendation,
      analysisState: analysisResult.state,
      analysisResult,
      runtimeConfig,
    });
    const output = {
      ticker: normalizedTicker,
      signal: recommendation.signal,
      noOfShares,
      rationale: recommendation.rationale,
      whatToLookFor,
      receivedWindow: normalizedHistory.length,
      analyzedWindow: analysisResult.trimmedHistory.length,
      analyzedStartDate: analysisResult.trimmedHistory[0]?.date ?? null,
      analyzedEndDate: analysisResult.trimmedHistory[analysisResult.trimmedHistory.length - 1]?.date ?? null,
      effectiveConfiguration: {
        maxRotations: runtimeConfig.maxRotations,
        rotationSize: runtimeConfig.rotationSize,
        useMaGate: runtimeConfig.useMaGate,
        maPeriod: runtimeConfig.maPeriod,
        maxHistoryDays: runtimeConfig.maxHistoryDays,
        volatilityThreshold: runtimeConfig.volatilityThreshold,
        startShareCount: runtimeConfig.startShareCount,
      },
      finalState: {
        mode: analysisResult.state.mode,
        currentShareCount: analysisResult.state.currentShareCount,
        currentProfit: analysisResult.state.currentProfit,
        currentMovingAverage: Number.isFinite(analysisResult.state.currentMa) ? analysisResult.state.currentMa : null,
        volatility: {
          crashPeak: analysisResult.state.volatility.crashPeak,
          episodeLow: analysisResult.state.volatility.episodeLow,
          syntheticBase: analysisResult.state.volatility.syntheticBase,
          rotationsUsed: analysisResult.state.volatility.rotationsUsed,
          rerotationThreshold: analysisResult.state.volatility.rerotationThreshold,
          rotationBlockValue: analysisResult.state.volatility.rotationBlockValue,
          rotationShares: analysisResult.state.volatility.rotationShares,
          rotationPrices: analysisResult.state.volatility.rotationPrices,
        },
      },
      eventEntries: analysisResult.state.events,
    };
    const recommendationPath = buildVolatilityAnalysisPath(normalizedTicker);
    const persistenceTreeId = getRequiredInvestmentPersistenceTreeId();
    const nextLogContent = buildRecommendationLogText({ ticker: normalizedTicker, output });
    const nextStateContent = buildRecommendationStateDocument(output);
    const existingLogDocument = await readSingleInvestmentTextAttachmentByFileName({
      treeId: persistenceTreeId,
      pathSegments: recommendationPath,
      fileName: VOLATILITY_ANALYSIS_LOG_FILE_NAME,
    });
    const existingStateDocument = await readSingleInvestmentTextAttachmentByFileName({
      treeId: persistenceTreeId,
      pathSegments: recommendationPath,
      fileName: VOLATILITY_ANALYSIS_STATE_FILE_NAME,
    });

    if (existingLogDocument?.text !== nextLogContent) {
      await replaceInvestmentLeafAttachment({
        treeId: persistenceTreeId,
        pathSegments: recommendationPath,
        fileName: VOLATILITY_ANALYSIS_LOG_FILE_NAME,
        contentType: 'text/plain; charset=utf-8',
        content: nextLogContent,
        updatedBy,
      });
    }
    if (existingStateDocument?.text !== nextStateContent) {
      await replaceInvestmentLeafAttachment({
        treeId: persistenceTreeId,
        pathSegments: recommendationPath,
        fileName: VOLATILITY_ANALYSIS_STATE_FILE_NAME,
        contentType: 'application/json; charset=utf-8',
        content: nextStateContent,
        updatedBy,
      });
    }

    return buildInvestmentToolResult({
      toolName: GET_BUY_SELL_VOLATILITY_RECOMMENDATION_TOOL,
      toolResultType: 'recommendation',
      data: output,
      includeDebug,
    });
  };
}