function buildNasdaqHistoricalUrl({ ticker, fromDate, toDate }) {
  const url = new URL(`https://api.nasdaq.com/api/quote/${ticker}/historical`);
  url.searchParams.set('assetclass', 'stocks');
  url.searchParams.set('fromdate', fromDate);
  url.searchParams.set('todate', toDate);
  url.searchParams.set('limit', '9999');
  url.searchParams.set('random', String(Math.floor(Math.random() * 1000) + 1));
  return url.toString();
}

function normalizeNasdaqClose(rawClose) {
  const normalizedValue = Number(
    String(rawClose ?? '')
      .replace(/\$/g, '')
      .replace(/,/g, '')
      .trim(),
  );

  return Number.isFinite(normalizedValue) ? normalizedValue : null;
}

function normalizeNasdaqDate(rawDate) {
  const normalizedValue = String(rawDate ?? '').trim();

  if (!normalizedValue) {
    return null;
  }

  const numericDateMatch = normalizedValue.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (numericDateMatch) {
    const month = numericDateMatch[1].padStart(2, '0');
    const day = numericDateMatch[2].padStart(2, '0');
    const year = numericDateMatch[3];

    return `${year}-${month}-${day}`;
  }

  const parsedDate = new Date(normalizedValue);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return parsedDate.toISOString().slice(0, 10);
}

function parseNasdaqHistoricalRows(rows) {
  if (!Array.isArray(rows)) {
    return [];
  }

  return rows
    .map((row) => {
      const date = normalizeNasdaqDate(row?.date ?? row?.Date);
      const close = normalizeNasdaqClose(row?.close ?? row?.Close ?? row?.lastSalePrice ?? row?.['Close/Last']);

      if (!date || !Number.isFinite(close)) {
        return null;
      }

      return { date, close };
    })
    .filter(Boolean)
    .sort((leftEntry, rightEntry) => leftEntry.date.localeCompare(rightEntry.date));
}

export async function fetchHistoricalClosingPrices({ ticker, fromDate, toDate }) {
  const normalizedTicker = String(ticker ?? '').trim().toUpperCase();

  if (!normalizedTicker) {
    throw new Error('Ticker is required to fetch historical closing prices.');
  }

  const response = await fetch(buildNasdaqHistoricalUrl({ ticker: normalizedTicker, fromDate, toDate }), {
    headers: {
      'user-agent': 'Mozilla/5.0',
      accept: 'application/json, text/plain, */*',
      origin: 'https://www.nasdaq.com',
      referer: 'https://www.nasdaq.com/',
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Historical price request failed for ${normalizedTicker} (${response.status}).`);
  }

  const payload = await response.json();
  const rows = payload?.data?.tradesTable?.rows;
  const priceHistory = parseNasdaqHistoricalRows(rows);

  if (priceHistory.length === 0) {
    throw new Error(`Historical price provider returned no closing-price rows for ${normalizedTicker}.`);
  }

  return priceHistory;
}