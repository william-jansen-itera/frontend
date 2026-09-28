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
const MARKET_TIME_ZONE = 'America/New_York';
const MARKET_CLOSE_MINUTES = 16 * 60;
const MARKET_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIME_ZONE,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

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

function getMarketDateTimeParts(date = new Date()) {
  const parts = MARKET_DATE_TIME_FORMATTER.formatToParts(date);

  return parts.reduce((result, part) => {
    if (part.type !== 'literal') {
      result[part.type] = part.value;
    }

    return result;
  }, {});
}

function getNthWeekdayOfMonth(year, monthIndex, weekday, occurrence) {
  const firstDayOfMonth = new Date(Date.UTC(year, monthIndex, 1));
  const firstWeekdayOffset = (7 + weekday - firstDayOfMonth.getUTCDay()) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + firstWeekdayOffset + ((occurrence - 1) * 7)));
}

function getLastWeekdayOfMonth(year, monthIndex, weekday) {
  const lastDayOfMonth = new Date(Date.UTC(year, monthIndex + 1, 0));
  const offset = (7 + lastDayOfMonth.getUTCDay() - weekday) % 7;
  return new Date(Date.UTC(year, monthIndex, lastDayOfMonth.getUTCDate() - offset));
}

function getObservedHolidayDate(year, monthIndex, dayOfMonth) {
  const holiday = new Date(Date.UTC(year, monthIndex, dayOfMonth));
  const dayOfWeek = holiday.getUTCDay();

  if (dayOfWeek === 6) {
    return shiftDays(holiday, -1);
  }

  if (dayOfWeek === 0) {
    return shiftDays(holiday, 1);
  }

  return holiday;
}

function getEasterSunday(year) {
  const century = Math.floor(year / 100);
  const yearInCentury = year % 100;
  const leapCentury = Math.floor(century / 4);
  const centuryRemainder = century % 4;
  const correction = Math.floor((century + 8) / 25);
  const adjustment = Math.floor((century - correction + 1) / 3);
  const goldenNumber = (19 * (year % 19) + century - leapCentury - adjustment + 15) % 30;
  const leapYearInCentury = Math.floor(yearInCentury / 4);
  const yearRemainder = yearInCentury % 4;
  const weekday = (32 + (2 * centuryRemainder) + (2 * leapYearInCentury) - goldenNumber - yearRemainder) % 7;
  const monthOffset = Math.floor((year % 19) + (11 * goldenNumber) + (22 * weekday) / 451);
  const month = Math.floor((goldenNumber + weekday - (7 * monthOffset) + 114) / 31);
  const day = ((goldenNumber + weekday - (7 * monthOffset) + 114) % 31) + 1;

  return new Date(Date.UTC(year, month - 1, day));
}

function getUsMarketHolidayKeys(year) {
  const holidayDates = [
    getObservedHolidayDate(year, 0, 1),
    getNthWeekdayOfMonth(year, 0, 1, 3),
    getNthWeekdayOfMonth(year, 1, 1, 3),
    shiftDays(getEasterSunday(year), -2),
    getLastWeekdayOfMonth(year, 4, 1),
    getObservedHolidayDate(year, 5, 19),
    getObservedHolidayDate(year, 6, 4),
    getNthWeekdayOfMonth(year, 8, 1, 1),
    getNthWeekdayOfMonth(year, 10, 4, 4),
    getObservedHolidayDate(year, 11, 25),
  ];

  return new Set(holidayDates.map((holidayDate) => formatDate(holidayDate)));
}

function isUsMarketHoliday(date) {
  const normalizedDate = parseIsoDate(date);

  if (!normalizedDate) {
    return false;
  }

  const year = normalizedDate.getUTCFullYear();
  const holidayKeys = new Set([
    ...getUsMarketHolidayKeys(year - 1),
    ...getUsMarketHolidayKeys(year),
    ...getUsMarketHolidayKeys(year + 1),
  ]);

  return holidayKeys.has(formatDate(normalizedDate));
}

function isTradingDay(date) {
  const normalizedDate = parseIsoDate(date);

  if (!normalizedDate) {
    return false;
  }

  const dayOfWeek = normalizedDate.getUTCDay();

  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return false;
  }

  return !isUsMarketHoliday(normalizedDate);
}

function findLatestTradingDayOnOrBefore(date) {
  let candidate = parseIsoDate(date);

  if (!candidate) {
    return null;
  }

  while (!isTradingDay(candidate)) {
    candidate = shiftDays(candidate, -1);
  }

  return candidate;
}

export function getLatestExpectedTradingCloseDate(date = new Date()) {
  const marketParts = getMarketDateTimeParts(date);
  const marketDate = `${marketParts.year}-${marketParts.month}-${marketParts.day}`;
  const marketDateObject = parseIsoDate(marketDate);

  if (!marketDateObject) {
    return null;
  }

  const marketMinutes = (Number.parseInt(marketParts.hour, 10) * 60) + Number.parseInt(marketParts.minute, 10);
  const isBeforeClose = Number.isFinite(marketMinutes) && marketMinutes < MARKET_CLOSE_MINUTES;
  const closingCandidate = isBeforeClose
    ? shiftDays(marketDateObject, -1)
    : marketDateObject;
  const latestTradingDay = findLatestTradingDayOnOrBefore(closingCandidate);

  return latestTradingDay ? formatDate(latestTradingDay) : null;
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
  const latestExpectedTradingCloseDate = getLatestExpectedTradingCloseDate();

  if (!latestDate || !calendarWindowStartDate || !earliestCachedDate || !latestExpectedTradingCloseDate) {
    return false;
  }

  const latestTime = new Date(latestDate).getTime();

  if (Number.isNaN(latestTime)) {
    return false;
  }

  return latestDate === latestExpectedTradingCloseDate
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