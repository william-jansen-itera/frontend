import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import { getPageVisitAnalyticsSummary } from '@/server/utils/pageVisitAnalytics';
import { hasClientPrincipalRole } from '@/shared/clientPrincipal';

function assertAdminPrincipal(principal) {
  if (!hasClientPrincipalRole(principal, 'mdsadmins')) {
    throw new Error('Admin role mdsadmins is required');
  }
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);

    assertAdminPrincipal(principal);

    const summary = await getPageVisitAnalyticsSummary();

    return NextResponse.json(summary, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    const status = error?.message === 'Admin role mdsadmins is required' ? 403 : 500;

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Analytics could not be loaded',
      },
      { status },
    );
  }
}