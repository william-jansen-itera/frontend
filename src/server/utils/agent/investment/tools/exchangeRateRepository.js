import {
  buildExchangeRatePath,
  EXCHANGE_RATE_CSV_FILE_NAME,
  getRequiredInvestmentPersistenceTreeId,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  assertConfiguredInvestmentTree,
  readSingleInvestmentTextAttachmentByFileName,
  replaceInvestmentLeafAttachment,
} from '@/server/utils/agent/investment/investmentTreeRepository';

const CSV_CONTENT_TYPE = 'text/csv; charset=utf-8';
const EXCHANGE_RATE_CACHE_MAX_AGE_DAYS = 5;
const EXCHANGE_RATE_PROVIDER_URL = 'https://api.frankfurter.dev/v2/rate/usd/dkk';

function normalizeCurrencyCode(currencyCode, fallbackCurrencyCode) {
  return String(currencyCode ?? '').trim().toUpperCase() || fallbackCurrencyCode;
}

function formatUtcDate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function subtractUtcDays(date, days) {
  const nextDate = new Date(date);
  nextDate.setUTCDate(nextDate.getUTCDate() - days);
  return nextDate;
}

function buildPairLabel(baseCurrency, quoteCurrency) {
  return `${baseCurrency}/${quoteCurrency}`;
}

function parseExchangeRateCsv(text, pairLabel) {
  const trimmedText = String(text ?? '').trim();

  if (!trimmedText) {
    return null;
  }

  const lines = trimmedText.split(/\r?\n/).filter(Boolean);
  const lastRow = lines[lines.length - 1] ?? '';
  const [datePart, ratePart] = lastRow.split(',');
  const date = String(datePart ?? '').trim();
  const rate = Number(String(ratePart ?? '').trim());

  if (!date || !Number.isFinite(rate) || rate <= 0) {
    return null;
  }

  const [baseCurrency = 'USD', quoteCurrency = 'DKK'] = pairLabel.split('/');

  return {
    base: baseCurrency,
    quote: quoteCurrency,
    date,
    rate,
    provider: 'frankfurter',
    url: EXCHANGE_RATE_PROVIDER_URL,
  };
}

function stringifyExchangeRateCsv(entry, pairLabel) {
  return `Date,${pairLabel}\n${entry.date},${entry.rate}\n`;
}

function isExchangeRateFreshEnough(entry) {
  if (!entry?.date || !Number.isFinite(entry?.rate) || entry.rate <= 0) {
    return false;
  }

  const freshnessThresholdDate = formatUtcDate(subtractUtcDays(new Date(), EXCHANGE_RATE_CACHE_MAX_AGE_DAYS));
  return entry.date >= freshnessThresholdDate;
}

async function fetchUsdToDkkRate() {
  const response = await fetch(EXCHANGE_RATE_PROVIDER_URL, {
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
    base: normalizeCurrencyCode(payload?.base, 'USD'),
    quote: normalizeCurrencyCode(payload?.quote, 'DKK'),
    date: String(payload?.date ?? '').trim() || formatUtcDate(new Date()),
    rate,
    provider: 'frankfurter',
    url: EXCHANGE_RATE_PROVIDER_URL,
  };
}

async function loadCachedExchangeRate(treeId, baseCurrency, quoteCurrency) {
  const pairLabel = buildPairLabel(baseCurrency, quoteCurrency);
  const existingDocument = await readSingleInvestmentTextAttachmentByFileName({
    treeId,
    pathSegments: buildExchangeRatePath(baseCurrency, quoteCurrency),
    fileName: EXCHANGE_RATE_CSV_FILE_NAME,
  });

  if (!existingDocument) {
    return null;
  }

  return parseExchangeRateCsv(existingDocument.text, pairLabel);
}

export async function getCachedOrFetchExchangeRate({ baseCurrency = 'USD', quoteCurrency = 'DKK', updatedBy = null } = {}) {
  const normalizedBaseCurrency = normalizeCurrencyCode(baseCurrency, 'USD');
  const normalizedQuoteCurrency = normalizeCurrencyCode(quoteCurrency, 'DKK');

  if (normalizedBaseCurrency !== 'USD' || normalizedQuoteCurrency !== 'DKK') {
    throw new Error(`Unsupported exchange rate pair: ${normalizedBaseCurrency}/${normalizedQuoteCurrency}.`);
  }

  const treeId = getRequiredInvestmentPersistenceTreeId();
  await assertConfiguredInvestmentTree(treeId);

  const pairLabel = buildPairLabel(normalizedBaseCurrency, normalizedQuoteCurrency);
  const existingEntry = await loadCachedExchangeRate(treeId, normalizedBaseCurrency, normalizedQuoteCurrency);

  if (isExchangeRateFreshEnough(existingEntry)) {
    return {
      ...existingEntry,
      cacheStatus: 'hit',
      providerRequests: [],
    };
  }

  const fetchedEntry = await fetchUsdToDkkRate();
  const existingCsv = existingEntry ? stringifyExchangeRateCsv(existingEntry, pairLabel) : '';
  const fetchedCsv = stringifyExchangeRateCsv(fetchedEntry, pairLabel);

  if (existingCsv !== fetchedCsv) {
    await replaceInvestmentLeafAttachment({
      treeId,
      pathSegments: buildExchangeRatePath(normalizedBaseCurrency, normalizedQuoteCurrency),
      fileName: EXCHANGE_RATE_CSV_FILE_NAME,
      contentType: CSV_CONTENT_TYPE,
      content: fetchedCsv,
      updatedBy,
    });
  }

  return {
    ...fetchedEntry,
    cacheStatus: existingEntry
      ? (existingCsv !== fetchedCsv ? 'refreshed' : 'validated')
      : 'created',
    providerRequests: [
      {
        reason: 'stale_refresh',
        url: EXCHANGE_RATE_PROVIDER_URL,
      },
    ],
  };
}