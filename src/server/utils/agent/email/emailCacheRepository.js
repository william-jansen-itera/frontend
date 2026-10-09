import { randomUUID } from 'node:crypto';
import {
  deletePersonalCachePath,
  findPersonalCacheLeafPathNode,
  readPersonalCacheTextAttachmentByFileName,
  replacePersonalCacheTextAttachment,
} from '@/server/utils/agent/personalCacheTreeRepository';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const RETRIEVAL_CACHE_TTL_MS = 30 * 60 * 1000;
const CACHED_EMAIL_DOCUMENT_FILE_NAME = 'cached.json';
const UID_MOVE_ALIAS_FILE_NAME = 'uid-move-aliases.json';

function normalizeProviderLabel(provider) {
  const normalizedProvider = String(provider ?? '').trim();

  if (!normalizedProvider) {
    return 'Hover';
  }

  return normalizedProvider.charAt(0).toUpperCase() + normalizedProvider.slice(1);
}

function buildEmailAccountPath(provider) {
  return ['Email', normalizeProviderLabel(provider)];
}

function buildRetrievalSnapshotPath(provider) {
  return [...buildEmailAccountPath(provider), 'Retrievals', 'Cached'];
}

function buildMoveAliasPath(provider) {
  return [...buildEmailAccountPath(provider), 'Retrievals', 'Aliases'];
}

function normalizeFolderValue(folder) {
  const normalizedFolder = String(folder ?? 'INBOX').trim() || 'INBOX';

  if (normalizedFolder.toUpperCase() === 'INBOX') {
    return 'INBOX';
  }

  return normalizedFolder;
}

function normalizeFolderLabel(folder) {
  const normalizedFolder = normalizeFolderValue(folder);

  if (normalizedFolder.toUpperCase() === 'INBOX') {
    return 'Inbox';
  }

  return normalizedFolder;
}

function buildCachedMessagePath(provider, folder, uid) {
  const normalizedUid = String(uid ?? '').trim() || 'unknown';
  return [...buildEmailAccountPath(provider), normalizeFolderLabel(folder), normalizedUid];
}

function buildRetrievalSnapshotFileName(folder) {
  const normalizedFolder = String(folder ?? 'INBOX').trim() || 'INBOX';
  const fileSafeFolder = normalizedFolder.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'INBOX';

  return `${fileSafeFolder.toLowerCase()}-latest.json`;
}

function buildCachedMessageFileName(uid) {
  return CACHED_EMAIL_DOCUMENT_FILE_NAME;
}

function buildMoveAliasKey(folder, uid) {
  return `${normalizeFolderValue(folder)}::${String(uid ?? '').trim()}`;
}

async function loadUidMoveAliases({ treeId, provider }) {
  const aliasDocument = await readJsonAttachment({
    treeId,
    pathSegments: buildMoveAliasPath(provider),
    fileName: UID_MOVE_ALIAS_FILE_NAME,
  });

  if (!aliasDocument || typeof aliasDocument !== 'object' || Array.isArray(aliasDocument)) {
    return {
      aliases: {},
      updatedAt: null,
    };
  }

  return {
    aliases: aliasDocument.aliases && typeof aliasDocument.aliases === 'object' && !Array.isArray(aliasDocument.aliases)
      ? aliasDocument.aliases
      : {},
    updatedAt: aliasDocument.updatedAt ?? null,
  };
}

async function writeUidMoveAliases({ treeId, provider, aliases, updatedBy = null }) {
  await writeJsonAttachment({
    treeId,
    pathSegments: buildMoveAliasPath(provider),
    fileName: UID_MOVE_ALIAS_FILE_NAME,
    value: {
      aliases,
      updatedAt: new Date().toISOString(),
    },
    updatedBy,
  });
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

function buildStoredCachedMessage(message) {
  if (!message || typeof message !== 'object') {
    return message;
  }

  if (message.analysisCache) {
    const { heuristicCache, ...messageWithoutHeuristics } = message;
    return messageWithoutHeuristics;
  }

  return message;
}

export async function storeLatestEmailRetrievalSnapshot({ treeId, provider, folder = 'INBOX', messages, updatedBy = null, sourceWindowSize = null }) {
  const snapshot = {
    datasetKey: randomUUID(),
    provider: normalizeProviderLabel(provider),
    folder: String(folder ?? 'INBOX').trim() || 'INBOX',
    messages: Array.isArray(messages) ? messages : [],
    createdAt: new Date().toISOString(),
    sourceWindowSize: Number.isInteger(sourceWindowSize) && sourceWindowSize > 0 ? sourceWindowSize : null,
  };

  await writeJsonAttachment({
    treeId,
    pathSegments: buildRetrievalSnapshotPath(provider),
    fileName: buildRetrievalSnapshotFileName(folder),
    value: snapshot,
    updatedBy,
  });

  return snapshot;
}

export async function loadLatestEmailRetrievalSnapshot({ treeId, provider, folder = 'INBOX' }) {
  return readJsonAttachment({
    treeId,
    pathSegments: buildRetrievalSnapshotPath(provider),
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
    pathSegments: buildRetrievalSnapshotPath(provider),
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

export async function updateLatestEmailRetrievalSnapshotFlags({ treeId, provider, folder = 'INBOX', uids, flags, updatedBy = null }) {
  const snapshot = await loadLatestEmailRetrievalSnapshot({
    treeId,
    provider,
    folder,
  });

  if (!snapshot || !Array.isArray(snapshot.messages)) {
    return false;
  }

  const normalizedUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => String(uid ?? '').trim()).filter(Boolean)));

  if (normalizedUids.length === 0) {
    return false;
  }

  const nextFlags = Array.isArray(flags) ? flags : [];
  let updated = false;
  const messages = snapshot.messages.map((message) => {
    const messageUid = String(message?.uid ?? '').trim();

    if (!normalizedUids.includes(messageUid)) {
      return message;
    }

    updated = true;

    return {
      ...message,
      flags: nextFlags,
    };
  });

  if (!updated) {
    return false;
  }

  await writeJsonAttachment({
    treeId,
    pathSegments: buildRetrievalSnapshotPath(provider),
    fileName: buildRetrievalSnapshotFileName(folder),
    value: {
      ...snapshot,
      messages,
      cachedAt: new Date().toISOString(),
    },
    updatedBy,
  });

  return true;
}

export async function removeLatestEmailRetrievalSnapshotMessages({ treeId, provider, folder = 'INBOX', uids, updatedBy = null }) {
  const snapshot = await loadLatestEmailRetrievalSnapshot({
    treeId,
    provider,
    folder,
  });

  if (!snapshot || !Array.isArray(snapshot.messages)) {
    return false;
  }

  const normalizedUids = Array.from(new Set((Array.isArray(uids) ? uids : []).map((uid) => String(uid ?? '').trim()).filter(Boolean)));

  if (normalizedUids.length === 0) {
    return false;
  }

  const nextMessages = snapshot.messages.filter((message) => !normalizedUids.includes(String(message?.uid ?? '').trim()));

  if (nextMessages.length === snapshot.messages.length) {
    return false;
  }

  await writeJsonAttachment({
    treeId,
    pathSegments: buildRetrievalSnapshotPath(provider),
    fileName: buildRetrievalSnapshotFileName(folder),
    value: {
      ...snapshot,
      messages: nextMessages,
      cachedAt: new Date().toISOString(),
    },
    updatedBy,
  });

  return true;
}

export async function upsertLatestEmailRetrievalSnapshotMessages({ treeId, provider, folder = 'INBOX', messages, updatedBy = null }) {
  const normalizedMessages = Array.isArray(messages)
    ? messages.filter((message) => String(message?.uid ?? '').trim())
    : [];

  if (normalizedMessages.length === 0) {
    return false;
  }

  const snapshot = await loadLatestEmailRetrievalSnapshot({
    treeId,
    provider,
    folder,
  });

  if (!snapshot) {
    return false;
  }

  const messageMap = new Map(
    (Array.isArray(snapshot.messages) ? snapshot.messages : []).map((message) => [String(message?.uid ?? '').trim(), message]),
  );

  for (const message of normalizedMessages) {
    messageMap.set(String(message.uid).trim(), message);
  }

  await writeJsonAttachment({
    treeId,
    pathSegments: buildRetrievalSnapshotPath(provider),
    fileName: buildRetrievalSnapshotFileName(folder),
    value: {
      ...snapshot,
      messages: Array.from(messageMap.values()),
      cachedAt: new Date().toISOString(),
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

export async function storeCachedEmailMessage({ treeId, provider, folder = null, uid, message, updatedBy = null }) {
  const resolvedFolder = folder ?? message?.folder ?? 'INBOX';

  await writeJsonAttachment({
    treeId,
    pathSegments: buildCachedMessagePath(provider, resolvedFolder, uid),
    fileName: buildCachedMessageFileName(uid),
    value: {
      cachedAt: new Date().toISOString(),
      message: buildStoredCachedMessage(message),
    },
    updatedBy,
  });
}

export async function loadCachedEmailMessage({ treeId, provider, folder = 'INBOX', uid }) {
  const cachedDocument = await readJsonAttachment({
    treeId,
    pathSegments: buildCachedMessagePath(provider, folder, uid),
    fileName: buildCachedMessageFileName(uid),
  });

  if (!cachedDocument?.message) {
    return null;
  }

  return cachedDocument.message;
}

export async function resolveCachedEmailMovedMessageAlias({ treeId, provider, sourceFolder = 'INBOX', sourceUid }) {
  const normalizedSourceUid = String(sourceUid ?? '').trim();

  if (!normalizedSourceUid) {
    return null;
  }

  const aliasDocument = await loadUidMoveAliases({ treeId, provider });
  const aliasRecord = aliasDocument.aliases[buildMoveAliasKey(sourceFolder, normalizedSourceUid)] ?? null;

  if (!aliasRecord || typeof aliasRecord !== 'object') {
    return null;
  }

  const destinationUid = String(aliasRecord.destinationUid ?? '').trim();
  const destinationFolder = String(aliasRecord.destinationFolder ?? '').trim();

  if (!destinationUid || !destinationFolder) {
    return null;
  }

  return {
    sourceFolder: normalizeFolderValue(aliasRecord.sourceFolder ?? sourceFolder),
    sourceUid: normalizedSourceUid,
    destinationFolder,
    destinationUid,
    movedAt: aliasRecord.movedAt ?? null,
    messageId: String(aliasRecord.messageId ?? '').trim() || null,
    subject: String(aliasRecord.subject ?? '').trim() || null,
    receivedAt: aliasRecord.receivedAt ?? null,
  };
}

export async function upsertCachedEmailMovedMessageAlias({
  treeId,
  provider,
  sourceFolder = 'INBOX',
  sourceUid,
  destinationFolder,
  destinationUid,
  message = null,
  updatedBy = null,
}) {
  const normalizedSourceUid = String(sourceUid ?? '').trim();
  const normalizedDestinationUid = String(destinationUid ?? '').trim();
  const normalizedDestinationFolder = String(destinationFolder ?? '').trim();

  if (!normalizedSourceUid || !normalizedDestinationUid || !normalizedDestinationFolder) {
    return false;
  }

  const aliasDocument = await loadUidMoveAliases({ treeId, provider });
  const nextAliases = {
    ...aliasDocument.aliases,
    [buildMoveAliasKey(sourceFolder, normalizedSourceUid)]: {
      sourceFolder: normalizeFolderValue(sourceFolder),
      sourceUid: normalizedSourceUid,
      destinationFolder: normalizedDestinationFolder,
      destinationUid: normalizedDestinationUid,
      movedAt: new Date().toISOString(),
      messageId: String(message?.messageId ?? '').trim() || null,
      subject: String(message?.subject ?? '').trim() || null,
      receivedAt: message?.receivedAt ?? null,
    },
  };

  await writeUidMoveAliases({
    treeId,
    provider,
    aliases: nextAliases,
    updatedBy,
  });

  return true;
}

export async function deleteCachedEmailMovedMessageAlias({ treeId, provider, sourceFolder = 'INBOX', sourceUid, updatedBy = null }) {
  const normalizedSourceUid = String(sourceUid ?? '').trim();

  if (!normalizedSourceUid) {
    return false;
  }

  const aliasDocument = await loadUidMoveAliases({ treeId, provider });
  const aliasKey = buildMoveAliasKey(sourceFolder, normalizedSourceUid);

  if (!Object.prototype.hasOwnProperty.call(aliasDocument.aliases, aliasKey)) {
    return false;
  }

  const nextAliases = { ...aliasDocument.aliases };
  delete nextAliases[aliasKey];

  await writeUidMoveAliases({
    treeId,
    provider,
    aliases: nextAliases,
    updatedBy,
  });

  return true;
}

export async function invalidateCachedEmailMessage({ treeId, provider, uid, updatedBy = null }) {
  await writeJsonAttachment({
    treeId,
    pathSegments: buildCachedMessagePath(provider, 'INBOX', uid),
    fileName: buildCachedMessageFileName(uid),
    value: {
      cachedAt: new Date().toISOString(),
      invalidatedAt: new Date().toISOString(),
      message: null,
    },
    updatedBy,
  });
}

export async function deleteCachedEmailMessageNode({ treeId, provider, folder = 'INBOX', uid, updatedBy = null }) {
  return deletePersonalCachePath({
    treeId,
    pathSegments: buildCachedMessagePath(provider, folder, uid),
    updatedBy,
  });
}

export async function updateCachedEmailMessageFlags({ treeId, provider, folder = 'INBOX', uid, flags, updatedBy = null }) {
  const cachedDocument = await readJsonAttachment({
    treeId,
    pathSegments: buildCachedMessagePath(provider, folder, uid),
    fileName: buildCachedMessageFileName(uid),
  });

  if (!cachedDocument?.message) {
    return false;
  }

  await writeJsonAttachment({
    treeId,
    pathSegments: buildCachedMessagePath(provider, folder, uid),
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

export async function moveCachedEmailMessage({
  treeId,
  provider,
  sourceFolder,
  sourceUid,
  destinationUid,
  destinationFolder,
  fallbackMessage = null,
  updatedBy = null,
}) {
  const cachedMessage = await loadCachedEmailMessage({
    treeId,
    provider,
    folder: sourceFolder,
    uid: sourceUid,
  });
  const sourceMessage = cachedMessage ?? (fallbackMessage && typeof fallbackMessage === 'object' ? fallbackMessage : null);

  if (!sourceMessage || !destinationUid) {
    return false;
  }

  const nextMessage = {
    ...sourceMessage,
    uid: String(destinationUid).trim(),
    folder: String(destinationFolder ?? sourceMessage.folder ?? 'INBOX').trim() || 'INBOX',
    movedFrom: {
      folder: normalizeFolderValue(sourceFolder ?? sourceMessage.folder ?? 'INBOX'),
      uid: String(sourceUid ?? '').trim(),
    },
  };
  const normalizedSourceUid = String(sourceUid ?? '').trim();
  const normalizedSourceFolder = String(sourceFolder ?? sourceMessage.folder ?? 'INBOX').trim() || 'INBOX';

  await storeCachedEmailMessage({
    treeId,
    provider,
    folder: destinationFolder,
    uid: nextMessage.uid,
    message: nextMessage,
    updatedBy,
  });

  await upsertCachedEmailMovedMessageAlias({
    treeId,
    provider,
    sourceFolder: normalizedSourceFolder,
    sourceUid: normalizedSourceUid,
    destinationFolder: nextMessage.folder,
    destinationUid: nextMessage.uid,
    message: nextMessage,
    updatedBy,
  });

  if (normalizedSourceUid !== nextMessage.uid || normalizedSourceFolder !== nextMessage.folder) {
    await deleteCachedEmailMessageNode({
      treeId,
      provider,
      folder: normalizedSourceFolder,
      uid: normalizedSourceUid,
      updatedBy,
    });

    const remainingSourceNode = await findPersonalCacheLeafPathNode({
      treeId,
      pathSegments: buildCachedMessagePath(provider, normalizedSourceFolder, normalizedSourceUid),
    });

    if (remainingSourceNode) {
      throw new Error(
        `Cached email source node ${normalizedSourceFolder}/${normalizedSourceUid} still exists after move.`,
      );
    }
  }

  return true;
}