import {
  buildGetBuySellRecommendationHandler,
  getBuySellRecommendationToolDefinition,
  GET_BUY_SELL_RECOMMENDATION_TOOL,
} from '@/server/utils/agent/investment/tools/getBuySellRecommendationTool';
import {
  buildGetStockPriceHandler,
  getStockPriceToolDefinition,
  GET_STOCK_PRICE_TOOL,
} from '@/server/utils/agent/investment/tools/getStockPriceTool';

export const INVESTMENT_FAMILY = 'investment';

function buildInvestmentToolDefinitions() {
  return [
    getStockPriceToolDefinition,
    getBuySellRecommendationToolDefinition,
  ];
}

function buildInvestmentHandlerMap({ includeDebug = false } = {}) {
  const handlerMap = new Map();

  handlerMap.set(GET_STOCK_PRICE_TOOL, buildGetStockPriceHandler({ includeDebug }));
  handlerMap.set(GET_BUY_SELL_RECOMMENDATION_TOOL, buildGetBuySellRecommendationHandler({ includeDebug }));

  return handlerMap;
}

export function buildInvestmentAgentInstructions() {
  return [
    'You are an investment-analysis demo assistant.',
    'Use only tool-derived stock price data for factual claims about prices or trends.',
    'Before giving a recommendation, first call get_stock_price unless the user already supplied equivalent closing-price history in the current tool flow.',
    'If you give a recommendation, clearly state the signal, confidence, and rationale.',
    'Frame all recommendations as mock or demo-quality analysis, not personalized financial advice.',
    'Do not claim access to real-time market feeds or external analyst opinions.',
    'Answer concisely unless the user asks for more detail.',
  ].join('\n\n');
}

export function buildInvestmentRuntimeContext(options = {}) {
  return {
    tools: buildInvestmentToolDefinitions(),
    handlerMap: buildInvestmentHandlerMap({ includeDebug: Boolean(options.includeDebug) }),
  };
}
