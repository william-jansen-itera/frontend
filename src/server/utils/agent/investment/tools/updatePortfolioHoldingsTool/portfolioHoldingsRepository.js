import {
  buildPortfolioHoldingsPath,
  PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER,
  PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
  PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER,
  PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER,
  PORTFOLIO_HOLDINGS_TICKER_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  readSingleInvestmentTextAttachmentByFileName,
  replaceInvestmentLeafAttachment,
} from '@/server/utils/agent/investment/investmentTreeRepository';
import { normalizeTicker } from '@/server/utils/agent/investment/tools/investmentToolShared';
import { fetchHistoricalClosingPrices } from '@/server/utils/agent/investment/tools/getStockPriceTool/historicalPriceProvider';
import { getCachedOrFetchPriceHistory } from '@/server/utils/agent/investment/tools/getStockPriceTool/stockPriceRepository';

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const TREE_OPTIONS = {
  allowPrivate: true,
  allowDescription: true,
  allowPublishedDescription: true,
};
const DERIVED_HEADERS = [
  PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_HEADER,
  PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER,
  PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER,
];
const PORTFOLIO_HOLDINGS_PRICE_LOOKUP_CONCURRENCY = 4;

const USD_TO_DKK_RATE_URL = 'https://api.frankfurter.dev/v2/rate/usd/dkk';

function escapeCsvCell(value) {
  const normalizedValue = String(value ?? '');

  if (!/[",\r\n]/.test(normalizedValue)) {
    return normalizedValue;
  }

  return `"${normalizedValue.replace(/"/g, '""')}"`;
}

function parseCsvLine(line) {
  const cells = [];
  let currentCell = '';
  let isQuoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const nextCharacter = line[index + 1];

    if (character === '"') {
      if (isQuoted && nextCharacter === '"') {
        currentCell += '"';
        index += 1;
        continue;
      }

      isQuoted = !isQuoted;
      continue;
    }

    if (character === ',' && !isQuoted) {
      cells.push(currentCell);
      currentCell = '';
      continue;
    }

    currentCell += character;
  }

  cells.push(currentCell);

  return cells;
}

function normalizeColumns(columns) {
  const seenColumns = new Set();
  const normalizedColumns = [];

  columns.forEach((column) => {
    const normalizedColumn = String(column ?? '').trim();

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

  DERIVED_HEADERS.forEach((header) => {
    if (!seenColumns.has(header)) {
      seenColumns.add(header);
      normalizedColumns.push(header);
    }
  });

  return normalizedColumns;
}

function parsePortfolioHoldingsCsv(text) {
  const normalizedText = String(text ?? '').trim();
  const lines = normalizedText ? normalizedText.split(/\r?\n/) : [];
  const rawColumns = lines.length > 0
    ? parseCsvLine(lines[0]).map((column) => String(column ?? '').trim())
    : [PORTFOLIO_HOLDINGS_TICKER_HEADER, PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER];
  const columns = normalizeColumns(rawColumns);
  const rows = lines.slice(1)
    .filter((line) => line.length > 0)
    .map((line) => {
      const values = parseCsvLine(line);
      const row = {};

      columns.forEach((column, index) => {
        row[column] = String(values[index] ?? '');
      });

      return row;
    });

  return {
    columns,
    rows,
  };
}

function stringifyPortfolioHoldingsCsv({ columns, rows }) {
  const normalizedColumns = normalizeColumns(columns);
  const lines = [normalizedColumns.map((column) => escapeCsvCell(column)).join(',')];

  rows.forEach((row) => {
    const line = normalizedColumns
      .map((column) => escapeCsvCell(row?.[column] ?? ''))
      .join(',');

    lines.push(line);
  });

  return `${lines.join('\n')}\n`;
}

function createEmptyPortfolioHoldingsDocument() {
  return stringifyPortfolioHoldingsCsv({
    columns: [PORTFOLIO_HOLDINGS_TICKER_HEADER, PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER],
    rows: [],
  });
}

function normalizeShareCount(value) {
  const parsedValue = Number(String(value ?? '').trim());

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    throw new Error(`Share count must be a non-negative number. Received: ${value ?? ''}`);
  }

  return String(parsedValue);
}

function formatValue(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '';
}

function formatPercentage(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : '';
}

async function loadUsdToDkkRate() {
  const response = await fetch(USD_TO_DKK_RATE_URL, {
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`USD to DKK rate request failed (${response.status}).`);
  }

  const payload = await response.json();
  const rate = Number(payload?.rate);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error('USD to DKK rate response did not contain a valid rate.');
  }

  return {
    base: String(payload?.base ?? 'USD').trim() || 'USD',
    quote: String(payload?.quote ?? 'DKK').trim() || 'DKK',
    date: String(payload?.date ?? '').trim() || null,
    rate,
    provider: 'frankfurter',
    url: USD_TO_DKK_RATE_URL,
  };
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

async function ensurePortfolioHoldingsFile({ treeId, updatedBy }) {
  const pathSegments = buildPortfolioHoldingsPath();
  const existingDocument = await readSingleInvestmentTextAttachmentByFileName({
    treeId,
    pathSegments,
    fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
    treeOptions: TREE_OPTIONS,
  });

  if (existingDocument) {
    return {
      attachment: existingDocument.attachment,
      fileLink: existingDocument.attachment?.blobUrl ?? null,
      ...parsePortfolioHoldingsCsv(existingDocument.text),
    };
  }

  const createdDocument = await replaceInvestmentLeafAttachment({
    treeId,
    pathSegments,
    fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
    contentType: CSV_CONTENT_TYPE,
    content: createEmptyPortfolioHoldingsDocument(),
    updatedBy,
    treeOptions: TREE_OPTIONS,
  });

  return {
    attachment: createdDocument,
    fileLink: createdDocument.blobUrl ?? null,
    columns: normalizeColumns([PORTFOLIO_HOLDINGS_TICKER_HEADER, PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER]),
    rows: [],
  };
}

async function savePortfolioHoldingsDocument({ treeId, columns, rows, updatedBy }) {
  const serializedCsv = stringifyPortfolioHoldingsCsv({ columns, rows });

  const savedAttachment = await replaceInvestmentLeafAttachment({
    treeId,
    pathSegments: buildPortfolioHoldingsPath(),
    fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
    contentType: CSV_CONTENT_TYPE,
    content: serializedCsv,
    updatedBy,
    treeOptions: TREE_OPTIONS,
  });

  return {
    columns: normalizeColumns(columns),
    rows,
    fileLink: savedAttachment.blobUrl ?? null,
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
        shareCount: normalizeShareCount(entry?.shareCount),
      }))
      .filter((entry) => entry.ticker)
    : [];

  if (normalizedEntries.length === 0) {
    throw new Error('At least one ticker and share count pair is required for update_holdings.');
  }

  onStep?.('tool update_portfolio_stock_holdings ensure file started', {
    mode: 'update_holdings',
  });
  const document = await ensurePortfolioHoldingsFile({ treeId, updatedBy });
  onStep?.('tool update_portfolio_stock_holdings ensure file completed', {
    mode: 'update_holdings',
    existingRowCount: Array.isArray(document.rows) ? document.rows.length : 0,
  });
  const rows = document.rows.map((row) => ({ ...row }));
  const columns = normalizeColumns(document.columns);
  const rowsByTicker = buildTickerRowMap(rows);
  const addedOrUpdatedTickers = [];

  normalizedEntries.forEach((entry) => {
    const existingRowIndex = rowsByTicker.get(entry.ticker);
    let targetRow;

    if (existingRowIndex === undefined) {
      targetRow = Object.fromEntries(columns.map((column) => [column, '']));
      rows.push(targetRow);
      rowsByTicker.set(entry.ticker, rows.length - 1);
    } else {
      targetRow = rows[existingRowIndex];
    }

    targetRow[PORTFOLIO_HOLDINGS_TICKER_HEADER] = entry.ticker;
    targetRow[PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER] = entry.shareCount;
    targetRow[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = '';
    targetRow[PORTFOLIO_HOLDINGS_VALUE_HEADER] = '';
    targetRow[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = '';
    targetRow[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';

    addedOrUpdatedTickers.push(entry.ticker);
  });

  onStep?.('tool update_portfolio_stock_holdings save started', {
    mode: 'update_holdings',
    rowCount: rows.length,
  });
  const savedDocument = await savePortfolioHoldingsDocument({
    treeId,
    columns,
    rows,
    updatedBy,
  });
  onStep?.('tool update_portfolio_stock_holdings save completed', {
    mode: 'update_holdings',
    rowCount: savedDocument.rows.length,
  });

  return {
    treeId: String(treeId),
    operation: 'update_holdings',
    currency: 'USD',
    fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
    pathSegments: buildPortfolioHoldingsPath(),
    columns: savedDocument.columns,
    rows: savedDocument.rows,
    addedOrUpdatedTickers,
    pricedTickers: [],
    skippedRows: [],
    totals: {
      pricedRowCount: 0,
      skippedRowCount: 0,
      totalPortfolioValue: 0,
      totalPortfolioValueDkk: 0,
      pricedTickerCount: 0,
    },
    fileLink: savedDocument.fileLink,
    warnings: [],
  };
}

export async function refreshPortfolioHoldingsCalculations({ treeId, updatedBy = null, onStep = null }) {
  if (!treeId) {
    throw new Error('A personal cache tree id is required to refresh portfolio holdings calculations.');
  }

  onStep?.('tool update_portfolio_stock_holdings ensure file started', {
    mode: 'refresh_calculations',
  });
  const document = await ensurePortfolioHoldingsFile({ treeId, updatedBy });
  onStep?.('tool update_portfolio_stock_holdings ensure file completed', {
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
    onStep?.('tool update_portfolio_stock_holdings exchange rate started');
    usdToDkkRate = await loadUsdToDkkRate();
    onStep?.('tool update_portfolio_stock_holdings exchange rate completed', {
      rate: usdToDkkRate?.rate ?? null,
    });
  } catch {
    warnings.push('USD to DKK exchange rate could not be loaded. The value DKK column was left blank.');
    onStep?.('tool update_portfolio_stock_holdings exchange rate failed');
  }

  const validRows = [];

  for (const [rowIndex, row] of rows.entries()) {
    const normalizedTicker = normalizeTicker(row?.[PORTFOLIO_HOLDINGS_TICKER_HEADER]);
    const shareCount = Number(String(row?.[PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER] ?? '').trim());

    row[PORTFOLIO_HOLDINGS_TICKER_HEADER] = normalizedTicker;

    if (!normalizedTicker || !Number.isFinite(shareCount) || shareCount < 0) {
      row[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = '';
      row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';
      skippedRows.push({
        rowNumber: rowIndex + 2,
        ticker: normalizedTicker || null,
        reason: 'invalid_ticker_or_share_count',
      });
      continue;
    }

    validRows.push({
      row,
      rowIndex,
      normalizedTicker,
      shareCount,
    });
  }

  const lookupResults = await mapWithConcurrency(
    validRows,
    PORTFOLIO_HOLDINGS_PRICE_LOOKUP_CONCURRENCY,
    async ({ row, rowIndex, normalizedTicker, shareCount }) => {
      try {
        onStep?.('tool update_portfolio_stock_holdings price lookup started', {
          ticker: normalizedTicker,
          rowNumber: rowIndex + 2,
        });
        const latestClose = await loadLatestClose({ ticker: normalizedTicker, updatedBy });
        const priceLookupSource = summarizePriceLookupSource(latestClose);
        onStep?.('tool update_portfolio_stock_holdings price lookup completed', {
          ticker: normalizedTicker,
          rowNumber: rowIndex + 2,
          ...priceLookupSource,
        });

        return {
          row,
          rowIndex,
          normalizedTicker,
          shareCount,
          latestClose,
          priceLookupSource,
          failed: false,
        };
      } catch {
        onStep?.('tool update_portfolio_stock_holdings price lookup failed', {
          ticker: normalizedTicker,
          rowNumber: rowIndex + 2,
        });

        return {
          row,
          rowIndex,
          normalizedTicker,
          shareCount,
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
      skippedRows.push({
        rowNumber: rowIndex + 2,
        ticker: normalizedTicker,
        reason: 'missing_latest_close',
      });
      continue;
    }

    const rowValue = shareCount * latestClose.close;
    row[PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER] = String(latestClose.close);
    row[PORTFOLIO_HOLDINGS_VALUE_HEADER] = formatValue(rowValue);
    row[PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER] = usdToDkkRate
      ? formatValue(rowValue * usdToDkkRate.rate)
      : '';
    row[PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER] = '';
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
    warnings.push('No holdings rows are stored yet. Add ticker and share count pairs first.');
  }

  onStep?.('tool update_portfolio_stock_holdings save started', {
    mode: 'refresh_calculations',
    rowCount: rows.length,
  });
  const savedDocument = await savePortfolioHoldingsDocument({
    treeId,
    columns,
    rows,
    updatedBy,
  });
  onStep?.('tool update_portfolio_stock_holdings save completed', {
    mode: 'refresh_calculations',
    rowCount: savedDocument.rows.length,
  });

  return {
    output: {
      treeId: String(treeId),
      operation: 'refresh_calculations',
      currency: 'USD',
      fileName: PORTFOLIO_HOLDINGS_CSV_FILE_NAME,
      pathSegments: buildPortfolioHoldingsPath(),
      columns: savedDocument.columns,
      rows: savedDocument.rows,
      addedOrUpdatedTickers: [],
      pricedTickers,
      skippedRows,
      totals: {
        pricedRowCount: pricedTickers.length,
        skippedRowCount: skippedRows.length,
        totalPortfolioValue: Number(totalPortfolioValue.toFixed(2)),
        totalPortfolioValueDkk: Number(totalPortfolioValueDkk.toFixed(2)),
        pricedTickerCount: pricedTickers.length,
      },
      fileLink: savedDocument.fileLink,
      warnings,
    },
    debug: {
      priceLookups,
      providerRequests,
      exchangeRate: usdToDkkRate,
    },
  };
}