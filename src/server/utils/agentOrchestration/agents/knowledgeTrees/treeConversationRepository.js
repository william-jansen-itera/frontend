import {
  findPersonalCacheLeafPathNode, getPersonalCacheContext, mutatePersonalCacheNotes,
} from '@/server/utils/agentOrchestration/personalCacheTreeRepository';
import { cleanupInactiveTreeConversations } from './treeConversationCleanupRepository.js';
import {
  RETRIEVAL_LANE, buildTreeLaneContext, assertTreeContextId, validateTreeConversation,
} from './treeLaneState.js';

function readState(notes, conversationId) {
  if (notes === null || notes === '') {
    return {
      schemaVersion: 1, conversationId, version: 0, activeLane: RETRIEVAL_LANE,
      stage: 'idle', previewId: null, uploadId: null, turn: null,
    };
  }
  const state = validateTreeConversation(JSON.parse(notes));
  if (state.conversationId !== conversationId) throw new Error('Conversation identity does not match its stored record.');
  return state;
}

function conflict(message, state) {
  const error = new Error(message);
  error.status = 409;
  error.laneContext = buildTreeLaneContext(state);
  return error;
}

async function mutateConversation({ principal, conversationId, expectedVersion }, mutate, { cleanupOnCreate = false } = {}) {
  assertTreeContextId(conversationId, 'conversationId');
  const { personalCacheTreeId: treeId, updatedBy } = await getPersonalCacheContext(principal);
  const pathSegments = ['Knowledge Trees', 'Conversations', conversationId, 'State'];
  if (cleanupOnCreate && expectedVersion === 0 &&
      !await findPersonalCacheLeafPathNode({ treeId, principal, pathSegments })) {
    await cleanupInactiveTreeConversations({ treeId, principal, conversationId });
  }
  return mutatePersonalCacheNotes({
    treeId, principal, updatedBy,
    pathSegments, expireAfterInactivity: true,
    createIfMissing: cleanupOnCreate && expectedVersion === 0,
    mutate: (notes) => {
      if (!notes && (!cleanupOnCreate || expectedVersion > 0)) {
        throw Object.assign(new Error('This conversation is no longer available. Reload chat to start a new conversation. Check previous action outcomes before retrying.'), {
          status: 410, code: 'CHAT_STATE_EXPIRED',
        });
      }
      const state = readState(notes, conversationId);
      const result = mutate(state);
      validateTreeConversation(state);
      return { notes: JSON.stringify(state), result };
    },
  });
}

export async function beginTreeTurn(options) {
  const { turnId, expectedVersion, previewUploadId } = options;
  assertTreeContextId(turnId, 'turnId');
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new Error('A non-negative expectedVersion is required.');
  }
  return mutateConversation(options, (state) => {
    if (state.turn?.id === turnId) {
      if (state.turn.status === 'completed') throw conflict('This turn has already completed and will not be executed again.', state);
      throw conflict(state.turn.status === 'running'
        ? 'This conversation already has a running turn. Do not retry its actions.'
        : 'This turn failed and will not be executed again. Check its outcome before submitting a new turn.', state);
    }
    if (state.turn?.status === 'running') {
      throw conflict('Another turn is running in this conversation. If it was interrupted, start a new conversation and check action outcomes before retrying.', state);
    }
    if (state.version !== expectedVersion) throw conflict('Conversation state changed. Refresh its context before submitting another turn.', state);
    if (previewUploadId && (state.uploadId !== previewUploadId || state.stage !== 'upload_processing')) {
      throw conflict('Upload completion was deferred because this is no longer its active workflow. Ask to continue the completed upload in a human turn.', state);
    }
    state.turn = { id: turnId, status: 'running' };
    state.version += 1;
    return { state: structuredClone(state) };
  }, { cleanupOnCreate: true });
}

export async function updateTreeTurn(options, patch) {
  return mutateConversation(options, (state) => {
    if (state.turn?.id !== options.turnId || state.turn.status !== 'running' || state.version !== options.version) {
      throw new Error('The active conversation turn changed. No further actions are authorized.');
    }
    Object.assign(state, patch);
    state.version += 1;
    return structuredClone(state);
  });
}

export async function completeTreeTurn(options, response) {
  return mutateConversation(options, (state) => {
    if (state.turn?.id !== options.turnId || state.turn.status !== 'running' || state.version !== options.version) {
      throw new Error('The conversation changed before its response could be recorded. Check action outcomes before retrying.');
    }
    state.version += 1;
    const laneContext = buildTreeLaneContext(state);
    const result = {
      ...response,
      laneContext,
      familyPayload: { ...response.familyPayload, laneContext },
    };
    state.turn = { ...state.turn, status: 'completed' };
    return result;
  });
}

export async function failTreeTurn(options) {
  return mutateConversation(options, (state) => {
    if (state.turn?.id !== options.turnId || state.turn.status !== 'running') {
      throw new Error('Could not record failure because the active turn changed.');
    }
    state.turn = { ...state.turn, status: 'failed' };
    state.previewId = null;
    if (state.stage === 'awaiting_approval') state.stage = 'idle';
    state.version += 1;
    return buildTreeLaneContext(state);
  });
}
