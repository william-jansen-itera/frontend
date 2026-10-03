import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  invokeAgentFamily,
  resolveAgentFamilySelection,
} from '@/server/utils/agent/agentFamilyInvoker';
import { logException, logStructuredTrace, logTrace } from '@/server/utils/logging';
import { parseClientPrincipal } from '@/server/utils/auth';

export const runtime = 'nodejs';

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
  return parseBooleanSetting(process.env.APPLICATION_DEBUG, false);
}

function createChatJsonResponse(body, { status = 200, requestId, includeDebug } = {}) {
  const response = NextResponse.json(body, { status });

  if (requestId) {
    response.headers.set('x-chat-request-id', requestId);
  }

  response.headers.set('x-chat-response-origin', 'app-route');
  response.headers.set('x-chat-debug-enabled', includeDebug ? 'true' : 'false');

  return response;
}

function appendRouteDebugStep(debug, step, details = null) {
  const normalizedDebug = debug && typeof debug === 'object' ? debug : {};
  const existingSteps = Array.isArray(normalizedDebug.stepsComplete) ? normalizedDebug.stepsComplete : [];
  const stepEntry = {
    step,
    completedAt: new Date().toISOString(),
    ...(details && typeof details === 'object' ? details : {}),
  };

  if (normalizedDebug.loggingEnabled && normalizedDebug.requestId) {
    void logStructuredTrace({
      event: 'chat_route_step',
      requestId: normalizedDebug.requestId,
      step,
      completedAt: stepEntry.completedAt,
      details: stepEntry,
    });
  }

  return {
    ...normalizedDebug,
    stepsComplete: [
      ...existingSteps,
      stepEntry,
    ],
  };
}

export async function POST(request) {
  let includeDebug = getDefaultIncludeDebug();
  const requestId = request.headers.get('x-chat-request-id') || randomUUID();
  const requestStartedAt = new Date().toISOString();
  let routeDebug = includeDebug ? appendRouteDebugStep({ requestId, loggingEnabled: includeDebug }, 'api call received', { requestId }) : null;

  try {
    const payload = await request.json();
    routeDebug = includeDebug ? appendRouteDebugStep(routeDebug, 'request json parsed') : routeDebug;
    const message = String(payload?.message ?? '').trim();
    const resolvedFamily = await resolveAgentFamilySelection(payload?.family);
    routeDebug = includeDebug ? appendRouteDebugStep(routeDebug, 'agent family resolved', {
      requestedFamily: String(payload?.family ?? '').trim() || null,
      resolvedFamily: resolvedFamily.family,
    }) : routeDebug;
    const family = resolvedFamily.family;
    const visibility = String(payload?.visibility ?? '').trim() || 'public';
    const followUpSelection = normalizeFollowUpSelection(payload?.followUpSelection);

    await logTrace(
      JSON.stringify({
        event: 'prompt_agent_invoke_started',
        requestId,
        requestStartedAt,
        includeDebug,
        requestedFamily: String(payload?.family ?? '').trim() || null,
        resolvedFamily: family,
        visibility,
        hasFollowUpSelection: Boolean(followUpSelection),
        messageLength: message.length,
      }),
    );

    if (!message && !followUpSelection) {
      return createChatJsonResponse(
        { error: 'A non-empty message is required.' },
        { status: 400, requestId, includeDebug },
      );
    }

    const history = normalizeHistory(payload?.history);
    const principal = parseClientPrincipal(request);
    routeDebug = includeDebug ? appendRouteDebugStep(routeDebug, 'chat route invoking agent family', {
      historyCount: history.length,
      hasPrincipal: Boolean(principal),
    }) : routeDebug;
    const result = await invokeAgentFamily({
      family,
      familyStatus: resolvedFamily,
      message,
      history,
      principal,
      visibility,
      followUpSelection,
      includeDebug,
      requestId,
    });
    routeDebug = includeDebug ? appendRouteDebugStep(routeDebug, 'chat route received agent family result', {
      toolsUsedCount: Array.isArray(result?.toolsUsed) ? result.toolsUsed.length : null,
    }) : routeDebug;

    await logTrace(
      JSON.stringify({
        event: 'prompt_agent_invoke_success',
        requestId,
        family,
        agentName: result.agent.name,
        toolNames: result.toolsUsed,
        userDetails: principal?.userDetails ?? null,
      }),
    );

    return createChatJsonResponse(
      includeDebug
        ? {
          ...result,
          debug: appendRouteDebugStep(
            result?.debug
              ? {
                ...result.debug,
                request: {
                  requestId,
                  requestStartedAt,
                  responseOrigin: 'app-route',
                },
              }
              : {
                ...routeDebug,
                request: {
                  requestId,
                  requestStartedAt,
                  responseOrigin: 'app-route',
                },
              },
            'chat route response serialized',
          ),
        }
        : { ...result, debug: undefined },
      { requestId, includeDebug },
    );
  } catch (error) {
    await logTrace(
      JSON.stringify({
        event: 'prompt_agent_invoke_failure',
        requestId,
        requestStartedAt,
        includeDebug,
        errorMessage: error instanceof Error ? error.message : String(error ?? 'Agent request failed'),
        errorName: error instanceof Error ? error.name : null,
        hasDebug: Boolean(error?.debug),
      }),
    );

    await logException(error);

    return createChatJsonResponse(
      includeDebug
        ? {
          error: error instanceof Error ? error.message : 'Agent request failed',
          debug: appendRouteDebugStep(
            error?.debug
              ? {
                ...error.debug,
                request: {
                  requestId,
                  requestStartedAt,
                  responseOrigin: 'app-route',
                },
              }
              : {
                ...routeDebug,
                request: {
                  requestId,
                  requestStartedAt,
                  responseOrigin: 'app-route',
                },
              },
            'chat route error response serialized',
            {
              errorMessage: error instanceof Error ? error.message : 'Agent request failed',
            },
          ),
        }
        : {
          error: error instanceof Error ? error.message : 'Agent request failed',
        },
      { status: 500, requestId, includeDebug },
    );
  }
}