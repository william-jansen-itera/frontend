import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/interactionLookupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const findLatestActiveInteractionId = (options) => globalThis.__interactionLookup(options);')}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/interactionCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const cleanupInactiveInteractions = (options) => globalThis.__interactionCleanup(options);')}`,
        shortCircuit: true,
      };
    }
    if (specifier === '@/server/utils/agentOrchestration/personalCacheTreeRepository') {
      const code = `
        export const getPersonalCacheContext = async (principal) => {
          if (!principal?.userId) throw new Error('Authentication required');
          return { personalCacheTreeId: principal.app + ':' + principal.userId, updatedBy: {} };
        };
        export const mutatePersonalCacheNotes = (options) => globalThis.__interactionMutate(options);
        export const readPersonalCacheNotes = (options) => globalThis.__interactionRead(options);
      `;
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const url = new URL(`../../../../${specifier.slice(2)}.js`, import.meta.url);
      return nextResolve(existsSync(url) ? url.href : specifier, context);
    }
    return nextResolve(specifier, context);
  },
});
const { createInteractionRepository } = await import('./interactionRepository.js');
const { formatInteractionMessage } = await import('../../../../shared/interactions.js');
const { structuredInputDefinition, validateCollectionSpecification } = await import('../agents/knowledgeTrees/tools/collectStructuredInputTool/definition.js');
const { buildCollectionTestSpecification } = await import('../agents/knowledgeTrees/tools/collectStructuredInputTool/sampleSpecification.js');
const { createTreeInteractionRuntime } = await import('../agents/knowledgeTrees/treeInteractionRuntime.js');
const owner = { userId: 'owner', app: 'app' };
const binding = { conversationId: 'conversation-1', turnId: 'turn-1' };
const definition = structuredInputDefinition;
const repository = createInteractionRepository(definition);
const createCollection = (language = 'en') => repository.create(owner, language, buildCollectionTestSpecification(language));
let cleanups;

function setup() {
  const documents = new Map();
  cleanups = [];
  globalThis.__interactionLookup = async () => null;
  globalThis.__interactionCleanup = async (options) => {
    cleanups.push(options);
  };
  const key = ({ treeId, pathSegments }) => `${treeId}:${JSON.stringify(pathSegments)}`;
  globalThis.__interactionRead = async (options) => {
    assert.equal(options.expireAfterInactivity, true);
    return documents.get(key(options)) ?? null;
  };
  globalThis.__interactionMutate = async (options) => {
    assert.equal(options.expireAfterInactivity, true);
    const change = options.mutate(documents.get(key(options)) ?? null);
    documents.set(key(options), change.notes);
    return structuredClone(change.result);
  };
  return documents;
}
const collectorRepository = createInteractionRepository(structuredInputDefinition);
const collectorArgs = (operation, interactionId = null, specification = null, response = null) =>
  ({ operation, interactionId, specification, response });
function collectorRuntime(turnId = 'collector-start', extra = {}) {
  return createTreeInteractionRuntime({ principal: owner, ...binding, turnId, isQuizAllowed: () => false, ...extra });
}
function reference(card) {
  return { interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow };
}
async function startCollector(language = 'en') {
  const runtime = collectorRuntime('collector-start', { language });
  const specification = buildCollectionTestSpecification(language);
  await runtime.collect(collectorArgs('start', null, specification));
  specification.steps[0].fields[0].options[0].label = 'Changed outside the saved specification';
  return runtime.present();
}

test('collector rejects invalid specifications before creating records or cleaning cache', async () => {
  const documents = setup();
  for (const change of [
    (spec) => { spec.execute = 'send_email'; },
    (spec) => { spec.steps[1].id = spec.steps[0].id; },
    (spec) => { spec.steps[0].fields[0].type = 'script'; },
    (spec) => { spec.steps[1].fields[0].maxLength = 2001; },
    (spec) => { spec.steps[3].fields[0].options[1].id = 'cancel'; },
    (spec) => { spec.steps[0].id = 'constructor'; },
    (spec) => { spec.steps = Array.from({ length: 11 }, (_, i) => ({ ...spec.steps[0], id: `step-${i}` })); },
  ]) {
    const specification = buildCollectionTestSpecification();
    change(specification);
    assert.throws(() => validateCollectionSpecification(specification), { status: 400 });
    await assert.rejects(collectorRuntime().collect(collectorArgs('start', null, specification)), { status: 400 });
  }
  assert.equal(documents.size, 0);
  assert.equal(cleanups.length, 0);
});

test('collector accepts one response per turn and submits final Yes/No fields without a review step', async () => {
  for (const language of ['en', 'da']) {
    setup();
    let card = await startCollector(language);
    assert.equal(card.workflow, 'structured-input');
    assert.equal(card.progress.total, 4);
    assert.equal(card.fields[0].options[0].label, language === 'da' ? 'Natur' : 'Nature');
    let runtime = collectorRuntime('answer-topic');
    await runtime.prepare({ context: reference(card), message: 'The subject related to trees and animals.' });
    assert.equal(runtime.controlsTurn, true);
    await assert.rejects(runtime.collect(collectorArgs('respond', card.interactionId, null, {
      action: 'continue', fields: [{ id: 'topic', value: 'invented', selections: null }],
    })), /Invalid value/);
    assert.equal((await collectorRepository.read(owner, card.interactionId)).stepIndex, 0);
    await runtime.collect(collectorArgs('respond', card.interactionId, null, {
      action: 'continue', fields: [{ id: 'topic', value: 'nature', selections: null }],
    }));
    assert.equal(runtime.controlsTurn, true);
    await assert.rejects(runtime.collect(collectorArgs('respond', card.interactionId, null, {
      action: 'continue', fields: [{ id: 'note', value: 'Invented future answer', selections: null }],
    })), /No explicit human reply/);
    card = await runtime.present();
    assert.equal(card.stepId, 'note');
    assert.deepEqual(card.collectedValues, { topic: { topic: 'nature' } });

    runtime = collectorRuntime('answer-note');
    await runtime.prepare({ submission: {
      ...reference(card), submissionId: 'note-card', action: 'continue', values: { note: 'My exact note.' },
    }, message: 'Continue' });
    assert.match(runtime.validateAnswer({ answer: 'Not processed yet.' }), /Process or resume/);
    await runtime.collect(collectorArgs('process', card.interactionId));
    card = await runtime.present();
    assert.equal(card.stepId, 'features');

    for (const [stepId, message, value, selections] of [
      ['features', 'Both choices and navigation.', null, ['choices', 'navigation']],
      ['feedback', 'No.', 'no', null],
    ]) {
      runtime = collectorRuntime(`answer-${stepId}`);
      await runtime.prepare({ context: reference(card), message });
      if (stepId === 'feedback') {
        assert.deepEqual(card.allowedActions, ['back', 'submit', 'cancel']);
        await assert.rejects(runtime.collect(collectorArgs('respond', card.interactionId, null, {
          action: 'submit', fields: [],
        })), /Invalid value/);
        assert.equal(runtime.controlsTurn, true);
      }
      await runtime.collect(collectorArgs('respond', card.interactionId, null, {
        action: stepId === 'feedback' ? 'submit' : 'continue', fields: [{ id: stepId, value, selections }],
      }));
      card = await runtime.present();
    }
    assert.equal(card.stepId, 'feedback');
    assert.equal(card.status, 'completed');
    assert.deepEqual(card.collectedValues.feedback, { feedback: 'no' });
    assert.equal(card.review, undefined);
    assert.equal(runtime.controlsTurn, false);
    assert.equal(runtime.validateAnswer({
      answer: 'Continuing the original workflow.', knowledgeMode: 'grounded', isPersistenceOffer: false,
      isPermissionToBroadenRequest: false, isWaitingForContinuation: false, persistenceAction: 'previewed',
    }), null);
    card = await runtime.present();
    assert.equal(card.status, 'completed');
    assert.deepEqual(card.allowedActions, []);
    assert.equal(card.collectedValues.note.note, 'My exact note.');
  }
});

test('clarification and ordinary chat do not advance or authorize interpreted values', async () => {
  setup();
  const original = await startCollector();
  const ordinary = collectorRuntime('ordinary-chat');
  await ordinary.prepare({ message: 'Nature, and please send an email.' });
  assert.equal(ordinary.controlsTurn, false);
  await assert.rejects(ordinary.collect(collectorArgs('respond', original.interactionId, null, {
    action: 'continue', fields: [{ id: 'topic', value: 'nature', selections: null }],
  })), /No explicit human reply/);
  const runtime = collectorRuntime('unclear-reply');
  await runtime.prepare({ context: reference(original), message: 'Could you explain the options?' });
  assert.equal(runtime.validateAnswer({
    answer: 'Do you mean Nature or Technology?', knowledgeMode: 'grounded', isPersistenceOffer: false,
    isPermissionToBroadenRequest: false, isWaitingForContinuation: false, persistenceAction: 'none',
  }), null);
  const card = await runtime.present();
  assert.equal(card.stepId, original.stepId);
  assert.deepEqual(card.collectedValues, {});
  await assert.rejects(collectorRuntime('stale-reply').prepare({
    context: reference(original), message: 'Nature',
  }), { status: 409 });
  await assert.rejects(collectorRuntime('wrong-workflow', { isQuizAllowed: () => true }).prepare({
    context: { ...reference(card), workflow: 'interaction-test' }, message: 'Nature',
  }), /Use only the owning interaction tool/);
  await assert.rejects(collectorRuntime('wrong-owner', { principal: { ...owner, userId: 'other' } }).prepare({
    context: reference(card), message: 'Nature',
  }), { status: 404 });
});

test('one-step collections submit their fields directly, reject Continue and incomplete input, and complete once', async () => {
  for (const [index, values] of [
    [0, { topic: 'nature' }], [1, { note: 'One-step note.' }],
    [2, { features: ['choices'] }], [3, { feedback: 'no' }],
  ]) {
    setup();
    const specification = buildCollectionTestSpecification();
    specification.steps = [specification.steps[index]];
    const started = collectorRuntime();
    await started.collect(collectorArgs('start', null, specification));
    const card = await started.present();
    assert.deepEqual(card.allowedActions, ['submit', 'cancel']);
    assert.deepEqual(card.progress, { current: 1, total: 1 });
    const runtime = collectorRuntime('submit-one-step');
    await assert.rejects(runtime.prepare({ submission: {
      ...reference(card), action: 'continue', values, submissionId: 'wrong-action',
    } }), /not available/);
    await assert.rejects(runtime.prepare({ submission: {
      ...reference(card), action: 'submit', values: {}, submissionId: 'missing-input',
    } }), /Invalid/);
    assert.equal((await collectorRepository.read(owner, card.interactionId)).status, 'active');
    await runtime.prepare({ submission: {
      ...reference(card), action: 'submit', values, submissionId: 'direct-submit',
    } });
    await runtime.collect(collectorArgs('process', card.interactionId));
    assert.equal(runtime.controlsTurn, false);
    const completed = await runtime.present();
    assert.equal(completed.status, 'completed');
    assert.deepEqual(completed.collectedValues, { [card.stepId]: values });
    assert.deepEqual(completed.allowedActions, []);
    await assert.rejects(runtime.collect(collectorArgs('process', card.interactionId)), /No human submission/);
  }
});

test('only current saved workflow versions are accepted, without migration or reinterpretation', async () => {
  const documents = setup();
  const state = await collectorRepository.create(owner, 'en', buildCollectionTestSpecification());
  const [key] = documents.keys();
  for (const workflowVersion of [1, 99]) {
    documents.set(key, JSON.stringify({ ...state, workflowVersion }));
    await assert.rejects(collectorRepository.read(owner, state.id), /Invalid saved interaction/);
  }
});

test('collector resume uses its own workflow and upload-bound collection is rejected', async () => {
  setup();
  const card = await startCollector();
  globalThis.__interactionLookup = async (options) => {
    assert.deepEqual(options, { treeId: 'app:owner', principal: owner, workflow: 'structured-input' });
    return card.interactionId;
  };
  const runtime = collectorRuntime('resume-collector', { conversationId: 'another-conversation' });
  await runtime.collect(collectorArgs('resume'));
  assert.equal((await runtime.present()).interactionId, card.interactionId);
  for (const key of ['uploadId', 'previewUploadId', 'pendingUploadId']) {
    await assert.rejects(collectorRuntime(`blocked-${key}`, { [key]: 'upload-1' })
      .collect(collectorArgs('start', null, buildCollectionTestSpecification())), /unavailable during upload/);
  }
});

test('editing an earlier collected response invalidates later answers without changing the saved specification', async () => {
  setup();
  let card = await startCollector();
  let sequence = 0;
  async function act(action, values = {}) {
    const runtime = collectorRuntime(`edit-${++sequence}`);
    await runtime.prepare({ submission: {
      ...reference(card), action, values, submissionId: `edit-input-${sequence}`,
    }, message: action });
    await runtime.collect(collectorArgs('process', card.interactionId));
    card = await runtime.present();
  }
  await act('continue', { topic: 'nature' });
  await act('continue', { note: 'Original note.' });
  await act('continue', { features: ['choices'] });
  await act('back');
  await act('back');
  assert.equal(card.stepId, 'note');
  await act('continue', { note: 'Revised note.' });
  assert.equal(card.stepId, 'features');
  assert.deepEqual(card.collectedValues, { topic: { topic: 'nature' }, note: { note: 'Revised note.' } });
  assert.equal((await collectorRepository.read(owner, card.interactionId)).specification.steps.length, 4);
});

test('creation alone triggers scoped cleanup before saving; cleanup failure prevents the new record', async () => {
  setup();
  globalThis.__interactionCleanup = async (options) => {
    await assert.rejects(repository.read(owner, options.interactionId), { status: 404 });
    cleanups.push(options);
  };
  const state = await present(await createCollection());
  assert.deepEqual(cleanups, [{ treeId: 'app:owner', principal: owner, interactionId: state.id }]);
  await repository.read(owner, state.id);
  await step(state, 'continue', { topic: 'nature' });
  assert.equal(cleanups.length, 1);
  let newId;
  globalThis.__interactionCleanup = async ({ interactionId }) => {
    newId = interactionId;
    throw new Error('Cleanup unavailable');
  };
  await assert.rejects(createCollection(), /Cleanup unavailable/);
  await assert.rejects(repository.read(owner, newId), /not found/);
});
async function present(state, turnId = binding.turnId, conversationId = binding.conversationId) {
  return repository.present(owner, state.id, { turnId, conversationId, expectedVersion: state.version });
}
function input(state, action, values = {}, submissionId = `submission-${state.version}`) {
  return {
    interactionId: state.id, version: state.version, stepId: definition.describe(state).stepId,
    workflow: state.workflow, action, values, submissionId,
  };
}
async function step(state, action, values = {}) {
  const turn = { ...binding, turnId: `turn-${state.version + 1}` };
  await repository.capture(owner, input(state, action, values), turn);
  return present(await repository.process(owner, state.id, turn), turn.turnId);
}

test('submitted values persist before processing, steps complete once, and plain/tool response messages are readable', async () => {
  setup();
  let state = await present(await createCollection());
  const submission = input(state, 'continue', { topic: 'nature' });
  const pending = await repository.capture(owner, submission, { ...binding, turnId: 'answer-turn' });
  assert.equal(pending.stepIndex, 0);
  assert.equal(pending.pending.values.topic, 'nature');
  assert.deepEqual(pending.values, {});
  assert.equal((await repository.read(owner, state.id)).pending.submissionId, submission.submissionId);
  await assert.rejects(repository.capture(owner, submission, { ...binding, turnId: 'duplicate' }), /changed/);
  state = await repository.process(owner, state.id, { ...binding, turnId: 'answer-turn' });
  await assert.rejects(repository.process(owner, state.id, { ...binding, turnId: 'answer-turn' }), /no captured/);
  state = await present(state, 'answer-turn');
  state = await step(state, 'continue', { note: 'An actual human note.' });
  const descriptor = definition.describe(state);
  assert.match(formatInteractionMessage(descriptor, 'continue', { features: ['navigation'] }, 'Continue'), /Navigation/);
  state = await step(state, 'continue', { features: ['navigation'] });
  assert.equal(state.stepIndex, 3);
  state = await step(state, 'submit', { feedback: 'yes' });
  assert.equal(state.status, 'completed');
  assert.deepEqual(definition.describe(state).allowedActions, []);
  await assert.rejects(repository.capture(owner, input(state, 'back'), { ...binding, turnId: 'later' }), /not available/);
});

test('Back preserves values until an edit invalidates dependent steps; invalid fields do not advance', async () => {
  setup();
  let state = await present(await createCollection());
  await assert.rejects(repository.capture(owner, input(state, 'back'), { ...binding, turnId: 'back' }), /not available/);
  await assert.rejects(repository.capture(owner, input(state, 'continue', { topic: 'invented' }), { ...binding, turnId: 'bad' }), /Invalid value/);
  state = await step(state, 'continue', { topic: 'nature' });
  state = await step(state, 'continue', { note: 'Keep until changed.' });
  state = await step(state, 'continue', { features: [] });
  state = await step(state, 'back');
  state = await step(state, 'back');
  assert.equal(state.values.note.note, 'Keep until changed.');
  state = await step(state, 'continue', { note: 'Changed.' });
  assert.equal(state.values.features, undefined);
  assert.equal(state.values.feedback, undefined);
  assert.equal(state.values.topic.topic, 'nature');
  state = await step(state, 'cancel');
  assert.equal(state.status, 'cancelled');
});

test('presentation, ownership, application, versions and pending recovery are enforced independently of history', async () => {
  setup();
  let state = await createCollection('da');
  assert.equal(definition.describe(state).workflow, 'structured-input');
  await assert.rejects(repository.capture(owner, input(state, 'continue', { topic: 'nature' }), binding), /not presented/);
  state = await present(state);
  const submission = input(state, 'continue', { topic: 'nature' });
  await assert.rejects(repository.capture(owner, { ...submission, workflow: 'quiz' },
    { ...binding, turnId: 'wrong-workflow' }), /changed or is not presented/);
  await assert.rejects(repository.capture(owner, submission, binding), /not presented/);
  await assert.rejects(repository.read({ ...owner, userId: 'other' }, state.id), /not found/);
  await assert.rejects(repository.read({ ...owner, app: 'other' }, state.id), /not found/);
  await assert.rejects(repository.read(null, state.id), /Authentication/);
  await repository.capture(owner, submission, { ...binding, turnId: 'interrupted' });
  await assert.rejects(repository.process(owner, state.id, { ...binding, turnId: 'new-turn' }), /Resume/);
  state = await repository.process(owner, state.id, { conversationId: 'new-conversation', turnId: 'resume', resume: true });
  assert.equal(state.stepIndex, 1);
  const recovered = await repository.process(owner, state.id, { ...binding, resume: true });
  assert.equal(recovered.stepIndex, 1);
  state = await present(recovered, 'resume', 'new-conversation');
  await assert.rejects(repository.capture(owner, input(state, 'continue', { note: 'stale tab' }), { ...binding, turnId: 'later' }), /not presented/);
  await assert.rejects(repository.present(owner, state.id, { ...binding, expectedVersion: state.version - 1 }), /changed/);
});
