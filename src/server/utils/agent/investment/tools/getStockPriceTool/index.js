import {
  buildInvestmentToolResult,
  normalizeTicker,
} from '@/server/utils/agent/investment/tools/investmentToolShared';
import { fetchHistoricalClosingPrices } from '@/server/utils/agent/investment/tools/getStockPriceTool/historicalPriceProvider';
import { getCachedOrFetchPriceHistory } from '@/server/utils/agent/investment/tools/getStockPriceTool/stockPriceRepository';

export const GET_STOCK_PRICE_TOOL = 'get_stock_price';

export const getStockPriceToolOutputSchema = {
  type: 'object',
  properties: {
    ticker: {
      type: 'string',
    },
    currency: {
      type: 'string',
    },
    days: {
      type: 'integer',
    },
    priceHistory: {
      type: 'array',
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
  required: ['ticker', 'currency', 'days', 'priceHistory'],
  additionalProperties: false,
};

export const getStockPriceToolDefinition = {
  type: 'function',
  name: GET_STOCK_PRICE_TOOL,
  description: 'Fetch daily closing-price history for a stock ticker over a recent calendar-day window. Keep requests fluent to the user need, cap them at 365 calendar days, and use 365 days when gathering history for a recommendation.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      ticker: {
        type: 'string',
        description: 'Stock ticker symbol, such as MSFT or AAPL.',
      },
      days: {
        type: 'integer',
        description: 'Number of recent calendar days to cover, capped at 365. Returned rows include the available market closes inside that calendar window. Use 5 when unsure.',
      },
    },
    required: ['ticker', 'days'],
    additionalProperties: false,
  },
};

function normalizeDays(value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 5;
  }

  return Math.min(parsedValue, 365);
}

export function buildGetStockPriceHandler({ includeDebug = false, updatedBy = null } = {}) {
  return async function getStockPriceHandler({ ticker, days }) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedDays = normalizeDays(days);
    const stockPriceResult = await getCachedOrFetchPriceHistory({
      ticker: normalizedTicker,
      days: normalizedDays,
      fetcher: fetchHistoricalClosingPrices,
      updatedBy,
    });
    const output = {
      ticker: normalizedTicker,
      currency: stockPriceResult.currency,
      days: normalizedDays,
      priceHistory: stockPriceResult.priceHistory,
    };

    return buildInvestmentToolResult({
      toolName: GET_STOCK_PRICE_TOOL,
      toolResultType: 'price_data',
      data: output,
      includeDebug,
      debug: includeDebug ? {
        cacheStatus: stockPriceResult.cacheStatus,
      } : null,
    });
  };
}