import { NextResponse } from 'next/server';
import { logException, logTrace } from '@/server/utils/logging';
import {
  getEntraObjectIdFromRoleSourcePayload,
  resolveRolesFromRoleSourcePayload,
} from '@/server/utils/swaRoleMapping';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getSafeAuditDetails(payload) {
  return {
    identityProvider: payload?.identityProvider ?? null,
    userDetails: payload?.userDetails ?? null,
    objectId: getEntraObjectIdFromRoleSourcePayload(payload),
  };
}

export async function POST(request) {
  let payload = null;

  try {
    payload = await request.json();
  } catch {
    await logTrace('rolesSource received invalid JSON payload.');
    return NextResponse.json({ roles: [] }, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }

  try {
    const roles = await resolveRolesFromRoleSourcePayload(payload);
    await logTrace(`rolesSource resolved roles: ${JSON.stringify({ ...getSafeAuditDetails(payload), roles })}`);

    return NextResponse.json({ roles }, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    await logException(error);
    await logTrace(`rolesSource failed closed: ${JSON.stringify(getSafeAuditDetails(payload))}`);

    return NextResponse.json({ roles: [] }, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }
}