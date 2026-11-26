import { randomUUID } from 'node:crypto';
import {
  getPersonalCacheContext, readPersonalCacheNotes, mutatePersonalCacheNotes,
} from '@/server/utils/agentOrchestration/personalCacheTreeRepository';
import { assertInteractionId, interactionError } from '@/shared/interactions';

const path = (id) => ['Knowledge Trees', 'Quiz Setups', 'By Setup ID', assertInteractionId(id)];
const linkPath = (id) => ['Knowledge Trees', 'Quiz Setups', 'By Collection ID', assertInteractionId(id)];

function validate(state, id) {
  if (!state || state.schemaVersion !== 1 || state.id !== id ||
      !Number.isSafeInteger(state.version) || state.version < 0 ||
      !['tree', 'roots', 'ready', 'prepared'].includes(state.phase) ||
      !Array.isArray(state.rootIds) || !Array.isArray(state.mapping)) {
    throw interactionError('Invalid saved quiz setup.', 409);
  }
  return state;
}

export async function readQuizSetup(principal, id) {
  const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
  const notes = await readPersonalCacheNotes({ treeId, principal, pathSegments: path(id) });
  if (!notes) throw interactionError('Quiz setup was not found for this user.', 404);
  return validate(JSON.parse(notes), id);
}

export async function saveQuizSetup(principal, previous, patch) {
  const id = previous?.id ?? randomUUID();
  const { personalCacheTreeId: treeId, updatedBy } = await getPersonalCacheContext(principal);
  return mutatePersonalCacheNotes({
    treeId, principal, updatedBy, pathSegments: path(id), createIfMissing: !previous,
    mutate(notes) {
      if (previous && (!notes || validate(JSON.parse(notes), id).version !== previous.version) || !previous && notes) {
        throw interactionError('Quiz setup changed. Rediscover its current choices.', 409);
      }
      const state = {
        schemaVersion: 1, id, version: 0, phase: 'tree', treeId: null, rootIds: [],
        mapping: [], specification: null, collectionId: null, quizId: null,
        ...previous, ...patch, updatedAt: new Date().toISOString(),
      };
      state.version++;
      validate(state, id);
      return { notes: JSON.stringify(state), result: state };
    },
  });
}

export async function bindQuizSetupCollection(principal, setup, collectionId) {
  const state = await saveQuizSetup(principal, setup, { collectionId });
  const { personalCacheTreeId: treeId, updatedBy } = await getPersonalCacheContext(principal);
  await mutatePersonalCacheNotes({
    treeId, principal, updatedBy, pathSegments: linkPath(collectionId),
    mutate(notes) {
      if (notes && JSON.parse(notes).setupId !== setup.id) {
        throw interactionError('This collection already belongs to another quiz setup.', 409);
      }
      return { notes: JSON.stringify({ schemaVersion: 1, setupId: setup.id, collectionId }), result: null };
    },
  });
  return state;
}

export async function findQuizSetupForCollection(principal, collectionId) {
  const { personalCacheTreeId: treeId } = await getPersonalCacheContext(principal);
  const notes = await readPersonalCacheNotes({ treeId, principal, pathSegments: linkPath(collectionId) });
  if (!notes) return null;
  const link = JSON.parse(notes);
  if (link.schemaVersion !== 1 || link.collectionId !== collectionId) {
    throw interactionError('Invalid quiz setup collection binding.', 409);
  }
  const setup = await readQuizSetup(principal, link.setupId);
  if (setup.collectionId !== collectionId) throw interactionError('This quiz selection has been superseded.', 409);
  return setup;
}
