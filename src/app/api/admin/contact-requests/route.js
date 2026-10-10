import { NextResponse } from 'next/server';
import { logException } from '@/server/utils/logging';
import { listRecentContactRequests } from '@/server/utils/contactRequestRepository';

export async function GET() {
  try {
    return NextResponse.json({
      requests: await listRecentContactRequests(),
    });
  } catch (error) {
    await logException(error);

    return NextResponse.json(
      { error: 'Contact requests could not be loaded right now.' },
      { status: 500 },
    );
  }
}