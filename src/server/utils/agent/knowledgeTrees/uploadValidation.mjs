import path from 'node:path';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set([
  '.docx', '.html', '.jpeg', '.jpg', '.pdf', '.png', '.pptx', '.txt', '.xlsx',
]);

export function extractUploadFilenameWords(fileName) {
  const basename = path.basename(String(fileName ?? '').replaceAll('\\', '/'));
  const stem = basename.slice(0, basename.length - path.extname(basename).length);
  return stem.split(/[_\s.-]+/u).filter((word) => [...word].length > 1);
}

export function validateChatUpload(file) {
  if (!file || typeof file.name !== 'string' || typeof file.arrayBuffer !== 'function') {
    throw new Error('Exactly one file is required.');
  }

  const fileName = path.basename(file.name.replaceAll('\\', '/')).trim();
  const extension = path.extname(fileName).toLowerCase();

  if (!fileName || fileName.length > 255 || !SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('This file format is not supported for chat uploads.');
  }

  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES) {
    throw new Error('Chat uploads must be non-empty files of 10 MB or less.');
  }

  return { fileName, extension };
}