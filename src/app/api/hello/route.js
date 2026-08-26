// src/app/api/hello/route.js
import { NextResponse } from 'next/server';
import { sql, withSqlConnection } from '@/server/utils/sql';
import { getRelevantPrincipalDetails, parseClientPrincipal } from '@/server/utils/auth';

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
  const principal = parseClientPrincipal(request);
  const principalDetails = getRelevantPrincipalDetails(principal);
  let userName = 'Anonymous';

  if (principalDetails) {
    await logTrace(`Parsed principal: ${JSON.stringify({
      identityProvider: principalDetails.identityProvider,
      userId: principalDetails.userId,
      userDetails: principalDetails.userDetails,
      userRoles: principalDetails.userRoles,
      tenantId: principalDetails.tenantId,
      objectId: principalDetails.objectId,
    })}`);
    userName = principalDetails.userDetails || 'Authenticated User';
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