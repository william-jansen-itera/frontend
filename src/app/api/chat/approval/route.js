import { NextResponse } from 'next/server';
import { claimAgentApproval } from '@/server/utils/agent/agentActionApprovalRepository';
import { resumeEmailAgentApproval } from '@/server/utils/agent/email/emailAgentService';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import { logException } from '@/server/utils/logging';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const principal = requireAuthenticatedPrincipal(request);
    const origin = request.headers.get('origin');

    if (origin && origin !== new URL(request.url).origin) {
      return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
    }

    const body = await request.json();
    const id = String(body?.id ?? '').trim();
    const decision = body?.decision;

    if (!['approve', 'cancel'].includes(decision) || !/^[0-9a-f-]{36}$/i.test(id)) {
      return NextResponse.json({ error: 'Invalid approval request.' }, { status: 400 });
    }

    const record = await claimAgentApproval({ id, principal, decision });

    if (!record) {
      return NextResponse.json({ error: 'Approval expired, was already decided, or does not belong to this user.' }, { status: 409 });
    }

    const includeDebug = ['true', '1', 'yes', 'on'].includes(String(process.env.APPLICATION_DEBUG ?? '').trim().toLowerCase());
    return NextResponse.json(await resumeEmailAgentApproval({ principal, id, decision, record, includeDebug }));
  } catch (error) {
    await logException(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Approval failed. Check the email state before retrying.' }, {
      status: error?.status ?? 500,
    });
  }
}