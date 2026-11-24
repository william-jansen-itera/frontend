import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/treeConversationCleanupRepository.js')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const cleanupInactiveTreeConversations = async () => {};')}`,
        shortCircuit: true,
      };
    }
    const name = specifier.split('/').at(-1);
    const stubs = {
      logging: 'export const logStructuredTrace = async () => {};',
      foundryAgentClient: 'export const getProjectClient = () => ({ getOpenAIClient: () => globalThis.__laneClient });',
      personalCacheTreeRepository: `
        export const getPersonalCacheContext = async () => ({ personalCacheTreeId: 1, updatedBy: {} });
        export const findPersonalCacheLeafPathNode = () => globalThis.__laneFind();
        export const mutatePersonalCacheNotes = (options) => globalThis.__laneMutate(options);`,
      treeCatalog: 'export const getTreeList = async () => [{ id: 1, currentUserCanWrite: true }]; export const assertTreeAccess = async () => { throw new Error("Unexpected access check in a tool-result builder"); };',
      treeAgentCatalog: `
        export const KNOWLEDGE_TREES_FAMILY = 'knowledgeTrees';
        export const getPublishedKnowledgeTreesPromptAgent = async () => ({ id: 'agent', name: 'agent', version: '1' });
        export const buildRuntimeTreeToolContext = async () => globalThis.__laneTools();
        export const buildVisibilityScopeContext = () => ({ visibility: 'private' });
        export const buildVisibilityScopeInstruction = () => 'Private trees only';
        export const buildAllowedToolInstruction = () => 'search_tree_topics_1';`,
    };
    if (specifier.startsWith('@/') && stubs[name]) {
      return { url: `data:text/javascript,${encodeURIComponent(stubs[name])}`, shortCircuit: true };
    }
    if (specifier.startsWith('@/')) {
      const base = new URL(`../../../../${specifier.slice(2)}`, import.meta.url);
      const file = new URL(`${base.href}.js`);
      return nextResolve(existsSync(file) ? file.href : new URL(`${base.href}/index.js`).href, context);
    }
    return nextResolve(specifier, context);
  },
});
const { invokeKnowledgeTreesAgent } = await import('./treeAgentService.js');
const { buildPersistenceToolHandlerResult } = await import('./tools/persistenceToolShared.js');
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
function setup() {
  let document = null;
  globalThis.__laneFind = () => document === null ? null : { id: 1 };
  context = { conversationId: 'integration-conversation', version: 0 };
  history = [];
  calls = { preview: 0, save: 0, search: 0, process: 0 };
  modelRequests = [];
  turnSequence = 0;
  globalThis.__laneMutate = async ({ mutate }) => {
    const change = mutate(document);
    document = change.notes;
    return change.result;
  };
  globalThis.__laneClient = {
    responses: { create: async (request, configuration) => {
      modelRequests.push({ request, configuration });
      assert.ok(responses.length, 'Unexpected additional model call');
      return responses.shift();
    } },
  };
  globalThis.__laneTools = () => ({
    includedTrees: [{ id: 1, isPrivate: true }],
    toolPolicies: new Map(['search_tree_topics_1', 'preview_save_to_tree', 'revise_save_preview', 'confirm_save_to_tree', 'process_upload']
      .map((name) => [name, { requiresUserApproval: false }])),
    handlerMap: new Map([
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
