// src/app/api/hello/route.js
import { NextResponse } from 'next/server';
import { confirmSqlIsResponsive, isLikelySleepingSqlError } from '@/server/utils/sql';
import { getRelevantPrincipalDetails, requireAuthenticatedPrincipal } from '@/server/utils/auth';

export async function GET(request) {
  const { logTrace, logException } = await import('../../../server/utils/logging');
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const principalDetails = getRelevantPrincipalDetails(principal);
    let userName = 'Authenticated User';

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

    const sqlResult = await confirmSqlIsResponsive();
    const databaseName = sqlResult.recordset[0]?.databaseName || 'configured database';

    return NextResponse.json({
      level: 'ok',
      message: `Ok.`, //${databaseName}
      userName,
    });
  } catch (err) {
    if (Number(err?.status) === 401) {
      return NextResponse.json({ message: 'Authentication is required.' }, { status: 401 });
    }

    logException(err);

    if (isLikelySleepingSqlError(err)) {
      return NextResponse.json({
        level: 'warning',
        message: 'System is waking up, please check back in a minute.',
        userName: 'Authenticated User',
      });
    }

    return NextResponse.json({
      level: 'error',
      message: 'Next API ok. DB connection failed.',
      userName: 'Authenticated User',
    });
  }
}