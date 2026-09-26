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

export const VOLATILITY_GENERAL_ENGINE_FILE_NAME = 'engine-settings.yaml';
export const VOLATILITY_TICKER_ENGINE_FILE_NAME = 'ticker-settings.yaml';
export const VOLATILITY_ANALYSIS_LOG_FILE_NAME = 'closing-price-recommendations.log';
export const VOLATILITY_ANALYSIS_STATE_FILE_NAME = 'closing-price-recommendations.json';
export const VOLATILITY_CONFIG_EXTENSION = '.yaml';
export const STOCK_PRICE_CSV_FILE_NAME = 'closing-prices.csv';
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
  return [...VOLATILITY_ANALYSIS_ROOT_PATH, String(ticker ?? '').trim().toUpperCase(), 'Closing price recommendations'];
}

export function buildStockPricePath(ticker) {
  return [...STOCK_PRICE_DATA_ROOT_PATH, String(ticker ?? '').trim().toUpperCase(), 'Closing prices'];
}