import { NextResponse } from 'next/server';
import { publishStoredTreeDescriptions, syncHostedAgent } from '@/server/utils/chatService';
import { logException, logTrace } from '@/server/utils/logging';

export const runtime = 'nodejs';

function getRequiredSyncToken() {
  return String(process.env.AZURE_AI_AGENT_SYNC_TOKEN || '').trim();
}

function isAuthorized(request, payload) {
  const expectedToken = getRequiredSyncToken();

  if (!expectedToken) {
    return process.env.NODE_ENV !== 'production';
  }

  const providedToken = String(
    request.headers.get('x-agent-sync-token') || payload?.token || '',
  ).trim();

  return providedToken === expectedToken;
}

export async function POST(request) {
  try {
    const payload = await request.json().catch(() => ({}));
    const requestedMode = String(payload?.mode ?? '').trim();

    if (!isAuthorized(request, payload)) {
      return NextResponse.json(
        { error: 'Not authorized to sync the agent.' },
        { status: 403 },
      );
    }

    const syncResult = requestedMode === 'publish-stored-descriptions'
      ? await publishStoredTreeDescriptions()
      : await syncHostedAgent();
    const agent = syncResult.agent;

    await logTrace(
      JSON.stringify({
        event: 'hosted_agent_sync_success',
        agentName: agent.name,
        agentVersion: agent.version ?? null,
        syncMode: syncResult.syncMode ?? 'manual',
      }),
    );

    return NextResponse.json({
      agent: {
        id: agent.id,
        name: agent.name,
        version: agent.version ?? null,
      },
      syncMode: syncResult.syncMode ?? 'manual',
      excludedTreeCount: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees.length : 0,
      excludedTrees: Array.isArray(syncResult.excludedTrees) ? syncResult.excludedTrees : [],
      tools: syncResult.tools,
    });
  } catch (error) {
    await logException(error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Agent sync failed',
      },
      { status: 500 },
    );
  }
}