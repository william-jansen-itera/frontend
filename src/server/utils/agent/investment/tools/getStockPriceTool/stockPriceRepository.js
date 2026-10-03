import { downloadNodeAttachmentBlob } from '@/server/utils/blobStorage';
import {
  buildStockPricePath,
  getRequiredInvestmentPersistenceTreeId,
  STOCK_PRICE_CSV_FILE_NAME,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  assertConfiguredInvestmentTree,
  ensureInvestmentTreePath,
  listInvestmentLeafAttachments,
  replaceInvestmentLeafAttachment,
} from '@/server/utils/agent/investment/investmentTreeRepository';
import {
  formatDate,
  getLatestExpectedTradingCloseDate,
  parseIsoDate,
  shiftDays,
} from '@/server/utils/agent/investment/tradingCalendar';

const CALENDAR_WINDOW_START_TOLERANCE_DAYS = 5;

function normalizeDays(days) {
  const parsedValue = Number.parseInt(days, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return 5;
  }

  return Math.min(parsedValue, 365);
}

function parseCsv(text) {
  const trimmedText = String(text ?? '').trim();

  if (!trimmedText) {
    return [];
  }

  const lines = trimmedText.split(/\r?\n/).filter(Boolean);

  return lines.slice(1)
    .map((line) => {
      const [datePart, closePart] = line.split(',');
      const date = String(datePart ?? '').trim();
      const close = Number(String(closePart ?? '').trim());

      if (!date || !Number.isFinite(close)) {
        return null;
      }

      return { date, close };
    })
    .filter(Boolean)
    .sort((leftEntry, rightEntry) => leftEntry.date.localeCompare(rightEntry.date));
}

function stringifyCsv(priceHistory) {
  const lines = ['Date,Close'];

  priceHistory.forEach((entry) => {
    lines.push(`${entry.date},${entry.close}`);
  });

  return `${lines.join('\n')}\n`;
}

function mergePriceHistory(existingHistory, incomingHistory) {
  const mergedByDate = new Map();

  [...existingHistory, ...incomingHistory].forEach((entry) => {
    if (!entry?.date || !Number.isFinite(entry?.close)) {
      return;
    }

    mergedByDate.set(entry.date, {
      date: entry.date,
      close: Number(entry.close),
    });
  });

  return [...mergedByDate.values()].sort((leftEntry, rightEntry) => leftEntry.date.localeCompare(rightEntry.date));
}

function buildCalendarWindowStartDate(priceHistory, days) {
  const latestDate = parseIsoDate(priceHistory[priceHistory.length - 1]?.date);

  if (!latestDate) {
    return null;
  }

  return shiftDays(latestDate, -(days - 1));
}

function sliceRecentHistory(priceHistory, days) {
  if (!Array.isArray(priceHistory) || priceHistory.length === 0) {
    return [];
  }

  const calendarWindowStartDate = buildCalendarWindowStartDate(priceHistory, days);

  if (!calendarWindowStartDate) {
    return [];
  }

  return priceHistory.filter((entry) => {
    const entryDate = parseIsoDate(entry?.date);

    return entryDate && entryDate >= calendarWindowStartDate;
  });
}

function doesCachedWindowStartCoverRequestedRange(earliestCachedDate, requiredWindowStartDate) {
  if (!earliestCachedDate || !requiredWindowStartDate) {
    return false;
  }

  const toleratedWindowStartDate = shiftDays(requiredWindowStartDate, CALENDAR_WINDOW_START_TOLERANCE_DAYS);

  return earliestCachedDate <= toleratedWindowStartDate;
}

function isCacheFreshEnough(priceHistory, days) {
  if (!Array.isArray(priceHistory) || priceHistory.length === 0) {
    return false;
  }

  const calendarWindowStartDate = buildCalendarWindowStartDate(priceHistory, days);
  const earliestCachedDate = parseIsoDate(priceHistory[0]?.date);
  const latestCachedDate = parseIsoDate(priceHistory[priceHistory.length - 1]?.date);
  const latestExpectedTradingCloseDate = parseIsoDate(getLatestExpectedTradingCloseDate());

  if (!calendarWindowStartDate || !earliestCachedDate || !latestCachedDate || !latestExpectedTradingCloseDate) {
    return false;
  }

  // Fresh means two separate conditions are true:
  // 1. the cache reaches the latest trading close that should exist by now, and
  // 2. the cache starts early enough to cover the requested calendar window,
  //    allowing a small 5-day tolerance at the window start.
  return latestCachedDate >= latestExpectedTradingCloseDate
    && doesCachedWindowStartCoverRequestedRange(earliestCachedDate, calendarWindowStartDate);
}

async function loadCachedPriceHistory(treeId, ticker) {
  const attachments = await listInvestmentLeafAttachments({
    treeId,
    pathSegments: buildStockPricePath(ticker),
  });
  const matchingAttachment = attachments.find((attachment) => String(attachment.fileName ?? '').trim().toLowerCase() === STOCK_PRICE_CSV_FILE_NAME);

  if (!matchingAttachment) {
    return [];
  }

  const downloadedAttachment = await downloadNodeAttachmentBlob(matchingAttachment.blobName);
  const primaryHistory = parseCsv(downloadedAttachment.content.toString('utf8'));

  return primaryHistory ?? [];
}

export async function loadStoredPriceHistory(ticker) {
  const normalizedTicker = String(ticker ?? '').trim().toUpperCase();

  if (!normalizedTicker) {
    throw new Error('Ticker is required to load stored stock prices.');
  }

  const treeId = getRequiredInvestmentPersistenceTreeId();
  await assertConfiguredInvestmentTree(treeId);

  return loadCachedPriceHistory(treeId, normalizedTicker);
}

export async function getCachedOrFetchPriceHistory({ ticker, days, fetcher, updatedBy = null }) {
  const normalizedTicker = String(ticker ?? '').trim().toUpperCase();

  if (!normalizedTicker) {
    throw new Error('Ticker is required to load stock prices.');
  }

  const normalizedDays = normalizeDays(days);
  const treeId = getRequiredInvestmentPersistenceTreeId();
  await assertConfiguredInvestmentTree(treeId);

  const existingHistory = await loadCachedPriceHistory(treeId, normalizedTicker);

  if (isCacheFreshEnough(existingHistory, normalizedDays)) {
    return {
      ticker: normalizedTicker,
      days: normalizedDays,
      currency: 'USD',
      priceHistory: sliceRecentHistory(existingHistory, normalizedDays),
      cacheStatus: 'hit',
      providerRequests: [],
    };
  }

  const fetchEndDate = formatDate(new Date());
  const fallbackStartDate = formatDate(shiftDays(new Date(), -(normalizedDays - 1)));
  const latestCachedDate = existingHistory[existingHistory.length - 1]?.date ?? null;
  const incrementalStartDate = latestCachedDate
    ? formatDate(shiftDays(new Date(latestCachedDate), -5))
    : null;
  const earliestCachedDate = parseIsoDate(existingHistory[0]?.date);
  const existingCalendarWindowStartDate = buildCalendarWindowStartDate(existingHistory, normalizedDays);

  // This is a different 5-day rule from the start-of-window tolerance above.
  // When we do need a provider refresh, we overlap the request by 5 days to make
  // merges less brittle around missing or revised provider rows.
  const needsHistoryBackfill = !earliestCachedDate
    || !existingCalendarWindowStartDate
    || !doesCachedWindowStartCoverRequestedRange(earliestCachedDate, existingCalendarWindowStartDate);
  const fetchStartDate = needsHistoryBackfill || !incrementalStartDate
    ? fallbackStartDate
    : incrementalStartDate;
  const providerRequests = [];
  let fetchResult = await fetcher({
    ticker: normalizedTicker,
    fromDate: fetchStartDate,
    toDate: fetchEndDate,
  });
  let fetchedHistory = Array.isArray(fetchResult)
    ? fetchResult
    : Array.isArray(fetchResult?.priceHistory)
      ? fetchResult.priceHistory
      : [];

  if (fetchResult?.request) {
    providerRequests.push({
      reason: needsHistoryBackfill || !incrementalStartDate ? 'window_backfill' : 'incremental_refresh',
      ...fetchResult.request,
    });
  }

  const mergedHistory = mergePriceHistory(existingHistory, fetchedHistory);

  if (mergedHistory.length === 0) {
    throw new Error(`No closing-price history is available for ${normalizedTicker}.`);
  }

  const existingCsv = stringifyCsv(existingHistory);
  const mergedCsv = stringifyCsv(mergedHistory);
  const didUpdateStoredCsv = existingCsv !== mergedCsv;

  if (didUpdateStoredCsv) {
    await ensureInvestmentTreePath({
      treeId,
      pathSegments: buildStockPricePath(normalizedTicker),
    });
    await replaceInvestmentLeafAttachment({
      treeId,
      pathSegments: buildStockPricePath(normalizedTicker),
      fileName: STOCK_PRICE_CSV_FILE_NAME,
      contentType: 'text/csv; charset=utf-8',
      content: mergedCsv,
      updatedBy,
    });
  }

  return {
    ticker: normalizedTicker,
    days: normalizedDays,
    currency: 'USD',
    priceHistory: sliceRecentHistory(mergedHistory, normalizedDays),
    cacheStatus: existingHistory.length > 0
      ? (didUpdateStoredCsv
        ? 'refreshed'
        : 'validated')
      : 'created',
    providerRequests,
  };
}
