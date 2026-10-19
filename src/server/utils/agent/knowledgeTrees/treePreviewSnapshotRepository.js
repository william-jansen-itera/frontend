import {
  deletePersonalCachePath,
  readPersonalCacheTextAttachmentByFileName,
  replacePersonalCacheTextAttachment,
} from '@/server/utils/agent/personalCacheTreeRepository';
import { buildAgentPersonalCacheContext } from '@/server/utils/agent/agentPersonalCache';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';
const PREVIEW_SNAPSHOT_TTL_MS = 30 * 60 * 1000;
const PREVIEW_SNAPSHOT_FILE_NAME = 'preview-snapshots.json';

function buildPreviewSnapshotPath() {
  return ['Knowledge Trees', 'Preview Snapshots', 'By Preview ID', 'Current'];
}

function pruneSnapshots(previews, now = Date.now()) {
  return Object.fromEntries(
    Object.entries(previews || {}).filter(([, snapshot]) => {
      const expiresAtMs = Date.parse(String(snapshot?.expiresAt ?? ''));
      return snapshot?.preview && Number.isFinite(expiresAtMs) && expiresAtMs > now;
    }),
  );
}

async function readSnapshotDocument({ treeId }) {
  const document = await readPersonalCacheTextAttachmentByFileName({
    treeId,
    pathSegments: buildPreviewSnapshotPath(),
    fileName: PREVIEW_SNAPSHOT_FILE_NAME,
  });

  if (!document?.text) {
    return null;
  }

  return JSON.parse(document.text);
}

async function deleteSnapshotDocument({ treeId, updatedBy = null }) {
  await deletePersonalCachePath({
    treeId,
    pathSegments: buildPreviewSnapshotPath(),
    updatedBy,
  });
}

async function writeSnapshotDocument({ treeId, snapshots, updatedBy = null }) {
  const prunedSnapshots = pruneSnapshots(snapshots);

  if (Object.keys(prunedSnapshots).length === 0) {
    await deleteSnapshotDocument({
      treeId,
      updatedBy,
    });
    return;
  }

  await replacePersonalCacheTextAttachment({
    treeId,
    pathSegments: buildPreviewSnapshotPath(),
    fileName: PREVIEW_SNAPSHOT_FILE_NAME,
    contentType: JSON_CONTENT_TYPE,
    content: JSON.stringify({
      previews: prunedSnapshots,
      updatedAt: new Date().toISOString(),
    }, null, 2),
    updatedBy,
  });
}

export async function storeTreePreviewSnapshot({ previewId, preview, principal }) {
  const cacheContext = await buildAgentPersonalCacheContext(principal);
  const snapshotDocument = await readSnapshotDocument({
    treeId: cacheContext.personalCacheTreeId,
  });
  const snapshots = pruneSnapshots(snapshotDocument?.previews);

  snapshots[String(previewId ?? '').trim()] = {
    preview,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PREVIEW_SNAPSHOT_TTL_MS).toISOString(),
  };

  await writeSnapshotDocument({
    treeId: cacheContext.personalCacheTreeId,
    snapshots,
    updatedBy: cacheContext.updatedBy,
  });
}

export async function consumeTreePreviewSnapshot({ previewId, principal }) {
  const cacheContext = await buildAgentPersonalCacheContext(principal);
  const snapshotDocument = await readSnapshotDocument({
    treeId: cacheContext.personalCacheTreeId,
  });
  const snapshots = pruneSnapshots(snapshotDocument?.previews);
  const normalizedPreviewId = String(previewId ?? '').trim();
  const snapshot = snapshots[normalizedPreviewId] ?? null;

  if (!snapshot?.preview) {
    await writeSnapshotDocument({
      treeId: cacheContext.personalCacheTreeId,
      snapshots,
      updatedBy: cacheContext.updatedBy,
    });
    throw new Error('The previewId was not found or has expired. Ask the user to preview the save again before confirming.');
  }

  delete snapshots[normalizedPreviewId];

  await writeSnapshotDocument({
    treeId: cacheContext.personalCacheTreeId,
    snapshots,
    updatedBy: cacheContext.updatedBy,
  });

  return snapshot.preview;
}