import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const exports = {
      '@azure/storage-queue': 'export class QueueClient { constructor(connection, queueName) { globalThis.uploadMocks.connection = connection; globalThis.uploadMocks.queueName = queueName; } async createIfNotExists() { if (globalThis.uploadMocks.createError) throw globalThis.uploadMocks.createError; } async sendMessage(message) { if (globalThis.uploadMocks.sendError) throw globalThis.uploadMocks.sendError; globalThis.uploadMocks.sent.push(message); } }',
      '@/server/utils/agent/agentToolResult': 'export const buildAgentToolResult = (result) => result; export const buildUntrustedContentMeta = () => ({});',
      '@/server/utils/tree/treeCatalog': 'export const getAuditMetadata = (principal) => ({ updatedByObjectId: principal.objectId });',
      '@/server/utils/agent/knowledgeTrees/chatUploadRepository': 'export const getOwnedChatUpload = (...args) => globalThis.uploadMocks.get(...args); export const queueOwnedChatUpload = (...args) => globalThis.uploadMocks.queue(...args); export const failQueuedChatUpload = (...args) => globalThis.uploadMocks.fail(...args);',
      '@/server/utils/agent/knowledgeTrees/tools/persistenceToolShared': 'export const KNOWLEDGE_TREES_FAMILY = "knowledgeTrees";',
    }[specifier];
    if (exports) return { url: `data:text/javascript,${encodeURIComponent(exports)}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

const { createProcessUploadHandler } = await import('./index.js');
const uploadId = 'c125d350-4cae-4ad4-a69c-419324125e00';
const principal = { objectId: 'owner' };

test.beforeEach(() => {
  process.env.AZURE_STORAGE_CONNECTION_STRING = 'tree-queue-connection';
  process.env.CHAT_UPLOAD_STORAGE_CONNECTION_STRING = 'upload-queue-connection';
  globalThis.uploadMocks = {
    sent: [], failed: [],
    get: async () => ({ status: 'staged', fileName: 'file.txt' }),
    queue: async () => true,
    fail: async (id) => globalThis.uploadMocks.failed.push(id),
  };
});

test('rejects IDs not attached to this turn before looking up an owner', async () => {
  let lookedUp = false;
  globalThis.uploadMocks.get = async () => { lookedUp = true; return null; };
  await assert.rejects(createProcessUploadHandler({ principal, currentUploadId: uploadId })({ uploadId: '00000000-0000-0000-0000-000000000000' }), /not attached/);
  assert.equal(lookedUp, false);
});

test('rejects uploads not owned by the principal', async () => {
  globalThis.uploadMocks.get = async ({ ownerObjectId }) => {
    assert.equal(ownerObjectId, 'owner');
    return null;
  };
  await assert.rejects(createProcessUploadHandler({ principal, currentUploadId: uploadId })({ uploadId }), /not found/);
  assert.equal(globalThis.uploadMocks.sent.length, 0);
});

test('queues once, and returns existing status on a repeat call', async () => {
  const handler = createProcessUploadHandler({ principal, currentUploadId: uploadId });
  const result = await handler({ uploadId });
  assert.equal(result.data.status, 'queued');
  assert.equal(globalThis.uploadMocks.connection, 'upload-queue-connection');
  assert.equal(globalThis.uploadMocks.queueName, 'chat-upload-jobs');
  assert.equal(globalThis.uploadMocks.sent.length, 1);
  assert.deepEqual(JSON.parse(Buffer.from(globalThis.uploadMocks.sent[0], 'base64').toString()), { uploadId });
  globalThis.uploadMocks.queue = async () => false;
  globalThis.uploadMocks.get = async () => ({ status: 'queued', fileName: 'file.txt' });
  assert.equal((await handler({ uploadId })).data.status, 'queued');
  assert.equal(globalThis.uploadMocks.sent.length, 1);
});

test('marks a failed enqueue and logs only safe queue diagnostics', async () => {
  const queueError = Object.assign(new Error('secret connection detail'), { code: 'AuthorizationFailure', statusCode: 403 });
  globalThis.uploadMocks.sendError = queueError;
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    await assert.rejects(createProcessUploadHandler({ principal, currentUploadId: uploadId })({ uploadId }), (error) => {
      assert.equal(error.message, 'Could not queue chat upload processing.');
      assert.equal(error.cause, queueError);
      return true;
    });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(globalThis.uploadMocks.failed, [uploadId]);
  assert.deepEqual(logged, [['Chat upload queue failed', { uploadId, step: 'send', code: 'AuthorizationFailure', statusCode: 403 }]]);
});