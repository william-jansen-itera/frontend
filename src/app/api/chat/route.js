import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  invokeAgentFamily,
  resolveAgentFamilySelection,
} from '@/server/utils/agentOrchestration/agentFamilyInvoker';
import { logException, logStructuredTrace, logTrace } from '@/server/utils/logging';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import { getAuditMetadata } from '@/server/utils/tree/treeCatalog';
import { bindChatUploadHumanMessage, getOwnedChatUpload } from '@/server/utils/agentOrchestration/agents/knowledgeTrees/chatUploadRepository';
import { assertTreeContextId } from '@/server/utils/agentOrchestration/agents/knowledgeTrees/treeLaneState';
import { validateInteractionContext, validateInteractionSubmission } from '@/shared/interactions';

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
    const previewUploadId = String(payload?.previewUploadId ?? '').trim() || null;
    const rawMessage = String(payload?.message ?? '');
    const message = payload?.interactionContext?.workflow === 'quiz' ? rawMessage : rawMessage.trim();
    const resolvedFamily = await resolveAgentFamilySelection(payload?.family);
    routeDebug = includeDebug ? appendRouteDebugStep(routeDebug, 'agent family resolved', {
      requestedFamily: String(payload?.family ?? '').trim() || null,
      resolvedFamily: resolvedFamily.family,
    }) : routeDebug;
    const family = resolvedFamily.family;
    const visibility = String(payload?.visibility ?? '').trim() || 'public';
    const language = ['en', 'da'].includes(payload?.language) ? payload.language : 'en';

    await logTrace(
      JSON.stringify({
        event: 'prompt_agent_invoke_started',
        requestId,
        requestStartedAt,
        includeDebug,
        requestedFamily: String(payload?.family ?? '').trim() || null,
        resolvedFamily: family,
        visibility,
        messageLength: message.length,
      }),
    );

    if (!message.trim()) {
      return createChatJsonResponse(
        { error: 'A non-empty message is required.' },
        { status: 400, requestId, includeDebug },
      );
    }

    const history = normalizeHistory(payload?.history);
    const principal = requireAuthenticatedPrincipal(request);
    let conversationContext = {};
    if (family === 'knowledgeTrees') {
      try {
        const conversationId = assertTreeContextId(payload?.conversationId, 'conversationId');
        const turnId = assertTreeContextId(payload?.turnId, 'turnId');
        const expectedVersion = payload?.expectedVersion;
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
          throw new Error('A non-negative expectedVersion is required.');
        }
        conversationContext = { conversationId, turnId, expectedVersion };
      } catch (error) {
        return createChatJsonResponse({ error: error.message }, { status: 400, requestId, includeDebug });
      }
    }
    const uploadId = String(payload?.uploadId ?? '').trim() || null;
    const pendingUploadId = String(payload?.pendingUploadId ?? '').trim() || null;
    const interactionSubmission = payload?.interactionSubmission ?? null;
    const interactionContext = payload?.interactionContext ?? null;
    if (interactionSubmission || interactionContext) {
      if (family !== 'knowledgeTrees' || uploadId || pendingUploadId || previewUploadId ||
          (interactionSubmission && interactionContext)) {
        return createChatJsonResponse({ error: 'Interaction input cannot be combined with another family or upload workflow.' },
          { status: 400, requestId, includeDebug });
      }
      try {
        if (interactionSubmission) validateInteractionSubmission(interactionSubmission);
        if (interactionContext) validateInteractionContext(interactionContext);
      } catch (error) {
        return createChatJsonResponse({ error: error.message }, { status: 400, requestId, includeDebug });
      }
    }
    const ownerObjectId = getAuditMetadata(principal).updatedByObjectId;
    let uploadHasHumanMessage = null;
    if (pendingUploadId) {
      if (family !== 'knowledgeTrees' || uploadId || previewUploadId || !ownerObjectId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pendingUploadId)) {
        return createChatJsonResponse({ error: 'Upload was not found or has expired.' }, { status: 404, requestId, includeDebug });
      }
      const pendingUpload = await getOwnedChatUpload({ uploadId: pendingUploadId, ownerObjectId });
      if (pendingUpload?.status !== 'succeeded') {
        return createChatJsonResponse({ error: 'Upload was not found or has not completed.' }, { status: 404, requestId, includeDebug });
      }
      uploadHasHumanMessage = Boolean(String(pendingUpload.originalHumanMessage ?? '').trim());
    }
    if (previewUploadId) {
      if (family !== 'knowledgeTrees' || uploadId || !ownerObjectId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(previewUploadId)) {
        return createChatJsonResponse({ error: 'Upload was not found or has expired.' }, { status: 404, requestId, includeDebug });
      }
      const upload = await getOwnedChatUpload({ uploadId: previewUploadId, ownerObjectId });
      if (!upload) {
        return createChatJsonResponse({ error: 'Upload was not found or has expired.' }, { status: 404, requestId, includeDebug });
      }
      uploadHasHumanMessage = Boolean(String(upload.originalHumanMessage ?? '').trim());
    }
    if (uploadId) {
      if (family !== 'knowledgeTrees' || !ownerObjectId ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId) ||
          !await getOwnedChatUpload({ uploadId, ownerObjectId })) {
        return createChatJsonResponse({ error: 'Upload was not found or has expired.' }, { status: 404, requestId, includeDebug });
      }
      if (payload?.hasTypedUploadMessage === true) {
        await bindChatUploadHumanMessage({ uploadId, ownerObjectId, message });
      }
      uploadHasHumanMessage = payload?.hasTypedUploadMessage === true;
    }
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
      language,
      includeDebug,
      requestId,
      uploadId,
      previewUploadId,
      pendingUploadId,
      uploadHasHumanMessage,
      ...(interactionSubmission ? { interactionSubmission } : {}),
      ...(interactionContext ? { interactionContext } : {}),
      ...conversationContext,
    });
    routeDebug = includeDebug ? appendRouteDebugStep(routeDebug, 'chat route received agent family result', {
      toolsUsedCount: Array.isArray(result?.toolsUsed) ? result.toolsUsed.length : null,
    }) : routeDebug;

    await logTrace(
      JSON.stringify({
        event: result.agent ? 'prompt_agent_invoke_success' : 'structured_interaction_success',
        requestId,
        family,
        agentName: result.agent?.name ?? null,
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
          ...(error?.laneContext ? { laneContext: error.laneContext } : {}),
          ...(error?.interaction ? { interaction: error.interaction } : {}),
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
          ...(error?.laneContext ? { laneContext: error.laneContext } : {}),
          ...(error?.interaction ? { interaction: error.interaction } : {}),
        },
      { status: error?.status ?? 500, requestId, includeDebug },
    );
  }
}