import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/treeConversationCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export const cleanupInactiveTreeConversations = (options) => globalThis.__cleanupLaneNotes(options);
        `)}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/personalCacheTreeRepository')) {
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export const getPersonalCacheContext = async (principal) => {
            if (!principal?.user) throw new Error('Authentication required');
            return { personalCacheTreeId: principal.app + ':' + principal.user, updatedBy: {} };
          };
          export const findPersonalCacheLeafPathNode = (options) => globalThis.__findLaneNotes(options);
          export const mutatePersonalCacheNotes = (options) => globalThis.__mutateLaneNotes(options);
        `)}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { beginTreeTurn, updateTreeTurn, completeTreeTurn, failTreeTurn } = await import('./treeConversationRepository.js');
let documents;
let queue;
let cleanups;
function setup() {
  documents = new Map();
  queue = Promise.resolve();
  cleanups = [];
  globalThis.__findLaneNotes = ({ treeId, pathSegments }) => (
    documents.has(`${treeId}:${pathSegments.join('/')}`) ? { id: 1 } : null
  );
  globalThis.__cleanupLaneNotes = async (options) => { cleanups.push(options); };
  globalThis.__mutateLaneNotes = ({ treeId, pathSegments, mutate, expireAfterInactivity }) => {
    assert.equal(expireAfterInactivity, true);
    const key = `${treeId}:${pathSegments.join('/')}`;
    const action = queue.then(() => {
      const { notes, result } = mutate(documents.get(key) ?? null);
      documents.set(key, notes);
      return result;
    });
    queue = action.catch(() => {});
    return action;
  };
}
const request = (extra = {}) => ({
  principal: { user: 'alice', app: 'app-a' }, conversationId: 'conversation-a',
  turnId: 'turn-a', expectedVersion: 0, message: 'Search for fish', ...extra,
});

test('only creation triggers cleanup, before claiming the new turn and within its owner scope', async () => {
  setup();
  const options = request();
  globalThis.__cleanupLaneNotes = async (scope) => {
    assert.equal(documents.size, 0);
    cleanups.push(scope);
  };
  await beginTreeTurn(options);
  assert.deepEqual(cleanups, [{
    treeId: 'app-a:alice', principal: options.principal, conversationId: options.conversationId,
  }]);
  await completeTreeTurn({ ...options, version: 1 }, { answer: 'First' });
  await beginTreeTurn(request({ turnId: 'turn-b', expectedVersion: 2 }));
  assert.equal(cleanups.length, 1);
});

test('cleanup failure is explicit and does not leave a newly claimed running turn', async () => {
  setup();
  globalThis.__cleanupLaneNotes = async () => { throw new Error('Cleanup unavailable'); };
  await assert.rejects(beginTreeTurn(request()), /Cleanup unavailable/);
  assert.equal(documents.size, 0);
});

test('conversation context starts in retrieval and is isolated by owner, app, and conversation', async () => {
  setup();
  for (const options of [
    request(), request({ principal: { user: 'bob', app: 'app-a' } }),
    request({ principal: { user: 'alice', app: 'app-b' } }), request({ conversationId: 'conversation-b' }),
  ]) {
    const { state } = await beginTreeTurn(options);
    assert.equal(state.activeLane, 'knowledge.retrieval');
    assert.equal(state.version, 1);
  }
  assert.equal(documents.size, 4);
  await assert.rejects(beginTreeTurn(request({ principal: null })), /Authentication/);
});

test('running turns, changed retries, and stale versions cannot execute another action', async () => {
  setup();
  const options = request();
  const results = await Promise.allSettled([beginTreeTurn(options), beginTreeTurn(options)]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.match(results.find(({ status }) => status === 'rejected').reason.message, /running turn/);
  await assert.rejects(beginTreeTurn(request({ message: 'Different content' })), /running turn/);
  const state = await updateTreeTurn({ ...options, version: 1 }, { activeLane: 'knowledge.saving' });
  assert.equal(state.version, 2);
  await assert.rejects(updateTreeTurn({ ...options, version: 1 }, {}), /changed/);
  const result = await completeTreeTurn({ ...options, version: 2 }, { answer: 'Nothing saved.', familyPayload: {} });
  assert.equal(result.laneContext.version, 3);
  await assert.rejects(beginTreeTurn(options), { status: 409, message: /already completed/ });
  await assert.rejects(beginTreeTurn(request({ turnId: 'turn-b', expectedVersion: 0 })), /state changed/);
});

test('saved conversations missing current quiz bindings are rejected rather than upgraded', async () => {
  setup();
  await beginTreeTurn(request());
  const [key, notes] = [...documents.entries()][0];
  const state = JSON.parse(notes);
  delete state.quizId;
  delete state.quizSetupId;
  documents.set(key, JSON.stringify(state));
  await assert.rejects(beginTreeTurn(request({ turnId: 'turn-b', expectedVersion: state.version })), /valid quizId/);
  assert.equal(documents.get(key), JSON.stringify(state));
});

test('quiz lane persists across turns without reusing saving workflow stages', async () => {
  setup();
  const options = request();
  await beginTreeTurn(options);
  await updateTreeTurn({ ...options, version: 1 }, { activeLane: 'quiz' });
  await assert.rejects(updateTreeTurn({ ...options, version: 2 }, { stage: 'awaiting_details' }), /Invalid Knowledge Trees workflow/);
  const result = await completeTreeTurn({ ...options, version: 2 }, { answer: 'Choose a test topic.' });
  assert.equal(result.laneContext.activeLane, 'quiz');
  const next = await beginTreeTurn(request({ turnId: 'turn-b', expectedVersion: result.laneContext.version }));
  assert.equal(next.state.activeLane, 'quiz');
  assert.equal(next.state.stage, 'idle');
});

test('completed turns reject duplicates and persist no response or request fingerprint', async () => {
  setup();
  const options = request();
  await beginTreeTurn(options);
  const response = { answer: 'Nothing saved.', debug: { requestId: 'debug-id' }, familyPayload: { knowledgeMode: 'grounded' } };
  const result = await completeTreeTurn({ ...options, version: 1 }, response);
  assert.equal(result.answer, response.answer);
  assert.deepEqual(result.debug, response.debug);
  assert.equal(result.familyPayload.knowledgeMode, 'grounded');
  assert.deepEqual(result.familyPayload.laneContext, result.laneContext);
  const stored = JSON.parse([...documents.values()][0]);
  assert.deepEqual(stored.turn, { id: options.turnId, status: 'completed' });
  assert.equal(stored.version, result.laneContext.version);
  for (const extra of [{}, { expectedVersion: stored.version }, { message: 'Different content', expectedVersion: stored.version }]) {
    await assert.rejects(beginTreeTurn(request(extra)), { status: 409, message: /already completed/ });
  }
});

test('older identities cannot bypass a stale version', async () => {
  setup();
  const first = request();
  await beginTreeTurn(first);
  await completeTreeTurn({ ...first, version: 1 }, { answer: 'First' });
  const second = request({ turnId: 'turn-b', expectedVersion: 2 });
  await beginTreeTurn(second);
  await completeTreeTurn({ ...second, version: 3 }, { answer: 'Second' });
  await assert.rejects(beginTreeTurn(first), /state changed/);
});

test('failed turns are not reexecuted and no failed preview becomes confirmation authority', async () => {
  setup();
  const options = request();
  await beginTreeTurn(options);
  await updateTreeTurn({ ...options, version: 1 }, {
    activeLane: 'knowledge.saving', stage: 'awaiting_approval', previewId: 'preview-a',
  });
  const context = await failTreeTurn(options);
  assert.equal(context.previewId, null);
  assert.equal(context.stage, 'idle');
  await assert.rejects(beginTreeTurn(options), /will not be executed again/);
  const next = await beginTreeTurn(request({ turnId: 'turn-b', expectedVersion: context.version }));
  assert.equal(next.state.previewId, null);
});

test('automatic upload completion is bound to the active upload and version', async () => {
  setup();
  const options = request();
  await beginTreeTurn(options);
  await updateTreeTurn({ ...options, version: 1 }, {
    activeLane: 'knowledge.saving', stage: 'upload_processing', uploadId: 'upload-a',
  });
  await completeTreeTurn({ ...options, version: 2 }, { answer: 'Processing' });
  await assert.rejects(beginTreeTurn(request({
    turnId: 'completion-b', expectedVersion: 3, previewUploadId: 'upload-b',
  })), /completion was deferred/);
  const started = await beginTreeTurn(request({
    turnId: 'completion-a', expectedVersion: 3, previewUploadId: 'upload-a',
  }));
  assert.equal(started.state.uploadId, 'upload-a');
});

test('malformed records and unknown lanes fail explicitly instead of defaulting', async () => {
  setup();
  await beginTreeTurn(request());
  const [key] = documents.keys();
  const stored = JSON.parse(documents.get(key));
  documents.set(key, JSON.stringify({ ...stored, activeLane: 'unknown-lane' }));
  await assert.rejects(beginTreeTurn(request()), /Unknown Knowledge Trees lane/);
  documents.set(key, '{bad-json');
  await assert.rejects(beginTreeTurn(request()), SyntaxError);
});

test('cleaned-up conversations cannot restart with an existing version or authorize delayed updates', async () => {
  setup();
  const options = request();
  await beginTreeTurn(options);
  documents.clear();
  await assert.rejects(beginTreeTurn(request({ turnId: 'later', expectedVersion: 1 })), {
    status: 410, message: /no longer available.*Reload chat/,
  });
  await assert.rejects(updateTreeTurn({ ...options, version: 1 }, {}), { status: 410 });
  await assert.rejects(completeTreeTurn({ ...options, version: 1 }, { answer: 'Late result' }), { status: 410 });
  await assert.rejects(failTreeTurn(options), { status: 410 });
  assert.equal(documents.size, 0);
  assert.equal(cleanups.length, 1);
});
