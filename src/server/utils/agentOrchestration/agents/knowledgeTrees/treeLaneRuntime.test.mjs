import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier.endsWith('/agentToolResult')
      ? nextResolve(new URL('../../agentToolResult.js', import.meta.url).href, context)
      : nextResolve(specifier, context);
  },
});
const { createTreeLaneRuntime } = await import('./treeLaneRuntime.js');
const { buildTreeLaneInstruction } = await import('./treeLaneState.js');

function runtime(extra = {}, handlers = new Map()) {
  let state = {
    schemaVersion: 1, conversationId: 'conversation-a', version: 1,
    activeLane: 'knowledge.retrieval', stage: 'idle', previewId: null, uploadId: null,
    ...extra.state,
  };
  let failPersist = false;
  const lane = createTreeLaneRuntime({
    ...extra, state,
    persist: async (version, patch) => {
      if (failPersist || version !== state.version) throw new Error('Context conflict');
      state = { ...state, ...patch, version: state.version + 1 };
      return state;
    },
  });
  lane.wrapHandlers(handlers, new Map(), extra.getToolInstruction);
  return { lane, handlers, conflict: () => { failPersist = true; } };
}
const preview = (id = 'preview-a') => ({ toolOutput: { toolResultType: 'tree_note_preview', data: { previewId: id } } });
const switchLane = (handlers, activeLane) => handlers.get('switch_tree_lane')({ activeLane, reason: 'The current human requested this workflow.' });

test('switch responses refresh tool guidance and detach quiz bindings without deleting domain state', async () => {
  let lane;
  const instance = runtime({
    state: { activeLane: 'quiz', quizId: 'quiz-a', quizSetupId: null },
    getToolInstruction: () => `Tools now available for ${lane.state.activeLane}`,
  });
  lane = instance.lane;
  const switched = await switchLane(instance.handlers, 'knowledge.retrieval');
  assert.match(switched.data.instruction, /Tools now available for knowledge.retrieval/);
  assert.equal(lane.state.quizId, null);
  assert.equal(lane.state.quizSetupId, null);
  await assert.rejects(lane.bindQuiz('quiz-a'), /Switch to quiz/);
});

test('tools are rechecked after every lane transition, including calls queued in one batch', async () => {
  let searches = 0;
  let previews = 0;
  const handlers = new Map([
    ['search_tree_topics_1', async () => { searches++; return {}; }],
    ['preview_save_to_tree', async () => { previews++; return preview(); }],
  ]);
  const { lane } = runtime({}, handlers);
  await assert.rejects(handlers.get('preview_save_to_tree')({}), /not allowed/);
  await handlers.get('search_tree_topics_1')({ query: 'fish' });
  const switched = await switchLane(handlers, 'knowledge.saving');
  assert.equal(switched.data.activeLane, 'knowledge.saving');
  assert.match(switched.data.instruction, /"activeLane":"knowledge.saving"/);
  await assert.rejects(handlers.get('search_tree_topics_1')({ query: 'fish' }), /not allowed/);
  await handlers.get('preview_save_to_tree')({});
  assert.equal(lane.state.stage, 'awaiting_approval');
  assert.equal(searches, 1);
  assert.equal(previews, 1);
  await assert.rejects(switchLane(handlers, 'knowledge.retrieval'), /Report the saving workflow result/);
});

test('retrying an earlier proposal cannot resurrect a preview replaced by revision', async () => {
  const handlers = new Map([
    ['preview_save_to_tree', async () => preview()],
    ['revise_save_preview', async () => preview('preview-b')],
  ]);
  const { lane } = runtime({ state: { activeLane: 'knowledge.saving' } }, handlers);
  await handlers.get('preview_save_to_tree')({ title: 'Topic' });
  await handlers.get('revise_save_preview')({ previewId: 'preview-a', path: 'New > Topic' });
  await assert.rejects(handlers.get('preview_save_to_tree')({ title: 'Topic' }), /superseded/);
  assert.equal(lane.state.previewId, 'preview-b');
});

test('quiz is a separate lane: its tool requires switching and cannot execute retrieval or saving tools', async () => {
  let tests = 0;
  let searches = 0;
  const handlers = new Map([
    ['quiz', async () => { tests++; return {}; }],
    ['search_tree_topics_1', async () => { searches++; return {}; }],
    ['preview_save_to_tree', async () => preview()],
    ['unknown_tool', async () => { throw new Error('Must never execute'); }],
  ]);
  const { lane } = runtime({}, handlers);
  await assert.rejects(handlers.get('quiz')({}), /not allowed in knowledge.retrieval/);
  await switchLane(handlers, 'knowledge.saving');
  await assert.rejects(handlers.get('quiz')({}), /not allowed in knowledge.saving/);
  const switched = await switchLane(handlers, 'quiz');
  assert.equal(switched.data.activeLane, 'quiz');
  assert.match(switched.data.instruction, /Knowledge common rules apply only.*never quiz/);
  await handlers.get('quiz')({});
  assert.equal(tests, 1);
  await assert.rejects(handlers.get('search_tree_topics_1')({}), /not allowed in quiz/);
  await assert.rejects(handlers.get('preview_save_to_tree')({}), /not allowed in quiz/);
  await assert.rejects(handlers.get('unknown_tool')({}), /not allowed in quiz/);
  assert.equal(searches, 0);
  await switchLane(handlers, 'knowledge.retrieval');
  await handlers.get('search_tree_topics_1')({});
  assert.equal(searches, 1);
  assert.equal(lane.state.activeLane, 'knowledge.retrieval');
});

test('wrapped preview results retain confirmation authority across turns with and without debug', async () => {
  for (const includeDebug of [false, true]) {
    const proposed = preview();
    if (includeDebug) proposed.debug = { toolOutput: proposed.toolOutput };
    const first = runtime({ state: { activeLane: 'knowledge.saving' } },
      new Map([['preview_save_to_tree', async () => proposed]]));
    assert.equal(await first.handlers.get('preview_save_to_tree')({ title: 'Topic' }), proposed);
    await first.lane.finishResponse({ answer: 'Save Topic?\n\n<!-- Preview ID: preview-a -->' });
    assert.equal(first.lane.state.previewId, 'preview-a');
    assert.equal(first.lane.state.stage, 'awaiting_approval');

    const saved = { toolOutput: { toolResultType: 'tree_note_created', data: {} } };
    const next = runtime({ state: first.lane.state },
      new Map([['confirm_save_to_tree', async () => saved]]));
    assert.equal(await next.handlers.get('confirm_save_to_tree')({ previewId: 'preview-a' }), saved);
    assert.equal(next.lane.state.previewId, null);
    assert.equal(next.lane.state.stage, 'completed');
  }
});

test('leaving saving cannot revive confirmation by switching back', async () => {
  for (const destination of ['knowledge.retrieval', 'quiz']) {
    let confirms = 0;
    const handlers = new Map([['confirm_save_to_tree', async () => { confirms++; return {}; }]]);
    const { lane } = runtime({
      state: { activeLane: 'knowledge.saving', stage: 'awaiting_approval', previewId: 'preview-a' },
    }, handlers);
    await switchLane(handlers, destination);
    await switchLane(handlers, 'knowledge.saving');
    await assert.rejects(handlers.get('confirm_save_to_tree')({ previewId: 'preview-a' }), /not active/);
    assert.equal(lane.state.previewId, null);
    assert.equal(lane.confirmationRevoked, true);
    assert.equal(confirms, 0);
  }
});

test('identical successful tool retries do not duplicate a save', async () => {
  let saves = 0;
  const saved = { toolOutput: { toolResultType: 'tree_note_created', data: {} } };
  const handlers = new Map([['confirm_save_to_tree', async () => { saves++; return saved; }]]);
  const { lane } = runtime({
    state: { activeLane: 'knowledge.saving', stage: 'awaiting_approval', previewId: 'preview-a' },
  }, handlers);
  const args = { previewId: 'preview-a', saveMode: 'create_leaf' };
  assert.equal(await handlers.get('confirm_save_to_tree')(args), saved);
  assert.equal(await handlers.get('confirm_save_to_tree')(args), saved);
  assert.equal(saves, 1);
  assert.equal(lane.state.stage, 'completed');
});

test('failed persistence stops transitions and destination operations', async () => {
  let calls = 0;
  const handlers = new Map([['search_tree_topics_1', async () => { calls++; }]]);
  const { lane, conflict } = runtime({}, handlers);
  conflict();
  await assert.rejects(switchLane(handlers, 'knowledge.saving'), /Context conflict/);
  assert.equal(lane.state.activeLane, 'knowledge.retrieval');
  await assert.rejects(handlers.get('search_tree_topics_1')({}), /Context conflict/);
  assert.equal(calls, 0);
});

test('automated completions cannot switch lanes and initial uploads must use saving', async () => {
  const automated = runtime({ previewUploadId: 'upload-a', state: { activeLane: 'knowledge.saving' } });
  await assert.rejects(switchLane(automated.handlers, 'knowledge.retrieval'), /automated upload completion/);
  await assert.rejects(switchLane(automated.handlers, 'quiz'), /automated upload completion/);
  const attached = runtime({ uploadId: 'upload-a' });
  await assert.rejects(switchLane(attached.handlers, 'knowledge.retrieval'), /newly attached upload/);
  await assert.rejects(switchLane(attached.handlers, 'quiz'), /newly attached upload/);
  await switchLane(attached.handlers, 'knowledge.saving');
  assert.equal(attached.lane.state.uploadId, 'upload-a');
});

test('quiz rejects broadening, saving and automated-continuation outcomes even without an active interaction', () => {
  const { lane } = runtime({ state: { activeLane: 'quiz' } });
  const status = {
    knowledgeMode: 'grounded', isPermissionToBroadenRequest: false, isPersistenceOffer: false,
    persistenceAction: 'none', isWaitingForContinuation: false,
  };
  assert.equal(lane.validateAnswer(status), null);
  for (const invalid of [
    { knowledgeMode: 'broad' }, { isPermissionToBroadenRequest: true },
    { isPersistenceOffer: true }, { persistenceAction: 'saved' }, { isWaitingForContinuation: true },
  ]) {
    assert.match(lane.validateAnswer({ ...status, ...invalid }), /active lane is quiz/);
  }
});

test('saving rejects retrieval-only final states and context does not imply consent', () => {
  const { lane } = runtime({ state: { activeLane: 'knowledge.saving' } });
  assert.match(lane.validateAnswer({ knowledgeMode: 'broad', isPersistenceOffer: true }), /knowledge.retrieval/);
  assert.equal(lane.validateAnswer({ knowledgeMode: 'grounded', isPersistenceOffer: false, isPermissionToBroadenRequest: false }), null);
  assert.match(buildTreeLaneInstruction(lane.state), /stage is not human approval/);
});
