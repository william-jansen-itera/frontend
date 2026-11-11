import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const code = {
      '@/server/utils/applicationIdentifier': 'export const getRequiredApplicationIdentifier = () => "app";',
      '@azure/identity': 'export class DefaultAzureCredential {}',
      '@azure/storage-blob': 'export const BlobServiceClient = { fromConnectionString: () => ({ getContainerClient: () => ({ getBlobClient: () => globalThis.__stagingBlob }) }) };',
    }[specifier];
    return code ? { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const { readVerifiedStagingFile } = await import('./stagingBlob.js');

test('only returns the original staged bytes when owner, application, size and digest match', async () => {
  process.env.CHAT_UPLOAD_STORAGE_CONNECTION_STRING = 'staging';
  process.env.CHAT_UPLOAD_CONTAINER_NAME = 'uploads';
  const bytes = Buffer.from('original file');
  const uploadId = 'c125d350-4cae-4ad4-a69c-419324125e00';
  const upload = {
    id: uploadId.toUpperCase(), blobName: `uploads/${uploadId}/file.pdf`, fileName: 'file.pdf', contentType: 'application/pdf',
    byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'succeeded',
  };
  const properties = { contentLength: bytes.length, metadata: {
    uploadid: uploadId, ownerobjectid: 'owner', applicationidentifier: 'app',
  } };
  globalThis.__stagingBlob = { getProperties: async () => properties, downloadToBuffer: async () => bytes };
  const file = await readVerifiedStagingFile({ upload, ownerObjectId: 'owner' });
  assert.equal(file.name, 'file.pdf');
  assert.deepEqual(await file.arrayBuffer(), bytes);
  properties.metadata.uploadid = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(readVerifiedStagingFile({ upload, ownerObjectId: 'owner' }), /no longer matches/);
  properties.metadata.uploadid = uploadId;
  await assert.rejects(readVerifiedStagingFile({ upload, ownerObjectId: 'someone-else' }), /no longer matches/);
  globalThis.__stagingBlob.downloadToBuffer = async () => Buffer.from('modified file');
  await assert.rejects(readVerifiedStagingFile({ upload, ownerObjectId: 'owner' }), /changed/);
});