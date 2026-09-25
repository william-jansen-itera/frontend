import {
  buildInvestmentToolResult,
  normalizeTicker,
} from '@/server/utils/agent/investment/tools/investmentToolShared';

export const GET_STOCK_PRICE_TOOL = 'get_stock_price';

export const getStockPriceToolDefinition = {
  type: 'function',
  name: GET_STOCK_PRICE_TOOL,
  description: 'Fetch mock daily closing-price history for a stock ticker before making any recommendation.',
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
        description: 'Number of recent daily closes to fetch. Use 5 when unsure.',
      },
    },
    required: ['ticker', 'days'],
    additionalProperties: false,
  },
};

function buildTickerSeed(ticker) {
  return ticker.split('').reduce((total, character) => total + character.charCodeAt(0), 0);
}

function normalizeDays(value) {
  const parsedValue = Number.parseInt(value, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 5;
  }

  return Math.min(parsedValue, 30);
}

function buildMockPriceHistory(ticker, days) {
  const seed = buildTickerSeed(ticker || 'STOCK');
  const basePrice = 80 + (seed % 140);
  const volatility = (seed % 7) + 2;

  return Array.from({ length: days }, (_, index) => {
    const offset = days - index - 1;
    const drift = ((seed + index) % 5) - 2;
    const close = Number((basePrice + (index * 0.9) + drift + ((offset % 2 === 0) ? volatility * 0.35 : -volatility * 0.25)).toFixed(2));
    const date = new Date(Date.now() - (offset * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);

    return {
      date,
      close,
    };
  });
}

export function buildGetStockPriceHandler({ includeDebug = false } = {}) {
  return async function getStockPriceHandler({ ticker, days }) {
    const normalizedTicker = normalizeTicker(ticker);
    const normalizedDays = normalizeDays(days);
    const priceHistory = buildMockPriceHistory(normalizedTicker, normalizedDays);
    const output = {
      ticker: normalizedTicker,
      currency: 'USD',
      days: normalizedDays,
      priceHistory,
    };

    return buildInvestmentToolResult({
      toolName: GET_STOCK_PRICE_TOOL,
      toolResultType: 'price_data',
      data: output,
      includeDebug,
      debug: includeDebug ? { toolOutput: output } : null,
    });
  };
}