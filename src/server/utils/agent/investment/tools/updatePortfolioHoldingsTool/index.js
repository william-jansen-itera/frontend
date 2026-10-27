import { appendDebugStep, attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildInvestmentToolResult } from '@/server/utils/agent/investment/tools/investmentToolShared';
import {
  collectPortfolioHoldings,
  exportPortfolioHoldingsCalculations,
  removePortfolioHoldings,
  refreshPortfolioHoldingsCalculations,
} from '@/server/utils/agent/investment/tools/updatePortfolioHoldingsTool/portfolioHoldingsRepository';

export const PORTFOLIO_STOCK_HOLDINGS_TOOL = 'portfolio_stock_holdings';
export const UPDATE_HOLDINGS_OPERATION = 'update_holdings';
export const REMOVE_HOLDINGS_OPERATION = 'remove_holdings';
export const REFRESH_CALCULATIONS_OPERATION = 'refresh_calculations';
export const EXPORT_CALCULATIONS_OPERATION = 'export_calculations';

export const updatePortfolioHoldingsToolOutputSchema = {
  type: 'object',
  properties: {
    treeId: { type: 'string' },
    operation: { type: 'string' },
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
    removedTickers: {
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
    noteLink: { type: 'string' },
    fileLink: { type: ['string', 'null'] },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['treeId', 'operation', 'pathSegments', 'currency', 'columns', 'rows', 'addedOrUpdatedTickers', 'removedTickers', 'pricedTickers', 'skippedRows', 'totals', 'noteLink', 'fileLink', 'warnings'],
  additionalProperties: false,
};

export const updatePortfolioHoldingsToolDefinition = {
  type: 'function',
  name: PORTFOLIO_STOCK_HOLDINGS_TOOL,
  description: 'Manage portfolio holdings stored as JSON in the personal-cache List node notes. Use update_holdings to create or partially update stored per-ticker fields after the user provides them. Use remove_holdings to remove one or more ticker rows. Each entry must include ticker and, for update_holdings, at least one explicitly user-provided field among shareCount, averagePurchasePrice, or returnSnapshot; use null for any other field that is not being updated. Never infer average purchase price or return from unrelated data. When update_holdings receives returnSnapshot, treat the user input as DKK for the full ticker position and convert it to USD before storing the return. Updating returnSnapshot clears the stored average purchase price; updating averagePurchasePrice clears the stored return so refresh_calculations can derive it again. If both are provided, averagePurchasePrice takes precedence. During refresh_calculations, average purchase price may be derived only from the stored return in USD, share count, and the latest closing price when average purchase price is otherwise missing. Use refresh_calculations to update closing price, value, percentage, return, and return (%) from the latest available closing prices. Use export_calculations to export the stored JSON rows in the original CSV format as an attachment on the same node; it does not refresh calculations. Return a note link for all operations and a file link for export_calculations.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        description: 'Operation to run. Use update_holdings to add or update ticker rows, remove_holdings to delete ticker rows, refresh_calculations to recompute portfolio values and return (%) from the stored notes, or export_calculations to attach a CSV export of the stored JSON.',
        enum: [UPDATE_HOLDINGS_OPERATION, REMOVE_HOLDINGS_OPERATION, REFRESH_CALCULATIONS_OPERATION, EXPORT_CALCULATIONS_OPERATION],
      },
      entries: {
        type: 'array',
        description: 'Per-ticker entries used by update_holdings or remove_holdings. For update_holdings, each entry must include ticker and may update shareCount, averagePurchasePrice, and/or returnSnapshot. For remove_holdings, pass the ticker to remove and set the other fields to null. Use [] for refresh_calculations and export_calculations.',
        items: {
          type: 'object',
          properties: {
            ticker: {
              type: 'string',
              description: 'Stock ticker symbol, such as MSFT or AAPL.',
            },
            shareCount: {
              type: ['number', 'null'],
              description: 'Share count to store for this ticker. Use null when share count is not being updated in this entry.',
            },
            averagePurchasePrice: {
              type: ['number', 'null'],
              description: 'Average purchase price per share in USD explicitly provided by the user for this ticker so return and return (%) can be calculated during refresh. Confirm the currency is USD if unclear. Use null when it is not being updated or is not known. The system may derive this later only from an explicitly provided returnSnapshot stored in USD plus the latest closing price.',
            },
            returnSnapshot: {
              type: ['number', 'null'],
              description: 'Absolute gain or loss for the full ticker position explicitly provided by the user in DKK. Use null when it is not being updated or is not known. This is not a percent and may be negative. update_holdings converts it to USD before storing it in the notes.',
            },
          },
          required: ['ticker', 'shareCount', 'averagePurchasePrice', 'returnSnapshot'],
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
        emitStep('tool portfolio_stock_holdings update started', {
          entryCount: Array.isArray(entries) ? entries.length : 0,
        });
        const updateResult = await collectPortfolioHoldings({
          treeId: resolvedTreeId,
          entries,
          updatedBy: resolvedUpdatedBy,
          onStep: emitStep,
        });
        output = updateResult?.output ?? updateResult;
        operationDebug = updateResult?.debug ?? null;
      } else if (operation === REMOVE_HOLDINGS_OPERATION) {
        emitStep('tool portfolio_stock_holdings remove started', {
          entryCount: Array.isArray(entries) ? entries.length : 0,
        });
        output = await removePortfolioHoldings({
          treeId: resolvedTreeId,
          entries,
          updatedBy: resolvedUpdatedBy,
          onStep: emitStep,
        });
      } else if (operation === REFRESH_CALCULATIONS_OPERATION) {
        emitStep('tool portfolio_stock_holdings refresh started');
        const refreshResult = await refreshPortfolioHoldingsCalculations({
          treeId: resolvedTreeId,
          updatedBy: resolvedUpdatedBy,
          onStep: emitStep,
        });
        output = refreshResult?.output ?? refreshResult;
        operationDebug = refreshResult?.debug ?? null;
      } else if (operation === EXPORT_CALCULATIONS_OPERATION) {
        emitStep('tool portfolio_stock_holdings export started');
        output = await exportPortfolioHoldingsCalculations({
          treeId: resolvedTreeId,
          updatedBy: resolvedUpdatedBy,
        });
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
      toolName: PORTFOLIO_STOCK_HOLDINGS_TOOL,
      toolResultType: 'portfolio_holdings_update',
      data: output,
      supportsCitations: true,
      includeDebug,
      debug: includeDebug ? {
        operation: output.operation,
        noteLink: output.noteLink,
        fileLink: output.fileLink,
        ...(operationDebug ? operationDebug : {}),
      } : null,
    });
  };
}