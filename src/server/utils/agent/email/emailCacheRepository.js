import { randomUUID } from 'node:crypto';
import {
  readPersonalCacheTextAttachmentByFileName,
  replacePersonalCacheTextAttachment,
} from '@/server/utils/agent/personalCacheTreeRepository';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const RETRIEVAL_CACHE_TTL_MS = 20 * 60 * 1000;

function normalizeProviderLabel(provider) {
  const normalizedProvider = String(provider ?? '').trim();

  if (!normalizedProvider) {
    return 'Hover';
  }

  return normalizedProvider.charAt(0).toUpperCase() + normalizedProvider.slice(1);
}

function buildEmailCachePath(provider, cacheSegment) {
  return ['Email', normalizeProviderLabel(provider), 'Cache', cacheSegment];
}

function buildRetrievalSnapshotFileName(folder) {
  const normalizedFolder = String(folder ?? 'INBOX').trim() || 'INBOX';
  const fileSafeFolder = normalizedFolder.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'INBOX';

  return `${fileSafeFolder.toLowerCase()}-latest.json`;
}

function buildCachedMessageFileName(uid) {
  return `message-${String(uid ?? '').trim() || 'unknown'}.json`;
}

async function readJsonAttachment({ treeId, pathSegments, fileName }) {
  const document = await readPersonalCacheTextAttachmentByFileName({
    treeId,
    pathSegments,
    fileName,
  });

  if (!document?.text) {
    return null;
  }

  return JSON.parse(document.text);
}

async function writeJsonAttachment({ treeId, pathSegments, fileName, value, updatedBy = null }) {
  const content = JSON.stringify(value, null, 2);

  await replacePersonalCacheTextAttachment({
    treeId,
    pathSegments,
    fileName,
    contentType: JSON_CONTENT_TYPE,
    content,
    updatedBy,
  });
}

export async function storeLatestEmailRetrievalSnapshot({ treeId, provider, folder = 'INBOX', messages, updatedBy = null, sourceWindowSize = null }) {
  const snapshot = {
    datasetKey: randomUUID(),
    provider: normalizeProviderLabel(provider),
    folder: String(folder ?? 'INBOX').trim() || 'INBOX',
    messages,
    createdAt: new Date().toISOString(),
    sourceWindowSize: Number.isInteger(sourceWindowSize) && sourceWindowSize > 0 ? sourceWindowSize : null,
  };

  await writeJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Retrievals'),
    fileName: buildRetrievalSnapshotFileName(folder),
    value: snapshot,
    updatedBy,
  });

  return snapshot;
}

export async function loadLatestEmailRetrievalSnapshot({ treeId, provider, folder = 'INBOX' }) {
  return readJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Retrievals'),
    fileName: buildRetrievalSnapshotFileName(folder),
  });
}

export async function invalidateLatestEmailRetrievalSnapshot({ treeId, provider, folder = 'INBOX', updatedBy = null }) {
  const snapshot = await loadLatestEmailRetrievalSnapshot({
    treeId,
    provider,
    folder,
  });

  if (!snapshot) {
    return false;
  }

  await writeJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Retrievals'),
    fileName: buildRetrievalSnapshotFileName(folder),
    value: {
      ...snapshot,
      createdAt: new Date(0).toISOString(),
      invalidatedAt: new Date().toISOString(),
    },
    updatedBy,
  });

  return true;
}

export function isEmailRetrievalSnapshotFresh(snapshot, now = Date.now()) {
  const createdAtMs = new Date(snapshot?.createdAt ?? '').getTime();

  if (!Number.isFinite(createdAtMs)) {
    return false;
  }

  return now - createdAtMs <= RETRIEVAL_CACHE_TTL_MS;
}

export async function storeCachedEmailMessage({ treeId, provider, uid, message, updatedBy = null }) {
  await writeJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Messages'),
    fileName: buildCachedMessageFileName(uid),
    value: {
      cachedAt: new Date().toISOString(),
      message,
    },
    updatedBy,
  });
}

export async function loadCachedEmailMessage({ treeId, provider, uid }) {
  const cachedDocument = await readJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Messages'),
    fileName: buildCachedMessageFileName(uid),
  });

  return cachedDocument?.message ?? null;
}

export async function invalidateCachedEmailMessage({ treeId, provider, uid, updatedBy = null }) {
  await writeJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Messages'),
    fileName: buildCachedMessageFileName(uid),
    value: {
      cachedAt: new Date().toISOString(),
      invalidatedAt: new Date().toISOString(),
      message: null,
    },
    updatedBy,
  });
}

export async function updateCachedEmailMessageFlags({ treeId, provider, uid, flags, updatedBy = null }) {
  const cachedDocument = await readJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Messages'),
    fileName: buildCachedMessageFileName(uid),
  });

  if (!cachedDocument?.message) {
    return false;
  }

  await writeJsonAttachment({
    treeId,
    pathSegments: buildEmailCachePath(provider, 'Messages'),
    fileName: buildCachedMessageFileName(uid),
    value: {
      ...cachedDocument,
      cachedAt: new Date().toISOString(),
      message: {
        ...cachedDocument.message,
        flags: Array.isArray(flags) ? flags : [],
      },
    },
    updatedBy,
  });

  return true;
}