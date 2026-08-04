import * as sql from 'mssql';

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

export function getRequiredApplicationIdentifier() {
  if (!config.applicationIdentifier) {
    throw new Error('Application identifier env var is not configured');
  }

  return config.applicationIdentifier;
}

export { sql };