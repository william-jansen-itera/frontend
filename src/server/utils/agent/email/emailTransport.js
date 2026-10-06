import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import {
  buildPreview,
  extractNormalizedMessageText,
  normalizeWhitespace,
} from '@/server/utils/agent/email/emailHeuristics';

const DEFAULT_SCAN_MULTIPLIER = 5;
const MIN_SCAN_LIMIT = 25;
const MAX_SCAN_LIMIT = 100;

export function normalizeRetrievalLimit(value, fallback = 10) {
  return Math.max(1, Math.min(Number.parseInt(String(value ?? fallback), 10) || fallback, 25));
}

export function computeRetrievalScanLimit(limit, fallback = 10) {
  const normalizedLimit = normalizeRetrievalLimit(limit, fallback);

  return Math.max(MIN_SCAN_LIMIT, Math.min(normalizedLimit * DEFAULT_SCAN_MULTIPLIER, MAX_SCAN_LIMIT));
}

function normalizeAddressValue(addressValue) {
  if (!addressValue || !Array.isArray(addressValue.value)) {
    return [];
  }

  return addressValue.value
    .map((entry) => String(entry?.address ?? '').trim())
    .filter(Boolean);
}

function normalizeMessageFlags(flags) {
  if (!flags) {
    return [];
  }

  return Array.from(flags).map((flag) => String(flag ?? '').trim()).filter(Boolean);
}

function buildImapClient(accountConfig) {
  return new ImapFlow({
    host: accountConfig.imap.host,
    port: accountConfig.imap.port,
    secure: accountConfig.imap.secure,
    auth: {
      user: accountConfig.imap.user,
      pass: accountConfig.imap.password,
    },
    logger: false,
  });
}

async function withImapClient(accountConfig, callback) {
  const client = buildImapClient(accountConfig);

  try {
    await client.connect();
    return await callback(client);
  } finally {
    await client.logout().catch(() => null);
  }
}

function normalizeReceivedAt(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    return null;
  }

  return value.toISOString();
}

function matchesDateBounds(messageDate, { since = null, before = null } = {}) {
  if (!messageDate) {
    return true;
  }

  const messageTime = messageDate.getTime();

  if (since) {
    const sinceTime = new Date(since).getTime();

    if (!Number.isNaN(sinceTime) && messageTime < sinceTime) {
      return false;
    }
  }

  if (before) {
    const beforeTime = new Date(before).getTime();

    if (!Number.isNaN(beforeTime) && messageTime > beforeTime) {
      return false;
    }
  }

  return true;
}

function matchesTextFilters(messageSummary, { fromContains, subjectContains, textQuery }) {
  const fromValue = String(messageSummary.from ?? '').toLowerCase();
  const subjectValue = String(messageSummary.subject ?? '').toLowerCase();
  const previewValue = String(messageSummary.preview ?? '').toLowerCase();
  const bodyValue = String(messageSummary.bodyText ?? '').toLowerCase();
  const normalizedFromContains = String(fromContains ?? '').trim().toLowerCase();
  const normalizedSubjectContains = String(subjectContains ?? '').trim().toLowerCase();
  const normalizedTextQuery = String(textQuery ?? '').trim().toLowerCase();

  if (normalizedFromContains && !fromValue.includes(normalizedFromContains)) {
    return false;
  }

  if (normalizedSubjectContains && !subjectValue.includes(normalizedSubjectContains)) {
    return false;
  }

  if (normalizedTextQuery && !subjectValue.includes(normalizedTextQuery) && !previewValue.includes(normalizedTextQuery) && !bodyValue.includes(normalizedTextQuery)) {
    return false;
  }

  return true;
}

async function parseMessageSource(source) {
  const parsedMessage = await simpleParser(source);
  const subject = normalizeWhitespace(parsedMessage.subject ?? '');
  const text = normalizeWhitespace(parsedMessage.text ?? '');
  const html = typeof parsedMessage.html === 'string' ? parsedMessage.html : '';
  const normalizedBodyText = extractNormalizedMessageText({
    subject,
    text,
    html,
  });

  return {
    subject,
    text,
    html,
    normalizedBodyText,
    preview: buildPreview(normalizedBodyText),
  };
}

export async function retrieveEmailsFromImap(accountConfig, filters = {}) {
  const folder = String(filters.folder ?? 'INBOX').trim() || 'INBOX';
  const limit = normalizeRetrievalLimit(filters.limit);
  const scanLimit = computeRetrievalScanLimit(limit);
  const returnAllScanned = filters.returnAllScanned === true;

  return withImapClient(accountConfig, async (client) => {
    const mailbox = await client.mailboxOpen(folder);
    const totalMessages = Number(mailbox?.exists ?? 0);
    const startSequence = Math.max(1, totalMessages - scanLimit + 1);
    const fetchedMessages = [];

    for await (const message of client.fetch(`${startSequence}:*`, {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      source: true,
    })) {
      fetchedMessages.push(message);
    }

    const normalizedMessages = [];

    for (const message of fetchedMessages.reverse()) {
      const parsedSource = await parseMessageSource(message.source);
      const flags = normalizeMessageFlags(message.flags);
      const summary = {
        uid: String(message.uid),
        messageId: String(message.envelope?.messageId ?? '').trim() || null,
        threadId: null,
        folder,
        from: normalizeAddressValue(message.envelope?.from)[0] ?? '',
        to: normalizeAddressValue(message.envelope?.to),
        cc: normalizeAddressValue(message.envelope?.cc),
        subject: parsedSource.subject || normalizeWhitespace(message.envelope?.subject ?? ''),
        receivedAt: normalizeReceivedAt(message.internalDate ?? message.envelope?.date ?? null),
        flags,
        preview: parsedSource.preview,
        bodyText: parsedSource.normalizedBodyText,
      };

      if (!returnAllScanned) {
        if (filters.unreadOnly && flags.includes('\\Seen')) {
          continue;
        }

        if (filters.flaggedOnly && !flags.includes('\\Flagged')) {
          continue;
        }

        if (!matchesDateBounds(message.internalDate ?? message.envelope?.date ?? null, filters)) {
          continue;
        }

        if (!matchesTextFilters(summary, filters)) {
          continue;
        }
      }

      normalizedMessages.push(summary);

      if (!returnAllScanned && normalizedMessages.length >= limit) {
        break;
      }
    }

    return {
      folder,
      messages: normalizedMessages,
      scanLimit,
    };
  });
}

export async function getImapMessageByUid(accountConfig, { uid, folder = 'INBOX' }) {
  return withImapClient(accountConfig, async (client) => {
    await client.mailboxOpen(folder);

    for await (const message of client.fetch(String(uid), {
      uid: true,
      envelope: true,
      flags: true,
      internalDate: true,
      source: true,
    }, { uid: true })) {
      const parsedSource = await parseMessageSource(message.source);

      return {
        uid: String(message.uid),
        messageId: String(message.envelope?.messageId ?? '').trim() || null,
        folder,
        from: normalizeAddressValue(message.envelope?.from)[0] ?? '',
        to: normalizeAddressValue(message.envelope?.to),
        cc: normalizeAddressValue(message.envelope?.cc),
        subject: parsedSource.subject || normalizeWhitespace(message.envelope?.subject ?? ''),
        receivedAt: normalizeReceivedAt(message.internalDate ?? message.envelope?.date ?? null),
        flags: normalizeMessageFlags(message.flags),
        bodyText: parsedSource.normalizedBodyText,
        preview: parsedSource.preview,
      };
    }

    throw new Error(`Email message ${uid} was not found in folder ${folder}.`);
  });
}

export async function updateImapMessageFlags(accountConfig, { uid, folder = 'INBOX', flags = [], mode = 'add' }) {
  return withImapClient(accountConfig, async (client) => {
    await client.mailboxOpen(folder);
    const normalizedFlags = Array.from(new Set((Array.isArray(flags) ? flags : []).map((flag) => String(flag ?? '').trim()).filter(Boolean)));

    if (normalizedFlags.length === 0) {
      throw new Error('At least one IMAP flag is required.');
    }

    if (mode === 'remove') {
      await client.messageFlagsRemove(String(uid), normalizedFlags, { uid: true });
    } else {
      await client.messageFlagsAdd(String(uid), normalizedFlags, { uid: true });
    }

    return {
      uid: String(uid),
      folder,
      mode: mode === 'remove' ? 'remove' : 'add',
      flags: normalizedFlags,
    };
  });
}

export async function deleteImapMessage(accountConfig, { uid, folder = 'INBOX', expunge = false }) {
  return withImapClient(accountConfig, async (client) => {
    await client.mailboxOpen(folder);
    await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });

    if (expunge) {
      await client.messageDelete(String(uid), { uid: true });
    }

    return {
      uid: String(uid),
      folder,
      expunge: Boolean(expunge),
      deleted: true,
    };
  });
}

export async function sendEmailViaSmtp(accountConfig, message) {
  const transport = nodemailer.createTransport({
    host: accountConfig.smtp.host,
    port: accountConfig.smtp.port,
    secure: accountConfig.smtp.secure,
    auth: {
      user: accountConfig.smtp.user,
      pass: accountConfig.smtp.password,
    },
  });

  const info = await transport.sendMail({
    from: message.from || accountConfig.smtp.user,
    to: message.to,
    cc: message.cc,
    bcc: message.bcc,
    subject: message.subject,
    text: message.body,
    html: message.htmlBody || undefined,
    replyTo: message.replyTo || undefined,
    inReplyTo: message.inReplyTo || undefined,
    references: Array.isArray(message.references) ? message.references : undefined,
  });

  return {
    accepted: Array.isArray(info.accepted) ? info.accepted : [],
    rejected: Array.isArray(info.rejected) ? info.rejected : [],
    messageId: info.messageId ?? null,
    response: info.response ?? null,
  };
}