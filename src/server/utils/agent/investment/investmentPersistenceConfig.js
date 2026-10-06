export const INVESTMENT_PERSISTENCE_TREE_ID_ENV = 'INVESTMENT_PERSISTENCE_TREE_ID';

export const VOLATILITY_GENERAL_ENGINE_PATH = Object.freeze([
  'Volatility harvesting',
  'Configuration',
  'General',
  'Engine',
]);

export const VOLATILITY_INDIVIDUAL_CONFIG_ROOT_PATH = Object.freeze([
  'Volatility harvesting',
  'Configuration',
  'Individual',
]);

export const VOLATILITY_ANALYSIS_ROOT_PATH = Object.freeze([
  'Volatility harvesting',
  'Analyses',
]);

export const STOCK_PRICE_DATA_ROOT_PATH = Object.freeze([
  'Stock prices',
  'Data',
]);

export const EXCHANGE_RATE_DATA_ROOT_PATH = Object.freeze([
  'Exchange rates',
  'Data',
]);

export const PORTFOLIO_HOLDINGS_PATH = Object.freeze([
  'Portfolio',
  'Holdings',
  'Stocks',
  'List',
]);

export const VOLATILITY_GENERAL_ENGINE_FILE_NAME = 'engine-settings.yaml';
export const VOLATILITY_TICKER_ENGINE_FILE_NAME = 'ticker-settings.yaml';
export const VOLATILITY_ANALYSIS_LOG_FILE_NAME = 'closing-price-recommendations.log';
export const VOLATILITY_ANALYSIS_STATE_FILE_NAME = 'closing-price-recommendations.json';
export const VOLATILITY_CONFIG_EXTENSION = '.yaml';
export const STOCK_PRICE_CSV_FILE_NAME = 'closing-prices.csv';
export const EXCHANGE_RATE_CSV_FILE_NAME = 'exchange-rate.csv';
export const PORTFOLIO_HOLDINGS_CSV_FILE_NAME = 'Portfolio stock holdings.csv';
export const PORTFOLIO_HOLDINGS_TICKER_HEADER = 'ticker';
export const PORTFOLIO_HOLDINGS_SHARE_COUNT_HEADER = 'share count';
export const PORTFOLIO_HOLDINGS_AVERAGE_PURCHASE_PRICE_HEADER = 'average purchase price';
export const PORTFOLIO_HOLDINGS_RETURN_SNAPSHOT_HEADER = 'return';
export const PORTFOLIO_HOLDINGS_CLOSING_PRICE_HEADER = 'closing price';
export const PORTFOLIO_HOLDINGS_VALUE_HEADER = 'value';
export const PORTFOLIO_HOLDINGS_VALUE_DKK_HEADER = 'value DKK';
export const PORTFOLIO_HOLDINGS_PERCENTAGE_HEADER = 'percentage';
export const PORTFOLIO_HOLDINGS_RETURN_PERCENTAGE_HEADER = 'return (%)';
export const DEFAULT_MAX_HISTORY_DAYS = 365;

export function getRequiredInvestmentPersistenceTreeId() {
  const rawValue = String(process.env[INVESTMENT_PERSISTENCE_TREE_ID_ENV] ?? '').trim();

  if (!rawValue) {
    throw new Error(`Environment variable ${INVESTMENT_PERSISTENCE_TREE_ID_ENV} is required for investment persistence.`);
  }

  const parsedValue = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`Environment variable ${INVESTMENT_PERSISTENCE_TREE_ID_ENV} must be a positive integer tree id.`);
  }

  return parsedValue;
}

export function buildVolatilityTickerConfigPath(ticker) {
  return [...VOLATILITY_INDIVIDUAL_CONFIG_ROOT_PATH, String(ticker ?? '').trim().toUpperCase()];
}

export function buildVolatilityAnalysisPath(ticker) {
  return [
    ...VOLATILITY_ANALYSIS_ROOT_PATH,
    'Closing price recommendations',
    String(ticker ?? '').trim().toUpperCase(),
  ];
}

export function buildStockPricePath(ticker) {
  return [...STOCK_PRICE_DATA_ROOT_PATH, 'Closing prices', String(ticker ?? '').trim().toUpperCase()];
}

export function buildExchangeRatePath(baseCurrency = 'USD', quoteCurrency = 'DKK') {
  const normalizedBaseCurrency = String(baseCurrency ?? '').trim().toUpperCase() || 'USD';
  const normalizedQuoteCurrency = String(quoteCurrency ?? '').trim().toUpperCase() || 'DKK';

  return [...EXCHANGE_RATE_DATA_ROOT_PATH, 'Recent', `${normalizedBaseCurrency}/${normalizedQuoteCurrency}`];
}

export function buildPortfolioHoldingsPath() {
  return [...PORTFOLIO_HOLDINGS_PATH];
}