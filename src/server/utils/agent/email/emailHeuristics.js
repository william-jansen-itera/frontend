function stripHtml(value) {
  return String(value ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

export function normalizeWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function extractNormalizedMessageText({ subject = '', text = '', html = '' }) {
  const normalizedText = normalizeWhitespace(text);
  const normalizedHtmlText = normalizeWhitespace(stripHtml(html));
  const body = normalizedText || normalizedHtmlText;

  return normalizeWhitespace([subject, body].filter(Boolean).join('\n\n'));
}

export function buildPreview(text, maxLength = 240) {
  const normalizedText = normalizeWhitespace(text);

  if (!normalizedText) {
    return '';
  }

  return normalizedText.length <= maxLength
    ? normalizedText
    : `${normalizedText.slice(0, maxLength - 1).trimEnd()}…`;
}

function splitSentences(text) {
  return normalizeWhitespace(text)
    .split(/(?<=[.!?])\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function summarizeEmailContent({ subject = '', bodyText = '' }) {
  const sentences = splitSentences(bodyText);
  const summaryText = sentences.slice(0, 2).join(' ');

  if (summaryText) {
    return summaryText;
  }

  return subject ? `Email regarding ${subject}.` : 'Email content available.';
}

const ACTION_PATTERNS = [
  /\bplease reply\b/i,
  /\blet me know\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bplease send\b/i,
  /\bneed you to\b/i,
  /\brespond\b/i,
  /\bconfirm\b/i,
];

export function extractActionItems(bodyText) {
  return splitSentences(bodyText)
    .filter((sentence) => ACTION_PATTERNS.some((pattern) => pattern.test(sentence)))
    .slice(0, 5);
}

const DEADLINE_PATTERNS = [
  /\bby\s+([A-Z][a-z]+day|tomorrow|today|\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?)\b/i,
  /\bbefore\s+([A-Z][a-z]+day|tomorrow|today|\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?)\b/i,
  /\bdeadline\s+is\s+([^.!?\n]+)/i,
  /\bdue\s+([^.!?\n]+)/i,
];

function normalizeDeadlineAt(matchText) {
  const normalizedValue = String(matchText ?? '').trim();

  if (!/^\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?$/.test(normalizedValue)) {
    return null;
  }

  const isoCandidate = normalizedValue.includes(' ')
    ? normalizedValue.replace(' ', 'T')
    : `${normalizedValue}T00:00:00`;
  const parsedDate = new Date(isoCandidate);

  return Number.isNaN(parsedDate.getTime()) ? null : parsedDate.toISOString();
}

export function extractDeadlines(bodyText) {
  const normalizedText = normalizeWhitespace(bodyText);
  const deadlines = [];

  for (const pattern of DEADLINE_PATTERNS) {
    const matches = normalizedText.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));

    for (const match of matches) {
      const deadlineText = normalizeWhitespace(match[0]);

      if (!deadlineText) {
        continue;
      }

      deadlines.push({
        text: deadlineText,
        deadlineAt: normalizeDeadlineAt(match[1] ?? deadlineText),
      });
    }
  }

  return deadlines.slice(0, 5);
}

export function classifyEmailContent({ subject = '', bodyText = '' }) {
  const normalizedText = normalizeWhitespace(`${subject}\n${bodyText}`);
  const actionItems = extractActionItems(normalizedText);
  const deadlines = extractDeadlines(normalizedText);
  const replyExpected = /\?|\bplease reply\b|\blet me know\b|\bcan you\b|\bcould you\b/i.test(normalizedText);
  const actionRequired = replyExpected || actionItems.length > 0;
  const importance = /\burgent\b|\basap\b|\bimmediately\b|\bimportant\b/i.test(normalizedText)
    ? 'high'
    : /\bfyi\b|\bnewsletter\b/i.test(normalizedText)
      ? 'low'
      : 'normal';
  const deadlineMentioned = deadlines.length > 0;
  const reasonParts = [];

  if (replyExpected) {
    reasonParts.push('The message contains a direct question or explicit request for a reply.');
  }

  if (deadlineMentioned) {
    reasonParts.push('The message includes time-bound language.');
  }

  if (!replyExpected && !deadlineMentioned && actionRequired) {
    reasonParts.push('The message contains action-oriented language.');
  }

  return {
    replyExpected,
    actionRequired,
    deadlineMentioned,
    deadlineText: deadlineMentioned ? deadlines[0].text : null,
    deadlineAt: deadlineMentioned ? deadlines[0].deadlineAt : null,
    importance,
    reason: reasonParts.join(' ').trim() || 'No strong reply, action, or deadline signal was detected.',
  };
}