import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const deleteModuleStubs = new Map([
  ['emailToolShared', 'export const buildEmailToolResult = ({ data }) => data;'],
  ['emailAccountConfigRepository', 'export const loadEmailAccountConfig = async () => ({ accountConfig: {} });'],
  ['emailTransport', 'export const deleteImapMessage = (...args) => globalThis.__deleteEmailMocks.deleteImapMessage(...args);'],
  ['emailCacheRepository', [
    'loadCachedEmailMessage', 'loadLatestEmailRetrievalSnapshot', 'resolveCachedEmailMovedMessageAlias',
    'deleteCachedEmailMovedMessageAlias', 'deleteCachedEmailMessageNode', 'moveCachedEmailMessage',
    'removeLatestEmailRetrievalSnapshotMessages', 'upsertLatestEmailRetrievalSnapshotMessages',
  ].map((name) => `export const ${name} = (...args) => globalThis.__deleteEmailMocks.${name}(...args);`).join('\n')],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = deleteModuleStubs.get(specifier.split('/').at(-1));

    if (stub && specifier.startsWith('@/')) {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }

    if (specifier.startsWith('@/')) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.js`, import.meta.url).href, context);
    }

    return nextResolve(specifier, context);
  },
});

const { runAgentFamilyExecution } = await import('./agentFamilyExecution.js');
const { buildDeleteEmailHandler } = await import('./email/tools/deleteEmailTool/index.js');

test('delete preview does not touch IMAP and changed aliases cannot use an old approval', async () => {
  let destinationUid = 'trash-1';
  let imapCalls = 0;
  globalThis.__deleteEmailMocks = {
    loadCachedEmailMessage: async ({ folder, uid }) => folder === 'Trash' ? { uid, messageId: '<message-1>', subject: 'Test' } : null,
    loadLatestEmailRetrievalSnapshot: async () => ({ messages: [] }),
    resolveCachedEmailMovedMessageAlias: async () => ({ destinationFolder: 'Trash', destinationUid }),
    deleteImapMessage: async () => { imapCalls += 1; return { deleted: true }; },
    deleteCachedEmailMessageNode: async () => true,
    deleteCachedEmailMovedMessageAlias: async () => true,
    removeLatestEmailRetrievalSnapshotMessages: async () => true,
  };
  const handler = buildDeleteEmailHandler({ personalCacheTreeId: 'test-tree' });
  const args = { provider: 'test', folder: 'INBOX', uids: ['source-1'], expunge: true };
  const preview = await handler(args, { previewOnly: true });

  assert.equal(imapCalls, 0);
  assert.equal(preview.targets[0].actualUid, 'trash-1');
  assert.equal(preview.targets[0].subject, 'Test');

  destinationUid = 'trash-2';
  const identities = preview.targets.map(({ requestedUid, requestedFolder, actualUid, actualFolder, messageId }) => ({
    requestedUid, requestedFolder, actualUid, actualFolder, messageId,
  }));
  await assert.rejects(handler(args, { approvedTargetIdentities: identities }), /exact resolved targets/);
  assert.equal(imapCalls, 0);

  destinationUid = 'trash-1';
  await handler(args, { approvedTargetIdentities: identities });
  assert.equal(imapCalls, 1);
});

function clientWithResponses(responses) {
  const requests = [];

  return {
    requests,
    responses: {
      async create(payload) {
        requests.push(payload);
        return responses.shift();
      },
    },
  };
}

const deleteCall = { type: 'function_call', name: 'delete_email', call_id: 'delete-1', arguments: '{"uids":["1"]}' };
const responseConfig = { type: 'direct_model', model: 'mock', instructions: 'mock', tools: [] };

test('proposal and decline never invoke the delete handler, and decline keeps the call id', async () => {
  let handlerCalls = 0;
  const handlerMap = new Map([['delete_email', async () => { handlerCalls += 1; }]]);
  const toolPolicies = new Map([['delete_email', { requiresUserApproval: true }]]);
  const initialClient = clientWithResponses([{ id: 'response-1', output: [deleteCall] }]);
  const proposal = await runAgentFamilyExecution({
    openAIClient: initialClient,
    responseConfig,
    initialInput: [],
    handlerMap,
    toolPolicies,
    createApproval: async ({ state }) => ({ id: 'pending', state }),
  });

  assert.equal(handlerCalls, 0);
  assert.equal(initialClient.requests.length, 1);
  assert.equal(proposal.approvalRequired.state.responseId, 'response-1');

  const resumedClient = clientWithResponses([{ id: 'response-2', output: [], output_text: 'Cancelled' }]);
  await runAgentFamilyExecution({
    openAIClient: resumedClient,
    responseConfig,
    initialInput: [],
    handlerMap,
    toolPolicies,
    resumeState: proposal.approvalRequired.state,
    approvedCall: { round: 0, index: 0, callId: 'delete-1', output: { status: 'user_declined' } },
  });

  assert.equal(handlerCalls, 0);
  assert.equal(resumedClient.requests[0].previous_response_id, 'response-1');
  assert.equal(resumedClient.requests[0].input[0].call_id, 'delete-1');
  assert.deepEqual(JSON.parse(resumedClient.requests[0].input[0].output), { status: 'user_declined' });
});

test('approval resumes siblings without executing delete again', async () => {
  let handlerCalls = 0;
  const handlerMap = new Map([
    ['show_email', async () => ({ emails: [] })],
    ['delete_email', async () => { handlerCalls += 1; }],
  ]);
  const toolPolicies = new Map([
    ['show_email', { requiresUserApproval: false }],
    ['delete_email', { requiresUserApproval: true }],
  ]);
  const initialClient = clientWithResponses([{ id: 'response-1', output: [
    { type: 'function_call', name: 'show_email', call_id: 'show-1', arguments: '{}' }, deleteCall,
  ] }]);
  const proposal = await runAgentFamilyExecution({
    openAIClient: initialClient, responseConfig, initialInput: [], handlerMap, toolPolicies,
    createApproval: async ({ state }) => state,
  });
  assert.equal(proposal.approvalRequired.nextIndex, 1);

  const client = clientWithResponses([{ id: 'response-2', output: [], output_text: 'Deleted' }]);
  await runAgentFamilyExecution({
    openAIClient: client, responseConfig, initialInput: [], handlerMap, toolPolicies,
    resumeState: proposal.approvalRequired,
    approvedCall: { round: 0, index: 1, callId: 'delete-1', output: { deleted: true } },
  });

  assert.equal(handlerCalls, 0);
  assert.deepEqual(client.requests[0].input.map((entry) => entry.call_id), ['show-1', 'delete-1']);
});

test('a missing policy never invokes its registered handler', async () => {
  let handlerCalls = 0;
  const client = clientWithResponses([
    { id: 'response-1', output: [deleteCall] },
    { id: 'response-2', output: [], output_text: 'Unable to delete' },
  ]);
  await runAgentFamilyExecution({
    openAIClient: client, responseConfig, initialInput: [],
    handlerMap: new Map([['delete_email', async () => { handlerCalls += 1; }]]),
    toolPolicies: new Map(),
  });

  assert.equal(handlerCalls, 0);
  assert.match(JSON.parse(client.requests[1].input[0].output).error, /No approval policy/);
});

test('two deletes in one response require separate decisions without replaying the first', async () => {
  let handlerCalls = 0;
  const handlerMap = new Map([['delete_email', async () => { handlerCalls += 1; }]]);
  const toolPolicies = new Map([['delete_email', { requiresUserApproval: true }]]);
  const secondCall = { ...deleteCall, call_id: 'delete-2', arguments: '{"uids":["2"]}' };
  const initialClient = clientWithResponses([{ id: 'response-1', output: [deleteCall, secondCall] }]);
  const createApproval = async ({ state }) => state;
  const first = await runAgentFamilyExecution({
    openAIClient: initialClient, responseConfig, initialInput: [], handlerMap, toolPolicies, createApproval,
  });
  const second = await runAgentFamilyExecution({
    openAIClient: clientWithResponses([]), responseConfig, initialInput: [], handlerMap, toolPolicies,
    createApproval, resumeState: first.approvalRequired,
    approvedCall: { round: 0, index: 0, callId: 'delete-1', output: { deleted: true } },
  });

  assert.equal(handlerCalls, 0);
  assert.equal(second.approvalRequired.nextIndex, 1);
  assert.equal(second.approvalRequired.outputs[0].call_id, 'delete-1');

  const resumedClient = clientWithResponses([{ id: 'response-2', output: [], output_text: 'Done' }]);
  await runAgentFamilyExecution({
    openAIClient: resumedClient, responseConfig, initialInput: [], handlerMap, toolPolicies,
    createApproval, resumeState: second.approvalRequired,
    approvedCall: { round: 0, index: 1, callId: 'delete-2', output: { status: 'user_declined' } },
  });

  assert.equal(handlerCalls, 0);
  assert.deepEqual(resumedClient.requests[0].input.map((output) => output.call_id), ['delete-1', 'delete-2']);
});