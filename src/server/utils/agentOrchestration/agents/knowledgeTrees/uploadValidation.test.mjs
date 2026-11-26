import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractUploadFilenameWords, MAX_UPLOAD_BYTES, validateChatUpload } from './uploadValidation.mjs';

function file(name, size) {
  return { name, size, arrayBuffer: async () => new ArrayBuffer(size) };
}

test('accepts supported document and OCR formats, without trusting a client path', () => {
  assert.deepEqual(validateChatUpload(file('folder\\document.PDF', 100)), {
    fileName: 'document.PDF', extension: '.pdf',
  });
  assert.equal(validateChatUpload(file('image.png', 1)).extension, '.png');
  assert.equal(validateChatUpload(file('spreadsheet.xlsx', MAX_UPLOAD_BYTES)).extension, '.xlsx');
});

test('rejects invalid files, unsupported formats, and out-of-bounds sizes', () => {
  assert.throws(() => validateChatUpload(null), /Exactly one/);
  assert.throws(() => validateChatUpload(file('empty.pdf', 0)), /non-empty/);
  assert.throws(() => validateChatUpload(file('big.pdf', MAX_UPLOAD_BYTES + 1)), /10 MB/);
  assert.throws(() => validateChatUpload(file('script.js', 1)), /not supported/);
  assert.throws(() => validateChatUpload(file('folder\\no-extension', 1)), /not supported/);
});

test('filename words exclude extension and single-letter segments while keeping word order', () => {
  assert.deepEqual(extractUploadFilenameWords('perch_w.Jpg'), ['perch']);
  assert.deepEqual(extractUploadFilenameWords('folder\\sea_bass_w.JPG'), ['sea', 'bass']);
  assert.deepEqual(extractUploadFilenameWords('fisk-med_lang.hale.jpeg'), ['fisk', 'med', 'lang', 'hale']);
  assert.deepEqual(extractUploadFilenameWords('a_b.JPG'), []);
});