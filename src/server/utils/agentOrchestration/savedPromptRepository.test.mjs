import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

const records = new Map();
const parents = new Map();
const trees = new Map();
let application = 'app-one';
let sequence = 0;
globalThis.__savedPromptCache = {
  async getPersonalCacheContext(principal) {
    const scope = JSON.stringify([application, principal.userId]);
    if (!trees.has(scope)) trees.set(scope, ++sequence);
    return { personalCacheTreeId: trees.get(scope), updatedBy: { updatedByObjectId: principal.userId } };
  },
  async replacePersonalCacheNotes({ treeId, pathSegments, notes }) {
    const parentKey = JSON.stringify([treeId, pathSegments.slice(0, -1)]);
    if (!parents.has(parentKey)) parents.set(parentKey, ++sequence);
    const parentId = parents.get(parentKey);
    const id = pathSegments.at(-1);
    records.set(JSON.stringify([treeId, parentId, id]), { treeId, parentId, id, content: notes });
  },
  async findPersonalCacheLeafPathNode({ treeId, pathSegments }) {
    const id = parents.get(JSON.stringify([treeId, pathSegments]));
    return id ? { id, isLeafNode: false } : null;
  },
  async deletePersonalCachePath({ treeId, pathSegments }) {
    const parentId = parents.get(JSON.stringify([treeId, pathSegments.slice(0, -1)]));
    return records.delete(JSON.stringify([treeId, parentId, pathSegments.at(-1)]));
  },
};
globalThis.__savedPromptPool = {
  request() {
    const inputs = {};
    return {
      input(name, type, value) { inputs[name] = value; return this; },
      async query() {
        return {
          recordset: [...records.values()]
            .filter((record) => record.treeId === inputs.tree_instance_id && record.parentId === inputs.parent_id)
            .map(({ id, content }) => ({ id, content })),
        };
      },
    };
  },
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/personalCacheTreeRepository')) {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const { getPersonalCacheContext, replacePersonalCacheNotes, findPersonalCacheLeafPathNode, deletePersonalCachePath } = globalThis.__savedPromptCache;')}`,
        shortCircuit: true,
      };
    }
    if (specifier === '@/server/utils/sql') {
      return {
        url: `data:text/javascript,${encodeURIComponent('export const sql = { Int: "int" }; export const withSqlConnection = (callback) => callback(globalThis.__savedPromptPool);')}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { savePrompt, listSavedPrompts, deleteSavedPrompt } = await import('./savedPromptRepository.js');

test('prompts survive repeated reads, preserve content, deduplicate and remain isolated by application, user and family', async () => {
  const principal = { userId: 'owner' };
  const options = { principal, family: 'email' };
  const content = '  Instructions\n    Preserve this spacing.\n';
  const first = await savePrompt({ ...options, content });
  assert.deepEqual(await savePrompt({ ...options, content }), first);
  assert.deepEqual(await listSavedPrompts(options), [first]);
  assert.deepEqual(await listSavedPrompts(options), [first]);

  const otherFamily = { ...options, family: 'knowledgeTrees' };
  assert.deepEqual(await listSavedPrompts(otherFamily), []);
  const familyPrompt = await savePrompt({ ...otherFamily, content: 'Knowledge instructions' });
  assert.deepEqual(await listSavedPrompts(otherFamily), [familyPrompt]);

  const otherUser = { ...options, principal: { userId: 'another-owner' } };
  assert.deepEqual(await listSavedPrompts(otherUser), []);
  await savePrompt({ ...otherUser, content: 'Other user instructions' });
  assert.deepEqual(await listSavedPrompts(options), [first]);

  application = 'app-two';
  assert.deepEqual(await listSavedPrompts(options), []);
  await savePrompt({ ...options, content: 'Other application instructions' });
  application = 'app-one';
  assert.deepEqual(await listSavedPrompts(options), [first]);
});

test('new notes receive short identifiers without changing their full prompt text', async () => {
  const options = { principal: { userId: 'short-titles' }, family: 'email' };
  const content = 'Long instructions '.repeat(100);
  const saved = await savePrompt({ ...options, content });
  assert.match(saved.id, /^Prompt [a-f0-9]{8}$/);
  assert.equal(saved.content, content);
  assert.deepEqual(await listSavedPrompts(options), [saved]);
});

test('existing full-hash titles are preserved and reused when saving the same content', async () => {
  const principal = { userId: 'legacy-titles' };
  const family = 'email';
  const content = 'Existing prompt instructions';
  const id = createHash('sha256').update(content).digest('hex');
  const { personalCacheTreeId: treeId } = await globalThis.__savedPromptCache.getPersonalCacheContext(principal);
  await globalThis.__savedPromptCache.replacePersonalCacheNotes({
    treeId, pathSegments: ['Chat', 'Prompts', family, id], notes: content,
  });
  assert.deepEqual(await savePrompt({ principal, family, content }), { id, content });
  assert.deepEqual(await listSavedPrompts({ principal, family }), [{ id, content }]);
});

test('a short title already used by an edited note is extended rather than overwritten', async () => {
  const principal = { userId: 'edited-titles' };
  const family = 'email';
  const content = 'Original instructions';
  const first = await savePrompt({ principal, family, content });
  const { personalCacheTreeId: treeId } = await globalThis.__savedPromptCache.getPersonalCacheContext(principal);
  const editedContent = 'Instructions edited in Notes';
  await globalThis.__savedPromptCache.replacePersonalCacheNotes({
    treeId, pathSegments: ['Chat', 'Prompts', family, first.id], notes: editedContent,
  });
  const second = await savePrompt({ principal, family, content });
  assert.match(second.id, /^Prompt [a-f0-9]{12}$/);
  assert.deepEqual(await listSavedPrompts({ principal, family }), [
    { ...first, content: editedContent }, second,
  ]);
});

test('delete removes only the selected prompt in the current application, user and family', async () => {
  const options = { principal: { userId: 'delete-owner' }, family: 'email' };
  const saved = await savePrompt({ ...options, content: 'Delete this prompt' });
  const keep = await savePrompt({ ...options, content: 'Keep this prompt' });
  for (const otherScope of [
    { ...options, principal: { userId: 'different-owner' } },
    { ...options, family: 'knowledgeTrees' },
  ]) {
    assert.equal(await deleteSavedPrompt({ ...otherScope, id: saved.id }), false);
  }
  application = 'another-application';
  try {
    assert.equal(await deleteSavedPrompt({ ...options, id: saved.id }), false);
  } finally {
    application = 'app-one';
  }
  assert.deepEqual(await listSavedPrompts(options), [saved, keep]);
  assert.equal(await deleteSavedPrompt({ ...options, id: saved.id }), true);
  assert.deepEqual(await listSavedPrompts(options), [keep]);
  assert.equal(await deleteSavedPrompt({ ...options, id: saved.id }), false);
});

test('delete supports legacy and user-renamed titles without touching the collection', async () => {
  const options = { principal: { userId: 'delete-renamed' }, family: 'email' };
  const { personalCacheTreeId: treeId } = await globalThis.__savedPromptCache.getPersonalCacheContext(options.principal);
  for (const id of ['a'.repeat(64), 'My renamed prompt']) {
    await globalThis.__savedPromptCache.replacePersonalCacheNotes({
      treeId, pathSegments: ['Chat', 'Prompts', options.family, id], notes: 'Saved content',
    });
    assert.equal(await deleteSavedPrompt({ ...options, id }), true);
  }
  assert.equal(await deleteSavedPrompt({ ...options, id: options.family }), false);
  assert.deepEqual(await listSavedPrompts(options), []);
});
