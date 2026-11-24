import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').at(-1);
    const stubs = {
      treePathRepository: `
        export const ensureTreePath = async () => ({ id: '7' });
        export const findTreePathNode = async () => null;
        export const listPersonalCacheSubtreeAttachments = async () => [];
        export const permanentlyDeletePersonalCacheSubtree = async () => false;`,
      blobStorage: 'export const deleteNodeAttachmentBlobIfExists = async () => {}; export const restoreNodeAttachmentBlobIfDeleted = async () => {};',
      treeCatalog: 'export const ensurePersonalCacheTree = async () => ({}); export const getAuditMetadata = () => ({ updatedByObjectId: "owner" });',
      treeRecordRepository: `
        export const queryTreeNodeDetailRecord = async () => null;
        export const upsertTreeNodeDetails = async (options) => { globalThis.__cacheWrites.push(options); };`,
      sql: `
        export const getRequiredApplicationIdentifier = () => 'application';
        export const withSqlConnection = async (callback) => callback();
        class Request {
          input() { return this; }
          async query(query) {
            if (query.includes('sp_getapplock')) return { recordset: [{ result: globalThis.__cacheLockResult }] };
            if (query.includes('SELECT details.notes')) return { recordset: globalThis.__cacheOwnerPresent ? [{ notes: 'before' }] : [] };
            return { recordset: [{ id: 1 }] };
          }
        }
        class Transaction {
          async begin() {}
          async commit() { globalThis.__cacheCommits++; }
          async rollback() { globalThis.__cacheRollbacks++; }
        }
        export const sql = { Request, Transaction, Int: 'int', NVarChar: () => 'nvarchar' };`,
    };
    return stubs[name]
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[name])}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});
const { mutatePersonalCacheNotes } = await import('./personalCacheTreeRepository.js');
const options = { treeId: 1, principal: { userId: 'owner' }, pathSegments: ['State'] };
function setup() {
  globalThis.__cacheWrites = [];
  globalThis.__cacheCommits = 0;
  globalThis.__cacheRollbacks = 0;
  globalThis.__cacheLockResult = 0;
  globalThis.__cacheOwnerPresent = true;
}

test('a short atomic cache mutation reads the locked value and commits its result', async () => {
  setup();
  const result = await mutatePersonalCacheNotes({
    ...options,
    mutate: (notes) => ({ notes: `${notes}-after`, result: 42 }),
  });
  assert.equal(result, 42);
  assert.equal(globalThis.__cacheWrites[0].notes, 'before-after');
  assert.ok(globalThis.__cacheWrites[0].transaction);
  assert.equal(globalThis.__cacheCommits, 1);
});

test('lock failure, lost ownership, invalid mutation, or callback error rolls back without writing', async () => {
  for (const failure of ['lock', 'missing-lock', 'owner', 'invalid', 'callback']) {
    setup();
    if (failure === 'lock') globalThis.__cacheLockResult = -1;
    if (failure === 'missing-lock') globalThis.__cacheLockResult = undefined;
    if (failure === 'owner') globalThis.__cacheOwnerPresent = false;
    await assert.rejects(mutatePersonalCacheNotes({
      ...options,
      mutate: () => {
        if (failure === 'callback') throw new Error('Rejected transition');
        return null;
      },
    }));
    assert.equal(globalThis.__cacheWrites.length, 0);
    assert.equal(globalThis.__cacheCommits, 0);
    assert.equal(globalThis.__cacheRollbacks, 1);
  }
});
