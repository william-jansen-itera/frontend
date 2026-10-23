import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import {
  deleteImapMessage,
  getDraftsMailboxPath,
  getImapMessageByUid,
  sendEmailViaSmtp,
} from '@/server/utils/agent/email/emailTransport';

export const SEND_EMAIL_TOOL = 'send_email';

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

function buildReplyReferences(message) {
  const existingReferences = Array.isArray(message?.references)
    ? message.references.map((entry) => String(entry ?? '').trim()).filter(Boolean)
    : [];
  const messageId = String(message?.messageId ?? '').trim();

  return Array.from(new Set([
    ...existingReferences,
    messageId,
  ].filter(Boolean)));
}

export const sendEmailToolDefinition = {
  type: 'function',
  name: SEND_EMAIL_TOOL,
  description: 'Send one email using the configured SMTP account settings, either from explicit message fields or from a previously saved draft identified by folder and uid. When the user wants delivery now, use this tool directly instead of creating a draft first. For normal replies, preserve the original subject unless the user explicitly asks to change it.',
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
      body: { type: ['string', 'null'] },
      htmlBody: { type: ['string', 'null'] },
      replyTo: { type: ['string', 'null'] },
      inReplyTo: { type: ['string', 'null'] },
      references: { type: ['array', 'null'], items: { type: 'string' } },
      from: { type: ['string', 'null'] },
    },
    required: ['provider', 'folder', 'uid', 'to', 'cc', 'bcc', 'subject', 'body', 'htmlBody', 'replyTo', 'inReplyTo', 'references', 'from'],
    additionalProperties: false,
  },
};

export function buildSendEmailHandler({ includeDebug = false, personalCacheTreeId = null } = {}) {
  return async function sendEmailHandler(args, agentContext = null) {
    const resolvedTreeId = agentContext?.personalCacheTreeId ?? personalCacheTreeId ?? null;

    try {
      if (!resolvedTreeId) {
        throw new Error('A personal cache tree id is required to send email.');
      }

      const normalizedFolder = String(args.folder ?? 'INBOX').trim() || 'INBOX';
      const normalizedUid = String(args.uid ?? '').trim();
      const normalizedTo = normalizeRecipientList(args.to);
      const normalizedCc = normalizeRecipientList(args.cc);
      const normalizedBcc = normalizeRecipientList(args.bcc);
      const normalizedSubject = String(args.subject ?? '').trim();
      const normalizedBody = typeof args.body === 'string' ? args.body.trim() : '';
      const normalizedHtmlBody = typeof args.htmlBody === 'string' ? args.htmlBody : null;
      const normalizedReplyTo = String(args.replyTo ?? '').trim() || null;
      const normalizedInReplyTo = String(args.inReplyTo ?? '').trim() || null;
      const normalizedReferences = Array.from(new Set((Array.isArray(args.references) ? args.references : [])
        .map((entry) => String(entry ?? '').trim())
        .filter(Boolean)));
      const normalizedFrom = String(args.from ?? '').trim() || null;

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        principal: agentContext?.principal,
        provider: args.provider,
      });
      const draftsMailboxPath = await getDraftsMailboxPath(accountConfig);
      const normalizedDraftsMailboxPath = String(draftsMailboxPath ?? '').trim().toLowerCase();
      const isSavedDraftSend = Boolean(normalizedUid)
        && normalizedDraftsMailboxPath
        && normalizedFolder.toLowerCase() === normalizedDraftsMailboxPath;

      let sourceMessage = null;
      let resolvedTo = normalizedTo;
      let resolvedCc = normalizedCc;
      let resolvedBcc = normalizedBcc;
      let resolvedSubject = normalizedSubject;
      let resolvedBody = normalizedBody;
      let resolvedHtmlBody = normalizedHtmlBody;
      let resolvedReplyTo = normalizedReplyTo;
      let resolvedInReplyTo = normalizedInReplyTo;
      let resolvedReferences = normalizedReferences;
      let resolvedFrom = normalizedFrom;

      if (normalizedUid) {
        sourceMessage = await getImapMessageByUid(accountConfig, {
          uid: normalizedUid,
          folder: normalizedFolder,
        });

        if (isSavedDraftSend) {
          resolvedTo = normalizedTo.length > 0 ? normalizedTo : normalizeRecipientList(sourceMessage.to);
          resolvedCc = normalizedCc.length > 0 ? normalizedCc : normalizeRecipientList(sourceMessage.cc);
          resolvedBcc = normalizedBcc.length > 0 ? normalizedBcc : normalizeRecipientList(sourceMessage.bcc);
          resolvedSubject = normalizedSubject || String(sourceMessage.subject ?? '').trim();
          resolvedBody = normalizedBody || String(sourceMessage.body ?? '').trim();
          resolvedHtmlBody = normalizedHtmlBody ?? sourceMessage.htmlBody ?? null;
          resolvedReplyTo = normalizedReplyTo || sourceMessage.replyTo || null;
          resolvedInReplyTo = normalizedInReplyTo || sourceMessage.inReplyTo || null;
          resolvedReferences = normalizedReferences.length > 0
            ? normalizedReferences
            : Array.isArray(sourceMessage.references) ? sourceMessage.references : [];
          resolvedFrom = normalizedFrom || sourceMessage.from?.address || null;
        } else {
          const replyRecipient = String(sourceMessage.replyTo ?? '').trim() || String(sourceMessage.from?.address ?? '').trim();

          resolvedTo = normalizedTo.length > 0
            ? normalizedTo
            : replyRecipient
              ? [replyRecipient]
              : [];
          resolvedSubject = normalizedSubject || buildReplySubject(sourceMessage.subject ?? '');
          resolvedInReplyTo = normalizedInReplyTo || String(sourceMessage.messageId ?? '').trim() || null;
          resolvedReferences = normalizedReferences.length > 0
            ? normalizedReferences
            : buildReplyReferences(sourceMessage);
        }
      }

      if (resolvedTo.length === 0) {
        throw new Error('At least one recipient is required to send email.');
      }

      if (!resolvedSubject) {
        throw new Error('An email subject is required to send email.');
      }

      if (!resolvedBody && !resolvedHtmlBody) {
        throw new Error('Email body content is required to send email.');
      }

      const output = await sendEmailViaSmtp(accountConfig, {
        to: resolvedTo,
        cc: resolvedCc,
        bcc: resolvedBcc,
        subject: resolvedSubject,
        body: resolvedBody,
        htmlBody: resolvedHtmlBody,
        replyTo: resolvedReplyTo,
        inReplyTo: resolvedInReplyTo,
        references: resolvedReferences,
        from: resolvedFrom,
      });

      let draftCleanup = null;

      if (normalizedUid && isSavedDraftSend) {
        try {
          const deleteResult = await deleteImapMessage(accountConfig, {
            uid: normalizedUid,
            folder: normalizedFolder,
            expunge: true,
          });

          draftCleanup = {
            deletedDraft: true,
            deletedDraftFolder: normalizedFolder,
            deletedDraftUid: normalizedUid,
            draftDeleteError: null,
            draftDeleteResult: deleteResult,
          };
        } catch (deleteError) {
          draftCleanup = {
            deletedDraft: false,
            deletedDraftFolder: normalizedFolder,
            deletedDraftUid: normalizedUid,
            draftDeleteError: String(deleteError?.message ?? 'Deleting the sent draft failed.'),
            draftDeleteResult: null,
          };
        }
      }

      const result = {
        ...output,
        provider: args.provider,
        folder: normalizedUid ? normalizedFolder : null,
        uid: normalizedUid || null,
        sourceType: normalizedUid ? (isSavedDraftSend ? 'saved_draft' : 'direct_reply') : 'direct',
        sourceSubject: sourceMessage?.subject ?? null,
        deletedDraft: draftCleanup?.deletedDraft ?? null,
        deletedDraftFolder: draftCleanup?.deletedDraftFolder ?? null,
        deletedDraftUid: draftCleanup?.deletedDraftUid ?? null,
        draftDeleteError: draftCleanup?.draftDeleteError ?? null,
      };

      return buildEmailToolResult({
        toolName: SEND_EMAIL_TOOL,
        toolResultType: 'email_send',
        data: result,
        includeDebug,
        debug: includeDebug ? result : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}