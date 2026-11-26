import {
  interactionError, validateInteractionSubmission, validateInteractionValues,
} from '@/shared/interactions';

export function validatePresentedInteractionInput(state, descriptor, input, { conversationId, turnId }) {
  validateInteractionSubmission(input);
  if (state.id !== input.interactionId || descriptor.workflow !== input.workflow ||
      state.version !== input.version || descriptor.stepId !== input.stepId ||
      state.pending || state.lastSubmissionId === input.submissionId ||
      state.presentation?.conversationId !== conversationId || state.presentation?.turnId === turnId ||
      state.presentation?.stepId !== input.stepId || state.presentation?.version !== state.version) {
    throw interactionError('This interaction changed or is not presented in this conversation. Resume it before submitting.', 409);
  }
  if (!descriptor.allowedActions.includes(input.action) || input.action === 'resume') {
    throw interactionError('This action is not available at the current step.', 409);
  }
  return validateInteractionValues(['continue', 'submit'].includes(input.action) ? descriptor.fields : [], input.values);
}
