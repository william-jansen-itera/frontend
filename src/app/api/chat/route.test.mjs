import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const modules = new Map([
  ['next/server', 'export const NextResponse = { json: (body, { status = 200 } = {}) => ({ body, status, headers: new Headers() }) };'],
  ['agentFamilyInvoker', `
    export const resolveAgentFamilySelection = async (family) => ({ family: family || 'knowledgeTrees' });
    export const invokeAgentFamily = async (options) => {
      globalThis.__chatRouteCalls.push(options);
      return { answer: 'Reply', responseLanguage: 'Danish', agent: { name: 'test-agent' }, toolsUsed: [] };
    };
  `],
  ['logging', 'export const logException = async () => {}; export const logStructuredTrace = async () => {}; export const logTrace = async () => {};'],
  ['auth', 'export const requireAuthenticatedPrincipal = () => ({ userId: "owner" });'],
  ['treeCatalog', 'export const getAuditMetadata = () => ({ updatedByObjectId: "00000000-0000-0000-0000-000000000001" });'],
  ['chatUploadRepository', 'export const getOwnedChatUpload = async () => globalThis.__chatRouteUploadOwned ? { id: "owned" } : null;'],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = modules.get(specifier === 'next/server' ? specifier : specifier.split('/').at(-1));
    return stub ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { POST } = await import('./route.js');

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
  globalThis.__chatRouteUploadOwned = false;
  const body = {
    family: 'knowledgeTrees',
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
