import { NextResponse } from 'next/server';
import { logException } from '@/server/utils/logging';
import { getPageVisitCounterDimensions, incrementPageVisitCounter } from '@/server/utils/pageVisitAnalytics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function getRequestErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallbackMessage;
}

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => null);
    const pagePath = String(payload?.pagePath ?? '').trim();
    const dimensions = getPageVisitCounterDimensions(request, pagePath);

    if (!dimensions) {
      return NextResponse.json({
        status: 'ignored',
      });
    }

    const result = await incrementPageVisitCounter(dimensions);

    return NextResponse.json(result, {
      status: 202,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    await logException(error);

    const errorMessage = getRequestErrorMessage(error, 'Page visit analytics failed');
    const isValidationError = errorMessage === 'Unsupported page path';

    return NextResponse.json({
      error: errorMessage,
    }, {
      status: isValidationError ? 400 : 500,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  }
}