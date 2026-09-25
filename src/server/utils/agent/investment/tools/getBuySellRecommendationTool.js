import {
  buildInvestmentToolResult,
  normalizeTicker,
} from '@/server/utils/agent/investment/tools/investmentToolShared';

export const GET_BUY_SELL_RECOMMENDATION_TOOL = 'get_buy_sell_recommendation';

export const getBuySellRecommendationToolDefinition = {
  type: 'function',
  name: GET_BUY_SELL_RECOMMENDATION_TOOL,
  description: 'Produce a mock buy, hold, or sell signal from recent closing prices after price data has been fetched.',
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
        description: 'Recent closing-price history, ideally returned by get_stock_price.',
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

function buildRecommendationSignal(priceHistory) {
  const prices = Array.isArray(priceHistory)
    ? priceHistory.map((entry) => Number(entry?.close)).filter((value) => Number.isFinite(value))
    : [];

  if (prices.length < 2) {
    return {
      signal: 'hold',
      confidence: 'low',
      rationale: 'Not enough closing-price history was provided to form a directional view.',
    };
  }

  const firstPrice = prices[0];
  const lastPrice = prices[prices.length - 1];
  const changeRatio = (lastPrice - firstPrice) / firstPrice;

  if (changeRatio >= 0.04) {
    return {
      signal: 'buy',
      confidence: 'medium',
      rationale: `Closing prices trend upward by ${(changeRatio * 100).toFixed(1)}% over the sampled window.`,
    };
  }

  if (changeRatio <= -0.04) {
    return {
      signal: 'sell',
      confidence: 'medium',
      rationale: `Closing prices trend downward by ${(Math.abs(changeRatio) * 100).toFixed(1)}% over the sampled window.`,
    };
  }

  return {
    signal: 'hold',
    confidence: 'low',
    rationale: `Closing prices moved only ${(changeRatio * 100).toFixed(1)}% over the sampled window, which is not decisive in this mock rule set.`,
  };
}

export function buildGetBuySellRecommendationHandler({ includeDebug = false } = {}) {
  return async function getBuySellRecommendationHandler({ ticker, priceHistory }) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedHistory = Array.isArray(priceHistory) ? priceHistory : [];
    const recommendation = buildRecommendationSignal(normalizedHistory);
    const output = {
      ticker: normalizedTicker,
      analyzedWindow: normalizedHistory.length,
      ...recommendation,
    };

    return buildInvestmentToolResult({
      toolName: GET_BUY_SELL_RECOMMENDATION_TOOL,
      toolResultType: 'recommendation',
      data: output,
      includeDebug,
      debug: includeDebug ? { toolOutput: output } : null,
    });
  };
}