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

function normalizeFollowUpSelection(selection) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
    return null;
  }

  const optionId = String(selection?.optionId ?? '').trim();
  const sourceTurnId = String(selection?.sourceTurnId ?? '').trim();
  const sourceQuestion = String(selection?.sourceQuestion ?? '').trim();
  const sourceToolInvocations = Array.isArray(selection?.sourceToolInvocations)
    ? selection.sourceToolInvocations
      .map((invocation) => ({
        toolName: String(invocation?.toolName ?? '').trim(),
        resultCount: Number(invocation?.resultCount ?? 0),
      }))
      .filter((invocation) => invocation.toolName)
    : [];

  if (!optionId || !sourceTurnId) {
    return null;
  }

  return {
    optionId,
    sourceTurnId,
    sourceQuestion,
    sourceToolInvocations,
  };
}

function parseBooleanSetting(value, fallbackValue) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalizedValue = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalizedValue)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalizedValue)) {
      return false;
    }
  }

  return fallbackValue;
}

function getDefaultIncludeDebug() {
  return parseBooleanSetting(process.env.AZURE_AI_CHAT_INCLUDE_DEBUG, false);
}

export async function POST(request) {
  let includeDebug = getDefaultIncludeDebug();

  try {
    const payload = await request.json();
    const message = String(payload?.message ?? '').trim();
    const followUpSelection = normalizeFollowUpSelection(payload?.followUpSelection);

    if (!message && !followUpSelection) {
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
      followUpSelection,
    });

    await logTrace(
      JSON.stringify({
        event: 'hosted_agent_invoke_success',
        agentName: result.agent.name,
        toolNames: result.toolsUsed,
        userDetails: principal?.userDetails ?? null,
      }),
    );

    return NextResponse.json(includeDebug ? result : { ...result, debug: undefined });
  } catch (error) {
    await logException(error);

    return NextResponse.json(
      includeDebug
        ? {
          error: error instanceof Error ? error.message : 'Agent request failed',
          debug: error?.debug ?? null,
        }
        : {
          error: error instanceof Error ? error.message : 'Agent request failed',
        },
      { status: 500 },
    );
  }
}