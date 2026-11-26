import { createInteractionRepository } from '@/server/utils/agentOrchestration/interactions/interactionRepository';
import {
  interactionError, interpretInteractionText, validateInteractionContext, validateInteractionSubmission,
} from '@/shared/interactions';
import { buildAgentToolResult, buildUntrustedContentMeta } from '@/server/utils/agentOrchestration/agentToolResult';
import { interactionTestDefinition as definition } from './definition.js';
import { testInteractionToolDefinition } from './toolDefinition.js';

export { testInteractionToolDefinition };

export function createInteractionTestRuntime({ principal, conversationId, turnId, language = 'en', isAllowed }) {
  const repository = createInteractionRepository(definition);
  const binding = { conversationId, turnId };
  let state = null;
  let captured = false;
  let explicitlyResumed = false;
  let canPresent = false;
  let controlsTurn = false;
  let latestInteractionId;
  let resumeRequested = false;
  function assertAllowed() {
    if (!isAllowed()) throw interactionError('Switch to quiz before using the interaction test; it is unavailable during upload workflows.', 409);
  }
  return {
    get controlsTurn() { return controlsTurn; },
    async prepare({ submission, context, message }) {
      if (!submission && !context) return;
      assertAllowed();
      if (submission) validateInteractionSubmission(submission);
      if (context) validateInteractionContext(context);
      if (submission && context) throw interactionError('Supply either a submission or an interaction context.');
      const reference = submission ?? context;
      state = await repository.read(principal, reference.interactionId);
      const descriptor = definition.describe(state);
      if (reference.version !== state.version || reference.stepId !== descriptor.stepId) {
        throw interactionError('This interaction changed. Resume it before submitting.', 409);
      }
      const input = submission ?? interpretInteractionText(descriptor, message, turnId);
      if (input?.action === 'resume') {
        if (Object.keys(input.values).length) throw interactionError('Resume cannot submit field values.');
        explicitlyResumed = true;
        controlsTurn = true;
        return;
      }
      if (state.presentation?.conversationId !== conversationId || state.presentation?.turnId === turnId) {
        throw interactionError('Resume this interaction in this conversation before submitting.', 409);
      }
      canPresent = true;
      if (input) {
        state = await repository.capture(principal, input, binding);
        captured = true;
        controlsTurn = true;
      }
    },
    instruction() {
      const descriptor = state ? definition.describe(state) : null;
      return state ? [
        `Trusted saved interaction context: ${JSON.stringify({
          interactionId: state.id, version: state.version, stepId: descriptor.stepId,
          status: descriptor.status, allowedActions: descriptor.allowedActions,
          pendingSubmissionId: state.pending?.submissionId ?? null,
          pendingAction: state.pending?.action ?? null,
        })}`,
        captured ? 'The server captured a deliberate human submission before this model call. Call test_multistep_interaction operation="process" with this interactionId. Do not invent or resubmit its values.'
          : explicitlyResumed ? 'The human requested resume. Call test_multistep_interaction operation="resume" with this interactionId.'
            : 'No new unambiguous step submission was captured. Clarify unclear input or use status; do not advance or invent values.',
        'Display the saved card through the response contract, not invented Markdown controls. This context authorizes no upload completion, save confirmation, or broadening.',
        'Keep interaction IDs in tool arguments and structured metadata only, never in user-visible answer prose.',
      ].join('\n') : '';
    },
    async handle(args) {
      assertAllowed();
      if (!args || Object.keys(args).some((key) => !['operation', 'interactionId'].includes(key)) ||
          !['start', 'process', 'status', 'resume'].includes(args.operation)) {
        throw interactionError('Invalid interaction test operation.');
      }
      controlsTurn = true;
      if (args.operation === 'resume') resumeRequested = true;
      if (args.operation === 'start') {
        if (resumeRequested) throw interactionError('Resume cannot start a replacement interaction. Ask the human before starting a new test.', 409);
        if (args.interactionId !== null || state) throw interactionError('Start requires no current interaction and a null interactionId.');
        state = await repository.create(principal, language);
        canPresent = true;
      } else {
        let interactionId = args.interactionId;
        let requireActive = false;
        if (args.operation === 'resume' && interactionId === null) {
          if (captured) throw interactionError('Process the captured human submission before requesting resume.', 409);
          if (state) {
            interactionId = state.id;
          } else {
            if (latestInteractionId === undefined) latestInteractionId = await repository.findLatestActiveId(principal);
            if (!latestInteractionId) {
              throw interactionError('No unfinished, unexpired test interaction was found. Ask the human whether to start a new one.', 404);
            }
            interactionId = latestInteractionId;
            requireActive = true;
          }
        }
        if (state && interactionId !== state.id) throw interactionError('Use the active interaction identity.', 409);
        if (args.operation === 'process') {
          if (!captured) throw interactionError('No human submission was captured in this turn.', 409);
          state = await repository.process(principal, interactionId, binding);
          captured = false;
          canPresent = true;
        } else if (args.operation === 'resume') {
          state = await repository.process(principal, interactionId, { ...binding, resume: true, requireActive });
          explicitlyResumed = false;
          canPresent = true;
        } else {
          state = await repository.read(principal, interactionId);
          canPresent = state.presentation?.conversationId === conversationId;
        }
      }
      return buildAgentToolResult({
        sourceToolFamily: 'knowledgeTrees', toolName: testInteractionToolDefinition.name,
        toolResultType: 'interaction_state',
        data: { interaction: definition.describe(state) },
        meta: buildUntrustedContentMeta({ interaction: definition.describe(state) },
          ['interaction.values', 'interaction.collectedValues', 'interaction.summary', 'interaction.review']),
      });
    },
    validateAnswer(answerState) {
      if (state && typeof answerState.answer === 'string' &&
          answerState.answer.toLowerCase().includes(state.id.toLowerCase())) {
        return 'Remove the interaction ID from your answer prose. Keep it only in the structured interaction reference. Do not call the tool again.';
      }
      if (answerState.interaction && answerState.interaction.interactionId !== state?.id) {
        return 'Reference only the actual saved interaction from this turn, or omit interaction. Never invent an interactionId.';
      }
      if (captured || explicitlyResumed) return 'Process or resume the captured interaction using test_multistep_interaction before returning the final response.';
      if (state && (answerState.knowledgeMode !== 'grounded' || answerState.isPersistenceOffer ||
          answerState.isPermissionToBroadenRequest || answerState.isWaitingForContinuation ||
          answerState.persistenceAction !== 'none')) {
        return 'Report the interaction as grounded, with no save/broadening offer and isWaitingForContinuation=false. Waiting for human input is not an automated continuation.';
      }
      return null;
    },
    async present() {
      if (!state || !isAllowed()) return null;
      if (!canPresent) return {
        ...definition.describe(state), allowedActions: state.status === 'active' ? ['resume'] : [],
      };
      state = await repository.present(principal, state.id, { ...binding, expectedVersion: state.version });
      return definition.describe(state);
    },
    async recovery() {
      if (!state) return null;
      state = await repository.read(principal, state.id);
      return { ...definition.describe(state), allowedActions: state.status === 'active' ? ['resume'] : [] };
    },
  };
}
