import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

const modules = new Map([
  ['next/server', 'export const NextResponse = { json: (body, { status = 200 } = {}) => ({ body, status }) };'],
  ['auth', 'export const requireAuthenticatedPrincipal = () => ({ userId: "owner" });'],
  ['treeCatalog', 'export const getAuditMetadata = () => ({ updatedByObjectId: "owner" });'],
  ['chatUploadRepository', `
    export const getOwnedChatUpload = async (options) => {
      globalThis.__uploadStatusLookup = options;
      return globalThis.__uploadStatusRecord;
    };
  `],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = modules.get(specifier === 'next/server' ? specifier : specifier.split('/').at(-1));
    if (stub) {
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    }
    if (specifier === '@/server/utils/agent/knowledgeTrees/uploadValidation.mjs') {
      return nextResolve(new URL('../../../../../server/utils/agent/knowledgeTrees/uploadValidation.mjs', import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { GET } = await import('./route.js');
const uploadId = '00000000-0000-0000-0000-000000000001';
const requestStatus = () => GET(new Request(`http://localhost/api/chat/upload-processing/${uploadId}`), {
  params: Promise.resolve({ uploadId }),
});

test('completion evidence includes normalized filename with unchanged note and caption', async () => {
  for (const [fileName, normalized] of [
    ['perch_w.Jpg', 'perch'],
    ['folder\\sea_bass_w.JPG', 'sea bass'],
    ['fisk-med_lang.hale.jpeg', 'fisk med lang hale'],
    ['a_b.JPG', ''],
  ]) {
    const upload = { id: uploadId, fileName, status: 'succeeded', note: 'A fish in the water.', caption: 'Fish beside a boat.' };
    globalThis.__uploadStatusRecord = upload;
    const response = await requestStatus();
    assert.equal(response.status, 200);
    assert.deepEqual({
      note: response.body.note, caption: response.body.caption, fileName: response.body.fileName,
    }, { note: upload.note, caption: upload.caption, fileName: normalized });
    assert.equal(upload.fileName, fileName);
    assert.deepEqual(globalThis.__uploadStatusLookup, { uploadId, ownerObjectId: 'owner' });
  }
});

test('unowned uploads still return not found without filename evidence', async () => {
  globalThis.__uploadStatusRecord = null;
  const response = await requestStatus();
  assert.equal(response.status, 404);
  assert.equal(response.body.fileName, undefined);
});
