import { NextResponse } from 'next/server';
import { invokeTreeSearchAgent } from '@/server/utils/chatService';
import { logException, logTrace } from '@/server/utils/logging';

export const runtime = 'nodejs';

function parseClientPrincipal(request) {
  const encodedPrincipal = request.headers.get('x-ms-client-principal');

  if (!encodedPrincipal) {
    return null;
  }

  try {
    const payload = Buffer.from(encodedPrincipal, 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .map((entry) => ({
      role: entry?.role === 'assistant' ? 'assistant' : 'user',
      content: String(entry?.content ?? '').trim(),
    }))
    .filter((entry) => entry.content);
}

export async function POST(request) {
  try {
    const payload = await request.json();
    const message = String(payload?.message ?? '').trim();

    if (!message) {
      return NextResponse.json(
        { error: 'A non-empty message is required.' },
        { status: 400 },
      );
    }

    const history = normalizeHistory(payload?.history);
    const principal = parseClientPrincipal(request);
    const result = await invokeTreeSearchAgent({
      message,
      history,
      principal,
    });

    await logTrace(
      JSON.stringify({
        event: 'hosted_agent_invoke_success',
        agentName: result.agent.name,
        toolNames: result.toolsUsed,
        userDetails: principal?.userDetails ?? null,
      }),
    );

    return NextResponse.json(result);
  } catch (error) {
    await logException(error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Hosted agent request failed',
      },
      { status: 500 },
    );
  }
}