import {
  buildExchangeRatePath,
  getRequiredInvestmentPersistenceTreeId,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  assertConfiguredInvestmentTree,
  readInvestmentLeafNotes,
  replaceInvestmentLeafNotes,
} from '@/server/utils/agent/investment/investmentTreeRepository';

const EXCHANGE_RATE_CACHE_MAX_AGE_DAYS = 5;
const EXCHANGE_RATE_PROVIDER = 'frankfurter';
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
    provider: EXCHANGE_RATE_PROVIDER,
    url: EXCHANGE_RATE_PROVIDER_URL,
  };
}

async function loadCachedExchangeRate(treeId, baseCurrency, quoteCurrency) {
  const storedNotes = await readInvestmentLeafNotes({
    treeId,
    pathSegments: buildExchangeRatePath(baseCurrency, quoteCurrency),
  });

  if (!storedNotes?.notes) {
    return null;
  }

  let entry;

  try {
    entry = JSON.parse(storedNotes.notes);
  } catch {
    throw new Error('Exchange rate notes contain invalid JSON; no rate was changed.');
  }

  if (entry?.base !== baseCurrency || entry?.quote !== quoteCurrency || !entry.date || !Number.isFinite(entry.rate) || entry.rate <= 0) {
    throw new Error('Exchange rate notes have an unexpected format; no rate was changed.');
  }

  return {
    base: entry.base,
    quote: entry.quote,
    date: entry.date,
    rate: entry.rate,
    provider: EXCHANGE_RATE_PROVIDER,
    url: EXCHANGE_RATE_PROVIDER_URL,
  };
}

export async function getCachedOrFetchExchangeRate({ baseCurrency = 'USD', quoteCurrency = 'DKK', updatedBy = null } = {}) {
  const normalizedBaseCurrency = normalizeCurrencyCode(baseCurrency, 'USD');
  const normalizedQuoteCurrency = normalizeCurrencyCode(quoteCurrency, 'DKK');

  if (normalizedBaseCurrency !== 'USD' || normalizedQuoteCurrency !== 'DKK') {
    throw new Error(`Unsupported exchange rate pair: ${normalizedBaseCurrency}/${normalizedQuoteCurrency}.`);
  }

  const treeId = getRequiredInvestmentPersistenceTreeId();
  await assertConfiguredInvestmentTree(treeId);

  const existingEntry = await loadCachedExchangeRate(treeId, normalizedBaseCurrency, normalizedQuoteCurrency);

  if (isExchangeRateFreshEnough(existingEntry)) {
    return {
      ...existingEntry,
      cacheStatus: 'hit',
      providerRequests: [],
    };
  }

  const fetchedEntry = await fetchUsdToDkkRate();
  const rateChanged = existingEntry?.date !== fetchedEntry.date || existingEntry?.rate !== fetchedEntry.rate;

  if (rateChanged) {
    const { base, quote, date, rate } = fetchedEntry;
    await replaceInvestmentLeafNotes({
      treeId,
      pathSegments: buildExchangeRatePath(normalizedBaseCurrency, normalizedQuoteCurrency),
      notes: JSON.stringify({ base, quote, date, rate }, null, 2),
      updatedBy,
    });
  }

  return {
    ...fetchedEntry,
    cacheStatus: existingEntry
      ? (rateChanged ? 'refreshed' : 'validated')
      : 'created',
    providerRequests: [
      {
        reason: 'stale_refresh',
        url: EXCHANGE_RATE_PROVIDER_URL,
      },
    ],
  };
}