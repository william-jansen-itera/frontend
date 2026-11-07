import { getProjectClient } from '@/server/utils/foundryAgentClient';
import {
  buildStructuredAnswerStateFinalResponseValidator,
  buildStructuredAnswerStateResponseFormat,
  parseStructuredAnswerStateResponse,
} from '@/server/utils/agent/agentAnswerState';
import { buildInitialAgentInput } from '@/server/utils/agent/agentConversationInput';
import {
  attachDebugToError,
  createAgentDebugState,
} from '@/server/utils/agent/agentDebug';
import { runAgentFamilyExecution } from '@/server/utils/agent/agentFamilyExecution';
import {
  buildAllowedToolInstruction,
  buildRuntimeTreeToolContext,
  buildVisibilityScopeContext,
  buildVisibilityScopeInstruction,
  getPublishedKnowledgeTreesPromptAgent,
} from '@/server/utils/agent/knowledgeTrees/treeAgentCatalog';
import {
  buildKnowledgeTreesFamilyResult,
  buildKnowledgeTreesResponse,
} from '@/server/utils/agent/knowledgeTrees/treeAgentResultBuilder';

const DEFAULT_HISTORY_LIMIT = 8;

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

// runs initial agent invocation
// starts the tool loop
// and classifies the grounded-vs-broad response mode
export async function invokeKnowledgeTreesAgent({ message, history = [], principal = null, visibility = 'public', includeDebug = false }) {
  const normalizedMessage = String(message ?? '').trim();

  if (!normalizedMessage) {
    throw new Error('A message is required to invoke the agent');
  }

  const project = getProjectClient();
  const openAIClient = project.getOpenAIClient();
  const agent = await getPublishedKnowledgeTreesPromptAgent();
  const { handlerMap, toolPolicies, includedTrees } = await buildRuntimeTreeToolContext({
    principal,
    visibility,
    enforceAccess: true,
    includeDebug,
    currentUserMessage: normalizedMessage,
  });
  const visibilityScope = buildVisibilityScopeContext({
    visibility,
    includedTrees,
  });
  const normalizedHistory = normalizeHistory(history);
  const allowedToolInstruction = [
    buildVisibilityScopeInstruction({ visibility, includedTrees }),
    buildAllowedToolInstruction(includedTrees),
  ].join('\n\n');
  const initialInput = buildInitialAgentInput({
    allowedToolInstruction,
    normalizedHistory,
    normalizedMessage,
  });
  const debug = includeDebug
    ? createAgentDebugState({
      sourceToolFamily: 'knowledgeTrees',
      normalizedMessage,
      initialInput,
      phaseNames: ['citationAssembly', 'responseShaping'],
      loggingEnabled: includeDebug,
    })
    : null;
  const requestStartedAtMs = includeDebug ? Date.now() : null;
  const validateAnswerState = buildStructuredAnswerStateFinalResponseValidator({
    allowBroadMode: true,
    allowPersistence: true,
    requirePersistenceOfferForBroad: true,
    requirePersistenceAction: true,
  });
  const validateFinalResponse = async ({ response, toolInvocations, debug: validationDebug }) => {
    const stateError = await validateAnswerState({ response, toolInvocations, debug: validationDebug });
    if (stateError) return stateError;

    const { answer, persistenceAction } = parseStructuredAnswerStateResponse(response, {
      allowBroadMode: true,
      allowPersistence: true,
      requirePersistenceOfferForBroad: true,
      requirePersistenceAction: true,
    });
    const lastAction = toolInvocations.findLast(({ toolName }) =>
      ['preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree'].includes(toolName));
    const successfulAction = lastAction?.output?.toolResultType === 'tree_note_preview'
      ? lastAction.toolName === 'revise_save_preview' ? 'revised' : 'previewed'
      : ['tree_note_updated', 'tree_note_created'].includes(lastAction?.output?.toolResultType) &&
        lastAction?.toolName === 'confirm_save_to_tree' ? 'saved' : 'none';
    if (persistenceAction !== successfulAction) {
      return `The reported persistenceAction does not match the latest persistence tool result. If the current user message explicitly confirms the latest preview, call confirm_save_to_tree with that preview's exact ID and approved save mode before replying. Only report persistenceAction="saved" after that call succeeds in this turn. Otherwise report persistenceAction="${successfulAction}" and rewrite answer and explanation to match the observed tool result; when confirm_save_to_tree did not succeed, explicitly say the note was not saved and remove any saved-note text, destination, or link. Do not copy the rejected answer.`;
    }
    if (['previewed', 'revised'].includes(successfulAction) &&
        (!answer.includes(`<!-- Preview ID: ${lastAction.output.data.previewId} -->`) ||
         !answer.includes(lastAction.output.data.defaultSavePath))) {
      return 'Report the actual defaultSavePath and end the answer with the exact Preview ID marker from the latest preview tool result. Do not claim the note was saved; ask for separate confirmation.';
    }
    if (successfulAction === 'saved' &&
        (!lastAction.output.data?.noteLink || !lastAction.output.data?.details?.notes ||
         !answer.includes(lastAction.output.data.noteLink) || !answer.includes(lastAction.output.data.details.notes))) {
      return 'The saved-note answer must contain the exact noteLink and complete details.notes from the successful confirm_save_to_tree result. Do not invent a link or note text.';
    }
    return null;
  };

  try {
    const { response, toolInvocations, modelCalls } = await runAgentFamilyExecution({
      openAIClient,
      responseConfig: {
        type: 'agent_reference',
        agentName: agent.name,
        text: buildStructuredAnswerStateResponseFormat({
          allowBroadMode: true,
          allowPersistence: true,
          requirePersistenceOfferForBroad: true,
          requirePersistenceAction: true,
        }),
      },
      initialInput,
      handlerMap,
      toolPolicies,
      finalResponseValidator: validateFinalResponse,
      debug,
      includeDebug,
    });
    if (debug) {
      debug.timings.modelCalls.push(...modelCalls);
    }
    const { familyResult } = await buildKnowledgeTreesFamilyResult({
      finalResponse: response,
      finalToolInvocations: [...toolInvocations],
      openAIClient,
      normalizedMessage,
      principal,
      visibilityScope,
      debug,
      agent,
    });
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }

    return buildKnowledgeTreesResponse({ familyResult, agent, principal, debug });
  } catch (error) {
    if (debug) {
      debug.timings.requestCompletedAt = new Date().toISOString();
      debug.timings.totalDurationMs = Date.now() - requestStartedAtMs;
    }
    throw attachDebugToError(error, debug);
  }
}
