import {
  DEFAULT_MAX_HISTORY_DAYS,
  VOLATILITY_GENERAL_ENGINE_PATH,
  buildVolatilityTickerConfigPath,
  getRequiredInvestmentPersistenceTreeId,
} from '@/server/utils/agent/investment/investmentPersistenceConfig';
import {
  readInvestmentLeafNotes,
  replaceInvestmentLeafNotes,
} from '@/server/utils/agent/investment/investmentTreeRepository';

const DEFAULT_GENERAL_VOLATILITY_CONFIG = Object.freeze({
  max_rotations: 3,
  rotation_size: 0.25,
  use_ma_gate: true,
  ma_period: 200,
  max_history_days: DEFAULT_MAX_HISTORY_DAYS,
});

const DEFAULT_TICKER_VOLATILITY_CONFIG = Object.freeze({
  start_share_count: 20,
  volatility_threshold: 0.06,
});

function normalizeInteger(value, keyName, { minimum = 0, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) {
      return null;
    }

    throw new Error(`Configuration value ${keyName} is required.`);
  }

  const normalizedValue = Number.parseInt(value, 10);

  if (!Number.isInteger(normalizedValue) || normalizedValue < minimum) {
    throw new Error(`Configuration value ${keyName} must be an integer greater than or equal to ${minimum}.`);
  }

  return normalizedValue;
}

function normalizeNumber(value, keyName, { minimum = Number.NEGATIVE_INFINITY, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) {
      return null;
    }

    throw new Error(`Configuration value ${keyName} is required.`);
  }

  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue < minimum) {
    throw new Error(`Configuration value ${keyName} must be a number greater than or equal to ${minimum}.`);
  }

  return normalizedValue;
}

function validateRotationSizing({ rotationSize, startShareCount }) {
  if (!(rotationSize > 0)) {
    throw new Error('Configuration value rotation_size must be greater than 0.');
  }

  if (!Number.isInteger(startShareCount) || startShareCount < 1) {
    throw new Error('Configuration value start_share_count must be an integer greater than or equal to 1.');
  }

  if (!(startShareCount > (1 / rotationSize))) {
    throw new Error('Configuration value start_share_count must be greater than 1 / rotation_size to guarantee non-zero triggered rotations.');
  }
}

function normalizeBoolean(value, keyName, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  if (normalizedValue === 'true') {
    return true;
  }

  if (normalizedValue === 'false') {
    return false;
  }

  throw new Error(`Configuration value ${keyName} must be a boolean.`);
}

function parseJsonDocument(text, label) {
  try {
    const parsedDocument = JSON.parse(text);

    if (!parsedDocument || typeof parsedDocument !== 'object' || Array.isArray(parsedDocument)) {
      throw new Error(`${label} must contain a JSON object.`);
    }

    return parsedDocument;
  } catch (error) {
    throw new Error(`${label} could not be parsed: ${error instanceof Error ? error.message : 'Unknown JSON parse error.'}`);
  }
}

async function ensureVolatilityConfigDocument({
  treeId,
  pathSegments,
  requiredLabel,
  defaultDocument,
}) {
  const storedNotes = await readInvestmentLeafNotes({ treeId, pathSegments });
  if (storedNotes?.notes) {
    return {
      document: parseJsonDocument(storedNotes.notes, requiredLabel),
      source: 'existing',
    };
  }

  await replaceInvestmentLeafNotes({
    treeId,
    pathSegments,
    notes: JSON.stringify(defaultDocument, null, 2),
  });

  return {
    document: defaultDocument,
    source: 'created',
  };
}

export async function loadVolatilityRuntimeConfig(ticker) {
  const normalizedTicker = String(ticker ?? '').trim().toUpperCase();

  if (!normalizedTicker) {
    throw new Error('A ticker is required to load volatility configuration.');
  }

  const treeId = getRequiredInvestmentPersistenceTreeId();
  const generalDocument = await ensureVolatilityConfigDocument({
    treeId,
    pathSegments: VOLATILITY_GENERAL_ENGINE_PATH,
    requiredLabel: 'General engine configuration',
    defaultDocument: DEFAULT_GENERAL_VOLATILITY_CONFIG,
  });
  const tickerDocument = await ensureVolatilityConfigDocument({
    treeId,
    pathSegments: buildVolatilityTickerConfigPath(normalizedTicker),
    requiredLabel: `${normalizedTicker} ticker configuration`,
    defaultDocument: DEFAULT_TICKER_VOLATILITY_CONFIG,
  });
  const generalConfig = generalDocument.document;
  const tickerConfig = tickerDocument.document;
  const effectiveConfig = {
    ...generalConfig,
    ...tickerConfig,
  };
  const volatilityThresholdValue = tickerConfig.volatility_threshold
    ?? generalConfig.volatility_threshold;
  const useMaGate = normalizeBoolean(effectiveConfig.use_ma_gate, 'use_ma_gate', false);
  const maPeriod = effectiveConfig.ma_period === undefined || effectiveConfig.ma_period === null || effectiveConfig.ma_period === ''
    ? null
    : normalizeInteger(effectiveConfig.ma_period, 'ma_period', { minimum: 1, required: false });

  if (useMaGate && !Number.isInteger(maPeriod)) {
    throw new Error('Configuration value ma_period is required when use_ma_gate is enabled.');
  }

  const rotationSize = normalizeNumber(effectiveConfig.rotation_size, 'rotation_size', { minimum: 0 });
  const startShareCount = normalizeInteger(effectiveConfig.start_share_count, 'start_share_count', { minimum: 0 });

  validateRotationSizing({
    rotationSize,
    startShareCount,
  });

  return {
    ticker: normalizedTicker,
    maxRotations: normalizeInteger(effectiveConfig.max_rotations, 'max_rotations', { minimum: 1 }),
    rotationSize,
    useMaGate,
    maPeriod,
    maxHistoryDays: effectiveConfig.max_history_days === undefined || effectiveConfig.max_history_days === null || effectiveConfig.max_history_days === ''
      ? DEFAULT_MAX_HISTORY_DAYS
      : normalizeInteger(effectiveConfig.max_history_days, 'max_history_days', { minimum: 1 }),
    volatilityThreshold: normalizeNumber(volatilityThresholdValue, 'volatility_threshold', { minimum: 0 }),
    startShareCount,
    raw: {
      sources: {
        general: generalDocument.source,
        ticker: tickerDocument.source,
      },
      general: generalConfig,
      ticker: tickerConfig,
      effective: effectiveConfig,
    },
  };
}