import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
  buildPreview,
  extractNormalizedMessageText,
  normalizeWhitespace,
} from '@/server/utils/agent/email/emailHeuristics';
import {
  MANUAL_UNSUBSCRIBE_KEYWORDS,
  UNSUBSCRIBE_BODY_LINK_LABELS,
} from '@/server/utils/agent/email/tools/unsubscribeEmailTool/unsubscribeDetectionConfig';

const MIN_SCAN_LIMIT = 25;
const MAX_SCAN_LIMIT = 100;
const MAX_UNSUBSCRIBE_HTML_ANALYSIS_CHARS = 50000;

export const REFRESH_RETRIEVAL_SCAN_LIMIT = MAX_SCAN_LIMIT;

export function normalizeRetrievalLimit(value, fallback = 10) {
  return Math.max(1, Math.min(Number.parseInt(String(value ?? fallback), 10) || fallback, 25));
}

function normalizeScanLimitOverride(value) {
  const parsedValue = Number.parseInt(String(value ?? ''), 10);

  if (!Number.isFinite(parsedValue)) {
    return null;
  }

  return Math.max(MIN_SCAN_LIMIT, Math.min(parsedValue, MAX_SCAN_LIMIT));
}

function normalizeEnvelopeAddressEntry(entry) {
  const directAddress = String(entry?.address ?? '').trim();
  const mailbox = String(entry?.mailbox ?? '').trim();
  const host = String(entry?.host ?? '').trim();
  const name = normalizeWhitespace(entry?.name ?? entry?.displayName ?? '');
  const address = directAddress || (mailbox && host ? `${mailbox}@${host}` : mailbox || '');

  if (!name && !address) {
    return null;
  }

  return {
    name: name || null,
    address: address || null,
  };
}

function normalizeAddressValue(addressValue) {
  const entries = Array.isArray(addressValue)
    ? addressValue
    : Array.isArray(addressValue?.value)
      ? addressValue.value
      : [];

  return entries
    .map((entry) => normalizeEnvelopeAddressEntry(entry))
    .filter(Boolean);
}

function normalizeAddressList(addressValue) {
  return normalizeAddressValue(addressValue)
    .map((entry) => entry.address || entry.name)
    .filter(Boolean);
}

function buildPrimarySenderFields(addressValue) {
  const primaryEntry = normalizeAddressValue(addressValue)[0] ?? null;

  return {
    from: primaryEntry
      ? {
        name: primaryEntry.name ?? null,
        address: primaryEntry.address ?? null,
      }
      : null,
  };
}

function normalizeSingleAddress(addressValue) {
  return normalizeAddressValue(addressValue)[0] ?? null;
}

function normalizeReferenceList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry ?? '').trim()).filter(Boolean);
  }

  return String(value ?? '')
    .split(/\s+/)
    .map((entry) => String(entry ?? '').trim())
    .filter(Boolean);
}

function normalizeMessageFlags(flags) {
  if (!flags) {
    return [];
  }

  return Array.from(flags).map((flag) => String(flag ?? '').trim()).filter(Boolean);
}

function resolveTrashMailboxPath(mailboxes = []) {
  const trashMailbox = mailboxes.find((mailbox) => String(mailbox?.specialUse ?? '').trim() === '\\Trash')
    ?? mailboxes.find((mailbox) => {
      const path = String(mailbox?.path ?? '').trim().toLowerCase();
      const name = String(mailbox?.name ?? '').trim().toLowerCase();

      return ['trash', 'deleted items', 'deleted messages'].includes(path)
        || ['trash', 'deleted items', 'deleted messages'].includes(name);
    })
    ?? null;

  return trashMailbox?.path ?? null;
}

function resolveSentMailboxPath(mailboxes = []) {
  const sentMailbox = mailboxes.find((mailbox) => String(mailbox?.specialUse ?? '').trim() === '\\Sent')
    ?? mailboxes.find((mailbox) => {
      const path = String(mailbox?.path ?? '').trim().toLowerCase();
      const name = String(mailbox?.name ?? '').trim().toLowerCase();

      return ['sent', 'sent items', 'sent messages', 'sent mail'].includes(path)
        || ['sent', 'sent items', 'sent messages', 'sent mail'].includes(name);
    })
    ?? null;

  return sentMailbox?.path ?? null;
}

function resolveDraftsMailboxPath(mailboxes = []) {
  const draftsMailbox = mailboxes.find((mailbox) => String(mailbox?.specialUse ?? '').trim() === '\\Drafts')
    ?? mailboxes.find((mailbox) => {
      const path = String(mailbox?.path ?? '').trim().toLowerCase();
      const name = String(mailbox?.name ?? '').trim().toLowerCase();

      return ['drafts', 'draft', 'concepts'].includes(path)
        || ['drafts', 'draft', 'concepts'].includes(name);
    })
    ?? null;

  return draftsMailbox?.path ?? null;
}

export async function getDraftsMailboxPath(accountConfig) {
  return withImapClient(accountConfig, async (client) => resolveDraftsMailboxPath(await client.list()));
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

function matchesTextFilters(messageSummary, { fromContains, subjectContains, textQuery, anyTextQueries }) {
  const fromValue = [messageSummary.from?.name, messageSummary.from?.address]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const subjectValue = String(messageSummary.subject ?? '').toLowerCase();
  const previewValue = String(messageSummary.preview ?? '').toLowerCase();
  const bodyValue = String(messageSummary.bodyText ?? '').toLowerCase();
  const normalizedFromContains = String(fromContains ?? '').trim().toLowerCase();
  const normalizedSubjectContains = String(subjectContains ?? '').trim().toLowerCase();
  const normalizedTextQuery = String(textQuery ?? '').trim().toLowerCase();
  const normalizedAnyTextQueries = Array.from(new Set(
    Array.isArray(anyTextQueries)
      ? anyTextQueries.map((value) => String(value ?? '').trim().toLowerCase()).filter(Boolean)
      : [],
  ));
  const searchableValues = [subjectValue, previewValue, bodyValue];

  if (normalizedFromContains && !fromValue.includes(normalizedFromContains)) {
    return false;
  }

  if (normalizedSubjectContains && !subjectValue.includes(normalizedSubjectContains)) {
    return false;
  }

  if (normalizedTextQuery && !searchableValues.some((value) => value.includes(normalizedTextQuery))) {
    return false;
  }

  if (normalizedAnyTextQueries.length > 0 && !normalizedAnyTextQueries.some((query) => searchableValues.some((value) => value.includes(query)))) {
    return false;
  }

  return true;
}

function normalizeParsedAttachments(attachments) {
  return Array.isArray(attachments)
    ? attachments.map((attachment, index) => {
      const normalizedFileName = String(attachment?.filename ?? '').trim();
      const normalizedContentType = String(attachment?.contentType ?? '').trim();
      const normalizedContentDisposition = String(attachment?.contentDisposition ?? '').trim();
      const normalizedContentId = String(attachment?.cid ?? '').trim();
      const normalizedSize = Number(attachment?.size ?? 0);

      return {
        fileName: normalizedFileName || `attachment-${index + 1}`,
        contentType: normalizedContentType || null,
        contentDisposition: normalizedContentDisposition || null,
        contentId: normalizedContentId || null,
        size: Number.isFinite(normalizedSize) && normalizedSize >= 0 ? normalizedSize : null,
        isInline: normalizedContentDisposition.toLowerCase() === 'inline' || Boolean(attachment?.related),
      };
    })
    : [];
}

function normalizeHeaderToken(value) {
  return String(value ?? '').trim();
}

function containsManualUnsubscribeKeyword(value) {
  const normalizedValue = String(value ?? '').toLowerCase();

  return MANUAL_UNSUBSCRIBE_KEYWORDS.some((keyword) => normalizedValue.includes(keyword));
}

function limitHtmlForAnalysis(value) {
  return String(value ?? '').slice(0, MAX_UNSUBSCRIBE_HTML_ANALYSIS_CHARS);
}

function collectAnchorTagCandidatesFromSlice(html) {
  const normalizedHtml = String(html ?? '');

  if (!normalizedHtml) {
    return [];
  }

  const lowerHtml = normalizedHtml.toLowerCase();
  const anchors = [];
  let index = 0;

  while (index < normalizedHtml.length) {
    const anchorStart = lowerHtml.indexOf('<a', index);

    if (anchorStart === -1) {
      break;
    }

    const openTagEnd = normalizedHtml.indexOf('>', anchorStart + 2);

    if (openTagEnd === -1) {
      break;
    }

    const closeTagStart = lowerHtml.indexOf('</a>', openTagEnd + 1);

    if (closeTagStart === -1) {
      break;
    }

    anchors.push({
      attributes: normalizedHtml.slice(anchorStart + 2, openTagEnd),
      bodyContent: normalizedHtml.slice(openTagEnd + 1, closeTagStart),
    });

    index = closeTagStart + 4;
  }

  return anchors;
}

function stripHtmlTagsForAnalysis(value) {
  const html = limitHtmlForAnalysis(value);
  let result = '';
  let index = 0;

  while (index < html.length) {
    const currentChar = html[index];

    if (currentChar === '<') {
      const tagEnd = html.indexOf('>', index + 1);

      if (tagEnd === -1) {
        break;
      }

      result += ' ';
      index = tagEnd + 1;
      continue;
    }

    result += currentChar;
    index += 1;
  }

  return result;
}

function extractAnchorTagCandidates(html) {
  const normalizedHtml = String(html ?? '');

  if (!normalizedHtml) {
    return [];
  }

  const headSlice = normalizedHtml.slice(0, MAX_UNSUBSCRIBE_HTML_ANALYSIS_CHARS);
  const tailStart = Math.max(0, normalizedHtml.length - MAX_UNSUBSCRIBE_HTML_ANALYSIS_CHARS);
  const tailSlice = normalizedHtml.slice(tailStart);
  const candidates = [
    ...collectAnchorTagCandidatesFromSlice(tailSlice),
    ...collectAnchorTagCandidatesFromSlice(headSlice),
  ];

  return Array.from(new Map(
    candidates.map((candidate) => [
      `${candidate.attributes}::${candidate.bodyContent}`,
      candidate,
    ]),
  ).values());
}

function containsUnsubscribeKeyword(value) {
  const normalizedValue = normalizeWhitespace(decodeBasicHtmlEntities(stripHtmlTagsForAnalysis(value))).toLowerCase();

  if (!normalizedValue) {
    return false;
  }

  return containsManualUnsubscribeKeyword(normalizedValue);
}

function parseListUnsubscribeHeaderValue(value) {
  const normalizedValue = normalizeHeaderToken(value);

  if (!normalizedValue) {
    return [];
  }

  const extractedBracketValues = Array.from(normalizedValue.matchAll(/<([^>]+)>/g), (match) => normalizeHeaderToken(match[1]));
  const candidateValues = extractedBracketValues.length > 0
    ? extractedBracketValues
    : normalizedValue.split(',').map((entry) => normalizeHeaderToken(entry));

  return Array.from(new Set(candidateValues.filter(Boolean).map((entry) => {
    const lowerEntry = entry.toLowerCase();

    if (lowerEntry.startsWith('mailto:')) {
      return {
        type: 'mailto',
        value: entry,
      };
    }

    if (lowerEntry.startsWith('http://') || lowerEntry.startsWith('https://')) {
      return {
        type: 'url',
        value: entry,
      };
    }

    return {
      type: 'other',
      value: entry,
    };
  }).map((entry) => JSON.stringify(entry)))).map((entry) => JSON.parse(entry));
}

function normalizeHeaderLookupValue(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeHeaderToken(entry)).filter(Boolean).join(', ');
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return normalizeHeaderToken(value.text);
    }

    if (typeof value.value === 'string') {
      return normalizeHeaderToken(value.value);
    }
  }

  return normalizeHeaderToken(value);
}

function decodeBasicHtmlEntities(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizeBodyLinkLabel(value) {
  return normalizeWhitespace(
    decodeBasicHtmlEntities(stripHtmlTagsForAnalysis(value)),
  ).toLowerCase();
}

function extractHtmlAttributeValue(attributeSource, attributeName) {
  const normalizedAttributeName = String(attributeName ?? '').trim();

  if (!normalizedAttributeName) {
    return '';
  }

  const attributePattern = new RegExp(`${normalizedAttributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i');
  const match = String(attributeSource ?? '').match(attributePattern);

  if (!match) {
    return '';
  }

  return normalizeHeaderToken(match[1] ?? match[2] ?? match[3] ?? '');
}

function buildUnsubscribeBodyLinkMethod(url) {
  const normalizedUrl = normalizeHeaderToken(url);
  const lowerUrl = normalizedUrl.toLowerCase();

  if (!normalizedUrl) {
    return null;
  }

  if (lowerUrl.startsWith('mailto:')) {
    return {
      type: 'mailto',
      value: normalizedUrl,
    };
  }

  if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
    return {
      type: 'url',
      value: normalizedUrl,
    };
  }

  return {
    type: 'other',
    value: normalizedUrl,
  };
}

function extractUnsubscribeBodyLink(html) {
  const anchorMatches = extractAnchorTagCandidates(html);

  if (anchorMatches.length === 0) {
    return null;
  }

  for (const match of anchorMatches) {
    const attributes = String(match.attributes ?? '');
    const bodyContent = String(match.bodyContent ?? '');
    const href = extractHtmlAttributeValue(attributes, 'href');
    const normalizedBodyLabel = normalizeBodyLinkLabel(bodyContent);

    if (!href) {
      continue;
    }

    if (!UNSUBSCRIBE_BODY_LINK_LABELS.has(normalizedBodyLabel)) {
      continue;
    }

    return {
      label: normalizedBodyLabel,
      url: href,
      method: buildUnsubscribeBodyLinkMethod(href),
    };
  }

  return null;
}

function extractManualUnsubscribeBodyInstruction(html) {
  const anchorMatches = extractAnchorTagCandidates(html);

  if (anchorMatches.length === 0) {
    return null;
  }

  for (const match of anchorMatches) {
    const attributes = String(match.attributes ?? '');
    const bodyContent = String(match.bodyContent ?? '');
    const href = extractHtmlAttributeValue(attributes, 'href');
    const normalizedLabel = normalizeBodyLinkLabel(bodyContent);

    if (!href || !normalizedLabel) {
      continue;
    }

    if (UNSUBSCRIBE_BODY_LINK_LABELS.has(normalizedLabel)) {
      continue;
    }

    if (!containsManualUnsubscribeKeyword(normalizedLabel)) {
      continue;
    }

    return {
      text: normalizedLabel,
      url: href,
      emailAddresses: [],
    };
  }

  return null;
}

function extractHeaderLineValue(headerLines, key) {
  const normalizedKey = String(key ?? '').trim().toLowerCase();

  if (!normalizedKey || !Array.isArray(headerLines)) {
    return '';
  }

  const matchingLine = headerLines.find((headerLine) => String(headerLine?.key ?? '').trim().toLowerCase() === normalizedKey);

  if (!matchingLine) {
    return '';
  }

  if (typeof matchingLine.line === 'string') {
    const separatorIndex = matchingLine.line.indexOf(':');

    if (separatorIndex >= 0) {
      return normalizeHeaderToken(matchingLine.line.slice(separatorIndex + 1));
    }
  }

  return normalizeHeaderToken(matchingLine?.value);
}

function extractRelevantManualInstructionText(value) {
  const normalizedValue = normalizeWhitespace(value);

  if (!normalizedValue) {
    return '';
  }

  const lowerValue = normalizedValue.toLowerCase();
  const keywordIndex = MANUAL_UNSUBSCRIBE_KEYWORDS
    .map((keyword) => lowerValue.indexOf(keyword))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;

  if (keywordIndex < 0) {
    return normalizedValue;
  }

  const separatorPattern = /[.!?;:|•·]/;
  let start = 0;

  for (let index = keywordIndex - 1; index >= 0; index -= 1) {
    if (separatorPattern.test(normalizedValue[index])) {
      start = index + 1;
      break;
    }
  }

  const prefixSegment = normalizedValue.slice(start, keywordIndex);
  const capitalizedWordPattern = /(?:^|\s)([A-ZÆØÅ][^\s]*)/g;
  let capitalizedMatch = capitalizedWordPattern.exec(prefixSegment);
  let capitalizedStart = -1;

  while (capitalizedMatch) {
    capitalizedStart = start + capitalizedMatch.index + capitalizedMatch[0].length - capitalizedMatch[1].length;
    capitalizedMatch = capitalizedWordPattern.exec(prefixSegment);
  }

  if (capitalizedStart >= start && keywordIndex - capitalizedStart <= 80) {
    start = capitalizedStart;
  }

  let end = normalizedValue.length;

  for (let index = keywordIndex; index < normalizedValue.length; index += 1) {
    if (separatorPattern.test(normalizedValue[index])) {
      end = index;
      break;
    }
  }

  return normalizeWhitespace(normalizedValue.slice(start, end));
}

function findManualUnsubscribeInstruction(bodyText, html) {
  const normalizedBodyText = normalizeWhitespace(bodyText ?? '');

  const manualBodyInstruction = extractManualUnsubscribeBodyInstruction(html);

  if (manualBodyInstruction) {
    return manualBodyInstruction;
  }

  if (!normalizedBodyText) {
    return null;
  }

  const sentenceCandidates = normalizedBodyText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => normalizeWhitespace(sentence))
    .filter(Boolean);

  for (const sentence of sentenceCandidates) {
    const lowerSentence = sentence.toLowerCase();

    if (!MANUAL_UNSUBSCRIBE_KEYWORDS.some((keyword) => lowerSentence.includes(keyword))) {
      continue;
    }

    const instructionText = extractRelevantManualInstructionText(sentence);

    return {
      text: instructionText || sentence,
      url: null,
      emailAddresses: Array.from(new Set(
        Array.from((instructionText || sentence).matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi), (match) => String(match[0] ?? '').trim())
          .filter(Boolean),
      )),
    };
  }

  return null;
}

function extractUnsubscribeMetadata(parsedMessage) {
  const headers = parsedMessage?.headers;
  const headerLines = Array.isArray(parsedMessage?.headerLines) ? parsedMessage.headerLines : [];
  const normalizedHeaderText = headerLines
    .map((headerLine) => normalizeHeaderToken(headerLine?.line ?? headerLine?.value ?? ''))
    .filter(Boolean)
    .join(' ');
  const normalizedBodyText = normalizeWhitespace(parsedMessage?.text ?? '');
  const normalizedHtml = typeof parsedMessage?.html === 'string' ? parsedMessage.html : '';
  const bodyLink = extractUnsubscribeBodyLink(parsedMessage?.html);
  const listUnsubscribeValue = normalizeHeaderLookupValue(headers?.get?.('list-unsubscribe'))
    || extractHeaderLineValue(headerLines, 'list-unsubscribe');
  const listUnsubscribePostValue = normalizeHeaderLookupValue(headers?.get?.('list-unsubscribe-post'))
    || extractHeaderLineValue(headerLines, 'list-unsubscribe-post');
  const headerMethods = parseListUnsubscribeHeaderValue(listUnsubscribeValue);
  const normalizedPostValue = listUnsubscribePostValue.toLowerCase();
  const headerHasOneClick = normalizedPostValue.includes('list-unsubscribe=one-click');
  const headerMailtoMethod = headerMethods.find((entry) => entry?.type === 'mailto') ?? null;
  const headerUrlMethod = headerMethods.find((entry) => entry?.type === 'url') ?? null;
  const bodyUrlMethod = bodyLink?.method?.type === 'url'
    ? bodyLink.method
    : null;
  const actionableMethod = headerMailtoMethod
    ?? (headerHasOneClick ? headerUrlMethod : null)
    ?? bodyUrlMethod;
  const actionableHttpMethod = actionableMethod?.type === 'url' && headerHasOneClick
    ? 'POST'
    : 'GET';
  const actionableLink = actionableMethod?.value ?? null;
  const supportsAutomatedUnsubscribe = Boolean(actionableLink);
  const actionableFromHeaders = headerMethods.length > 0;
  const actionableFromBody = Boolean(bodyLink);
  const detectedFromHeaders = containsUnsubscribeKeyword(normalizedHeaderText) || actionableFromHeaders;
  const detectedFromBody = containsUnsubscribeKeyword(normalizedBodyText) || containsUnsubscribeKeyword(normalizedHtml) || actionableFromBody;
  const detected = detectedFromHeaders || detectedFromBody || supportsAutomatedUnsubscribe;
  const type = detected
    ? supportsAutomatedUnsubscribe ? 'actionable' : 'manual'
    : null;
  const manualInstruction = supportsAutomatedUnsubscribe || !detected
    ? null
    : findManualUnsubscribeInstruction(normalizedBodyText, normalizedHtml);
  const link = type === 'actionable'
    ? actionableLink
    : manualInstruction?.url ?? bodyLink?.url ?? headerUrlMethod?.value ?? headerMailtoMethod?.value ?? null;
  const hasLink = Boolean(link);

  return {
    unsubscribe: {
      detected,
      type,
      hasLink,
      link,
      manualInstructionText: manualInstruction?.text ?? null,
    },
    execution: supportsAutomatedUnsubscribe
      ? {
        httpMethod: actionableHttpMethod,
      }
      : null,
  };
}

export function buildExposedUnsubscribeMetadata(unsubscribe) {
  const normalizedUnsubscribe = unsubscribe && typeof unsubscribe === 'object'
    ? unsubscribe
    : null;
  const detected = Boolean(normalizedUnsubscribe?.detected);
  const normalizedType = normalizedUnsubscribe?.type === 'actionable' || normalizedUnsubscribe?.type === 'manual'
    ? normalizedUnsubscribe.type
    : null;

  return {
    detected,
    type: detected ? normalizedType : null,
    hasLink: Boolean(normalizedUnsubscribe?.hasLink),
    link: String(normalizedUnsubscribe?.link ?? '').trim() || null,
    manualInstructionText: String(normalizedUnsubscribe?.manualInstructionText ?? '').trim() || null,
  };
}

async function parseMessageSource(source) {
  const parsedMessage = await simpleParser(source);
  const subject = normalizeWhitespace(parsedMessage.subject ?? '');
  const text = String(parsedMessage.text ?? '').trim();
  const html = typeof parsedMessage.html === 'string' ? parsedMessage.html : '';
  const unsubscribeMetadata = extractUnsubscribeMetadata(parsedMessage);
  const normalizedBodyText = extractNormalizedMessageText({
    subject,
    text,
    html,
  });

  return {
    subject,
    text,
    html,
    from: normalizeSingleAddress(parsedMessage.from),
    replyTo: normalizeSingleAddress(parsedMessage.replyTo),
    to: normalizeAddressList(parsedMessage.to),
    cc: normalizeAddressList(parsedMessage.cc),
    bcc: normalizeAddressList(parsedMessage.bcc),
    inReplyTo: String(parsedMessage.inReplyTo ?? '').trim() || null,
    references: normalizeReferenceList(parsedMessage.references),
    normalizedBodyText,
    preview: buildPreview(normalizedBodyText),
    attachments: normalizeParsedAttachments(parsedMessage.attachments),
    unsubscribe: unsubscribeMetadata.unsubscribe,
    unsubscribeExecution: unsubscribeMetadata.execution,
  };
}

async function findImapMessageUidByMessageId(client, { folder = 'INBOX', messageId, scanLimit = 25 }) {
  const normalizedMessageId = String(messageId ?? '').trim();

  if (!normalizedMessageId) {
    return null;
  }

  const mailbox = await client.mailboxOpen(folder);
  const totalMessages = Number(mailbox?.exists ?? 0);
  const effectiveScanLimit = Math.max(1, Math.min(Number.parseInt(String(scanLimit ?? 25), 10) || 25, 50));
  const startSequence = Math.max(1, totalMessages - effectiveScanLimit + 1);
  const fetchedMessages = [];

  for await (const message of client.fetch(`${startSequence}:*`, {
    uid: true,
    envelope: true,
  })) {
    fetchedMessages.push(message);
  }

  for (const message of fetchedMessages.reverse()) {
    const currentMessageId = String(message?.envelope?.messageId ?? '').trim();

    if (currentMessageId && currentMessageId === normalizedMessageId) {
      return String(message.uid ?? '').trim() || null;
    }
  }

  return null;
}

export async function retrieveEmailsFromImap(accountConfig, filters = {}) {
  const folder = String(filters.folder ?? 'INBOX').trim() || 'INBOX';
  const limit = normalizeRetrievalLimit(filters.limit);
  const scanLimit = normalizeScanLimitOverride(filters.scanLimit) ?? REFRESH_RETRIEVAL_SCAN_LIMIT;
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
        ...buildPrimarySenderFields(message.envelope?.from),
        to: normalizeAddressList(message.envelope?.to),
        cc: normalizeAddressList(message.envelope?.cc),
        subject: parsedSource.subject || normalizeWhitespace(message.envelope?.subject ?? ''),
        receivedAt: normalizeReceivedAt(message.internalDate ?? message.envelope?.date ?? null),
        flags,
        preview: parsedSource.preview,
        bodyText: parsedSource.normalizedBodyText,
        attachments: parsedSource.attachments,
        unsubscribe: parsedSource.unsubscribe,
        unsubscribeExecution: parsedSource.unsubscribeExecution,
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
        from: parsedSource.from ?? buildPrimarySenderFields(message.envelope?.from).from,
        replyTo: parsedSource.replyTo?.address ?? null,
        to: parsedSource.to.length > 0 ? parsedSource.to : normalizeAddressList(message.envelope?.to),
        cc: parsedSource.cc.length > 0 ? parsedSource.cc : normalizeAddressList(message.envelope?.cc),
        bcc: parsedSource.bcc,
        subject: parsedSource.subject || normalizeWhitespace(message.envelope?.subject ?? ''),
        receivedAt: normalizeReceivedAt(message.internalDate ?? message.envelope?.date ?? null),
        flags: normalizeMessageFlags(message.flags),
        body: parsedSource.text,
        htmlBody: parsedSource.html || null,
        inReplyTo: parsedSource.inReplyTo,
        references: parsedSource.references,
        bodyText: parsedSource.normalizedBodyText,
        preview: parsedSource.preview,
        attachments: parsedSource.attachments,
        unsubscribe: parsedSource.unsubscribe,
        unsubscribeExecution: parsedSource.unsubscribeExecution,
      };
    }

    throw new Error(`Email message ${uid} was not found in folder ${folder}.`);
  });
}

export async function updateImapMessageFlags(accountConfig, { uid, uids, folder = 'INBOX', flags = [], mode = 'add' }) {
  return withImapClient(accountConfig, async (client) => {
    await client.mailboxOpen(folder);
    const normalizedFlags = Array.from(new Set((Array.isArray(flags) ? flags : []).map((flag) => String(flag ?? '').trim()).filter(Boolean)));
    const normalizedUids = Array.from(new Set((Array.isArray(uids) ? uids : [uid]).map((value) => String(value ?? '').trim()).filter(Boolean)));

    if (normalizedFlags.length === 0) {
      throw new Error('At least one IMAP flag is required.');
    }

    if (normalizedUids.length === 0) {
      throw new Error('At least one email uid is required.');
    }

    for (const normalizedUid of normalizedUids) {
      if (mode === 'remove') {
        await client.messageFlagsRemove(normalizedUid, normalizedFlags, { uid: true });
      } else {
        await client.messageFlagsAdd(normalizedUid, normalizedFlags, { uid: true });
      }
    }

    return {
      uids: normalizedUids,
      folder,
      mode: mode === 'remove' ? 'remove' : 'add',
      flags: normalizedFlags,
    };
  });
}

export async function deleteImapMessage(accountConfig, { uid, uids, folder = 'INBOX', expunge = false }) {
  return withImapClient(accountConfig, async (client) => {
    await client.mailboxOpen(folder);
    const normalizedUids = Array.from(new Set((Array.isArray(uids) ? uids : [uid]).map((value) => String(value ?? '').trim()).filter(Boolean)));

    if (normalizedUids.length === 0) {
      throw new Error('At least one email uid is required.');
    }

    if (!expunge) {
      const trashMailboxPath = resolveTrashMailboxPath(await client.list());

      if (!trashMailboxPath) {
        throw new Error('A Trash mailbox could not be found for this account.');
      }

      const movedMessages = [];

      for (const normalizedUid of normalizedUids) {
        const moveResult = await client.messageMove(normalizedUid, trashMailboxPath, { uid: true });
        const destinationUid = moveResult?.uidMap?.get(Number(normalizedUid));

        movedMessages.push({
          sourceUid: normalizedUid,
          destinationUid: Number.isFinite(destinationUid) ? String(destinationUid) : null,
        });
      }

      return {
        uids: normalizedUids,
        folder,
        destinationFolder: trashMailboxPath,
        movedMessages,
        expunge: false,
        deleted: true,
        movedToTrash: true,
      };
    }

    for (const normalizedUid of normalizedUids) {
      await client.messageFlagsAdd(normalizedUid, ['\\Deleted'], { uid: true });
      await client.messageDelete(normalizedUid, { uid: true });
    }

    return {
      uids: normalizedUids,
      folder,
      destinationFolder: null,
      movedMessages: normalizedUids.map((sourceUid) => ({ sourceUid, destinationUid: null })),
      expunge: Boolean(expunge),
      deleted: true,
      movedToTrash: false,
    };
  });
}

export async function sendEmailViaSmtp(accountConfig, message) {
  const normalizedDate = message?.date instanceof Date && !Number.isNaN(message.date.getTime())
    ? message.date
    : new Date();
  const mailOptions = {
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
    date: normalizedDate,
  };
  const transport = nodemailer.createTransport({
    host: accountConfig.smtp.host,
    port: accountConfig.smtp.port,
    secure: accountConfig.smtp.secure,
    auth: {
      user: accountConfig.smtp.user,
      pass: accountConfig.smtp.password,
    },
  });

  const info = await transport.sendMail(mailOptions);
  const sentMailboxResult = await withImapClient(accountConfig, async (client) => {
    const sentMailboxPath = resolveSentMailboxPath(await client.list());

    if (!sentMailboxPath) {
      return {
        savedToSent: false,
        sentMailboxPath: null,
        sentMailboxError: 'A Sent mailbox could not be found for this account.',
      };
    }

    const rawMessage = await new MailComposer({
      ...mailOptions,
      messageId: info.messageId ?? undefined,
    }).compile().build();

    const appendResult = await client.append(sentMailboxPath, rawMessage, ['\\Seen'], normalizedDate);

    return {
      savedToSent: appendResult !== false,
      sentMailboxPath,
      sentMailboxError: appendResult === false ? 'Appending the sent email to the Sent mailbox did not succeed.' : null,
    };
  }).catch((error) => ({
    savedToSent: false,
    sentMailboxPath: null,
    sentMailboxError: String(error?.message ?? 'Appending the sent email to the Sent mailbox failed.'),
  }));

  return {
    accepted: Array.isArray(info.accepted) ? info.accepted : [],
    rejected: Array.isArray(info.rejected) ? info.rejected : [],
    messageId: info.messageId ?? null,
    response: info.response ?? null,
    savedToSent: sentMailboxResult.savedToSent,
    sentMailboxPath: sentMailboxResult.sentMailboxPath,
    sentMailboxError: sentMailboxResult.sentMailboxError,
  };
}

export async function saveEmailDraft(accountConfig, message) {
  const normalizedDate = message?.date instanceof Date && !Number.isNaN(message.date.getTime())
    ? message.date
    : new Date();
  const messageId = String(message?.messageId ?? '').trim() || null;
  const mailOptions = {
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
    date: normalizedDate,
    messageId: messageId || undefined,
  };

  return withImapClient(accountConfig, async (client) => {
    const draftsMailboxPath = resolveDraftsMailboxPath(await client.list());

    if (!draftsMailboxPath) {
      throw new Error('A Drafts mailbox could not be found for this account.');
    }

    const rawMessage = await new MailComposer(mailOptions).compile().build();
    const appendResult = await client.append(draftsMailboxPath, rawMessage, ['\\Draft'], normalizedDate);

    if (appendResult === false) {
      throw new Error('Appending the email draft to the Drafts mailbox did not succeed.');
    }

    const draftUid = await findImapMessageUidByMessageId(client, {
      folder: draftsMailboxPath,
      messageId,
    });

    return {
      savedToDrafts: true,
      draftsMailboxPath,
      draftUid,
      draftMailboxError: null,
      messageId,
    };
  });
}

function decodeMailtoValue(value) {
  return decodeURIComponent(String(value ?? '').replace(/\+/g, ' '));
}

function parseMailtoAddressList(value) {
  return Array.from(new Set(
    String(value ?? '')
      .split(',')
      .map((entry) => normalizeHeaderToken(decodeMailtoValue(entry)))
      .filter(Boolean),
  ));
}

function parseMailtoUnsubscribeUrl(mailtoUrl) {
  const normalizedValue = String(mailtoUrl ?? '').trim();
  const withoutScheme = normalizedValue.slice('mailto:'.length);
  const queryIndex = withoutScheme.indexOf('?');
  const addressSegment = queryIndex >= 0 ? withoutScheme.slice(0, queryIndex) : withoutScheme;
  const querySegment = queryIndex >= 0 ? withoutScheme.slice(queryIndex + 1) : '';
  const searchParams = new URLSearchParams(querySegment);
  const to = parseMailtoAddressList(addressSegment);
  const cc = parseMailtoAddressList(searchParams.get('cc'));
  const bcc = parseMailtoAddressList(searchParams.get('bcc'));
  const subject = normalizeHeaderToken(decodeMailtoValue(searchParams.get('subject') ?? ''));
  const body = decodeMailtoValue(searchParams.get('body') ?? '').trim();

  return {
    to,
    cc,
    bcc,
    subject,
    body,
  };
}