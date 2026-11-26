import { randomUUID } from 'node:crypto';
import { cleanupInactiveInteractions } from './interactionCleanupRepository.js';
import { findLatestActiveInteractionId } from './interactionLookupRepository.js';
import { validatePresentedInteractionInput } from './interactionBindings.js';
import {
  getPersonalCacheContext, mutatePersonalCacheNotes, readPersonalCacheNotes,
} from '@/server/utils/agentOrchestration/personalCacheTreeRepository';
import {
  assertInteractionId, interactionError, validateInteractionDescriptor,
  validateInteractionSubmission, validateInteractionValues,
} from '@/shared/interactions';

function validateRecord(state, definition) {
  if (!state || state.schemaVersion !== 1 || state.workflow !== definition.id ||
      state.workflowVersion !== definition.version ||
      !Number.isSafeInteger(state.version) ||
      state.version < 0 || !Number.isInteger(state.stepIndex) || !state.values ||
      typeof state.values !== 'object' || Array.isArray(state.values) ||
      !['active', 'completed', 'cancelled'].includes(state.status) ||
      !['en', 'da'].includes(state.language)) throw interactionError('Invalid saved interaction.', 409);
  assertInteractionId(state.id);
  if (state.pending) {
    const { conversationId, turnId, ...submission } = state.pending;
    assertInteractionId(conversationId);
    assertInteractionId(turnId);
    validateInteractionSubmission(submission);
    const descriptor = definition.describe({ ...state, pending: null });
    if (state.status !== 'active' || submission.stepId !== descriptor.stepId ||
        !descriptor.allowedActions.includes(submission.action)) {
      throw interactionError('Invalid pending interaction action.', 409);
    }
    validateInteractionValues(['continue', 'submit'].includes(submission.action) ? descriptor.fields : [], submission.values);
  }
  validateInteractionDescriptor(definition.describe(state));
  definition.validate(state);
  return state;
}

export function createInteractionRepository(definition) {
  const path = (id) => ['Interactions', 'By Interaction ID', assertInteractionId(id)];
  async function mutate(principal, id, change, { cleanupOnCreate = false } = {}) {
    const { personalCacheTreeId: treeId, updatedBy } = await getPersonalCacheContext(principal);
    if (cleanupOnCreate) await cleanupInactiveInteractions({ treeId, principal, interactionId: id });
    return mutatePersonalCacheNotes({
      treeId, principal, updatedBy, pathSegments: path(id),
      expireAfterInactivity: true, createIfMissing: cleanupOnCreate,
      mutate(notes) {
        const state = notes ? validateRecord(JSON.parse(notes), definition) : null;
        if (state && state.id !== id) throw interactionError('Saved interaction identity mismatch.', 409);
        const next = change(state);
        next.updatedAt = new Date().toISOString();
        validateRecord(next, definition);
        return { notes: JSON.stringify(next), result: structuredClone(next) };
      },
    });
  }
  return {
    async findLatestActiveId(principal) {
      const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
      return findLatestActiveInteractionId({ treeId, principal, workflow: definition.id });
    },
    async read(principal, id) {
      const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
      const notes = await readPersonalCacheNotes({
        treeId, principal, pathSegments: path(id), expireAfterInactivity: true,
      });
      if (!notes) throw interactionError('Interaction was not found for this user.', 404);
      const state = validateRecord(JSON.parse(notes), definition);
      if (state.id !== id) throw interactionError('Saved interaction identity mismatch.', 409);
      return state;
    },
    async create(principal, language, input) {
      const initial = definition.initialize?.(input) ?? {};
      const id = randomUUID();
      return mutate(principal, id, (state) => {
        if (state) throw interactionError('Interaction already exists.', 409);
        return {
          ...initial,
          schemaVersion: 1, id, workflow: definition.id, workflowVersion: definition.version,
          version: 0, status: 'active', stepIndex: 0, values: {}, pending: null,
          lastSubmissionId: null, presentation: null, language,
          createdAt: new Date().toISOString(),
        };
      }, { cleanupOnCreate: true });
    },
    async capture(principal, input, { conversationId, turnId }) {
      validateInteractionSubmission(input);
      return mutate(principal, input.interactionId, (state) => {
        if (!state) throw interactionError('Interaction was not found.', 404);
        const descriptor = definition.describe(state);
        const values = validatePresentedInteractionInput(state, descriptor, input, { conversationId, turnId });
        state.pending = { ...input, values, conversationId, turnId };
        state.version++;
        return state;
      });
    },
    async process(principal, id, { conversationId, turnId, resume = false, requireActive = false }) {
      return mutate(principal, id, (state) => {
        if (!state) throw interactionError('Interaction was not found.', 404);
        if (requireActive && state.status !== 'active') {
          throw interactionError('The selected interaction is no longer unfinished. Start a new resume request to select again.', 409);
        }
        if (state.pending) {
          if (!resume && (state.pending.conversationId !== conversationId || state.pending.turnId !== turnId)) {
            throw interactionError('Resume this interaction explicitly to finish its pending submission.', 409);
          }
          const submission = state.pending;
          definition.apply(state, submission);
          state.lastSubmissionId = submission.submissionId;
          state.pending = null;
          state.version++;
        } else if (!resume) {
          throw interactionError('There is no captured human submission to process.', 409);
        }
        return state;
      });
    },
    async present(principal, id, { conversationId, turnId, expectedVersion }) {
      return mutate(principal, id, (state) => {
        if (!state) throw interactionError('Interaction was not found.', 404);
        if (state.version !== expectedVersion) throw interactionError('The interaction changed before presentation. Resume it.', 409);
        state.presentation = { conversationId, turnId, stepId: definition.describe(state).stepId, version: state.version + 1 };
        state.version++;
        return state;
      });
    },
  };
}
