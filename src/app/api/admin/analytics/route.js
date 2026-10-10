import { NextResponse } from 'next/server';
import { getPageVisitAnalyticsSummary } from '@/server/utils/pageVisitAnalytics';

export async function GET() {
  try {
    const summary = await getPageVisitAnalyticsSummary();

    return NextResponse.json(summary, {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Analytics could not be loaded',
      },
      { status: 500 },
    );
  }
}