import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const modules = new Map([
  ['next/server', 'export const NextResponse = { json: (body, { status = 200 } = {}) => ({ body, status, headers: new Headers() }) };'],
  ['agentFamilyInvoker', `
    export const resolveAgentFamilySelection = async (family) => ({ family: family || 'knowledgeTrees' });
    export const invokeAgentFamily = async (options) => {
      globalThis.__chatRouteCalls.push(options);
      return { answer: 'Reply', responseLanguage: 'Danish', agent: globalThis.__chatRouteServerInteraction ? null : { name: 'test-agent' }, toolsUsed: [] };
    };
  `],
  ['logging', 'export const logException = async () => {}; export const logStructuredTrace = async () => {}; export const logTrace = async () => {};'],
  ['auth', 'export const requireAuthenticatedPrincipal = () => ({ userId: "owner" });'],
  ['treeCatalog', 'export const getAuditMetadata = () => ({ updatedByObjectId: "00000000-0000-0000-0000-000000000001" });'],
  ['chatUploadRepository', `
    export const getOwnedChatUpload = async () => globalThis.__chatRouteUploadOwned ? { id: "owned", status: globalThis.__chatRouteUploadStatus || "succeeded", originalHumanMessage: globalThis.__chatRouteOriginalHumanMessage ?? null } : null;
    export const bindChatUploadHumanMessage = async (options) => { globalThis.__chatRouteBindings.push(options); };
  `],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/shared/interactions') {
      return nextResolve(new URL('../../../shared/interactions.js', import.meta.url).href, context);
    }
    if (specifier.endsWith('/treeLaneState')) {
      return nextResolve(new URL('../../../server/utils/agentOrchestration/agents/knowledgeTrees/treeLaneState.js', import.meta.url).href, context);
    }
    const stub = modules.get(specifier === 'next/server' ? specifier : specifier.split('/').at(-1));
    return stub ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { POST } = await import('./route.js');
const laneIdentity = { conversationId: 'conversation-1', turnId: 'turn-1', expectedVersion: 0 };

test('server-processed card results do not require agent metadata for logging or serialization', async () => {
  globalThis.__chatRouteCalls = [];
  globalThis.__chatRouteServerInteraction = true;
  try {
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Continue', family: 'knowledgeTrees', ...laneIdentity,
        interactionSubmission: {
          interactionId: 'collector-1', stepId: 'topic', version: 2, workflow: 'structured-input',
          submissionId: 'selection-1', action: 'continue', values: { topic: 'nature' },
        },
      }),
    }));
    assert.equal(response.status, 200);
    assert.equal(response.body.agent, null);
    assert.equal(response.body.answer, 'Reply');
  } finally {
    globalThis.__chatRouteServerInteraction = false;
  }
});

test('interaction metadata follows the human chat path and cannot masquerade as an upload completion', async () => {
  globalThis.__chatRouteCalls = [];
  const submission = {
    interactionId: 'interaction-1', stepId: 'topic', version: 2,
    submissionId: 'submission-1', action: 'continue', values: { topic: 'nature' },
  };
  const request = (extra = {}) => new Request('http://localhost/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'Browser (automated): Continue\nChoose a topic: Nature', family: 'knowledgeTrees',
      ...laneIdentity, interactionSubmission: submission, ...extra,
    }),
  });
  assert.equal((await POST(request())).status, 200);
  assert.deepEqual(globalThis.__chatRouteCalls[0].interactionSubmission, submission);
  for (const extra of [
    { family: 'email' }, { previewUploadId: '00000000-0000-0000-0000-000000000001' },
    { interactionSubmission: { ...submission, version: -1 } },
    { interactionSubmission: { ...submission, action: 'arbitrary_tool' } },
    { interactionSubmission: { ...submission, workflow: 'unknown-workflow' } },
  ]) assert.equal((await POST(request(extra))).status, 400);
  assert.equal(globalThis.__chatRouteCalls.length, 1);
  const context = { interactionId: 'collector-1', stepId: 'note', version: 2, workflow: 'structured-input' };
  assert.equal((await POST(request({
    message: 'This is my note.', interactionSubmission: null, interactionContext: context,
  }))).status, 200);
  assert.deepEqual(globalThis.__chatRouteCalls[1].interactionContext, context);
});

test('chat forwards context identity but never accepts a client lane as authoritative', async () => {
  globalThis.__chatRouteCalls = [];
  const request = (extra) => new Request('http://localhost/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'A question', family: 'knowledgeTrees', ...laneIdentity, ...extra }),
  });
  const identity = { conversationId: 'conversation-1', turnId: 'turn-1', expectedVersion: 3 };
  assert.equal((await POST(request({ ...identity, activeLane: 'knowledge.saving' }))).status, 200);
  for (const [key, value] of Object.entries(identity)) assert.equal(globalThis.__chatRouteCalls[0][key], value);
  assert.equal(globalThis.__chatRouteCalls[0].activeLane, undefined);
  assert.equal((await POST(request({ conversationId: '../other' }))).status, 400);
  assert.equal((await POST(request({ expectedVersion: -1 }))).status, 400);
  assert.equal(globalThis.__chatRouteCalls.length, 1);
});

test('Knowledge Trees rejects missing or null conversation identity fields instead of generating defaults', async () => {
  globalThis.__chatRouteCalls = [];
  for (const field of Object.keys(laneIdentity)) {
    for (const value of [undefined, null]) {
      const response = await POST(new Request('http://localhost/api/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'A question', family: 'knowledgeTrees', ...laneIdentity, [field]: value }),
      }));
      assert.equal(response.status, 400);
      assert.match(response.body.error, new RegExp(field));
    }
  }
  assert.equal(globalThis.__chatRouteCalls.length, 0);
});

test('chat route forwards supported locales and defaults unsupported or missing hints to English', async () => {
  globalThis.__chatRouteCalls = [];
  globalThis.__chatRouteUploadOwned = false;
  for (const [hint, expected] of [['en', 'en'], ['da', 'da'], ['de', 'en'], [null, 'en']]) {
    const body = { message: 'Hello', family: 'email', history: [{ role: 'user', content: 'Earlier message' }] };
    if (hint !== null) body.language = hint;
    const response = await POST(new Request('http://localhost/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
    assert.equal(response.body.responseLanguage, 'Danish');
    assert.equal(response.body.debug, undefined);
    assert.equal(globalThis.__chatRouteCalls.at(-1).language, expected);
    assert.equal(globalThis.__chatRouteCalls.at(-1).history[0].content, 'Earlier message');
  }
});

test('locale cannot bypass upload ownership for an automated completion', async () => {
  globalThis.__chatRouteCalls = [];
  globalThis.__chatRouteBindings = [];
  globalThis.__chatRouteUploadOwned = false;
  const body = {
    family: 'knowledgeTrees',
    ...laneIdentity,
    language: 'da',
    message: 'Browser (automated): processed upload',
    previewUploadId: '00000000-0000-0000-0000-000000000002',
  };
  const request = () => new Request('http://localhost/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await POST(request())).status, 404);
  assert.equal(globalThis.__chatRouteCalls.length, 0);
  globalThis.__chatRouteUploadOwned = true;
  assert.equal((await POST(request())).status, 200);
  assert.equal(globalThis.__chatRouteCalls[0].previewUploadId, body.previewUploadId);
  assert.equal(globalThis.__chatRouteCalls[0].language, 'da');
  body.message = 'Browser (automatisk): uploaden er færdigbehandlet';
  assert.equal((await POST(request())).status, 200);
  assert.equal(globalThis.__chatRouteCalls[1].message, body.message);
});

test('only the initial typed upload message is bound; an owned completed clarification does not reprocess', async () => {
  globalThis.__chatRouteCalls = [];
  globalThis.__chatRouteBindings = [];
  globalThis.__chatRouteUploadOwned = true;
  globalThis.__chatRouteUploadStatus = 'succeeded';
  const uploadId = '00000000-0000-0000-0000-000000000002';
  const request = (body) => new Request('http://localhost/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ family: 'knowledgeTrees', ...laneIdentity, ...body }),
  });
  assert.equal((await POST(request({ message: 'A fishing trip', uploadId, hasTypedUploadMessage: true }))).status, 200);
  assert.equal(globalThis.__chatRouteCalls.at(-1).uploadHasHumanMessage, true);
  assert.deepEqual(globalThis.__chatRouteBindings, [{ uploadId, ownerObjectId: '00000000-0000-0000-0000-000000000001', message: 'A fishing trip' }]);
  assert.equal((await POST(request({ message: 'Default browser request', uploadId }))).status, 200);
  assert.equal(globalThis.__chatRouteCalls.at(-1).uploadHasHumanMessage, false);
  assert.equal(globalThis.__chatRouteBindings.length, 1);
  assert.equal((await POST(request({ message: 'It is a trout.', pendingUploadId: uploadId }))).status, 200);
  assert.equal(globalThis.__chatRouteCalls.at(-1).pendingUploadId, uploadId);
  assert.equal(globalThis.__chatRouteCalls.at(-1).uploadId, null);
  assert.equal(globalThis.__chatRouteBindings.length, 1);
  globalThis.__chatRouteUploadStatus = 'running';
  assert.equal((await POST(request({ message: 'It is a trout.', pendingUploadId: uploadId }))).status, 404);
  globalThis.__chatRouteUploadOwned = false;
  assert.equal((await POST(request({ message: 'It is a trout.', pendingUploadId: uploadId }))).status, 404);
});

test('completed uploads derive human-message provenance from storage, not a client flag or follow-up text', async (t) => {
  t.after(() => { delete globalThis.__chatRouteOriginalHumanMessage; });
  globalThis.__chatRouteCalls = [];
  globalThis.__chatRouteUploadOwned = true;
  globalThis.__chatRouteUploadStatus = 'succeeded';
  const uploadId = '00000000-0000-0000-0000-000000000002';
  const request = (body) => new Request('http://localhost/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ family: 'knowledgeTrees', ...laneIdentity, ...body }),
  });
  for (const originalHumanMessage of [null, '   ', 'Only process this file; do not prepare a save preview.']) {
    globalThis.__chatRouteOriginalHumanMessage = originalHumanMessage;
    const expected = Boolean(originalHumanMessage?.trim());
    for (const context of [
      { previewUploadId: uploadId, message: 'Browser (automatisk): Uploaden er færdigbehandlet.' },
      { pendingUploadId: uploadId, message: 'It is a pike.' },
    ]) {
      const response = await POST(request({ ...context, uploadHasHumanMessage: !expected }));
      assert.equal(response.status, 200);
      assert.equal(globalThis.__chatRouteCalls.at(-1).uploadHasHumanMessage, expected);
    }
  }
});
