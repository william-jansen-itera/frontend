import { getProjectClient } from '@/server/utils/foundryAgentClient';
import { buildAgentPersonalCacheContext } from '@/server/utils/agent/agentPersonalCache';
import { buildInitialAgentInput } from '@/server/utils/agent/agentConversationInput';
import { readAgentTurnState } from '@/server/utils/agent/agentTurnStateReader';
import {
  attachDebugToError,
  appendDebugStep,
  createAgentDebugState,
} from '@/server/utils/agent/agentDebug';
import { runAgentFamilyExecution } from '@/server/utils/agent/agentFamilyExecution';
import { createPendingAgentApproval, finishAgentApproval } from '@/server/utils/agent/agentActionApprovalRepository';
import {
  buildEmailRuntimeContext,
  EMAIL_FAMILY,
  getPublishedEmailPromptAgent,
} from '@/server/utils/agent/email/emailAgentCatalog';
import { DELETE_EMAIL_TOOL } from '@/server/utils/agent/email/tools/deleteEmailTool';
import {
  buildEmailFamilyResult,
  buildEmailResponse,
} from '@/server/utils/agent/email/emailAgentResultBuilder';

const DEFAULT_HISTORY_LIMIT = 8;

function createEmailApproval({ principal, handlerMap, handlerContext, debug = null }) {
  return async ({ toolName, arguments: args, state }) => {
    if (toolName !== DELETE_EMAIL_TOOL) {
      throw new Error(`No approval preview exists for tool ${toolName}.`);
    }

    const startedAt = new Date().toISOString();
    const startedAtMs = performance.now();
    const preview = await handlerMap.get(toolName)(args, { ...handlerContext, previewOnly: true });
    if (debug) {
      debug.timings.deletePreview = {
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - startedAtMs,
      };
    }

    return createPendingAgentApproval({
      principal,
      family: EMAIL_FAMILY,
      toolName,
      arguments: args,
      preview,
      continuation: state,
    });
  };
}

export async function resumeEmailAgentApproval({ principal, id, decision, record, includeDebug = false }) {
  if (record.family !== EMAIL_FAMILY || record.toolName !== DELETE_EMAIL_TOOL) {
    throw new Error('Unsupported approval target.');
  }

  const project = getProjectClient();
  const agent = await getPublishedEmailPromptAgent();
  const handlerContext = await buildAgentPersonalCacheContext(principal);
  const { handlerMap, toolPolicies } = buildEmailRuntimeContext(handlerContext);

  if (toolPolicies.get(record.toolName)?.requiresUserApproval !== true) {
    throw new Error('The approval policy changed. This action was not executed.');
  }

  const call = record.continuation.functionCalls[record.continuation.nextIndex];

  if (call?.name !== record.toolName || !call.call_id
    || JSON.stringify(JSON.parse(call.arguments || '{}')) !== JSON.stringify(record.arguments)) {
    throw new Error('The pending tool call no longer matches the approved action.');
  }

  let output;
  let actionTiming = null;

  if (decision === 'approve') {
    const startedAt = new Date().toISOString();
    const startedAtMs = performance.now();
    try {
      output = await handlerMap.get(record.toolName)(record.arguments, {
        ...handlerContext,
        approvedTargetIdentities: record.preview.targets.map(({ requestedUid, requestedFolder, actualUid, actualFolder, messageId }) => ({
          requestedUid, requestedFolder, actualUid, actualFolder, messageId,
        })),
      });
    } catch (error) {
      actionTiming = { startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - startedAtMs };
      try {
        await finishAgentApproval({ id, outcome: { error: error instanceof Error ? error.message : 'Delete outcome unknown' }, failed: true });
      } catch (recordError) {
        console.error('Could not record the failed email action outcome.', recordError);
      }
      return {
        answer: 'The email action could not be confirmed. It will not be retried automatically. Check the mailbox before trying again.',
        agent: { name: agent.name },
        toolsUsed: [record.toolName],
        debug: includeDebug ? { approval: {
          decision, toolName: record.toolName, preview: record.preview,
          actionTiming,
          outcome: { status: 'failed', error: error instanceof Error ? error.message : 'Delete outcome unknown' },
        } } : undefined,
      };
    }
    actionTiming = { startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - startedAtMs };

    try {
      await finishAgentApproval({ id, outcome: output });
    } catch (error) {
      console.error('Could not record the completed email action outcome.', error);
      return {
        answer: 'The approved email action completed, but its status could not be saved. Check the mailbox for the result.',
        agent: { name: agent.name },
        toolsUsed: [record.toolName],
        debug: includeDebug ? { approval: {
          decision, toolName: record.toolName, preview: record.preview,
          actionTiming,
          outcome: { status: 'outcome_not_saved', result: output },
        } } : undefined,
      };
    }
  } else {
    output = { status: 'user_declined', toolName: record.toolName, deleted: false };
  }

  const approvalDebug = includeDebug ? {
    decision,
    toolName: record.toolName,
    preview: record.preview,
    actionTiming,
    outcome: output,
  } : null;

  try {
    const execution = await runAgentFamilyExecution({
      openAIClient: project.getOpenAIClient(),
      responseConfig: { type: 'agent_reference', agentName: agent.name },
      initialInput: [],
      handlerMap,
      toolPolicies,
      handlerContext,
      createApproval: createEmailApproval({ principal, handlerMap, handlerContext }),
      resumeState: record.continuation,
      approvedCall: {
        round: record.continuation.round,
        index: record.continuation.nextIndex,
        callId: call.call_id,
        output,
      },
    });

    if (execution.approvalRequired) {
      return { approvalRequired: execution.approvalRequired, agent: { name: agent.name }, toolsUsed: [], debug: approvalDebug ? { approval: approvalDebug } : undefined };
    }

    const { familyResult } = await buildEmailFamilyResult({
      finalResponse: execution.response,
      finalToolInvocations: execution.toolInvocations,
      openAIClient: project.getOpenAIClient(),
      debug: null,
      agent,
    });

    return buildEmailResponse({ familyResult, principal, debug: approvalDebug ? { approval: approvalDebug } : null });
  } catch {
    return {
      answer: decision === 'approve'
        ? 'The approved email action completed, but the assistant could not finish its response. Check the mailbox for the result.'
        : 'The email action was cancelled. No email was deleted, but the assistant could not finish its response.',
      agent: { name: agent.name },
      toolsUsed: decision === 'approve' ? [record.toolName] : [],
      debug: approvalDebug ? { approval: approvalDebug } : undefined,
    };
  }
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history
    .slice(-DEFAULT_HISTORY_LIMIT)
    .map((entry) => {
      const role = entry?.role === 'assistant' ? 'assistant' : 'user';
      const content = String(entry?.content ?? '').trim();

      if (!content) {
        return null;
      }

      return {
        type: 'message',
        role,
        content,
      };
    })
    .filter(Boolean);
}

export async function invokeEmailAgent({
  message,
  history = [],
  principal = null,
  includeDebug = false,
  requestId = null,
}) {
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the email family');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  let debug = null;

  if (includeDebug) {
    debug = createAgentDebugState({
      sourceToolFamily: EMAIL_FAMILY,
      normalizedMessage,
      initialInput: null,
      phaseNames: ['citationAssembly', 'responseShaping'],
      logContext: {
        requestId,
        family: EMAIL_FAMILY,
      },
      loggingEnabled: includeDebug,
    });
    appendDebugStep(debug, 'email agent invocation started');
  }

  const agent = await getPublishedEmailPromptAgent();
  appendDebugStep(debug, 'published prompt agent loaded', {
    agentName: agent?.name ?? null,
  });
  const agentPersonalCacheContext = await buildAgentPersonalCacheContext(principal);
  appendDebugStep(debug, 'personal cache context loaded', {
    personalCacheTreeId: agentPersonalCacheContext?.personalCacheTreeId ?? null,
  });
  const { handlerMap, toolPolicies, tools } = buildEmailRuntimeContext({
    includeDebug,
    updatedBy: agentPersonalCacheContext.updatedBy,
    personalCacheTreeId: agentPersonalCacheContext.personalCacheTreeId,
  });
  appendDebugStep(debug, 'email runtime context built', {
    toolCount: Array.isArray(tools) ? tools.length : null,
  });
  const normalizedHistory = normalizeHistory(history);
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction: null,
    normalizedHistory,
    normalizedMessage,
  });
  if (debug) {
    debug.curatedAgentInput.initialMessages = initialInput;
    appendDebugStep(debug, 'initial agent input built', {
      historyMessageCount: normalizedHistory.length,
    });
  }
  const requestStartedAtMs = includeDebug ? Date.now() : null;

  try {
    appendDebugStep(debug, 'agent family execution started');
    const execution = await runAgentFamilyExecution({
      openAIClient,
      responseConfig: {
        type: 'agent_reference',
        agentName: agent.name,
      },
      initialInput,
      handlerMap,
      toolPolicies,
      createApproval: createEmailApproval({
        principal,
        handlerMap,
        handlerContext: agentPersonalCacheContext,
        debug,
      }),
      handlerContext: {
        ...agentPersonalCacheContext,
        debug,
      },
      debug,
      includeDebug,
    });
    if (execution.approvalRequired) {
      if (debug) {
        const approval = execution.approvalRequired;
        appendDebugStep(debug, 'email action awaiting user approval', { toolName: approval.toolName });
        readAgentTurnState({
          finalResponse: null,
          finalToolInvocations: execution.toolInvocations,
          requireReportedAnswerState: false,
          debug,
        });
        debug.turnClassification = {
          ...debug.turnClassification,
          status: 'awaiting_user_approval',
          toolName: approval.toolName,
          deletionMode: approval.preview.expunge ? 'permanent_delete' : 'move_to_trash',
        };
        debug.toolCalls.push({
          round: debug.timings.modelCalls.length,
          toolName: approval.toolName,
          parsedArguments: { approvalPreview: approval.preview },
          toolOutput: { status: 'pending_user_approval', preview: approval.preview },
        });
        debug.timings.requestCompletedAt = new Date().toISOString();
        debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
      }
      return { approvalRequired: execution.approvalRequired, agent: { name: agent.name }, toolsUsed: [], debug };
    }
    const { response, toolInvocations, modelCalls } = execution;
    appendDebugStep(debug, 'agent family execution completed', {
      toolInvocationCount: toolInvocations.length,
      finalResponseId: response?.id ?? null,
    });

    if (debug) {
      debug.timings.modelCalls.push(...modelCalls);
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    appendDebugStep(debug, 'email result builder started');
    const { familyResult } = await buildEmailFamilyResult({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      openAIClient,
      normalizedMessage,
      debug,
      agent,
    });
    appendDebugStep(debug, 'email result builder completed', {
      toolsUsedCount: Array.isArray(familyResult?.toolsUsed) ? familyResult.toolsUsed.length : null,
    });

    appendDebugStep(debug, 'email response built');
    return buildEmailResponse({ familyResult, principal, debug });
  } catch (error) {
    if (debug) {
      appendDebugStep(debug, 'email agent invocation failed', {
        errorMessage: error instanceof Error ? error.message : String(error ?? 'Agent request failed'),
      });
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    throw attachDebugToError(error, debug);
  }
}