import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').at(-1);
    const stubs = {
      treePathRepository: `
        export const ensureTreePath = async () => { globalThis.__cacheEnsures++; return { id: '7' }; };
        export const findTreePathNode = async () => globalThis.__cacheLeafPresent ? { id: '7' } : null;
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
            globalThis.__cacheQueries.push(query);
            if (query.includes('sp_getapplock')) {
              globalThis.__cacheOnLock?.();
              return { recordset: [{ result: globalThis.__cacheLockResult }] };
            }
            if (query.includes('SELECT details.notes')) {
              return { recordset: globalThis.__cacheOwnerPresent ? [{
                notes: 'before',
                expired: globalThis.__cacheNow - globalThis.__cacheUpdatedAt >= 24 * 60 * 60 * 1000 ? 1 : 0,
              }] : [] };
            }
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
const { mutatePersonalCacheNotes, readPersonalCacheNotes } = await import('./personalCacheTreeRepository.js');
const options = { treeId: 1, principal: { userId: 'owner' }, pathSegments: ['State'] };
function setup() {
  globalThis.__cacheWrites = [];
  globalThis.__cacheCommits = 0;
  globalThis.__cacheRollbacks = 0;
  globalThis.__cacheLockResult = 0;
  globalThis.__cacheOwnerPresent = true;
  globalThis.__cacheNow = Date.parse('2026-11-25T12:00:00Z');
  globalThis.__cacheUpdatedAt = globalThis.__cacheNow;
  globalThis.__cacheQueries = [];
  globalThis.__cacheOnLock = null;
  globalThis.__cacheLeafPresent = true;
  globalThis.__cacheEnsures = 0;
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

test('chat-state reads and mutations reject at the exact 24-hour database inactivity boundary, without reviving records', async () => {
  const day = 24 * 60 * 60 * 1000;
  for (const age of [day - 1, day, day + 1]) {
    setup();
    globalThis.__cacheUpdatedAt = globalThis.__cacheNow - age;
    let mutations = 0;
    const read = () => readPersonalCacheNotes({ ...options, expireAfterInactivity: true });
    const write = () => mutatePersonalCacheNotes({
      ...options, expireAfterInactivity: true,
      mutate: (notes) => {
        mutations++;
        return { notes: `${notes}-after`, result: 'changed' };
      },
    });
    if (age < day) {
      assert.equal(await read(), 'before');
      assert.equal(await write(), 'changed');
      assert.equal(mutations, 1);
    } else {
      for (const operation of [read, write]) {
        await assert.rejects(operation(), { status: 410, code: 'CHAT_STATE_EXPIRED', message: /24 hours.*Reload chat/ });
      }
      assert.equal(mutations, 0);
      assert.equal(globalThis.__cacheWrites.length, 0);
      assert.equal(globalThis.__cacheCommits, 0);
      assert.equal(globalThis.__cacheRollbacks, 1);
    }
    const reads = globalThis.__cacheQueries.filter((query) => query.includes('SELECT details.notes'));
    assert.equal(reads.length, 2);
    for (const query of reads) {
      assert.match(query, /details\.updated_at <= DATEADD\(HOUR, -24, SYSUTCDATETIME\(\)\)/);
      assert.match(query, /tree\.owner_object_id = @owner AND app\.app_identifier = @application_identifier/);
      assert.doesNotMatch(query, /JSON_VALUE/);
    }
  }
});

test('expiry is rechecked after obtaining the mutation lock and does not apply to unrelated cache notes', async () => {
  setup();
  globalThis.__cacheOnLock = () => { globalThis.__cacheUpdatedAt -= 24 * 60 * 60 * 1000; };
  await assert.rejects(mutatePersonalCacheNotes({
    ...options, expireAfterInactivity: true,
    mutate: () => { throw new Error('Expired mutation must not run'); },
  }), { status: 410 });
  assert.equal(globalThis.__cacheWrites.length, 0);
  globalThis.__cacheOnLock = null;
  assert.equal(await mutatePersonalCacheNotes({
    ...options, mutate: (notes) => ({ notes, result: 'unrelated cache note preserved' }),
  }), 'unrelated cache note preserved');
});

test('updating or resuming a cleaned-up chat record does not recreate its cache path', async () => {
  setup();
  globalThis.__cacheLeafPresent = false;
  await assert.rejects(mutatePersonalCacheNotes({
    ...options, expireAfterInactivity: true, createIfMissing: false,
    mutate: () => { throw new Error('Missing record must not be recreated'); },
  }), { status: 410, code: 'CHAT_STATE_EXPIRED' });
  assert.equal(globalThis.__cacheEnsures, 0);
  assert.equal(globalThis.__cacheWrites.length, 0);
});
