import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildInvestmentToolResult } from '@/server/utils/agent/investment/tools/investmentToolShared';
import {
  collectPortfolioHoldings,
  refreshPortfolioHoldingsCalculations,
} from '@/server/utils/agent/investment/tools/updatePortfolioHoldingsTool/portfolioHoldingsRepository';

export const UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL = 'update_portfolio_stock_holdings';
export const UPDATE_HOLDINGS_OPERATION = 'update_holdings';
export const REFRESH_CALCULATIONS_OPERATION = 'refresh_calculations';

export const updatePortfolioHoldingsToolOutputSchema = {
  type: 'object',
  properties: {
    treeId: { type: 'string' },
    operation: { type: 'string' },
    fileName: { type: 'string' },
    pathSegments: {
      type: 'array',
      items: { type: 'string' },
    },
    currency: { type: 'string' },
    columns: {
      type: 'array',
      items: { type: 'string' },
    },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
    addedOrUpdatedTickers: {
      type: 'array',
      items: { type: 'string' },
    },
    pricedTickers: {
      type: 'array',
      items: { type: 'string' },
    },
    skippedRows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rowNumber: { type: 'integer' },
          ticker: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
        required: ['rowNumber', 'ticker', 'reason'],
        additionalProperties: false,
      },
    },
    totals: {
      type: 'object',
      properties: {
        pricedRowCount: { type: 'integer' },
        skippedRowCount: { type: 'integer' },
        totalPortfolioValue: { type: 'number' },
        totalPortfolioValueDkk: { type: 'number' },
        pricedTickerCount: { type: 'integer' },
      },
      required: ['pricedRowCount', 'skippedRowCount', 'totalPortfolioValue', 'totalPortfolioValueDkk', 'pricedTickerCount'],
      additionalProperties: false,
    },
    fileLink: { type: ['string', 'null'] },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['treeId', 'operation', 'fileName', 'pathSegments', 'currency', 'columns', 'rows', 'addedOrUpdatedTickers', 'pricedTickers', 'skippedRows', 'totals', 'fileLink', 'warnings'],
  additionalProperties: false,
};

export const updatePortfolioHoldingsToolDefinition = {
  type: 'function',
  name: UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL,
  description: 'Manage the personal-cache portfolio holdings CSV. Use update_holdings to create or upsert ticker and share count rows after the user provides them. Use refresh_calculations to update closing price, value, and percentage from the latest available closing prices and return the full current CSV dataset plus a file link.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Operation to run. Use update_holdings to add or update ticker rows, or refresh_calculations to recompute portfolio values from the stored CSV.',
        enum: [UPDATE_HOLDINGS_OPERATION, REFRESH_CALCULATIONS_OPERATION],
      },
      entries: {
        type: 'array',
        description: 'Ticker and share count pairs to write when operation is update_holdings. Use [] for refresh_calculations.',
        items: {
          type: 'object',
          properties: {
            ticker: {
              type: 'string',
              description: 'Stock ticker symbol, such as MSFT or AAPL.',
            },
            shareCount: {
              type: 'number',
              description: 'Share count to store for this ticker.',
            },
          },
          required: ['ticker', 'shareCount'],
          additionalProperties: false,
        },
      },
    },
    required: ['operation', 'entries'],
    additionalProperties: false,
  },
};

export function buildUpdatePortfolioHoldingsHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function updatePortfolioHoldingsHandler({ operation, entries = [] }, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;
    const agentDebug = agentContext?.debug ?? null;
    let output;
    let operationDebug = null;
    const emitStep = (step, details = null) => {
      if (!includeDebug || !agentDebug) {
        return;
      }

      appendDebugStep(agentDebug, step, details);
    };

    try {
      if (operation === UPDATE_HOLDINGS_OPERATION) {
        emitStep('tool update_portfolio_stock_holdings update started', {
          entryCount: Array.isArray(entries) ? entries.length : 0,
        });
        output = await collectPortfolioHoldings({
          treeId: resolvedTreeId,
          entries,
          updatedBy: resolvedUpdatedBy,
          onStep: emitStep,
        });
      } else if (operation === REFRESH_CALCULATIONS_OPERATION) {
        emitStep('tool update_portfolio_stock_holdings refresh started');
        const refreshResult = await refreshPortfolioHoldingsCalculations({
          treeId: resolvedTreeId,
          updatedBy: resolvedUpdatedBy,
          onStep: emitStep,
        });
        output = refreshResult?.output ?? refreshResult;
        operationDebug = refreshResult?.debug ?? null;
      } else {
        throw new Error(`Unsupported portfolio holdings operation: ${operation ?? ''}`);
      }
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? {
        operation: String(operation ?? ''),
        entryCount: Array.isArray(entries) ? entries.length : 0,
        entries,
        resolvedTreeId,
        resolvedUpdatedBy,
      } : null);
    }

    return buildInvestmentToolResult({
      toolName: UPDATE_PORTFOLIO_STOCK_HOLDINGS_TOOL,
      toolResultType: 'portfolio_holdings_update',
      data: output,
      supportsCitations: true,
      includeDebug,
      debug: includeDebug ? {
        operation: output.operation,
        fileLink: output.fileLink,
        ...(operationDebug ? operationDebug : {}),
      } : null,
    });
  };
}