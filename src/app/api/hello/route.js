// src/app/api/hello/route.js
import { NextResponse } from 'next/server';
import { sql, withSqlConnection } from '@/server/utils/sql';

function isLikelySleepingSqlError(error) {
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

export async function GET(request) {
  const { logTrace, logException } = await import('../../../server/utils/logging');
  // Try to get the x-ms-client-principal header
  const principalHeader = request.headers.get('x-ms-client-principal');
  let userName = 'Anonymous';
  if (principalHeader) {
    try {
      const principal = JSON.parse(Buffer.from(principalHeader, 'base64').toString('utf8'));
      console.log('principal: ', principal);
      logTrace('Parsed principal: ' + JSON.stringify(principal));
      userName = principal.userDetails || 'Authenticated User';
    } catch (err) {
      logException(err);
      userName = 'Invalid principal';
    }
  }

  try {
    const sqlResult = await withSqlConnection(async () => new sql.Request().query(`
      SELECT DB_NAME() AS databaseName, SYSUTCDATETIME() AS serverUtcTime;
    `));
    const databaseName = sqlResult.recordset[0]?.databaseName || 'configured database';

    return NextResponse.json({
      level: 'ok',
      message: `Next API ok. DB ok.`, //${databaseName}
      userName,
    });
  } catch (err) {
    logException(err);

    if (isLikelySleepingSqlError(err)) {
      return NextResponse.json({
        level: 'warning',
        message: 'Next API ok. System is waking up, please check back in a minute.',
        userName,
      });
    }

    return NextResponse.json({
      level: 'error',
      message: 'Next API ok. DB connection failed.',
      userName,
    });
  }
}