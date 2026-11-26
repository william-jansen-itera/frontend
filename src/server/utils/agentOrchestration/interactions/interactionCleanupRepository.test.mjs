import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stubs = {
      treeCatalog: 'export const getAuditMetadata = (principal) => ({ updatedByObjectId: principal?.userId });',
      treePathRepository: 'export const permanentlyDeletePersonalCacheSubtree = (options) => globalThis.__deleteInteraction(options);',
      sql: `
        export const getRequiredApplicationIdentifier = () => 'app-a';
        export const withSqlConnection = async (callback) => callback();
        class Request {
          constructor(transaction) { this.transaction = transaction; this.inputs = {}; }
          input(name, type, value) { this.inputs[name] = value; return this; }
          query(query) { return globalThis.__queryInteractions({ query, inputs: this.inputs, transaction: this.transaction }); }
        }
        class Transaction {
          async begin(isolation) { globalThis.__interactionTransactions.push(this); this.isolation = isolation; }
          async commit() { this.committed = true; }
          async rollback() { this.rolledBack = true; }
        }
        export const sql = {
          Request, Transaction, Int: 'int', NVarChar: () => 'nvarchar',
          ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' },
        };`,
    };
    const stub = stubs[specifier.split('/').at(-1)];
    return stub
      ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const { cleanupInactiveInteractions } = await import('./interactionCleanupRepository.js');
const options = { treeId: 7, principal: { userId: 'owner-a' }, interactionId: 'new-interaction' };
let queries, deletions, candidates, rechecked, lockResults, failure;

function setup() {
  queries = [];
  deletions = [];
  candidates = [];
  rechecked = new Set();
  lockResults = [];
  failure = null;
  globalThis.__interactionTransactions = [];
  globalThis.__queryInteractions = async (request) => {
    queries.push(request);
    if (request.query.includes('sp_getapplock')) {
      return { recordset: [{ result: lockResults.length ? lockResults.shift() : 0 }] };
    }
    if (failure === 'initial-query' || failure === 'recheck-query' && request.transaction) {
      throw new Error('Cleanup query failed');
    }
    return {
      recordset: request.transaction
        ? rechecked.has(request.inputs.node_id) ? [{ interactionNodeId: request.inputs.node_id }] : []
        : candidates.slice(0, 20),
    };
  };
  globalThis.__deleteInteraction = async (scope) => {
    deletions.push(scope);
    return failure !== 'delete';
  };
}

test('24-hour-old interaction leaves are eligible in the exact owner/app path, including active and pending ones', async () => {
  setup();
  assert.equal(await cleanupInactiveInteractions(options), 0);
  const { query, inputs } = queries[0];
  assert.equal(inputs.tree_id, 7);
  assert.equal(inputs.owner, 'owner-a');
  assert.equal(inputs.application_identifier, 'app-a');
  assert.equal(inputs.current_interaction_id, 'new-interaction');
  assert.match(query, /tree\.id = @tree_id AND tree\.deleted_at IS NULL AND tree\.is_private = 1/);
  assert.match(query, /LOWER\(LTRIM\(RTRIM\(tree\.display_name\)\)\) = N'personal cache'/);
  assert.match(query, /tree\.owner_object_id = @owner AND app\.app_identifier = @application_identifier/);
  assert.match(query, /interactions\.parent_id IS NULL AND interactions\.text = N'Interactions'/);
  assert.match(query, /by_id\.text = N'By Interaction ID'/);
  assert.match(query, /interaction\.deleted_at IS NULL AND interaction\.is_leaf_node = 1/);
  assert.match(query, /interaction\.text <> @current_interaction_id/);
  assert.match(query, /details\.updated_at <= DATEADD\(HOUR, -24, SYSUTCDATETIME\(\)\)/);
  assert.match(query, /ISJSON\(details\.notes\) = 1/);
  assert.match(query, /'\$\.schemaVersion'\) = N'1'/);
  assert.match(query, /'\$\.id'\) = interaction\.text/);
  assert.match(query, /'\$\.status'\)\s+IN \(N'active', N'completed', N'cancelled'\)/);
  assert.doesNotMatch(query, /'\$\.pending'/);
  assert.match(query, /child\.parent_id = interaction\.id/);
  assert.match(query, /files\.tree_node_id = interaction\.id/);
  assert.doesNotMatch(query, /agent_action_approvals|N'Conversations'|N'Quizzes'/);
});

test('cleanup deletes at most 20 oldest candidates, locking and rechecking each leaf before removal', async () => {
  setup();
  candidates = Array.from({ length: 25 }, (_, index) => ({ interactionNodeId: index + 10 }));
  rechecked = new Set(candidates.map(({ interactionNodeId }) => interactionNodeId));
  assert.equal(await cleanupInactiveInteractions(options), 20);
  assert.equal(deletions.length, 20);
  assert.match(queries[0].query, /SELECT TOP \(20\)/);
  assert.match(queries[0].query, /ORDER BY details\.updated_at, interaction\.id/);
  for (const [index, deletion] of deletions.entries()) {
    const transaction = globalThis.__interactionTransactions[index];
    assert.deepEqual(deletion, {
      treeId: 7, rootNodeId: candidates[index].interactionNodeId, ownerObjectId: 'owner-a', transaction,
    });
    assert.equal(transaction.isolation, 'serializable');
    assert.equal(transaction.committed, true);
    assert.notEqual(transaction.rolledBack, true);
    const requests = queries.filter((request) => request.transaction === transaction);
    assert.deepEqual(requests.slice(0, 2).map(({ inputs }) => inputs.resource), [
      'tree-path:7', `personal-cache-note:7:${deletion.rootNodeId}`,
    ]);
    assert.equal(requests[2].inputs.node_id, deletion.rootNodeId);
    assert.match(requests[2].query, /AND interaction\.id = @node_id/);
    assert.match(requests[2].query, /details\.updated_at <= DATEADD\(HOUR, -24, SYSUTCDATETIME\(\)\)/);
    assert.match(requests[2].query, /IN \(N'active', N'completed', N'cancelled'\)/);
    assert.doesNotMatch(requests[2].query, /'\$\.pending'/);
    assert.equal(requests[2].inputs.owner, 'owner-a');
    assert.equal(requests[2].inputs.application_identifier, 'app-a');
  }
});

test('a candidate no longer eligible after the locks is preserved', async () => {
  setup();
  candidates = [{ interactionNodeId: 10 }, { interactionNodeId: 11 }];
  rechecked.add(11);
  assert.equal(await cleanupInactiveInteractions(options), 1);
  assert.deepEqual(deletions.map(({ rootNodeId }) => rootNodeId), [11]);
  assert.ok(globalThis.__interactionTransactions.every((transaction) => transaction.committed));
});

test('authentication, queries, lock failures and deletion failures are explicit and roll back', async () => {
  setup();
  await assert.rejects(cleanupInactiveInteractions({ ...options, principal: null }), /authenticated principal/);
  assert.equal(queries.length, 0);
  for (const error of ['initial-query', 'recheck-query', 'path-lock', 'note-lock', 'missing-lock', 'delete']) {
    setup();
    candidates = [{ interactionNodeId: 10 }];
    rechecked.add(10);
    failure = error;
    if (error === 'path-lock') lockResults = [-1];
    if (error === 'note-lock') lockResults = [0, -1];
    if (error === 'missing-lock') lockResults = [undefined];
    await assert.rejects(cleanupInactiveInteractions(options), /query failed|Could not lock|Could not delete/);
    assert.ok(globalThis.__interactionTransactions.every((transaction) => transaction.rolledBack && !transaction.committed));
    if (error !== 'delete') assert.equal(deletions.length, 0);
  }
});
