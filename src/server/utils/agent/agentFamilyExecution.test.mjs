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
const { buildStructuredAnswerStateFinalResponseValidator } = await import('./agentAnswerState.js');
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

test('final response validation retries reach the agent, but exhaustion hides internal instructions from the user', async () => {
  const client = clientWithResponses([
    { id: 'response-1', output: [] },
    { id: 'response-2', output: [] },
    { id: 'response-3', output: [] },
  ]);
  const validationInstruction = 'Report persistenceAction="none"; do not claim a save.';
  const debug = { stepsComplete: [], timings: { modelCalls: [] } };

  await assert.rejects(runAgentFamilyExecution({
    openAIClient: client,
    responseConfig,
    initialInput: [],
    handlerMap: new Map(),
    toolPolicies: new Map(),
    finalResponseValidator: async () => validationInstruction,
    debug,
  }), /The agent could not produce a valid answer/);

  assert.equal(client.requests.length, 3);
  for (const [index, responseId] of ['response-1', 'response-2'].entries()) {
    assert.equal(client.requests[index + 1].previous_response_id, responseId);
    assert.deepEqual(client.requests[index + 1].input, [{
      type: 'message', role: 'system',
      content: `This is a correction within the same user turn, not a new user request. The latest user message is still the one in the original request; do not ask for approval again if that message already provided it. Do not treat earlier user messages as approval for this turn. ${validationInstruction}`,
    }]);
  }
  assert.deepEqual(debug.stepsComplete.filter(({ step }) => step === 'final response validation retry requested')
    .map(({ retryCount, validationInstruction: instruction }) => ({ retryCount, instruction })), [
    { retryCount: 1, instruction: validationInstruction },
    { retryCount: 2, instruction: validationInstruction },
  ]);
  assert.equal(debug.stepsComplete.at(-1).validationInstruction, validationInstruction);
});

test('a corrected final response is returned after a validation retry', async () => {
  const client = clientWithResponses([
    { id: 'response-1', status: 'completed', output: [], output_text: 'not json' },
    { id: 'response-2', output: [], output_text: 'Corrected answer' },
  ]);
  const debug = { stepsComplete: [], timings: { modelCalls: [] } };
  const result = await runAgentFamilyExecution({
    openAIClient: client,
    responseConfig,
    initialInput: [],
    handlerMap: new Map(),
    toolPolicies: new Map(),
    finalResponseValidator: async ({ response }) => response.id === 'response-1' ? 'Correct the answer.' : null,
    debug,
  });

  assert.equal(result.response.output_text, 'Corrected answer');
  assert.equal(client.requests.length, 2);
  assert.match(client.requests[1].input[0].content, /same user turn, not a new user request/);
  assert.match(client.requests[1].input[0].content, /do not ask for approval again if that message already provided it/);
  assert.match(client.requests[1].input[0].content, /Correct the answer\.$/);
  const rejectedStep = debug.stepsComplete.find(({ step }) => step === 'final response validation retry requested');
  assert.equal(rejectedStep.validationInstruction, 'Correct the answer.');
  assert.equal(rejectedStep.rawOutputText, 'not json');
  assert.equal(rejectedStep.outputTextLength, 8);
  assert.equal(rejectedStep.outputTextTruncated, false);
  assert.equal(rejectedStep.responseStatus, 'completed');
  assert.equal(debug.stepsComplete.at(-1).step, 'final response validation passed');
  assert.equal(debug.stepsComplete.at(-1).retryCount, 1);
  assert.equal(debug.stepsComplete.at(-1).responseId, 'response-2');
  assert.equal(debug.stepsComplete.at(-1).rawOutputText, 'Corrected answer');
  assert.equal(debug.stepsComplete.at(-1).outputTextLength, 'Corrected answer'.length);
  assert.equal(debug.stepsComplete.at(-1).outputTextTruncated, false);
});

test('a validation retry can call a tool before returning a final response', async () => {
  const client = clientWithResponses([
    { id: 'response-1', output: [], output_text: 'not json' },
    { id: 'response-2', output: [{
      type: 'function_call', name: 'confirm_save_to_tree', call_id: 'confirm-1',
      arguments: '{"previewId":"preview-1","saveMode":"merge_existing"}',
    }] },
    { id: 'response-3', output: [], output_text: 'Saved after confirmation.' },
  ]);
  let confirmCalls = 0;
  const result = await runAgentFamilyExecution({
    openAIClient: client,
    responseConfig,
    initialInput: [{ type: 'message', role: 'user', content: 'Yes, save the preview.' }],
    handlerMap: new Map([['confirm_save_to_tree', async () => {
      confirmCalls += 1;
      return { toolResultType: 'tree_note_updated' };
    }]]),
    toolPolicies: new Map([['confirm_save_to_tree', { requiresUserApproval: false }]]),
    finalResponseValidator: async ({ response, toolInvocations }) =>
      response.id === 'response-1' ? 'Return valid JSON after completing the requested action.'
        : toolInvocations.some(({ output }) => output.toolResultType === 'tree_note_updated') ? null : 'Confirm the save first.',
  });

  assert.equal(confirmCalls, 1);
  assert.equal(result.toolInvocations[0].toolName, 'confirm_save_to_tree');
  assert.equal(result.response.output_text, 'Saved after confirmation.');
  assert.equal(client.requests[2].previous_response_id, 'response-2');
  assert.equal(client.requests[2].input[0].type, 'function_call_output');
  assert.equal(client.requests[2].input[0].call_id, 'confirm-1');
});

test('validation debug bounds long rejected model output while preserving both ends', async () => {
  const rawOutputText = `START-${'x'.repeat(10000)}-END`;
  const client = clientWithResponses([
    { id: 'response-1', output: [], output_text: rawOutputText },
    { id: 'response-2', output: [], output_text: rawOutputText },
  ]);
  const debug = { stepsComplete: [], timings: { modelCalls: [] } };
  await runAgentFamilyExecution({
    openAIClient: client,
    responseConfig,
    initialInput: [],
    handlerMap: new Map(),
    toolPolicies: new Map(),
    finalResponseValidator: async ({ response }) => response.id === 'response-1' ? 'Invalid answer.' : null,
    debug,
  });

  const rejectedStep = debug.stepsComplete.find(({ step }) => step === 'final response validation retry requested');
  assert.equal(rejectedStep.outputTextLength, rawOutputText.length);
  assert.equal(rejectedStep.outputTextTruncated, true);
  assert.ok(rejectedStep.rawOutputText.startsWith('START-'));
  assert.ok(rejectedStep.rawOutputText.endsWith('-END'));
  assert.ok(rejectedStep.rawOutputText.length < rawOutputText.length);
  const acceptedStep = debug.stepsComplete.find(({ step }) => step === 'final response validation passed');
  assert.equal(acceptedStep.outputTextLength, rawOutputText.length);
  assert.equal(acceptedStep.outputTextTruncated, true);
  assert.ok(acceptedStep.rawOutputText.startsWith('START-'));
  assert.ok(acceptedStep.rawOutputText.endsWith('-END'));
  assert.ok(acceptedStep.rawOutputText.length < rawOutputText.length);
});

test('malformed structured output records its parser error without changing the model retry', async () => {
  const malformedOutput = '{"answer":"Saved",]';
  const client = clientWithResponses([
    { id: 'response-1', output: [], output_text: malformedOutput },
    { id: 'response-2', output: [], output_text: JSON.stringify({
      answer: 'Saved', knowledgeMode: 'grounded', isPermissionToBroadenRequest: false,
      isPersistenceOffer: false, explanation: 'Reporting a result.', persistenceAction: 'none',
    }) },
  ]);
  const debug = { stepsComplete: [], timings: { modelCalls: [] } };
  await runAgentFamilyExecution({
    openAIClient: client,
    responseConfig,
    initialInput: [],
    handlerMap: new Map(),
    toolPolicies: new Map(),
    finalResponseValidator: buildStructuredAnswerStateFinalResponseValidator({ requirePersistenceAction: true }),
    debug,
  });

  const parseStep = debug.stepsComplete.find(({ step }) => step === 'final response JSON parse failed');
  assert.equal(parseStep.responseId, 'response-1');
  assert.ok(parseStep.parseError);
  assert.equal(debug.stepsComplete.find(({ step }) => step === 'final response validation retry requested').rawOutputText, malformedOutput);
  assert.match(client.requests[1].input[0].content, /not valid JSON/);
});

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