import mssql from 'mssql';

const sql = mssql;
const DEFAULT_SQL_IDLE_CLOSE_MS = 300_000;

const config = {
  user: process.env.AZURE_SQL_USER,
  password: process.env.AZURE_SQL_PASSWORD,
  server: process.env.AZURE_SQL_SERVER,
  database: process.env.AZURE_SQL_DATABASE,
  applicationIdentifier: process.env.APPLICATION_IDENTIFIER,
  options: {
    encrypt: process.env.AZURE_SQL_ENCRYPT === 'true',
    trustServerCertificate: false,
  },
};

let sqlConnectionPromise;
let sqlIdleCloseTimer;
let sqlActiveOperationCount = 0;
let sqlConnectionGeneration = 0;

const SQL_STATUS_PROBE_QUERY = `
  SELECT DB_NAME() AS databaseName, SYSUTCDATETIME() AS serverUtcTime;
`;

function getSqlIdleCloseMs() {
  const configuredValue = Number.parseInt(String(process.env.AZURE_SQL_IDLE_CLOSE_MS ?? ''), 10);

  return Number.isFinite(configuredValue) && configuredValue >= 0
    ? configuredValue
    : DEFAULT_SQL_IDLE_CLOSE_MS;
}

function clearSqlIdleCloseTimer() {
  if (!sqlIdleCloseTimer) {
    return;
  }

  clearTimeout(sqlIdleCloseTimer);
  sqlIdleCloseTimer = undefined;
}

function scheduleSqlIdleClose() {
  clearSqlIdleCloseTimer();

  if (!sqlConnectionPromise || sqlActiveOperationCount > 0) {
    return;
  }

  const idleCloseMs = getSqlIdleCloseMs();

  if (idleCloseMs < 0) {
    return;
  }

  const scheduledGeneration = sqlConnectionGeneration;
  sqlIdleCloseTimer = setTimeout(async () => {
    if (sqlActiveOperationCount > 0 || !sqlConnectionPromise || scheduledGeneration !== sqlConnectionGeneration) {
      return;
    }

    const activeConnectionPromise = sqlConnectionPromise;
    sqlConnectionPromise = undefined;
    clearSqlIdleCloseTimer();

    try {
      await activeConnectionPromise;
      await sql.close();
    } catch {
      sqlConnectionPromise = undefined;
    }
  }, idleCloseMs);
}

function getSqlConnection() {
  clearSqlIdleCloseTimer();

  if (!sqlConnectionPromise) {
    sqlConnectionGeneration += 1;
    sqlConnectionPromise = sql.connect(config).catch((error) => {
      sqlConnectionPromise = undefined;
      throw error;
    });
  }

  return sqlConnectionPromise;
}

export async function withSqlConnection(callback) {
  const connection = await getSqlConnection();
  sqlActiveOperationCount += 1;

  try {
    return await callback(connection);
  } finally {
    sqlActiveOperationCount = Math.max(0, sqlActiveOperationCount - 1);
    scheduleSqlIdleClose();
  }
}

export function isLikelySleepingSqlError(error) {
  const message = String(
    error?.message
      || error?.originalError?.message
      || error?.precedingErrors?.[0]?.message
      || '',
  ).toLowerCase();
  const code = String(error?.code || error?.originalError?.code || '').toLowerCase();

  return [
    'timeout',
    'timed out',
    'connection timeout',
    'handshake inactivity timeout',
    'login timeout',
    'server was not found or was not accessible',
    'the database is not currently available',
    'resuming',
    'warming up',
    'paused',
    'sleep',
  ].some((fragment) => message.includes(fragment)) || ['etimeout', 'esocket'].includes(code);
}

export async function confirmSqlIsResponsive() {
  return withSqlConnection(async () => new sql.Request().query(SQL_STATUS_PROBE_QUERY));
}

export function getRequiredApplicationIdentifier() {
  if (!config.applicationIdentifier) {
    throw new Error('Application identifier env var is not configured');
  }

  return config.applicationIdentifier;
}

export { sql };