// src/app/api/hello/route.js
import { NextResponse } from 'next/server';
import { confirmSqlIsResponsive, isLikelySleepingSqlError } from '@/server/utils/sql';
import { getRelevantPrincipalDetails, parseClientPrincipal } from '@/server/utils/auth';

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
    const sqlResult = await confirmSqlIsResponsive();
    const databaseName = sqlResult.recordset[0]?.databaseName || 'configured database';

    return NextResponse.json({
      level: 'ok',
      message: `Ok.`, //${databaseName}
      userName,
    });
  } catch (err) {
    logException(err);

    if (isLikelySleepingSqlError(err)) {
      return NextResponse.json({
        level: 'warning',
        message: 'System is waking up, please check back in a minute.',
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