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

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function shiftDays(date, offsetDays) {
  const shiftedDate = new Date(date);
  shiftedDate.setUTCDate(shiftedDate.getUTCDate() + offsetDays);
  return shiftedDate;
}

export function parseIsoDate(value) {
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