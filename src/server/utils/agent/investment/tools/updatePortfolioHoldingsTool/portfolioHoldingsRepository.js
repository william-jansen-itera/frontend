import {
  PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER,
  buildPortfolioHoldingsPath,
  PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER,
  PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
  PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER,
  PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER,
  PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER,
  PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER,
  PORTFOLIO_HOLDINGS_TICKER_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  readInvestmentLeafNotes,
  replaceInvestmentLeafAttachment,
  replaceInvestmentLeafNotes,
} from '@/server/utils/agent/investment/investmentTreeRepository';
import { getCachedOrFetchExchangeRate } from '@/server/utils/agent/investment/tools/exchangeRateRepository';
import { normalizeTicker } from '@/server/utils/agent/investment/tools/investmentToolShared';
import { fetchHistoricalClosingPrices } from '@/server/utils/agent/investment/tools/getStockPriceTool/historicalPriceProvider';
import { getCachedOrFetchPriceHistory } from '@/server/utils/agent/investment/tools/getStockPriceTool/stockPriceRepository';

const TREE_OPTIONS = {
  allowPrivate: true,
  allowDescription: true,
  allowPublishedDescription: true,
};
const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const REQUIRED_HEADERS = [
  PORTFOLIO_HOLDINGS_TICKER_HEADER,
  PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER,
  PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER,
  PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER,
];
const DERIVED_HEADERS = [
  PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER,
  PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER,
  PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER,
];
const PORTFOLIO_HOLDINGS_PRICE_LOOKUP_CONCURRENCY = 4;

const CANONICAL_HEADER_LOOKUP = new Map(
  [...REQUIRED_HEADERS, ...DERIVED_HEADERS].map((header) => [header.toLowerCase(), header]),
);

function escapeCsvCell(value) {
  const normalizedValue = String(value ?? '');

  if (!/[",\r\n]/.test(normalizedValue)) {
    return normalizedValue;
  }

  return `"${normalizedValue.replace(/"/g, '""')}"`;
}

function canonicalizeColumnName(column) {
  const normalizedColumn = String(column ?? '').trim();

  if (!normalizedColumn) {
    return '';
  }

  return CANONICAL_HEADER_LOOKUP.get(normalizedColumn.toLowerCase()) ?? normalizedColumn;
}

function normalizeColumns(columns) {
  const seenColumns = new Set();
  const normalizedColumns = [];

  columns.forEach((column) => {
    const normalizedColumn = canonicalizeColumnName(column);

    if (!normalizedColumn) {
      return;
    }

    const lookupKey = normalizedColumn.toLowerCase();

    if (seenColumns.has(lookupKey)) {
      return;
    }

    seenColumns.add(lookupKey);
    normalizedColumns.push(normalizedColumn);
  });

  REQUIRED_HEADERS.forEach((header) => {
    const lookupKey = header.toLowerCase();

    if (!seenColumns.has(lookupKey)) {
      seenColumns.add(lookupKey);
      normalizedColumns.push(header);
    }
  });

  DERIVED_HEADERS.forEach((header) => {
    const lookupKey = header.toLowerCase();

    if (!seenColumns.has(lookupKey)) {
      seenColumns.add(lookupKey);
      normalizedColumns.push(header);
    }
  });

  return normalizedColumns;
}

function normalizeOptionalShareCount(value) {
  const trimmedValue = String(value ?? '').trim();

  if (!trimmedValue) {
    return '';
  }

  const parsedValue = Number(trimmedValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`Share count must be a non-negative number when provided. Received: ${value ?? ''}`);
  }

  return String(parsedValue);
}

function normalizeAveragePurchasePrice(value) {
  const trimmedValue = String(value ?? '').trim();

  if (!trimmedValue) {
    return '';
  }

  const parsedValue = Number(trimmedValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`Average purchase price must be a non-negative number when provided. Received: ${value ?? ''}`);
  }

  return String(parsedValue);
}

function normalizeReturnSnapshot(value) {
  const trimmedValue = String(value ?? '').trim();

  if (!trimmedValue) {
    return '';
  }

  const parsedValue = Number(trimmedValue);

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Return must be a finite number when provided. Received: ${value ?? ''}`);
  }

  return String(parsedValue);
}

function formatCollectedNumber(value) {
  return Number.isFinite(value) ? String(Number(value.toFixed(6))) : '';
}

function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '';
}

function formatPercentage(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : '';
}

function convertDkkToUsd(value, usdToDkkRate) {
  if (!Number.isFinite(value) || !Number.isFinite(usdToDkkRate?.rate) || usdToDkkRate.rate <= 0) {
    return null;
  }

  return value / usdToDkkRate.rate;
}

async function loadUsdToDkkRate() {
  return getCachedOrFetchExchangeRate({
    baseCurrency: 'USD',
    quoteCurrency: 'DKK',
  });
}

function buildTickerRowMap(rows) {
  const rowsByTicker = new Map();

  rows.forEach((row, index) => {
    const normalizedTicker = normalizeTicker(row?.[PORTFOLIO_HOLDINGS_TICKER_HEADER]);

    if (normalizedTicker) {
      rowsByTicker.set(normalizedTicker, index);
    }
  });

  return rowsByTicker;
}

function buildPortfolioNoteLink(treeId, nodeId) {
  const searchParams = new URLSearchParams({ treeId: String(treeId), nodeId: String(nodeId), visibility: 'private' });
  return `/notes?${searchParams.toString()}`;
}

async function loadPortfolioHoldingsDocument({ treeId }) {
  const pathSegments = buildPortfolioHoldingsPath();
  const storedNotes = await readInvestmentLeafNotes({ treeId, pathSegments, treeOptions: TREE_OPTIONS });

  if (storedNotes?.notes) {
    let parsedNotes;

    try {
      parsedNotes = JSON.parse(storedNotes.notes);
    } catch {
      throw new Error('Portfolio holdings notes contain invalid JSON; no holdings were changed.');
    }

    if (!parsedNotes || !Array.isArray(parsedNotes.columns) || !Array.isArray(parsedNotes.rows)) {
      throw new Error('Portfolio holdings notes have an unexpected format; no holdings were changed.');
    }

    const columns = normalizeColumns(parsedNotes.columns);
    if (parsedNotes.rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
      throw new Error('Portfolio holdings notes contain invalid rows; no holdings were changed.');
    }

    return {
      columns,
      rows: parsedNotes.rows,
      noteLink: buildPortfolioNoteLink(treeId, storedNotes.nodeId),
      hasStoredNotes: true,
    };
  }

  return {
    noteLink: storedNotes?.nodeId ? buildPortfolioNoteLink(treeId, storedNotes.nodeId) : null,
    hasStoredNotes: false,
    columns: normalizeColumns(REQUIRED_HEADERS),
    rows: [],
  };
}

async function savePortfolioHoldingsDocument({ treeId, columns, rows, updatedBy }) {
  const nodeId = await replaceInvestmentLeafNotes({
    treeId,
    pathSegments: buildPortfolioHoldingsPath(),
    notes: JSON.stringify({ columns: normalizeColumns(columns), rows }, null, 2),
    updatedBy,
    treeOptions: TREE_OPTIONS,
  });

  return {
    columns: normalizeColumns(columns),
    rows,
    noteLink: buildPortfolioNoteLink(treeId, nodeId),
  };
}

async function loadLatestClose({ ticker, updatedBy }) {
  const stockPriceResult = await getCachedOrFetchPriceHistory({
    ticker,
    days: 5,
    fetcher: fetchHistoricalClosingPrices,
    updatedBy,
  });
  const latestEntry = Array.isArray(stockPriceResult?.priceHistory)
    ? stockPriceResult.priceHistory[stockPriceResult.priceHistory.length - 1] ?? null
    : null;

  return latestEntry
    ? {
      ticker,
      currency: stockPriceResult.currency,
      date: latestEntry.date,
      close: latestEntry.close,
      cacheStatus: stockPriceResult.cacheStatus ?? null,
      providerRequests: Array.isArray(stockPriceResult.providerRequests)
        ? stockPriceResult.providerRequests
        : [],
    }
    : null;
}

function summarizePriceLookupSource(latestClose) {
  const providerRequests = Array.isArray(latestClose?.providerRequests)
    ? latestClose.providerRequests
    : [];
  const providerRequestCount = providerRequests.length;
  const cacheStatus = latestClose?.cacheStatus ?? null;
  const usedFetchedPrice = cacheStatus !== 'hit' || providerRequestCount > 0;

  return {
    cacheStatus,
    priceSource: cacheStatus === 'hit'
      ? 'cache'
      : usedFetchedPrice
        ? 'provider_fetch'
        : 'unknown',
    providerRequestCount,
    providerRequestReasons: providerRequests
      .map((request) => String(request?.reason ?? '').trim())
      .filter(Boolean),
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }

  const results = new Array(items.length);
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

export async function collectPortfolioHoldings({ treeId, entries, updatedBy = null, onStep = null }) {
  if (!treeId) {
    throw new Error('A personal cache tree id is required to collect portfolio holdings.');
  }

  const normalizedEntries = Array.isArray(entries)
    ? entries
      .map((entry) => ({
        ticker: normalizeTicker(entry?.ticker),
        shareCount: normalizeOptionalShareCount(entry?.shareCount),
        averagePurchasePrice: normalizeAveragePurchasePrice(entry?.averagePurchasePrice),
        returnSnapshot: normalizeReturnSnapshot(entry?.returnSnapshot),
      }))
      .filter((entry) => entry.ticker)
    : [];

  const actionableEntries = normalizedEntries.filter((entry) => entry.shareCount || entry.averagePurchasePrice || entry.returnSnapshot);

  if (actionableEntries.length === 0) {
    throw new Error('At least one ticker and one stored field among share count, average purchase price, or return is required for update_holdings.');
  }

  const hasReturnSnapshotUpdates = actionableEntries.some((entry) => entry.returnSnapshot && !entry.averagePurchasePrice);
  let usdToDkkRate = null;

  if (hasReturnSnapshotUpdates) {
    onStep?.('tool portfolio_stock_holdings exchange rate started', {
      mode: 'update_holdings',
    });
    try {
      usdToDkkRate = await getCachedOrFetchExchangeRate({
        baseCurrency: 'USD',
        quoteCurrency: 'DKK',
        updatedBy,
      });
      onStep?.('tool portfolio_stock_holdings exchange rate completed', {
        mode: 'update_holdings',
        rate: usdToDkkRate?.rate ?? null,
        cacheStatus: usdToDkkRate?.cacheStatus ?? null,
      });
    } catch (error) {
      onStep?.('tool portfolio_stock_holdings exchange rate failed', {
        mode: 'update_holdings',
      });
      throw new Error(`Return could not be stored because the USD to DKK exchange rate was unavailable: ${String(error?.message ?? error)}`);
    }
  }

  onStep?.('tool portfolio_stock_holdings load notes started', {
    mode: 'update_holdings',
  });
  const document = await loadPortfolioHoldingsDocument({ treeId });
  onStep?.('tool portfolio_stock_holdings load notes completed', {
    mode: 'update_holdings',
    existingRowCount: Array.isArray(document.rows) ? document.rows.length : 0,
  });
  const rows = document.rows.map((row) => ({ ...row }));
  const columns = normalizeColumns(document.columns);
  const rowsByTicker = buildTickerRowMap(rows);
  const addedOrUpdatedTickers = [];

  actionableEntries.forEach((entry) => {
    const existingRowIndex = rowsByTicker.get(entry.ticker);
    let targetRow;
    const normalizedReturnSnapshot = entry.returnSnapshot && !entry.averagePurchasePrice
      ? formatCollectedNumber(convertDkkToUsd(Number(entry.returnSnapshot), usdToDkkRate))
      : '';

    if (existingRowIndex === undefined) {
      targetRow = Object.fromEntries(columns.map((column) => [column, '']));
      rows.push(targetRow);
      rowsByTicker.set(entry.ticker, rows.length - 1);
    } else {
      targetRow = rows[existingRowIndex];
    }

    targetRow[PORTFOLIO_HOLDINGS_TICKER_HEADER] = entry.ticker;
    if (entry.shareCount) {
      targetRow[PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER] = entry.shareCount;
    }
    if (entry.averagePurchasePrice) {
      targetRow[PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER] = entry.averagePurchasePrice;
      targetRow[PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER] = '';
    } else if (entry.returnSnapshot) {
      targetRow[PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER] = '';
      targetRow[PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER] = normalizedReturnSnapshot;
    }

    addedOrUpdatedTickers.push(entry.ticker);
  });

  onStep?.('tool portfolio_stock_holdings save started', {
    mode: 'update_holdings',
    rowCount: rows.length,
  });
  const savedDocument = await savePortfolioHoldingsDocument({
    treeId,
    columns,
    rows,
    updatedBy,
  });
  onStep?.('tool portfolio_stock_holdings save completed', {
    mode: 'update_holdings',
    rowCount: savedDocument.rows.length,
  });

  return {
    output: {
      treeId: String(treeId),
      operation: 'update_holdings',
      currency: 'USD',
      pathSegments: buildPortfolioHoldingsPath(),
      columns: savedDocument.columns,
      rows: savedDocument.rows,
      addedOrUpdatedTickers,
      removedTickers: [],
      pricedTickers: [],
      skippedRows: [],
      totals: {
        pricedRowCount: 0,
        skippedRowCount: 0,
        totalPortfolioValue: 0,
        totalPortfolioValueDkk: 0,
        pricedTickerCount: 0,
      },
      noteLink: savedDocument.noteLink,
      fileLink: null,
      warnings: [],
    },
    debug: {
      exchangeRate: usdToDkkRate,
    },
  };
}

export async function removePortfolioHoldings({ treeId, entries, updatedBy = null, onStep = null }) {
  if (!treeId) {
    throw new Error('A personal cache tree id is required to remove portfolio holdings.');
  }

  const tickersToRemove = Array.isArray(entries)
    ? entries
      .map((entry) => normalizeTicker(entry?.ticker))
      .filter(Boolean)
    : [];

  if (tickersToRemove.length === 0) {
    throw new Error('At least one ticker is required for remove_holdings.');
  }

  onStep?.('tool portfolio_stock_holdings load notes started', {
    mode: 'remove_holdings',
  });
  const document = await loadPortfolioHoldingsDocument({ treeId });
  onStep?.('tool portfolio_stock_holdings load notes completed', {
    mode: 'remove_holdings',
    existingRowCount: Array.isArray(document.rows) ? document.rows.length : 0,
  });

  const requestedTickerSet = new Set(tickersToRemove);
  const removedTickers = [];
  const rows = document.rows.filter((row) => {
    const ticker = normalizeTicker(row?.[PORTFOLIO_HOLDINGS_TICKER_HEADER]);

    if (!requestedTickerSet.has(ticker)) {
      return true;
    }

    removedTickers.push(ticker);
    return false;
  });

  onStep?.('tool portfolio_stock_holdings save started', {
    mode: 'remove_holdings',
    rowCount: rows.length,
  });
  const savedDocument = await savePortfolioHoldingsDocument({
    treeId,
    columns: normalizeColumns(document.columns),
    rows,
    updatedBy,
  });
  onStep?.('tool portfolio_stock_holdings save completed', {
    mode: 'remove_holdings',
    rowCount: savedDocument.rows.length,
  });

  return {
    treeId: String(treeId),
    operation: 'remove_holdings',
    currency: 'USD',
    pathSegments: buildPortfolioHoldingsPath(),
    columns: savedDocument.columns,
    rows: savedDocument.rows,
    addedOrUpdatedTickers: [],
    removedTickers,
    pricedTickers: [],
    skippedRows: [],
    totals: {
      pricedRowCount: 0,
      skippedRowCount: 0,
      totalPortfolioValue: 0,
      totalPortfolioValueDkk: 0,
      pricedTickerCount: 0,
    },
    noteLink: savedDocument.noteLink,
    fileLink: null,
    warnings: removedTickers.length === tickersToRemove.length
      ? []
      : [
        `${tickersToRemove.length - removedTickers.length} requested ticker(s) were not present in the holdings notes.`,
      ],
  };
}

export async function refreshPortfolioHoldingsCalculations({ treeId, updatedBy = null, onStep = null }) {
  if (!treeId) {
    throw new Error('A personal cache tree id is required to refresh portfolio holdings calculations.');
  }

  onStep?.('tool portfolio_stock_holdings load notes started', {
    mode: 'refresh_calculations',
  });
  const document = await loadPortfolioHoldingsDocument({ treeId });
  onStep?.('tool portfolio_stock_holdings load notes completed', {
    mode: 'refresh_calculations',
    existingRowCount: Array.isArray(document.rows) ? document.rows.length : 0,
  });
  const rows = document.rows.map((row) => ({ ...row }));
  const columns = normalizeColumns(document.columns);
  const pricedTickers = [];
  const skippedRows = [];
  const priceLookups = [];
  const providerRequests = [];
  const warnings = [];
  let usdToDkkRate = null;
  let totalPortfolioValue = 0;
  let totalPortfolioValueDkk = 0;

  try {
    onStep?.('tool portfolio_stock_holdings exchange rate started');
    usdToDkkRate = await getCachedOrFetchExchangeRate({
      baseCurrency: 'USD',
      quoteCurrency: 'DKK',
      updatedBy,
    });
    onStep?.('tool portfolio_stock_holdings exchange rate completed', {
      rate: usdToDkkRate?.rate ?? null,
      cacheStatus: usdToDkkRate?.cacheStatus ?? null,
    });
  } catch {
    warnings.push('USD to DKK exchange rate could not be loaded. The value DKK column was left blank.');
    onStep?.('tool portfolio_stock_holdings exchange rate failed');
  }

  const validRows = [];

  for (const [rowIndex, row] of rows.entries()) {
    const normalizedTicker = normalizeTicker(row?.[PORTFOLIO_HOLDINGS_TICKER_HEADER]);
    const shareCount = Number(String(row?.[PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER] ?? '').trim());
    const averagePurchasePriceRaw = String(row?.[PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER] ?? '').trim();
    const averagePurchasePrice = averagePurchasePriceRaw
      ? Number(averagePurchasePriceRaw)
      : null;
    const returnSnapshotRaw = String(row?.[PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER] ?? '').trim();
    const returnSnapshot = returnSnapshotRaw
      ? Number(returnSnapshotRaw)
      : null;

    row[PORTFOLIO_HOLDINGS_TICKER_HEADER] = normalizedTicker;

    if (!normalizedTicker || !Number.isFinite(shareCount) || shareCount < 0) {
      row[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER] = '';
      skippedRows.push({
        rowNumber: rowIndex + 2,
        ticker: normalizedTicker || null,
        reason: 'invalid_ticker_or_share_count',
      });
      continue;
    }

    if (averagePurchasePriceRaw && (!Number.isFinite(averagePurchasePrice) || averagePurchasePrice < 0)) {
      warnings.push(`Row ${rowIndex + 2} has an invalid average purchase price. return (%) was left blank for that row.`);
    }

    if (returnSnapshotRaw && !Number.isFinite(returnSnapshot)) {
      warnings.push(`Row ${rowIndex + 2} has an invalid return. average purchase price could not be derived from that row.`);
    }

    validRows.push({
      row,
      rowIndex,
      normalizedTicker,
      shareCount,
      averagePurchasePrice,
      returnSnapshot,
    });
  }

  const lookupResults = await mapWithConcurrency(
    validRows,
    PORTFOLIO_HOLDINGS_PRICE_LOOKUP_CONCURRENCY,
    async ({ row, rowIndex, normalizedTicker, shareCount, averagePurchasePrice, returnSnapshot }) => {
      try {
        onStep?.('tool portfolio_stock_holdings price lookup started', {
          ticker: normalizedTicker,
          rowNumber: rowIndex + 2,
        });
        const latestClose = await loadLatestClose({ ticker: normalizedTicker, updatedBy });
        const priceLookupSource = summarizePriceLookupSource(latestClose);
        onStep?.('tool portfolio_stock_holdings price lookup completed', {
          ticker: normalizedTicker,
          rowNumber: rowIndex + 2,
          ...priceLookupSource,
        });

        return {
          row,
          rowIndex,
          normalizedTicker,
          shareCount,
          averagePurchasePrice,
          returnSnapshot,
          latestClose,
          priceLookupSource,
          failed: false,
        };
      } catch {
        onStep?.('tool portfolio_stock_holdings price lookup failed', {
          ticker: normalizedTicker,
          rowNumber: rowIndex + 2,
        });

        return {
          row,
          rowIndex,
          normalizedTicker,
          shareCount,
          averagePurchasePrice,
          returnSnapshot,
          latestClose: null,
          priceLookupSource: null,
          failed: true,
        };
      }
    },
  );

  for (const lookupResult of lookupResults) {
    const {
      row,
      rowIndex,
      normalizedTicker,
      shareCount,
      averagePurchasePrice,
      returnSnapshot,
      latestClose,
      priceLookupSource,
      failed,
    } = lookupResult;

    if (priceLookupSource) {
      priceLookups.push({
        ticker: normalizedTicker,
        ...priceLookupSource,
      });
    }

    if (Array.isArray(latestClose?.providerRequests)) {
      providerRequests.push(
        ...latestClose.providerRequests.map((request) => ({
          ticker: normalizedTicker,
          ...request,
        })),
      );
    }

    if (failed) {
      row[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER] = '';
      skippedRows.push({
        rowNumber: rowIndex + 2,
        ticker: normalizedTicker,
        reason: 'price_lookup_failed',
      });
      continue;
    }

    if (!latestClose || !Number.isFinite(latestClose.close)) {
      row[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER] = '';
      skippedRows.push({
        rowNumber: rowIndex + 2,
        ticker: normalizedTicker,
        reason: 'missing_latest_close',
      });
      continue;
    }

    const rowValue = shareCount * latestClose.close;
    const effectiveAveragePurchasePrice = Number.isFinite(averagePurchasePrice) && averagePurchasePrice > 0
      ? averagePurchasePrice
      : Number.isFinite(returnSnapshot) && shareCount > 0
        ? latestClose.close - (returnSnapshot / shareCount)
        : null;
    const recalculatedReturnSnapshot = Number.isFinite(effectiveAveragePurchasePrice) && effectiveAveragePurchasePrice > 0
      ? (latestClose.close - effectiveAveragePurchasePrice) * shareCount
      : null;

    if ((!Number.isFinite(averagePurchasePrice) || averagePurchasePrice <= 0) && Number.isFinite(effectiveAveragePurchasePrice) && effectiveAveragePurchasePrice > 0) {
      row[PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER] = formatCollectedNumber(effectiveAveragePurchasePrice);
    }
    if (Number.isFinite(recalculatedReturnSnapshot)) {
      row[PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER] = formatCollectedNumber(recalculatedReturnSnapshot);
    }

    row[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = String(latestClose.close);
    row[PORTFOLIO_HOLDINGS_VALUE_HEADER] = formatValue(rowValue);
    row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = usdToDkkRate
      ? formatValue(rowValue * usdToDkkRate.rate)
      : '';
    row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';
    row[PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER] = Number.isFinite(effectiveAveragePurchasePrice) && effectiveAveragePurchasePrice > 0
      ? formatPercentage(((latestClose.close - effectiveAveragePurchasePrice) / effectiveAveragePurchasePrice) * 100)
      : '';

    if ((!Number.isFinite(averagePurchasePrice) || averagePurchasePrice <= 0) && Number.isFinite(returnSnapshot) && (!Number.isFinite(effectiveAveragePurchasePrice) || effectiveAveragePurchasePrice <= 0)) {
      warnings.push(`Row ${rowIndex + 2} could not derive average purchase price from return because the computed value was not positive.`);
    }

    totalPortfolioValue += rowValue;
    if (usdToDkkRate) {
      totalPortfolioValueDkk += rowValue * usdToDkkRate.rate;
    }
    pricedTickers.push(normalizedTicker);
  }

  rows.forEach((row) => {
    const rowValue = Number(row?.[PORTFOLIO_HOLDINGS_VALUE_HEADER]);
    row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = totalPortfolioValue > 0 && Number.isFinite(rowValue)
      ? formatPercentage((rowValue / totalPortfolioValue) * 100)
      : '';
  });

  if (skippedRows.length > 0) {
    warnings.push(`${skippedRows.length} holding row(s) were skipped during calculation refresh.`);
  }

  if (rows.length === 0) {
    warnings.push('No holdings rows are stored yet. Add ticker rows first, and include share count before refreshing calculations that require pricing.');
  }

  const didChangeNotes = !document.hasStoredNotes || JSON.stringify(rows) !== JSON.stringify(document.rows);

  let savedDocument;

  if (didChangeNotes) {
    onStep?.('tool portfolio_stock_holdings save started', {
      mode: 'refresh_calculations',
      rowCount: rows.length,
    });
    savedDocument = await savePortfolioHoldingsDocument({
      treeId,
      columns,
      rows,
      updatedBy,
    });
    onStep?.('tool portfolio_stock_holdings save completed', {
      mode: 'refresh_calculations',
      rowCount: savedDocument.rows.length,
    });
  } else {
    savedDocument = {
      columns,
      rows,
      noteLink: document.noteLink,
    };
    onStep?.('tool portfolio_stock_holdings save skipped', {
      mode: 'refresh_calculations',
      reason: 'no_notes_changes',
      rowCount: rows.length,
    });
  }

  return {
    output: {
      treeId: String(treeId),
      operation: 'refresh_calculations',
      currency: 'USD',
      pathSegments: buildPortfolioHoldingsPath(),
      columns: savedDocument.columns,
      rows: savedDocument.rows,
      addedOrUpdatedTickers: [],
      removedTickers: [],
      pricedTickers,
      skippedRows,
      totals: {
        pricedRowCount: pricedTickers.length,
        skippedRowCount: skippedRows.length,
        totalPortfolioValue: Number(totalPortfolioValue.toFixed(2)),
        totalPortfolioValueDkk: Number(totalPortfolioValueDkk.toFixed(2)),
        pricedTickerCount: pricedTickers.length,
      },
      noteLink: savedDocument.noteLink,
      fileLink: null,
      warnings,
    },
    debug: {
      didChangeNotes,
      priceLookups,
      providerRequests,
      exchangeRate: usdToDkkRate,
    },
  };
}

function stringifyPortfolioHoldingsCsv({ columns, rows }) {
  const normalizedColumns = normalizeColumns(columns);
  const lines = [normalizedColumns.map((column) => escapeCsvCell(column)).join(',')];

  rows.forEach((row) => {
    lines.push(normalizedColumns.map((column) => escapeCsvCell(row?.[column] ?? '')).join(','));
  });

  return `${lines.join('\n')}\n`;
}

export async function exportPortfolioHoldingsCalculations({ treeId, updatedBy = null }) {
  if (!treeId) {
    throw new Error('A personal cache tree id is required to export portfolio holdings.');
  }

  const document = await loadPortfolioHoldingsDocument({ treeId });

  if (!document.hasStoredNotes) {
    throw new Error('Portfolio holdings JSON notes are missing. Save or refresh holdings before exporting calculations.');
  }

  const attachment = await replaceInvestmentLeafAttachment({
    treeId,
    pathSegments: buildPortfolioHoldingsPath(),
    fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
    contentType: CSV_CONTENT_TYPE,
    content: stringifyPortfolioHoldingsCsv(document),
    updatedBy,
    treeOptions: TREE_OPTIONS,
  });
  const pricedRows = document.rows.filter((row) => {
    const storedValue = String(row?.[PORTFOLIO_HOLDINGS_VALUE_HEADER] ?? '').trim();
    return storedValue !== '' && Number.isFinite(Number(storedValue));
  });
  const totalPortfolioValue = pricedRows.reduce((total, row) => total + Number(row[PORTFOLIO_HOLDINGS_VALUE_HEADER]), 0);
  const totalPortfolioValueDkk = pricedRows.reduce((total, row) => {
    const storedValueDkk = Number(row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER]);
    return total + (Number.isFinite(storedValueDkk) ? storedValueDkk : 0);
  }, 0);

  return {
    treeId: String(treeId),
    operation: 'export_calculations',
    currency: 'USD',
    pathSegments: buildPortfolioHoldingsPath(),
    columns: document.columns,
    rows: document.rows,
    addedOrUpdatedTickers: [],
    removedTickers: [],
    pricedTickers: pricedRows.map((row) => row[PORTFOLIO_HOLDINGS_TICKER_HEADER]),
    skippedRows: [],
    totals: {
      pricedRowCount: pricedRows.length,
      skippedRowCount: 0,
      totalPortfolioValue: Number(totalPortfolioValue.toFixed(2)),
      totalPortfolioValueDkk: Number(totalPortfolioValueDkk.toFixed(2)),
      pricedTickerCount: pricedRows.length,
    },
    noteLink: document.noteLink,
    fileLink: attachment.blobUrl ?? null,
    warnings: [],
  };
}