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

const CALENDAR_WINDOW_START_TOLERANCE_DAYS = 5;

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function shiftDays(date, offsetDays) {
  const shiftedDate = new Date(date);
  shiftedDate.setUTCDate(shiftedDate.getUTCDate() + offsetDays);
  return shiftedDate;
}

function parseIsoDate(value) {
  const normalizedValue = String(value ?? '').trim();

  if (!normalizedValue) {
    return null;
  }

  const parsedDate = new Date(`${normalizedValue}T00:00:00.000Z`);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate;
}

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

function isOneDayBehind(leftDate, rightDate) {
  const leftParsedDate = parseIsoDate(leftDate);
  const rightParsedDate = parseIsoDate(rightDate);

  if (!leftParsedDate || !rightParsedDate) {
    return false;
  }

  return formatDate(shiftDays(leftParsedDate, 1)) === formatDate(rightParsedDate);
}

function isWindowCoveredWithinTolerance(earliestCachedDate, calendarWindowStartDate) {
  if (!earliestCachedDate || !calendarWindowStartDate) {
    return false;
  }

  const toleratedWindowStartDate = shiftDays(calendarWindowStartDate, CALENDAR_WINDOW_START_TOLERANCE_DAYS);

  return earliestCachedDate <= toleratedWindowStartDate;
}

function isCacheFreshEnough(priceHistory, days) {
  if (!Array.isArray(priceHistory) || priceHistory.length === 0) {
    return false;
  }

  const calendarWindowStartDate = buildCalendarWindowStartDate(priceHistory, days);
  const earliestCachedDate = parseIsoDate(priceHistory[0]?.date);
  const latestDate = priceHistory[priceHistory.length - 1]?.date;

  if (!latestDate || !calendarWindowStartDate || !earliestCachedDate) {
    return false;
  }

  const latestTime = new Date(latestDate).getTime();

  if (Number.isNaN(latestTime)) {
    return false;
  }

  return latestDate === formatDate(new Date())
    && isWindowCoveredWithinTolerance(earliestCachedDate, calendarWindowStartDate);
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
  return parseCsv(downloadedAttachment.content.toString('utf8'));
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
  const needsHistoryBackfill = !earliestCachedDate
    || !existingCalendarWindowStartDate
    || !isWindowCoveredWithinTolerance(earliestCachedDate, existingCalendarWindowStartDate);
  const fetchStartDate = needsHistoryBackfill || !incrementalStartDate
    ? fallbackStartDate
    : incrementalStartDate;
  let fetchedHistory = await fetcher({
    ticker: normalizedTicker,
    fromDate: fetchStartDate,
    toDate: fetchEndDate,
  });
  const latestFetchedDate = fetchedHistory[fetchedHistory.length - 1]?.date ?? null;

  if (existingHistory.length > 0 && isOneDayBehind(latestCachedDate, latestFetchedDate)) {
    const repairStartDate = fallbackStartDate;

    fetchedHistory = await fetcher({
      ticker: normalizedTicker,
      fromDate: repairStartDate,
      toDate: fetchEndDate,
    });
  }

  const mergedHistory = mergePriceHistory(existingHistory, fetchedHistory);

  if (mergedHistory.length === 0) {
    throw new Error(`No closing-price history is available for ${normalizedTicker}.`);
  }

  const existingCsv = stringifyCsv(existingHistory);
  const mergedCsv = stringifyCsv(mergedHistory);

  if (existingCsv !== mergedCsv) {
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
    cacheStatus: existingHistory.length > 0 ? 'refreshed' : 'created',
  };
}