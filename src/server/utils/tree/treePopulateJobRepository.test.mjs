import assert from 'node:assert/strict';
import test from 'node:test';

// Mock setup for this test file
const exportsByModule = {
  sql: ['getRequiredApplicationIdentifier', 'sql', 'withSqlConnection'],
};

let mockTransactions = [];
let mockQueries = [];
let mockResults = { recordsets: [[]], rowsAffected: [0] };

const globalMocks = {
  sql: {
    Transaction: class {
      constructor() { this._aborted = false; }
      async begin() { mockTransactions.push('begin'); }
      async commit() { mockTransactions.push('commit'); }
      async rollback() { mockTransactions.push('rollback'); this._aborted = true; }
    },
    Request: class {
      constructor(transaction) { this.transaction = transaction; }
      input(name, type, value) { return this; }
      async query(sqlQuery) { mockQueries.push(sqlQuery); return mockResults; }
    },
    Int: 'Int',
    NVarChar: () => 'NVarChar',
    MAX: 'MAX',
    UniqueIdentifier: () => 'UniqueIdentifier',
  },
  getRequiredApplicationIdentifier: () => 'test-app',
  withSqlConnection: async (callback) => callback(),
};

globalThis.__treePopulateMocks = globalMocks;

// Module resolution hook for mocking imports
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/server/utils/sql') {
      const code = `
        export const sql = globalThis.__treePopulateMocks.sql;
        export const getRequiredApplicationIdentifier = () => globalThis.__treePopulateMocks.getRequiredApplicationIdentifier();
        export const withSqlConnection = (...args) => globalThis.__treePopulateMocks.withSqlConnection(...args);
      `;
      return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const { createOrGetPopulateJob, getTreeJob } = await import('./treePopulateJobRepository.js');

test.beforeEach(() => {
  mockTransactions = [];
  mockQueries = [];
  mockResults = { recordsets: [[]], rowsAffected: [0] };
});

test('createOrGetPopulateJob reconciles stale queued jobs (older than 2 hours)', async () => {
  mockResults = {
    recordsets: [
      [{ jobId: 'job-1', status: 'queued', isNew: 0 }],
    ],
    rowsAffected: [1, 1, 0],
  };

  const result = await createOrGetPopulateJob({
    tree: { id: 1, name: 'Test Tree', description: 'Test' },
    principal: { objectId: 'user-1' },
  });

  const updateQuery = mockQueries[0];
  assert.match(updateQuery, /UPDATE job SET status = 'failed'/);
  assert.match(updateQuery, /job.status = 'queued' AND job.updated_at < DATEADD\(hour, -2/);
  assert.match(updateQuery, /job.status = 'running' AND job.lease_until < DATEADD\(minute, -15/);
});

test('createOrGetPopulateJob reconciles stale running jobs (lease expired 15+ minutes ago)', async () => {
  mockResults = {
    recordsets: [
      [{ jobId: 'job-1', status: 'running', isNew: 0 }],
    ],
    rowsAffected: [1, 1, 0],
  };

  const result = await createOrGetPopulateJob({
    tree: { id: 1, name: 'Test Tree', description: 'Test' },
    principal: { objectId: 'user-1' },
  });

  const updateQuery = mockQueries[0];
  assert.match(updateQuery, /DATEADD\(minute, -15, SYSUTCDATETIME\(\)\)/);
});

test('createOrGetPopulateJob preserves failure summary and timestamps during reconciliation', async () => {
  mockResults = {
    recordsets: [
      [{ jobId: 'job-1', status: 'failed', isNew: 0 }],
    ],
    rowsAffected: [1, 1, 0],
  };

  const result = await createOrGetPopulateJob({
    tree: { id: 1, name: 'Test Tree', description: 'Test' },
    principal: { objectId: 'user-1' },
  });

  const updateQuery = mockQueries[0];
  assert.match(updateQuery, /failure_summary = 'Tree population stopped before completion.'/);
  assert.match(updateQuery, /finished_at = SYSUTCDATETIME\(\)/);
  assert.match(updateQuery, /updated_at = SYSUTCDATETIME\(\)/);
});

test('createOrGetPopulateJob creates new job when no active job exists', async () => {
  mockResults = {
    recordsets: [
      [], // First SELECT returns no active jobs
      [{ jobId: 'new-job-id', status: 'queued', isNew: 1 }],
    ],
    rowsAffected: [0, 1, 1],
  };

  const result = await createOrGetPopulateJob({
    tree: { id: 1, name: 'Test Tree', description: 'Test' },
    principal: { objectId: 'user-1' },
  });

  assert.equal(result.isNew, 1);
  assert.equal(mockTransactions[0], 'begin');
  assert.equal(mockTransactions[1], 'commit');
});

test('createOrGetPopulateJob returns existing active job without creating new one', async () => {
  mockResults = {
    recordsets: [
      [{ jobId: 'existing-job-id', status: 'queued', isNew: 0 }],
    ],
    rowsAffected: [0, 1, 0],
  };

  const result = await createOrGetPopulateJob({
    tree: { id: 1, name: 'Test Tree', description: 'Test' },
    principal: { objectId: 'user-1' },
  });

  assert.equal(result.isNew, 0);
  assert.equal(mockTransactions[0], 'begin');
  assert.equal(mockTransactions[1], 'commit');
});

test('createOrGetPopulateJob scopes reconciliation to current application and tree', async () => {
  mockResults = {
    recordsets: [
      [{ jobId: 'job-1', status: 'queued', isNew: 0 }],
    ],
    rowsAffected: [1, 1, 0],
  };

  await createOrGetPopulateJob({
    tree: { id: 42, name: 'Test Tree', description: 'Test' },
    principal: { objectId: 'user-1' },
  });

  const updateQuery = mockQueries[0];
  assert.match(updateQuery, /job.tree_instance_id = @tree_id/);
  assert.match(updateQuery, /ai.app_identifier = @application_identifier/);
});

test('getTreeJob reconciles stale jobs before returning status', async () => {
  mockResults = {
    recordset: [{ jobId: 'job-1', status: 'queued' }],
  };

  await getTreeJob({ jobId: 'job-1', treeId: 1 });

  const updateQuery = mockQueries[0];
  assert.match(updateQuery, /UPDATE job SET status = 'failed'/);
  assert.match(updateQuery, /job.job_type = 'populate'/);
});

test('getTreeJob applies reconciliation only to populate jobs', async () => {
  mockResults = {
    recordset: [{ jobId: 'job-1', status: 'queued' }],
  };

  await getTreeJob({ jobId: 'job-1', treeId: 1 });

  const updateQuery = mockQueries[0];
  assert.match(updateQuery, /job.job_type = 'populate'/);
});

test('getTreeJob preserves authorization check scope', async () => {
  mockResults = {
    recordset: [{ jobId: 'job-1', status: 'queued' }],
  };

  await getTreeJob({ jobId: 'job-1', treeId: 1 });

  const selectQuery = mockQueries[0];
  assert.match(selectQuery, /ai.app_identifier = @application_identifier/);
  assert.match(selectQuery, /ti.deleted_at IS NULL/);
});

test('getTreeJob returns job when found', async () => {
  mockResults = {
    recordset: [{ jobId: 'job-1', status: 'queued', rootNodeCount: 5 }],
  };

  const result = await getTreeJob({ jobId: 'job-1', treeId: 1 });

  assert.equal(result.jobId, 'job-1');
  assert.equal(result.status, 'queued');
});

test('getTreeJob returns null when job not found', async () => {
  mockResults = {
    recordset: [],
  };

  const result = await getTreeJob({ jobId: 'nonexistent', treeId: 1 });

  assert.equal(result, null);
});
