import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import {
  deleteCachedEmailMovedMessageAlias,
  deleteCachedEmailMessageNode,
  loadCachedEmailMessage,
  loadLatestEmailRetrievalSnapshot,
  moveCachedEmailMessage,
  removeLatestEmailRetrievalSnapshotMessages,
  resolveCachedEmailMovedMessageAlias,
  upsertLatestEmailRetrievalSnapshotMessages,
} from '@/server/utils/agent/email/emailCacheRepository';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { deleteImapMessage } from '@/server/utils/agent/email/emailTransport';

export const DELETE_EMAIL_TOOL = 'delete_email';

export const deleteEmailToolDefinition = {
  type: 'function',
  name: DELETE_EMAIL_TOOL,
  description: 'Move one or more emails to the trash folder. When expunge is true, permanently delete them instead.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: { type: 'string' },
      uids: {
        description: 'Strings copied unchanged from data.emails[].uid in the latest retrieve_emails result. Do not use the array index, data.resultCount, meta.resultCount, or any value not present in data.emails[].uid.',
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      },
      expunge: { type: 'boolean', description: 'When true, permanently delete the messages instead of moving them to Trash.' },
    },
    required: ['provider', 'folder', 'uids', 'expunge'],
    additionalProperties: false,
  },
};

function normalizeDeleteTargetUids(args) {
  const uidValues = [];

  for (const uid of Array.isArray(args?.uids) ? args.uids : []) {
    const normalizedUid = String(uid ?? '').trim();

    if (normalizedUid) {
      uidValues.push(normalizedUid);
    }
  }

  return Array.from(new Set(uidValues));
}

function buildDeleteEmailMissingUidError(uid, folder, { expunge = false } = {}) {
  if (expunge) {
    return new Error(
      `Email uid ${uid} is not available in folder ${folder}, and no cached Trash uid mapping was found for permanent delete. Run retrieve_emails for the Trash folder, locate the matching email, and retry. Do not invent, transform, or guess the uid.`,
    );
  }

  return new Error(
    `Email uid ${uid} is not available in the current cache for folder ${folder}. Run retrieve_emails for that folder, then look up data.emails[].uid in the latest retrieve_emails result in this conversation and retry with one of those exact uid strings. Do not invent or transform the uid.`,
  );
}

export function buildDeleteEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function deleteEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to delete email.');
      }

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });
      const targetUids = normalizeDeleteTargetUids(args);
      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';

      if (targetUids.length === 0) {
        throw new Error('At least one email uid is required to delete email.');
      }

      const sourceSnapshot = await loadLatestEmailRetrievalSnapshot({
        treeId: resolvedTreeId,
        provider: args.provider,
        folder: normalizedFolder,
      });
      const sourceSnapshotMessages = Array.isArray(sourceSnapshot?.messages) ? sourceSnapshot.messages : [];
      const sourceSnapshotMessagesByUid = new Map(
        sourceSnapshotMessages.map((message) => [String(message?.uid ?? '').trim(), message]),
      );
      const resolvedDeleteTargets = [];

      for (const uid of targetUids) {
        const cachedMessage = await loadCachedEmailMessage({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: normalizedFolder,
          uid,
        });

        if (cachedMessage) {
          resolvedDeleteTargets.push({
            requestedUid: uid,
            requestedFolder: normalizedFolder,
            actualUid: uid,
            actualFolder: normalizedFolder,
            sourceMessage: cachedMessage,
          });
          continue;
        }

        const sourceSnapshotMessage = sourceSnapshotMessagesByUid.get(uid);

        if (sourceSnapshotMessage) {
          resolvedDeleteTargets.push({
            requestedUid: uid,
            requestedFolder: normalizedFolder,
            actualUid: uid,
            actualFolder: normalizedFolder,
            sourceMessage: sourceSnapshotMessage,
          });
          continue;
        }

        if (args.expunge) {
          const movedMessageAlias = await resolveCachedEmailMovedMessageAlias({
            treeId: resolvedTreeId,
            provider: args.provider,
            sourceFolder: normalizedFolder,
            sourceUid: uid,
          });

          if (movedMessageAlias?.destinationUid && movedMessageAlias?.destinationFolder) {
            const aliasedCachedMessage = await loadCachedEmailMessage({
              treeId: resolvedTreeId,
              provider: args.provider,
              folder: movedMessageAlias.destinationFolder,
              uid: movedMessageAlias.destinationUid,
            });

            resolvedDeleteTargets.push({
              requestedUid: uid,
              requestedFolder: normalizedFolder,
              actualUid: movedMessageAlias.destinationUid,
              actualFolder: movedMessageAlias.destinationFolder,
              sourceMessage: aliasedCachedMessage,
              movedMessageAlias,
            });
            continue;
          }
        }

        if (sourceSnapshotMessages.length > 0) {
          if (args.expunge) {
            throw buildDeleteEmailMissingUidError(uid, normalizedFolder, { expunge: true });
          }

          throw new Error(
            `Wrong message uid was provided: ${uid}. This uid does not exist in the latest retrieve_emails result for folder ${normalizedFolder} in this conversation. Look up data.emails[].uid in that latest retrieve_emails result and retry with one of those exact uid strings. Do not invent or transform the uid.`,
          );
        }

        throw buildDeleteEmailMissingUidError(uid, normalizedFolder, { expunge: Boolean(args.expunge) });
      }

      const deleteOperations = args.expunge
        ? Array.from(resolvedDeleteTargets.reduce((groups, target) => {
          const groupKey = target.actualFolder;
          const group = groups.get(groupKey) ?? [];
          group.push(target);
          groups.set(groupKey, group);
          return groups;
        }, new Map()).entries())
          .map(([folder, targets]) => ({ folder, targets }))
        : [{ folder: normalizedFolder, targets: resolvedDeleteTargets }];

      const deleteResults = [];

      for (const deleteOperation of deleteOperations) {
        deleteResults.push(await deleteImapMessage(accountConfig, {
          folder: deleteOperation.folder,
          uids: deleteOperation.targets.map((target) => target.actualUid),
          expunge: args.expunge,
        }));
      }

      const output = args.expunge
        ? {
          uids: targetUids,
          folder: normalizedFolder,
          destinationFolder: null,
          movedMessages: resolvedDeleteTargets.map((target) => ({
            sourceUid: target.requestedUid,
            destinationUid: null,
            deletedFolder: target.actualFolder,
            deletedUid: target.actualUid,
          })),
          expunge: true,
          deleted: true,
          movedToTrash: false,
        }
        : deleteResults[0];
      let messageCacheDeletedCount = 0;
      let messageCacheMovedCount = 0;
      let sourceSnapshotUpdated = false;
      let destinationSnapshotUpdated = false;

      if (args.expunge) {
        for (const target of resolvedDeleteTargets) {
          const cacheDeleted = await deleteCachedEmailMessageNode({
            treeId: resolvedTreeId,
            provider: args.provider,
            folder: target.actualFolder,
            uid: target.actualUid,
            updatedBy: resolvedUpdatedBy,
          });

          if (cacheDeleted) {
            messageCacheDeletedCount += 1;
          }

          const movedFrom = target.sourceMessage?.movedFrom;
          const aliasSourceFolder = target.movedMessageAlias?.sourceFolder ?? movedFrom?.folder ?? target.requestedFolder;
          const aliasSourceUid = target.movedMessageAlias?.sourceUid ?? movedFrom?.uid ?? target.requestedUid;

          if (aliasSourceUid && (target.movedMessageAlias || movedFrom)) {
            await deleteCachedEmailMovedMessageAlias({
              treeId: resolvedTreeId,
              provider: args.provider,
              sourceFolder: aliasSourceFolder,
              sourceUid: aliasSourceUid,
              updatedBy: resolvedUpdatedBy,
            });
          }
        }
      } else {
        for (const movedMessage of Array.isArray(output.movedMessages) ? output.movedMessages : []) {
          const sourceUid = String(movedMessage?.sourceUid ?? '').trim();
          const destinationUid = String(movedMessage?.destinationUid ?? '').trim() || null;

          if (!sourceUid || !destinationUid) {
            continue;
          }

          const fallbackMessage = sourceSnapshotMessagesByUid.get(sourceUid)
            ?? await loadCachedEmailMessage({
              treeId: resolvedTreeId,
              provider: args.provider,
              folder: normalizedFolder,
              uid: sourceUid,
            });

          const cacheMoved = await moveCachedEmailMessage({
            treeId: resolvedTreeId,
            provider: args.provider,
            sourceFolder: normalizedFolder,
            sourceUid,
            destinationUid,
            destinationFolder: output.destinationFolder,
            fallbackMessage,
            updatedBy: resolvedUpdatedBy,
          });

          if (cacheMoved) {
            messageCacheMovedCount += 1;
          }
        }
      }

      try {
        if (args.expunge) {
          const snapshotDeleteTargets = Array.from(resolvedDeleteTargets.reduce((groups, target) => {
            const snapshotFolder = target.actualFolder;
            const group = groups.get(snapshotFolder) ?? [];
            group.push(target.actualUid);
            groups.set(snapshotFolder, group);
            return groups;
          }, new Map()).entries());

          const snapshotDeleteResults = await Promise.all(
            snapshotDeleteTargets.map(([folder, uids]) => removeLatestEmailRetrievalSnapshotMessages({
              treeId: resolvedTreeId,
              provider: args.provider,
              folder,
              uids,
              updatedBy: resolvedUpdatedBy,
            })),
          );

          sourceSnapshotUpdated = snapshotDeleteResults.some(Boolean);
        } else {
          sourceSnapshotUpdated = await removeLatestEmailRetrievalSnapshotMessages({
            treeId: resolvedTreeId,
            provider: args.provider,
            folder: normalizedFolder,
            uids: targetUids,
            updatedBy: resolvedUpdatedBy,
          });
        }

        if (!args.expunge) {
          const destinationSnapshotMessages = (Array.isArray(output.movedMessages) ? output.movedMessages : [])
            .map((movedMessage) => {
              const sourceUid = String(movedMessage?.sourceUid ?? '').trim();
              const destinationUid = String(movedMessage?.destinationUid ?? '').trim();
              const sourceMessage = sourceSnapshotMessagesByUid.get(sourceUid);

              if (!sourceUid || !destinationUid || !sourceMessage) {
                return null;
              }

              return {
                ...sourceMessage,
                uid: destinationUid,
                folder: output.destinationFolder,
                movedFrom: {
                  folder: normalizedFolder,
                  uid: sourceUid,
                },
              };
            })
            .filter(Boolean);

          destinationSnapshotUpdated = await upsertLatestEmailRetrievalSnapshotMessages({
            treeId: resolvedTreeId,
            provider: args.provider,
            folder: output.destinationFolder,
            messages: destinationSnapshotMessages,
            updatedBy: resolvedUpdatedBy,
          });
        }
      } catch {
        sourceSnapshotUpdated = false;
        destinationSnapshotUpdated = false;
      }

      return buildEmailToolResult({
        toolName: DELETE_EMAIL_TOOL,
        toolResultType: 'email_delete',
        data: output,
        includeDebug,
        debug: includeDebug ? {
          ...output,
          messageCacheDeletedCount,
          messageCacheMovedCount,
          sourceSnapshotUpdated,
          destinationSnapshotUpdated,
        } : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}