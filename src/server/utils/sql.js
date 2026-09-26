import mssql from 'mssql';

const sql = mssql;

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

const SQL_STATUS_PROBE_QUERY = `
  SELECT DB_NAME() AS databaseName, SYSUTCDATETIME() AS serverUtcTime;
`;

function getSqlConnection() {
  if (!sqlConnectionPromise) {
    sqlConnectionPromise = sql.connect(config).catch((error) => {
      sqlConnectionPromise = undefined;
      throw error;
    });
  }

  return sqlConnectionPromise;
}

export async function withSqlConnection(callback) {
  await getSqlConnection();
  return callback();
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