import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const principal = { userId: 'owner' };
const calls = [];
let authError;
let storageError;
let deleteResult = true;
const modules = new Map([
  ['next/server', 'export const NextResponse = { json: (body, options = {}) => ({ body, status: 200, ...options }) };'],
  ['auth', `export const requireAuthenticatedPrincipal = () => globalThis.__promptAuth();`],
  ['agentFamilyRegistry', 'export const listRegisteredAgentFamilies = () => ["knowledgeTrees", "email"];'],
  ['savedPromptRepository', `
    export const savePrompt = (options) => globalThis.__promptStorage("save", options);
    export const listSavedPrompts = (options) => globalThis.__promptStorage("list", options);
    export const deleteSavedPrompt = (options) => globalThis.__promptStorage("delete", options);
  `],
]);
globalThis.__promptAuth = () => {
  if (authError) throw authError;
  return principal;
};
globalThis.__promptStorage = (operation, options) => {
  calls.push({ operation, ...options });
  if (storageError) throw storageError;
  if (operation === 'delete') return deleteResult;
  return operation === 'save' ? { id: 'saved', content: options.content } : [{ id: 'saved', content: 'Instructions' }];
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = modules.get(specifier === 'next/server' ? specifier : specifier.split('/').at(-1));
    return stub
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { GET, POST, DELETE } = await import('./route.js');
const remove = (query = '?family=email&id=Prompt%20a1b2c3d4') => DELETE(new Request(`http://localhost/api/chat/prompts${query}`, { method: 'DELETE' }));
const post = (body) => POST(new Request('http://localhost/api/chat/prompts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));

test('save preserves multiline content and derives ownership from authentication, not the body', async () => {
  calls.length = 0;
  const content = '  Detailed instructions:\n    Keep indentation.\n';
  const response = await post({ family: 'email', content, userId: 'another-user', applicationIdentifier: 'another-app' });
  assert.equal(response.status, 201);
  assert.deepEqual(response.body.prompt, { id: 'saved', content });
  assert.deepEqual(calls, [{ operation: 'save', principal, family: 'email', content }]);
});

test('listing is authenticated, family-scoped and not cacheable', async () => {
  calls.length = 0;
  const response = await GET(new Request('http://localhost/api/chat/prompts?family=knowledgeTrees'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.prompts, [{ id: 'saved', content: 'Instructions' }]);
  assert.deepEqual(calls, [{ operation: 'list', principal, family: 'knowledgeTrees' }]);
  assert.equal(response.headers['Cache-Control'], 'private, no-store');
});

test('rejects invalid family, empty or non-string content and malformed JSON without storage calls', async () => {
  calls.length = 0;
  for (const body of [null, {}, { family: '../email', content: 'text' }, { family: 'email', content: ' \n ' }, { family: 'email', content: 3 }]) {
    assert.equal((await post(body)).status, 400);
  }
  for (const query of ['', '?family=unknown']) {
    assert.equal((await GET(new Request(`http://localhost/api/chat/prompts${query}`))).status, 400);
  }
  assert.equal((await POST(new Request('http://localhost/api/chat/prompts', { method: 'POST', body: '{' }))).status, 400);
  assert.deepEqual(calls, []);
});

test('unauthenticated requests cannot list or save, and persistence failures never report success', async (t) => {
  t.mock.method(console, 'error', () => {});
  calls.length = 0;
  authError = Object.assign(new Error('Authentication required'), { status: 401 });
  try {
    assert.equal((await post({ family: 'email', content: 'text' })).status, 401);
    assert.equal((await GET(new Request('http://localhost/api/chat/prompts?family=email'))).status, 401);
    assert.equal((await remove()).status, 401);
    assert.deepEqual(calls, []);
  } finally {
    authError = null;
  }
  storageError = new Error('Storage unavailable');
  try {
    assert.equal((await post({ family: 'email', content: 'text' })).status, 500);
    assert.equal((await GET(new Request('http://localhost/api/chat/prompts?family=email'))).status, 500);
    assert.equal((await remove()).status, 500);
  } finally {
    storageError = null;
  }
});

test('delete uses authenticated ownership and returns not found for missing or unowned prompts', async () => {
  calls.length = 0;
  const response = await remove('?family=email&id=My%20renamed%20prompt&userId=another-owner');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { deleted: true });
  assert.deepEqual(calls, [{ operation: 'delete', principal, family: 'email', id: 'My renamed prompt' }]);
  deleteResult = false;
  try {
    assert.equal((await remove()).status, 404);
  } finally {
    deleteResult = true;
  }
});

test('delete rejects missing or invalid identifiers and families before accessing storage', async () => {
  calls.length = 0;
  for (const query of ['', '?family=email', '?family=unknown&id=test', '?family=email&id=%20', `?family=email&id=${'a'.repeat(256)}`]) {
    assert.equal((await remove(query)).status, 400);
  }
  assert.deepEqual(calls, []);
});
