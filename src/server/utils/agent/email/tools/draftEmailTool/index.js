import { randomUUID } from 'node:crypto';
import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import {
  loadCachedEmailMessage,
  loadLatestEmailRetrievalSnapshot,
  storeCachedEmailMessage,
} from '@/server/utils/agent/email/emailCacheRepository';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { saveEmailDraft } from '@/server/utils/agent/email/emailTransport';

export const DRAFT_EMAIL_TOOL = 'draft_email';

export const draftEmailToolDefinition = {
  type: 'function',
  name: DRAFT_EMAIL_TOOL,
  description: 'Save one email draft to the configured Drafts mailbox without sending it. Supports new drafts and reply drafts based on a retrieved email uid. Requires explicit confirmation before the draft is saved.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      folder: { type: ['string', 'null'] },
      uid: { type: ['string', 'null'] },
      to: { type: ['array', 'null'], items: { type: 'string' } },
      cc: { type: ['array', 'null'], items: { type: 'string' } },
      bcc: { type: ['array', 'null'], items: { type: 'string' } },
      subject: { type: ['string', 'null'] },
      body: { type: 'string' },
      htmlBody: { type: ['string', 'null'] },
      confirm: {
        type: 'boolean',
        description: 'Must be true only after the user explicitly confirms saving the draft.',
      },
    },
    required: ['provider', 'folder', 'uid', 'to', 'cc', 'bcc', 'subject', 'body', 'htmlBody', 'confirm'],
    additionalProperties: false,
  },
};

function normalizeRecipientList(value) {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean)));
}

function buildReplySubject(subject) {
  const normalizedSubject = String(subject ?? '').trim();

  if (!normalizedSubject) {
    return 'Re:';
  }

  return /^re\s*:/i.test(normalizedSubject)
    ? normalizedSubject
    : `Re: ${normalizedSubject}`;
}

async function resolveReplyDraftTarget({ treeId, provider, folder, uid, updatedBy = null }) {
  const cachedMessage = await loadCachedEmailMessage({
    treeId,
    provider,
    folder,
    uid,
  });

  if (cachedMessage) {
    return cachedMessage;
  }

  const snapshot = await loadLatestEmailRetrievalSnapshot({
    treeId,
    provider,
    folder,
  });
  const snapshotMessages = Array.isArray(snapshot?.messages) ? snapshot.messages : [];
  const snapshotMessage = snapshotMessages.find((entry) => String(entry?.uid ?? '').trim() === uid) ?? null;

  if (snapshotMessage) {
    await storeCachedEmailMessage({
      treeId,
      provider,
      folder,
      uid,
      message: snapshotMessage,
      updatedBy,
    });

    return snapshotMessage;
  }

  if (snapshotMessages.length > 0) {
    throw new Error(
      `Wrong message uid was provided: ${uid}. This uid does not exist in the latest retrieve_emails result for folder ${folder} in this conversation. Look up data.emails[].uid in that latest retrieve_emails result and retry with one of those exact uid strings. Do not invent or transform the uid.`,
    );
  }

  throw new Error(
    `Email uid ${uid} is not available in the current cache for folder ${folder}. Run retrieve_emails for that folder, then look up data.emails[].uid in the latest retrieve_emails result in this conversation and retry with one of those exact uid strings. Do not invent or transform the uid.`,
  );
}

export function buildDraftEmailHandler({ includeDebug = false, updatedBy = null, personalCacheTreeId = null } = {}) {
  return async function draftEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;
    const resolvedUpdatedBy = agentContext?.updatedBy ?? updatedBy ?? null;

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to save an email draft.');
      }

      const normalizedUid = String(args.uid ?? '').trim();
      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';
      const normalizedTo = normalizeRecipientList(args.to);
      const normalizedCc = normalizeRecipientList(args.cc);
      const normalizedBcc = normalizeRecipientList(args.bcc);
      const normalizedSubject = String(args.subject ?? '').trim();
      const normalizedBody = String(args.body ?? '').trim();
      const normalizedHtmlBody = typeof args.htmlBody === 'string' ? args.htmlBody : null;

      if (args.confirm !== true) {
        throw new Error('Draft save confirmation is required. Retry with confirm set to true only after the user explicitly confirms saving the draft.');
      }

      if (!normalizedBody) {
        throw new Error('Email draft body content is required.');
      }

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });

      let mode = 'new';
      let replyMessage = null;
      let resolvedTo = normalizedTo;
      let resolvedSubject = normalizedSubject;
      let resolvedInReplyTo = null;
      let resolvedReferences = [];

      if (normalizedUid) {
        mode = 'reply';
        replyMessage = await resolveReplyDraftTarget({
          treeId: resolvedTreeId,
          provider: args.provider,
          folder: normalizedFolder,
          uid: normalizedUid,
          updatedBy: resolvedUpdatedBy,
        });

        const replyAddress = String(replyMessage?.from?.address ?? '').trim();

        resolvedTo = normalizedTo.length > 0
          ? normalizedTo
          : replyAddress
            ? [replyAddress]
            : [];
        resolvedSubject = normalizedSubject || buildReplySubject(replyMessage?.subject ?? '');
        resolvedInReplyTo = String(replyMessage?.messageId ?? '').trim() || null;
        resolvedReferences = resolvedInReplyTo ? [resolvedInReplyTo] : [];
      }

      if (resolvedTo.length === 0) {
        throw new Error('At least one recipient is required to save an email draft.');
      }

      if (!resolvedSubject) {
        throw new Error('An email subject is required to save an email draft.');
      }

      const draftMessageId = `<draft-${randomUUID()}@local>`;
      const output = await saveEmailDraft(accountConfig, {
        to: resolvedTo,
        cc: normalizedCc,
        bcc: normalizedBcc,
        subject: resolvedSubject,
        body: normalizedBody,
        htmlBody: normalizedHtmlBody,
        replyTo: null,
        inReplyTo: resolvedInReplyTo,
        references: resolvedReferences,
        from: null,
        messageId: draftMessageId,
      });

      const result = {
        provider: args.provider,
        mode,
        folder: mode === 'reply' ? normalizedFolder : null,
        uid: mode === 'reply' ? normalizedUid : null,
        to: resolvedTo,
        cc: normalizedCc,
        bcc: normalizedBcc,
        subject: resolvedSubject,
        body: normalizedBody,
        htmlBody: normalizedHtmlBody,
        confirm: args.confirm === true,
        inReplyTo: resolvedInReplyTo,
        references: resolvedReferences,
        replySourceSubject: replyMessage?.subject ?? null,
        savedToDrafts: output.savedToDrafts,
        draftFolder: output.draftsMailboxPath,
        draftUid: output.draftUid,
        draftsMailboxPath: output.draftsMailboxPath,
        draftMailboxError: output.draftMailboxError,
        messageId: output.messageId || draftMessageId,
      };

      return buildEmailToolResult({
        toolName: DRAFT_EMAIL_TOOL,
        toolResultType: 'email_draft',
        data: result,
        includeDebug,
        debug: includeDebug ? result : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}