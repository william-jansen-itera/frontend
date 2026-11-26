import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/interactionLookupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const findLatestActiveInteractionId = (options) => globalThis.__laneLookup(options);')}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/interactionCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const cleanupInactiveInteractions = async () => {};')}`,
        shortCircuit: true,
      };
    }
    if (specifier.endsWith('/treeConversationCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const cleanupInactiveTreeConversations = async () => {};')}`,
        shortCircuit: true,
      };
    }
    const name = specifier.split('/').at(-1);
    const stubs = {
      logging: 'export const logStructuredTrace = async () => {};',
      foundryAgentClient: 'export const getProjectClient = () => { globalThis.__laneFoundry.push("client"); return { getOpenAIClient: () => globalThis.__laneClient }; };',
      personalCacheTreeRepository: `
        export const getPersonalCacheContext = async () => ({ personalCacheTreeId: 1, updatedBy: {} });
        export const findPersonalCacheLeafPathNode = () => globalThis.__laneFind();
        export const mutatePersonalCacheNotes = (options) => globalThis.__laneMutate(options);
        export const readPersonalCacheNotes = (options) => globalThis.__laneRead(options);`,
      treeCatalog: 'export const getTreeList = async () => [{ id: 1, currentUserCanWrite: true }]; export const assertTreeAccess = async () => { throw new Error("Unexpected access check in a tool-result builder"); };',
      treeAgentCatalog: `
        export const KNOWLEDGE_TREES_FAMILY = 'knowledgeTrees';
        export const getPublishedKnowledgeTreesPromptAgent = async () => { globalThis.__laneFoundry.push('agent'); return { id: 'agent', name: 'agent', version: '1' }; };
        export const buildRuntimeTreeToolContext = async (options) => { globalThis.__laneFoundry.push('tools'); return globalThis.__laneTools(options); };
        export const buildVisibilityScopeContext = () => ({ visibility: 'private' });
        export const buildVisibilityScopeInstruction = () => 'Private trees only';
        export const buildAllowedToolInstruction = () => 'search_tree_topics_1';`,
    };
    if (specifier.startsWith('@/') && stubs[name]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[name])}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const base = new URL(`../../../../../${specifier.slice(2)}`, import.meta.url);
      const file = new URL(`${base.href}.js`);
      return nextResolve(existsSync(file) ? file.href : new URL(`${base.href}/index.js`).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { invokeKnowledgeTreesAgent } = await import('./treeAgentService.js');
const { buildPersistenceToolHandlerResult } = await import('./tools/persistenceToolShared.js');
const { buildCollectionTestSpecification } = await import('./tools/collectStructuredInputTool/sampleSpecification.js');
const previewId = 'c125d350-4cae-4ad4-a69c-419324125e00';
const uploadId = '60b8daca-abcd-4321-8000-000000000001';
const path = 'Topics > Fish';
const noteLink = '[View note](/notes?treeId=1&nodeId=2)';
const note = 'Fish live in water.';
let context;
let history;
let calls;
let modelRequests;
let turnSequence;
let responses;
let expiredPaths;

function final(answer, extra = {}) {
  return {
    id: `response-${Math.random()}`, output: [],
    output_text: JSON.stringify({
      answer, knowledgeMode: 'grounded', isPermissionToBroadenRequest: false,
      isPersistenceOffer: false, explanation: 'Reporting this turn.',
      persistenceAction: 'none', isWaitingForContinuation: false,
      responseLanguage: 'en', languageReason: 'The current message is English.', ...extra,
    }),
  };
}
function tool(name, args) {
  return { type: 'function_call', name, call_id: `call-${Math.random()}`, arguments: JSON.stringify(args) };
}
function tools(...output) {
  return { id: `tools-${Math.random()}`, output };
}
function quizSwitch() {
  return tool('switch_tree_lane', { activeLane: 'quiz', reason: 'The human requested the interaction test or its resume.' });
}
function setup() {
  const documents = new Map();
  const key = ({ pathSegments }) => JSON.stringify(pathSegments);
  expiredPaths = new Set();
  globalThis.__laneLookup = async () => {
    const match = [...documents.entries()].reverse().find(([path, notes]) => {
      const state = JSON.parse(notes);
      return path.includes('"Interactions"') && !expiredPaths.has(path) &&
        state.workflow === 'interaction-test' && state.status === 'active';
    });
    return match ? JSON.parse(match[1]).id : null;
  };
  function assertNotExpired(options) {
    if (options.expireAfterInactivity && expiredPaths.has(key(options))) {
      throw Object.assign(new Error('Saved chat state expired after 24 hours of inactivity. Reload chat.'), {
        status: 410, code: 'CHAT_STATE_EXPIRED',
      });
    }
  }
  globalThis.__laneRead = async (options) => {
    assertNotExpired(options);
    return documents.get(key(options)) ?? null;
  };
  globalThis.__laneFind = () => documents.size ? { id: 1 } : null;
  context = { conversationId: 'integration-conversation', version: 0 };
  history = [];
  calls = { preview: 0, save: 0, search: 0, process: 0 };
  modelRequests = [];
  globalThis.__laneFoundry = [];
  turnSequence = 0;
  globalThis.__laneMutate = async (options) => {
    assertNotExpired(options);
    const change = options.mutate(documents.get(key(options)) ?? null);
    documents.delete(key(options));
    documents.set(key(options), change.notes);
    return change.result;
  };
  globalThis.__laneClient = {
    responses: { create: async (request, configuration) => {
      modelRequests.push({ request, configuration });
      assert.ok(responses.length, 'Unexpected additional model call');
      const response = responses.shift();
      return typeof response === 'function' ? response() : response;
    } },
  };
  globalThis.__laneTools = ({ interactionRuntime }) => ({
    includedTrees: [{ id: 1, isPrivate: true }],
    toolPolicies: new Map(['search_tree_topics_1', 'preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree', 'process_upload', 'test_multistep_interaction', 'collect_structured_input']
      .map((name) => [name, { requiresUserApproval: false }])),
    handlerMap: new Map([
      ['test_multistep_interaction', (args) => interactionRuntime.handle(args)],
      ['collect_structured_input', (args) => interactionRuntime.collect(args)],
      ['search_tree_topics_1', async () => {
        calls.search++;
        return { count: 1, results: [{ treeId: 1, nodeId: 2, title: 'Fish' }] };
      }],
      ['preview_save_to_tree', async () => {
        calls.preview++;
        return buildPersistenceToolHandlerResult({
          toolName: 'preview_save_to_tree', toolResultType: 'tree_note_preview',
          toolOutput: { previewId, defaultSavePath: path },
        });
      }],
      ['confirm_save_to_tree', async () => {
        calls.save++;
        return buildPersistenceToolHandlerResult({
          toolName: 'confirm_save_to_tree', toolResultType: 'tree_note_created',
          toolOutput: { noteLink, details: { notes: note } },
        });
      }],
      ['revise_save_preview', async () => { throw new Error('Not expected in this scenario'); }],
      ['process_upload', async () => {
        calls.process++;
        return { toolResultType: 'temporary_upload_note', data: { uploadId, status: 'queued' } };
      }],
    ]),
  });
}
function options(message, extra) {
  return {
    principal: { userId: 'owner' }, message, history: structuredClone(history), visibility: 'private',
    language: 'en', conversationId: context.conversationId, expectedVersion: context.version,
    turnId: `turn-${++turnSequence}`, ...extra,
  };
}
async function submit(message, nextResponses, extra = {}) {
  responses = [...nextResponses];
  const request = options(message, extra);
  const result = await invokeKnowledgeTreesAgent(request);
  context = result.laneContext;
  history.push({ role: 'user', content: message }, { role: 'assistant', content: result.answer });
  assert.equal(responses.length, 0);
  return { request, result };
}

test('the shared collector starts in any lane without authorizing retrieval or saving', async () => {
  for (const activeLane of ['knowledge.retrieval', 'knowledge.saving', 'quiz']) {
    setup();
    const switching = activeLane === 'knowledge.retrieval' ? [] : [
      tool('switch_tree_lane', { activeLane, reason: 'Prepare the requested lane.' }),
    ];
    const { result } = await submit('Test structured interaction.', [
      tools(...switching, tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(), response: null,
      })),
      final('Choose a topic.'),
    ]);
    assert.equal(result.laneContext.activeLane, activeLane);
    assert.equal(result.interaction.workflow, 'structured-input');
    assert.equal(result.interaction.stepId, 'topic');
    assert.equal(result.interaction.progress.total, 4);
    assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
  }
});

test('ordinary chat remains independent, while a scoped interpreted response advances only its collector', async () => {
  setup();
  const { result: started } = await submit('Test structured interaction.', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(), response: null,
    })), final('Choose a topic.'),
  ]);
  const { result: ordinary } = await submit('Tell me about fish.', [
    tools(tool('search_tree_topics_1', { query: 'fish' })), final('Fish live in water.'),
  ]);
  assert.equal(ordinary.interaction, undefined);
  assert.equal(calls.search, 1);
  const card = started.interaction;
  const { result } = await submit('The topic about plants and animals.', [
    tools(tool('search_tree_topics_1', { query: 'plants' }), tool('collect_structured_input', {
      operation: 'respond', interactionId: card.interactionId, specification: null,
      response: { action: 'continue', fields: [{ id: 'topic', value: 'nature', selections: null }] },
    })), final('Enter a short note.'),
  ], { interactionContext: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
  } });
  assert.equal(result.interaction.stepId, 'note');
  assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'nature' } });
  assert.equal(calls.search, 1);
  assert.equal(calls.save, 0);
});

async function collectorAtSubmit() {
  const specification = buildCollectionTestSpecification();
  specification.steps = specification.steps.slice(0, 2);
  const { result: started } = await submit('Collect my topic before continuing.', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification, response: null,
    })), final('Choose a topic.'),
  ]);
  const card = started.interaction;
  const { result } = await submit('Nature', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: `topic-${card.version}`, action: 'continue', values: { topic: 'nature' },
  } });
  return result.interaction;
}

async function submitDirectCollectorCard(card, action, values = {}, extra = {}) {
  const previousModels = modelRequests.length;
  const previousFoundry = globalThis.__laneFoundry.length;
  const { result } = await submit(action, [], {
    includeDebug: true, ...extra, interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: `direct-${turnSequence + 1}`, action, values,
    },
  });
  assert.equal(modelRequests.length, previousModels);
  assert.equal(globalThis.__laneFoundry.length, previousFoundry, 'No client, published-agent lookup or tool discovery');
  assert.equal(result.agent, null);
  assert.deepEqual(result.toolsUsed, []);
  assert.deepEqual(result.toolInvocations, []);
  assert.deepEqual(result.citations, []);
  assert.equal(result.knowledgeMode, 'grounded');
  assert.equal(result.isPersistenceOffer, false);
  assert.equal(result.isPermissionToBroadenRequest, false);
  assert.equal(result.isWaitingForContinuation, false);
  assert.deepEqual(result.familyPayload.interaction, result.interaction);
  assert.equal(result.answer, result.interaction.prompt);
  assert.equal(result.debug.executionMode, 'server-interaction');
  assert.deepEqual(result.debug.timings.modelCalls, []);
  return result;
}

test('collector cards handle resume, fields, Back/edit invalidation and cancellation without Foundry', async () => {
  for (const language of ['en', 'da']) {
    setup();
    const { result: started } = await submit('Collect information.', [
      tools(tool('collect_structured_input', {
        operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(language), response: null,
      })), final('Choose a topic.'),
    ], { language });
    let result = await submitDirectCollectorCard(started.interaction, 'resume');
    assert.equal(result.interaction.stepId, 'topic');
    result = await submitDirectCollectorCard(result.interaction, 'continue', { topic: 'nature' });
    assert.equal(result.interaction.stepId, 'note');
    result = await submitDirectCollectorCard(result.interaction, 'continue', { note: 'My exact note.' });
    assert.equal(result.interaction.stepId, 'features');
    result = await submitDirectCollectorCard(result.interaction, 'continue', { features: ['choices', 'navigation'] });
    assert.equal(result.interaction.stepId, 'feedback');
    result = await submitDirectCollectorCard(result.interaction, 'back');
    assert.deepEqual(result.interaction.values, { features: ['choices', 'navigation'] });
    result = await submitDirectCollectorCard(result.interaction, 'back');
    assert.deepEqual(result.interaction.values, { note: 'My exact note.' });
    result = await submitDirectCollectorCard(result.interaction, 'back');
    assert.deepEqual(result.interaction.values, { topic: 'nature' });
    result = await submitDirectCollectorCard(result.interaction, 'continue', { topic: 'technology' });
    assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'technology' } });
    assert.deepEqual(result.interaction.values, { note: '' });
    result = await submitDirectCollectorCard(result.interaction, 'cancel');
    assert.equal(result.interaction.status, 'cancelled');
    assert.deepEqual(result.interaction.allowedActions, []);
    assert.equal(result.responseLanguage, language, 'Direct replies follow the saved collection language');
    assert.equal(result.answer, language === 'da' ? 'Indsamlingen er annulleret' : 'Collection cancelled');
    assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
  }
});

test('invalid or stale collector cards fail before Foundry and do not advance the collection', async () => {
  setup();
  const card = await collectorAtSubmit();
  const previousModels = modelRequests.length;
  const previousFoundry = globalThis.__laneFoundry.length;
  for (const change of [
    { version: card.version - 1 },
    { stepId: 'topic' },
    { values: { note: '' } },
    { values: { invented: 'Not a field.' } },
    { action: 'continue' },
  ]) {
    await assert.rejects(submit('Submit', [], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: `invalid-${turnSequence + 1}`, action: 'submit', values: { note: 'Ready.' }, ...change,
    } }), (error) => {
      assert.ok([400, 409].includes(error.status));
      context = error.laneContext;
      return true;
    });
  }
  const state = JSON.parse(await globalThis.__laneRead({
    pathSegments: ['Interactions', 'By Interaction ID', card.interactionId],
  }));
  assert.equal(state.status, 'active');
  assert.equal(state.pending, null);
  assert.deepEqual(state.values, { topic: { topic: 'nature' } });
  assert.equal(modelRequests.length, previousModels);
  assert.equal(globalThis.__laneFoundry.length, previousFoundry);
});

test('a failed direct transition retains pending input and card Resume processes it once without Foundry', async () => {
  setup();
  const { result: started } = await submit('Collect information.', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification: buildCollectionTestSpecification(), response: null,
    })), final('Choose a topic.'),
  ]);
  const card = started.interaction;
  const previousModels = modelRequests.length;
  const previousFoundry = globalThis.__laneFoundry.length;
  const mutate = globalThis.__laneMutate;
  let interrupted = false;
  globalThis.__laneMutate = async (options) => {
    if (!interrupted && options.pathSegments.includes(card.interactionId) &&
        JSON.parse(await globalThis.__laneRead(options)).pending) {
      interrupted = true;
      throw new Error('Transition interrupted');
    }
    return mutate(options);
  };
  let recovery;
  await assert.rejects(submit('Nature', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'pending-topic', action: 'continue', values: { topic: 'nature' },
  } }), (error) => {
    assert.match(error.message, /Transition interrupted/);
    context = error.laneContext;
    recovery = error.interaction;
    return true;
  });
  assert.equal(recovery.status, 'pending');
  assert.deepEqual(recovery.allowedActions, ['resume']);
  const resumed = await submitDirectCollectorCard(recovery, 'resume');
  assert.equal(resumed.interaction.stepId, 'note');
  assert.deepEqual(resumed.interaction.collectedValues, { topic: { topic: 'nature' } });
  const again = await submitDirectCollectorCard(resumed.interaction, 'resume');
  assert.equal(again.interaction.stepId, 'note');
  assert.equal(modelRequests.length, previousModels);
  assert.equal(globalThis.__laneFoundry.length, previousFoundry);
});

test('final card Submit is processed before a single model call with all collected values', async () => {
  setup();
  const card = await collectorAtSubmit();
  const previousModels = modelRequests.length;
  const { result } = await submit('Submit', [() => {
    const instruction = modelRequests.at(-1).request.input
      .filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
    assert.match(instruction, /server already processed.*completed this collection/);
    assert.match(instruction, /collectedValues.*topic.*nature.*note.*Ready/);
    assert.doesNotMatch(instruction, /Call collect_structured_input operation="process"/);
    return final('The collection is complete.');
  }], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'direct-final-submit', action: 'submit', values: { note: 'Ready.' },
  } });
  assert.equal(modelRequests.length, previousModels + 1);
  assert.equal(result.interaction.status, 'completed');
  assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'nature' }, note: { note: 'Ready.' } });
  assert.equal(result.agent.name, 'agent');
});

test('a model failure after direct final Submit does not roll back answers or permit replay', async () => {
  setup();
  const card = await collectorAtSubmit();
  await assert.rejects(submit('Submit', [() => { throw new Error('Model unavailable after completion'); }], {
    interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: 'committed-final-submit', action: 'submit', values: { note: 'Already saved.' },
    },
  }), (error) => {
    assert.match(error.message, /Model unavailable after completion/);
    assert.equal(error.interaction.status, 'completed');
    assert.deepEqual(error.interaction.allowedActions, []);
    assert.equal(error.interaction.collectedValues.note.note, 'Already saved.');
    context = error.laneContext;
    return true;
  });
  const previousModels = modelRequests.length;
  await assert.rejects(submit('Submit again', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'committed-final-submit', action: 'submit', values: { note: 'Replace saved answer.' },
  } }), { status: 409 });
  assert.equal(modelRequests.length, previousModels);
  const state = JSON.parse(await globalThis.__laneRead({
    pathSegments: ['Interactions', 'By Interaction ID', card.interactionId],
  }));
  assert.equal(state.lastSubmissionId, 'committed-final-submit');
  assert.equal(state.values.note.note, 'Already saved.');
});

test('successful collector Submit releases the same turn for other tools through either response channel', async () => {
  for (const channel of ['card', 'textarea']) {
    setup();
    const card = await collectorAtSubmit();
    const reference = {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    };
    const { result } = await submit('Submit', [
      tools(...(channel === 'textarea' ? [tool('collect_structured_input', {
        operation: 'respond', interactionId: card.interactionId,
        specification: null, response: { action: 'submit', fields: [{ id: 'note', value: 'Ready.', selections: null }] },
      })] : []), tool('search_tree_topics_1', { query: 'nature' })),
      final('Collection completed; search performed.'),
    ], channel === 'card' ? { interactionSubmission: {
      ...reference, submissionId: 'final-submit', action: 'submit', values: { note: 'Ready.' },
    } } : { interactionContext: reference });
    assert.equal(result.interaction.status, 'completed');
    assert.deepEqual(result.interaction.collectedValues, { topic: { topic: 'nature' }, note: { note: 'Ready.' } });
    assert.equal(calls.search, 1);
    assert.equal(calls.save, 0);
    assert.equal(result.laneContext.activeLane, 'knowledge.retrieval');
  }
});

test('completed collector can hand off to a new collector which owns presentation and restricts tools again', async () => {
  setup();
  const card = await collectorAtSubmit();
  const specification = buildCollectionTestSpecification();
  specification.title = 'Follow-up collection';
  specification.steps = specification.steps.slice(1, 2);
  const { result } = await submit('Submit', [
    tools(tool('collect_structured_input', {
      operation: 'start', interactionId: null, specification, response: null,
    }), tool('search_tree_topics_1', { query: 'not allowed while collecting again' })),
    final('Enter a short note.'),
  ], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'final-submit', action: 'submit', values: { note: 'Ready.' },
  } });
  assert.notEqual(result.interaction.interactionId, card.interactionId);
  assert.equal(result.interaction.title, 'Follow-up collection');
  assert.equal(result.interaction.status, 'active');
  assert.equal(result.interaction.stepId, 'note');
  assert.deepEqual(result.interaction.collectedValues, {});
  assert.equal(calls.search, 0);
});

test('cancellation and reading a previously completed collector do not release turn ownership', async () => {
  for (const action of ['cancel', 'submit']) {
    setup();
    const card = await collectorAtSubmit();
    const { result: ended } = await submit(action, action === 'cancel' ? [] : [
      final('Collection ended.'),
    ], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: 'end-collection', action, values: action === 'submit' ? { note: 'Ready.' } : {},
    } });
    assert.equal(ended.interaction.status, action === 'submit' ? 'completed' : 'cancelled');
    if (action === 'submit') {
      await submit('Check the collected values.', [
        tools(tool('collect_structured_input', {
          operation: 'status', interactionId: card.interactionId, specification: null, response: null,
        }), tool('search_tree_topics_1', { query: 'status is not a final submission' })),
        final('The collection was already completed.'),
      ]);
    }
    assert.equal(calls.search, 0);
  }
});

test('completion permits lane handoff and normal preview reporting but does not approve saving', async () => {
  for (const attemptSave of [false, true]) {
    setup();
    const card = await collectorAtSubmit();
    const { result } = await submit('Submit', [
      tools(tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'Continue the original request.' }),
      tool('preview_save_to_tree', { content: 'Collected information.' }),
      ...(attemptSave ? [tool('confirm_save_to_tree', { previewId })] : [])),
      attemptSave ? final('The note was not saved; later approval is required.')
        : final(`Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`, { persistenceAction: 'previewed' }),
    ], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
      submissionId: 'final-submit', action: 'submit', values: { note: 'Ready.' },
    } });
    assert.equal(result.interaction.status, 'completed');
    assert.equal(result.laneContext.activeLane, 'knowledge.saving');
    assert.equal(result.laneContext.stage, attemptSave ? 'idle' : 'awaiting_approval');
    assert.equal(result.answer, attemptSave ? 'The note was not saved; later approval is required.'
      : `Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`);
    assert.equal(calls.preview, 1);
    assert.equal(calls.save, 0);
  }
});

test('resuming a pending final Submit can complete the collector and continue in the same turn', async () => {
  setup();
  const card = await collectorAtSubmit();
  const mutate = globalThis.__laneMutate;
  globalThis.__laneMutate = async (options) => {
    if (options.pathSegments.includes(card.interactionId) &&
        JSON.parse(await globalThis.__laneRead(options)).pending) {
      throw new Error('Processing interrupted after capture');
    }
    return mutate(options);
  };
  await assert.rejects(submit('Submit', [], { interactionSubmission: {
    interactionId: card.interactionId, stepId: card.stepId, version: card.version, workflow: card.workflow,
    submissionId: 'interrupted-final-submit', action: 'submit', values: { note: 'Ready.' },
  } }), /Processing interrupted after capture/);
  globalThis.__laneMutate = mutate;
  context = { conversationId: 'resumed-collector-conversation', version: 0 };
  history = [];
  const { result } = await submit('Resume the submitted collection and continue.', [
    tools(tool('collect_structured_input', {
      operation: 'resume', interactionId: card.interactionId, specification: null, response: null,
    }), tool('search_tree_topics_1', { query: 'nature' })),
    final('The submitted collection was completed and search performed.'),
  ]);
  assert.equal(result.interaction.status, 'completed');
  assert.equal(calls.search, 1);
});

test('an expired conversation is rejected before any model or tool work', async () => {
  setup();
  await submit('Hello', [final('Hello.')]);
  expiredPaths.add(JSON.stringify(['Knowledge Trees', 'Conversations', context.conversationId, 'State']));
  const count = modelRequests.length;
  await assert.rejects(submit('Continue', []), { status: 410, code: 'CHAT_STATE_EXPIRED' });
  assert.equal(modelRequests.length, count);
  assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
});

test('an expired interaction is rejected before model processing without offering recovery controls', async () => {
  setup();
  const { result } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  const card = result.interaction;
  expiredPaths.add(JSON.stringify(['Interactions', 'By Interaction ID', card.interactionId]));
  const count = modelRequests.length;
  await assert.rejects(submit('Continue', [], { interactionContext: {
    interactionId: card.interactionId, version: card.version, stepId: card.stepId,
  } }), (error) => {
    assert.equal(error.status, 410);
    assert.equal(error.code, 'CHAT_STATE_EXPIRED');
    assert.equal(error.interaction, undefined);
    return true;
  });
  assert.equal(modelRequests.length, count);
});

test('expiry while awaiting the model remains an explicit expiry even if saving failure status also expires', async () => {
  setup();
  await assert.rejects(submit('Hello', [() => {
    expiredPaths.add(JSON.stringify(['Knowledge Trees', 'Conversations', context.conversationId, 'State']));
    return final('Hello.');
  }]), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.status, 410);
    assert.equal(error.code, 'CHAT_STATE_EXPIRED');
    assert.equal(error.errors.length, 2);
    assert.ok(error.errors.every((cause) => cause.status === 410));
    return true;
  });
});

test('expiry discovered during interaction recovery is not replaced by a generic server failure', async () => {
  setup();
  const { result } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  const card = result.interaction;
  await assert.rejects(submit('An unclear selection', [() => {
    expiredPaths.add(JSON.stringify(['Interactions', 'By Interaction ID', card.interactionId]));
    throw new Error('Model unavailable');
  }], { interactionContext: {
    interactionId: card.interactionId, version: card.version, stepId: card.stepId,
  } }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.status, 410);
    assert.equal(error.code, 'CHAT_STATE_EXPIRED');
    assert.match(error.errors[0].message, /Model unavailable/);
    assert.equal(error.errors[1].status, 410);
    assert.equal(error.interaction, undefined);
    return true;
  });
});

test('interaction tool launches a fixed card, captures input before the agent, and handles typed Back through the real loop', async () => {
  setup();
  const { result: started } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic in the test.'),
  ]);
  const card = started.interaction;
  assert.equal(card.stepId, 'topic');
  assert.equal(card.status, 'active');
  assert.equal(started.laneContext.activeLane, 'quiz');
  assert.deepEqual(card.allowedActions, ['continue', 'cancel']);
  const submission = {
    interactionId: card.interactionId, version: card.version, stepId: card.stepId,
    action: 'continue', values: { topic: 'technology' }, submissionId: 'selection-1',
  };
  const originalCreate = globalThis.__laneClient.responses.create;
  let observedPending = false;
  globalThis.__laneClient.responses.create = async (request, config) => {
    if (!observedPending) {
      const saved = JSON.parse(await globalThis.__laneRead({
        pathSegments: ['Interactions', 'By Interaction ID', card.interactionId],
      }));
      assert.equal(saved.pending.values.topic, 'technology');
      assert.deepEqual(saved.values, {});
      assert.equal(saved.stepIndex, 0);
      observedPending = true;
    }
    return originalCreate(request, config);
  };
  const { result: answered } = await submit('Browser (automated): Continue\nChoose a topic: Technology', [
    tools(tool('test_multistep_interaction', { operation: 'process', interactionId: card.interactionId })),
    final('Enter a note.', { interaction: { interactionId: card.interactionId } }),
  ], { interactionSubmission: submission });
  assert.ok(observedPending);
  assert.equal(answered.interaction.stepId, 'note');
  assert.equal(answered.interaction.collectedValues.topic.topic, 'technology');
  const noteCard = answered.interaction;
  const { result: back } = await submit('Back', [
    tools(tool('test_multistep_interaction', { operation: 'process', interactionId: card.interactionId })),
    final('Choose a topic again.'),
  ], { interactionContext: {
    interactionId: noteCard.interactionId, version: noteCard.version, stepId: noteCard.stepId,
  } });
  assert.equal(back.interaction.stepId, 'topic');
  assert.equal(back.interaction.values.topic, 'technology');
  await assert.rejects(submit('A stale selection', [], { interactionSubmission: submission }), /changed/);
});

test('the agent loop records typed No and Yes as input before final review, without treating either as approval or cancellation', async () => {
  setup();
  const { result: started } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  let card = started.interaction;
  for (const values of [{ topic: 'nature' }, { note: 'Normal test input.' }, { features: [] }]) {
    const { result } = await submit('Continue with these values', [
      tools(tool('test_multistep_interaction', { operation: 'process', interactionId: card.interactionId })),
      final('Input recorded.'),
    ], { interactionSubmission: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version,
      submissionId: `answer-${card.version}`, action: 'continue', values,
    } });
    card = result.interaction;
  }
  assert.equal(card.stepId, 'feedback');
  for (const [message, nextStep] of [['No', 'review'], ['Back', 'feedback'], ['Yes', 'review'], ['Submit', 'review']]) {
    const { result } = await submit(message, [
      tools(tool('test_multistep_interaction', { operation: 'process', interactionId: card.interactionId }),
        ...(message === 'Submit' ? [tool('search_tree_topics_1', { query: 'legacy completion stays isolated' })] : [])),
      final('Input recorded.'),
    ], { interactionContext: {
      interactionId: card.interactionId, stepId: card.stepId, version: card.version,
    } });
    card = result.interaction;
    assert.equal(card.stepId, nextStep);
    assert.equal(card.status, message === 'Submit' ? 'completed' : 'active');
    if (message === 'No' || message === 'Yes') {
      assert.deepEqual(card.collectedValues.feedback, { feedback: message.toLowerCase() });
    }
  }
  assert.deepEqual(calls, { preview: 0, save: 0, search: 0, process: 0 });
});

test('an interaction submission cannot authorize unrelated tools even after its transition commits', async () => {
  setup();
  const { result: start } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  const card = start.interaction;
  const { result } = await submit('Continue with Nature', [
    tools(
      tool('test_multistep_interaction', { operation: 'process', interactionId: card.interactionId }),
      tool('search_tree_topics_1', { query: 'not authorized by this click' }),
    ),
    final('The selection was processed. No unrelated search was executed.'),
  ], { interactionSubmission: {
    interactionId: card.interactionId, version: card.version, stepId: card.stepId,
    action: 'continue', values: { topic: 'nature' }, submissionId: 'scoped-input',
  } });
  assert.equal(calls.search, 0);
  assert.equal(result.interaction.stepId, 'note');
  assert.match(JSON.stringify(modelRequests.at(-1).request.input), /authorizes only its owning tool/);
});

test('failed interaction evaluation returns recoverable state and a fresh conversation resumes accepted input once', async () => {
  setup();
  const { result: start } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  const card = start.interaction;
  let failure;
  try {
    await submit('Continue with Nature', [], { interactionSubmission: {
      interactionId: card.interactionId, version: card.version, stepId: card.stepId,
      action: 'continue', values: { topic: 'nature' }, submissionId: 'interrupted-input',
    } });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  assert.equal(failure.interaction.status, 'pending');
  assert.deepEqual(failure.interaction.allowedActions, ['resume']);
  context = { conversationId: 'resumed-conversation', version: 0 };
  history = [];
  const { result: resumed } = await submit('Resume my latest interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'resume', interactionId: null })),
    final('Your saved selection was processed. Enter a note.'),
  ]);
  assert.equal(resumed.interaction.stepId, 'note');
  assert.equal(resumed.interaction.collectedValues.topic.topic, 'nature');
  const { result: again } = await submit(`Resume interaction ${card.interactionId}`, [
    tools(tool('test_multistep_interaction', { operation: 'resume', interactionId: card.interactionId })),
    final('Enter a note.'),
  ]);
  assert.equal(again.interaction.stepId, 'note');
  let committedFailure;
  try {
    await submit('Continue with a saved note', [
      tools(tool('test_multistep_interaction', { operation: 'process', interactionId: card.interactionId })),
    ], { interactionSubmission: {
      interactionId: card.interactionId, version: again.interaction.version, stepId: 'note',
      action: 'continue', values: { note: 'Already committed before response failure.' }, submissionId: 'committed-input',
    } });
  } catch (error) {
    committedFailure = error;
  }
  assert.equal(committedFailure?.interaction.stepId, 'features');
  context = { conversationId: 'after-committed-failure', version: 0 };
  history = [];
  const { result: committedResume } = await submit(`Resume interaction ${card.interactionId}`, [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'resume', interactionId: card.interactionId })),
    final('The note was already processed. Choose features.'),
  ]);
  assert.equal(committedResume.interaction.stepId, 'features');
  assert.equal(committedResume.interaction.collectedValues.note.note, 'Already committed before response failure.');
});

test('switching out of quiz pauses test input; resuming switches back without losing saved values', async () => {
  setup();
  const { result: started } = await submit('Test multistep interaction', [
    tools(tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  assert.match(JSON.stringify(modelRequests[1].request.input), /not allowed in knowledge.retrieval/);
  const card = started.interaction;
  const { result: searched } = await submit('What do the notes say about fish?', [
    tools(tool('switch_tree_lane', { activeLane: 'knowledge.retrieval', reason: 'The human requested a knowledge search.' }),
      tool('search_tree_topics_1', { query: 'fish' })),
    final('The notes describe fish.'),
  ], { interactionContext: {
    interactionId: card.interactionId, version: card.version, stepId: card.stepId,
  } });
  assert.equal(searched.laneContext.activeLane, 'knowledge.retrieval');
  assert.equal(searched.interaction, undefined);
  assert.equal(calls.search, 1);
  await assert.rejects(submit('Continue with Nature', [], { interactionSubmission: {
    interactionId: card.interactionId, version: card.version, stepId: card.stepId,
    action: 'continue', values: { topic: 'nature' }, submissionId: 'wrong-lane',
  } }), (error) => {
    assert.match(error.message, /Switch to quiz/);
    context = error.laneContext;
    return true;
  });
  const { result: resumed } = await submit(`Resume interaction ${card.interactionId}`, [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'resume', interactionId: card.interactionId })),
    final('Choose a topic again.'),
  ]);
  assert.equal(resumed.laneContext.activeLane, 'quiz');
  assert.equal(resumed.interaction.interactionId, card.interactionId);
  assert.equal(resumed.interaction.stepId, 'topic');
  assert.deepEqual(resumed.interaction.collectedValues, {});
});

test('interaction IDs remain in structured metadata while an answer exposing one is corrected without rerunning the tool', async () => {
  setup();
  const { result } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    async () => final(`Your interaction ID is ${await globalThis.__laneLookup()}.`),
    final('Choose a topic in the test.'),
  ]);
  assert.equal(result.answer, 'Choose a topic in the test.');
  assert.ok(result.interaction.interactionId);
  assert.equal(result.toolInvocations.filter((invocation) => invocation.toolName === 'test_multistep_interaction').length, 1);
  assert.match(JSON.stringify(modelRequests.at(-1).request.input), /Remove the interaction ID/);
});

test('resume without an ID finds an unfinished unexpired interaction in a fresh conversation without history', async () => {
  setup();
  const { result: first } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  const { result: answered } = await submit('Nature', [
    tools(tool('test_multistep_interaction', { operation: 'process', interactionId: first.interaction.interactionId })),
    final('Enter a note.'),
  ], { interactionContext: {
    interactionId: first.interaction.interactionId, stepId: first.interaction.stepId, version: first.interaction.version,
  } });
  context = { conversationId: 'another-conversation', version: 0 };
  history = [];
  const { result: newer } = await submit('Test multistep interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ]);
  expiredPaths.add(JSON.stringify(['Interactions', 'By Interaction ID', newer.interaction.interactionId]));
  context = { conversationId: 'signed-back-in-conversation', version: 0 };
  history = [];
  const { result: resumed } = await submit('Resume my interaction', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'resume', interactionId: null })),
    final('Continue with your saved note step.'),
  ]);
  assert.equal(resumed.interaction.interactionId, answered.interaction.interactionId);
  assert.equal(resumed.interaction.stepId, 'note');
  assert.deepEqual(resumed.interaction.collectedValues.topic, { topic: 'nature' });
  assert.equal(resumed.laneContext.activeLane, 'quiz');
});

test('a human can switch from saving to the test without a pending upload hint forcing saving', async () => {
  setup();
  await submit('Save this in a tree', [
    tools(tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human requested saving.' })),
    final('Which content should be saved?'),
  ]);
  const { result } = await submit('Test multistep interaction instead', [
    tools(quizSwitch(), tool('test_multistep_interaction', { operation: 'start', interactionId: null })),
    final('Choose a topic.'),
  ], { pendingUploadId: uploadId });
  assert.equal(result.laneContext.activeLane, 'quiz');
  assert.equal(result.laneContext.previewId, null);
  assert.equal(result.laneContext.uploadId, null);
  assert.equal(result.interaction.stepId, 'topic');
  assert.equal(calls.preview, 0);
  assert.equal(calls.save, 0);
});

test('real execution preserves retrieval, broadening, preview, later confirmation, and duplicate rejection', async () => {
  setup();
  await submit('What do the notes say?', [
    tools(tool('search_tree_topics_1', { query: 'fish' })),
    final('The notes cover fish. May I answer more broadly?', { isPermissionToBroadenRequest: true }),
  ]);
  await submit('Yes, answer broadly.', [
    final(`${note} Would you like to save this?`, { knowledgeMode: 'broad', isPersistenceOffer: true }),
  ]);
  const previewReply = `Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`;
  const { result: previewResult } = await submit('Yes, save that answer.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human accepted the save offer.' }),
      tool('preview_save_to_tree', { contentSource: 'prior_broad_answer', broaderAnswer: note }),
    ),
    final(previewReply, { persistenceAction: 'previewed' }),
  ]);
  assert.equal(previewResult.laneContext.stage, 'awaiting_approval');
  assert.equal(calls.save, 0);
  const { request, result } = await submit('Yes, use that destination.', [
    tools(tool('confirm_save_to_tree', { previewId, saveMode: 'create_leaf' })),
    final(`Saved.\n\n${note}\n\n${noteLink}`, { persistenceAction: 'saved' }),
  ]);
  assert.equal(result.laneContext.stage, 'completed');
  assert.equal(result.familyPayload.laneContext.activeLane, 'knowledge.saving');
  const before = modelRequests.length;
  await assert.rejects(invokeKnowledgeTreesAgent(request), { status: 409, message: /already completed/ });
  assert.equal(modelRequests.length, before);
  assert.deepEqual(calls, { search: 1, preview: 1, save: 1, process: 0 });
  assert.ok(modelRequests.every(({ configuration }) => configuration.body.agent.type === 'agent_reference'));
});

test('a same-turn preview cannot be confirmed even when the model queues both calls', async () => {
  setup();
  await submit('Save this factual text.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human requested saving current text.' }),
      tool('preview_save_to_tree', { contentSource: 'current_user_text', broaderAnswer: note }),
      tool('confirm_save_to_tree', { previewId, saveMode: 'create_leaf' }),
    ),
    final('Nothing saved; confirmation requires a later human message.'),
  ]);
  assert.equal(calls.save, 0);
  assert.equal(context.previewId, null);
  const outputs = modelRequests.at(-1).request.input;
  assert.match(JSON.parse(outputs.at(-1).output).error, /later human approval/);
});

test('normal upload completion retains its saving workflow and preview authority requires a later human', async () => {
  setup();
  await submit('Save my attachment.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human attached a file to save.' }),
      tool('process_upload', { uploadId }),
    ),
    final('Processing has started. Nothing saved.', { isWaitingForContinuation: true }),
  ], { uploadId });
  assert.equal(context.stage, 'upload_processing');
  assert.equal(context.uploadId, uploadId);
  await submit('Browser (automated): Upload complete.', [
    tools(tool('preview_save_to_tree', { contentSource: 'completed_upload_note', uploadId })),
    final(`Save at ${path}?\n\n<!-- Preview ID: ${previewId} -->`, { persistenceAction: 'previewed' }),
  ], { previewUploadId: uploadId });
  assert.equal(calls.process, 1);
  assert.equal(calls.preview, 1);
  assert.equal(calls.save, 0);
});

test('a completed upload cannot hijack a newer retrieval workflow', async () => {
  setup();
  await submit('Process this file.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.saving', reason: 'The human requested upload processing.' }),
      tool('process_upload', { uploadId }),
    ),
    final('Processing.', { isWaitingForContinuation: true }),
  ], { uploadId });
  const uploadVersion = context.version;
  await submit('Instead, search for fish.', [
    tools(
      tool('switch_tree_lane', { activeLane: 'knowledge.retrieval', reason: 'The human requested a new search.' }),
      tool('search_tree_topics_1', { query: 'fish' }),
    ),
    final('The notes contain fish.'),
  ]);
  const count = modelRequests.length;
  await assert.rejects(invokeKnowledgeTreesAgent(options('Browser (automated): Upload complete.', {
    expectedVersion: uploadVersion, previewUploadId: uploadId,
  })), /state changed/);
  assert.equal(modelRequests.length, count);
  assert.equal(calls.preview, 0);
});
