import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const name = specifier.split('/').at(-1);
    const stubs = {
      treeCatalog: 'export const getAuditMetadata = (principal) => ({ updatedByObjectId: principal?.userId });',
      treePathRepository: 'export const permanentlyDeletePersonalCacheSubtree = (options) => globalThis.__deleteConversation(options);',
      sql: `
        export const getRequiredApplicationIdentifier = () => 'app-a';
        export const withSqlConnection = async (callback) => callback();
        class Request {
          constructor(transaction) { this.transaction = transaction; this.inputs = {}; }
          input(name, type, value) { this.inputs[name] = value; return this; }
          query(query) { return globalThis.__queryConversations({ query, inputs: this.inputs, transaction: this.transaction }); }
        }
        class Transaction {
          async begin(isolation) { globalThis.__cleanupTransactions.push(this); this.isolation = isolation; }
          async commit() { this.committed = true; }
          async rollback() { this.rolledBack = true; }
        }
        export const sql = {
          Request, Transaction, Int: 'int', NVarChar: () => 'nvarchar',
          ISOLATION_LEVEL: { SERIALIZABLE: 'serializable' },
        };`,
    };
    return stubs[name]
      ? { url: `data:text/javascript,${encodeURIComponent(stubs[name])}`, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const { cleanupInactiveTreeConversations } = await import('./treeConversationCleanupRepository.js');
const options = { treeId: 7, principal: { userId: 'owner-a' }, conversationId: 'new-conversation' };
let queries;
let deletions;
let candidates;
let rechecked;
let lockResults;
let queryError;
let deleteResult;

function setup() {
  queries = [];
  deletions = [];
  candidates = [];
  rechecked = new Map();
  lockResults = [];
  queryError = null;
  deleteResult = true;
  globalThis.__cleanupTransactions = [];
  globalThis.__queryConversations = async (request) => {
    queries.push(request);
    if (request.query.includes('sp_getapplock')) {
      return { recordset: [{ result: lockResults.length ? lockResults.shift() : 0 }] };
    }
    if (queryError && (queryError.initial || request.transaction)) throw new Error('Cleanup query failed');
    return {
      recordset: request.transaction
        ? rechecked.get(request.inputs.state_node_id) ?? []
        : candidates.slice(0, 20),
    };
  };
  globalThis.__deleteConversation = async (scope) => {
    deletions.push(scope);
    return deleteResult;
  };
}

test('cleanup selects a bounded oldest-first batch in the exact owner, application, and conversation-state scope', async () => {
  setup();
  assert.equal(await cleanupInactiveTreeConversations(options), 0);
  assert.equal(globalThis.__cleanupTransactions.length, 0);
  const { query, inputs } = queries[0];
  assert.equal(inputs.tree_id, 7);
  assert.equal(inputs.owner, 'owner-a');
  assert.equal(inputs.application_identifier, 'app-a');
  assert.equal(inputs.current_conversation_id, 'new-conversation');
  assert.match(query, /SELECT TOP \(20\)/);
  assert.match(query, /tree\.owner_object_id = @owner AND app\.app_identifier = @application_identifier/);
  assert.match(query, /tree\.id = @tree_id AND tree\.deleted_at IS NULL AND tree\.is_private = 1/);
  assert.match(query, /LOWER\(LTRIM\(RTRIM\(tree\.display_name\)\)\) = N'personal cache'/);
  assert.match(query, /family\.parent_id IS NULL AND family\.text = N'Knowledge Trees'/);
  assert.match(query, /conversations\.text = N'Conversations'/);
  assert.match(query, /state_node\.text = N'State' AND state_node\.is_leaf_node = 1/);
  assert.match(query, /conversation\.text <> @current_conversation_id/);
  assert.match(query, /details\.updated_at <= DATEADD\(DAY, -7, SYSUTCDATETIME\(\)\)/);
  assert.match(query, /ISJSON\(details\.notes\) = 1/);
  assert.match(query, /'\$\.turn\.status'\)\s+IN \(N'completed', N'failed'\)/);
  assert.match(query, /ORDER BY details\.updated_at, conversation\.id/);
  assert.match(query, /extra\.parent_id = conversation\.id AND extra\.id <> state_node\.id/);
  assert.match(query, /OR extra\.parent_id = state_node\.id/);
  assert.match(query, /files\.tree_node_id IN \(conversation\.id, state_node\.id\)/);
  assert.match(query, /branch_details\.tree_node_id = conversation\.id/);
});

test('each deletion locks the path and state, rechecks eligibility, and removes only that conversation branch', async () => {
  setup();
  candidates = [{ conversationNodeId: 11, stateNodeId: 12 }, { conversationNodeId: 21, stateNodeId: 22 }];
  for (const candidate of candidates) rechecked.set(candidate.stateNodeId, [candidate]);
  assert.equal(await cleanupInactiveTreeConversations(options), 2);
  assert.deepEqual(deletions.map(({ rootNodeId }) => rootNodeId), [11, 21]);
  for (const [index, deletion] of deletions.entries()) {
    const transaction = globalThis.__cleanupTransactions[index];
    assert.equal(deletion.treeId, 7);
    assert.equal(deletion.ownerObjectId, 'owner-a');
    assert.equal(deletion.transaction, transaction);
    assert.equal(transaction.isolation, 'serializable');
    assert.equal(transaction.committed, true);
    assert.notEqual(transaction.rolledBack, true);
    const requests = queries.filter((request) => request.transaction === transaction);
    assert.deepEqual(requests.slice(0, 2).map(({ inputs }) => inputs.resource), [
      'tree-path:7', `personal-cache-note:7:${candidates[index].stateNodeId}`,
    ]);
    assert.equal(requests[2].inputs.state_node_id, candidates[index].stateNodeId);
    assert.match(requests[2].query, /AND state_node\.id = @state_node_id/);
    assert.match(requests[2].query, /details\.updated_at <= DATEADD\(DAY, -7, SYSUTCDATETIME\(\)\)/);
    assert.match(requests[2].query, /IN \(N'completed', N'failed'\)/);
    assert.equal(requests[2].inputs.owner, 'owner-a');
    assert.equal(requests[2].inputs.application_identifier, 'app-a');
  }
});

test('candidates that resumed, became running, disappeared, or changed scope before the recheck are retained', async () => {
  setup();
  candidates = [
    { conversationNodeId: 11, stateNodeId: 12 },
    { conversationNodeId: 21, stateNodeId: 22 },
    { conversationNodeId: 31, stateNodeId: 32 },
    { conversationNodeId: 41, stateNodeId: 42 },
  ];
  assert.equal(await cleanupInactiveTreeConversations(options), 0);
  assert.equal(deletions.length, 0);
  assert.equal(globalThis.__cleanupTransactions.length, 4);
  assert.ok(globalThis.__cleanupTransactions.every((transaction) => transaction.committed));
});

test('cleanup processes at most 20 candidates per creation', async () => {
  setup();
  candidates = Array.from({ length: 25 }, (_, index) => ({
    conversationNodeId: index * 2 + 1, stateNodeId: index * 2 + 2,
  }));
  for (const candidate of candidates) rechecked.set(candidate.stateNodeId, [candidate]);
  await cleanupInactiveTreeConversations(options);
  assert.equal(deletions.length, 20);
  assert.equal(globalThis.__cleanupTransactions.length, 20);
});

test('authentication, query, lock, and deletion failures are explicit and incomplete deletions roll back', async () => {
  setup();
  await assert.rejects(cleanupInactiveTreeConversations({ ...options, principal: null }), /authenticated principal/);
  assert.equal(queries.length, 0);
  for (const failure of ['initial-query', 'recheck-query', 'path-lock', 'note-lock', 'missing-lock', 'delete']) {
    setup();
    candidates = [{ conversationNodeId: 11, stateNodeId: 12 }];
    rechecked.set(12, candidates);
    if (failure === 'initial-query') queryError = { initial: true };
    if (failure === 'recheck-query') queryError = {};
    if (failure === 'path-lock') lockResults = [-1];
    if (failure === 'note-lock') lockResults = [0, -1];
    if (failure === 'missing-lock') lockResults = [undefined];
    if (failure === 'delete') deleteResult = false;
    await assert.rejects(cleanupInactiveTreeConversations(options), /query failed|Could not lock|Could not delete/);
    assert.ok(globalThis.__cleanupTransactions.every((transaction) => transaction.rolledBack && !transaction.committed));
    if (failure !== 'delete') assert.equal(deletions.length, 0);
  }
});
