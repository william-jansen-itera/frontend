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

const REPLY_PATTERNS = [
  // English
  /\b(please\s+)?(reply|respond)\b/i,
  /\bget back to (me|us)\b/i,
  /\blet (me|us) know\b/i,
  /\b(awaiting|waiting for) your (reply|response|feedback)\b/i,
  /\blooking forward to (your|hearing from you)\b/i,
  /\b(please\s+)?confirm\b/i,
  /\byour (feedback|thoughts|input)\b/i,
  /\b(if|that|hope|hoping|appreciate(?: it)? if) you (could|can|would) (reply|respond|confirm|let me know)\b/i,

  // Danish
  /\b(venligst\s+)?(svar|besvar|bekræft)\b/i,
  /\bvend(er)? (gerne )?tilbage til (mig|os)\b/i,
  /\b(lad|giv) (mig|os) (gerne )?(vide|besked)\b/i,
  /\b(afventer|venter på) (dit|jeres) (svar|tilbagemelding|feedback)\b/i,
  /\b(ser frem til|glæder mig til) (dit svar|at høre)\b/i,
  /\bhør(er)? gerne fra (dig|jer)\b/i,
  /\b(din|jeres|dine) (feedback|tilbagemelding)\b/i,
];

const OTHER_ACTION_PATTERNS = [
  // English
  /\b(can|could|would|will) you (please\s+)?/i,
  /\bwould you (mind|be able to)\b/i,
  /\b(please|kindly)\s+(send|provide|share|forward|review|approve|advise|schedule|book|sign|complete|submit|update|fill|attach)\b/i,
  /\b(i |we )?(need|ask) you to\b/i,
  /\b(if|that|hope|hoping|appreciate(?: it)? if) you (could|can|would)\b/i,
  /\baction required\b/i,
  /\b(rsvp|r\.s\.v\.p\.)\b/i,
  /\b(schedule|book|set up|arrange) (a |an )?(call|meeting|time|slot)\b/i,
  /\b(when|are you) available\b/i,
  /\bfind a time\b/i,
  /\bfor your (review|analysis|consideration|approval|attention|action|feedback|sign[- ]?off)\b/i,
  /\b(please\s+)?(review and )?(approve|sign off|weigh in)\b/i,
  /\byour approval\b/i,

  // Danish
  /\b(kan|kunne|vil|ville) du (venligst\s+)?/i,
  /\bbedes du\b/i,
  /\b(venligst|bedes)\s+(send|fremsend|vedhæft|gennemgå|godkend|oplys|book|planlæg|underskriv|udfyld|indsend|opdater)\b/i,
  /\b(har brug for|beder) (dig|jer) om\b/i,
  /\b(hvis|at|håber) du (kan|kunne|vil|ville)\b/i,
  /\bhandling (påkrævet|kræves|påkræves)\b/i,
  /\b(rsvp|tilmeld dig|bedes tilmelde)\b/i,
  /\b(book|planlæg|aftal) (et |en )?(møde|opkald|tidspunkt)\b/i,
  /\b(hvornår har du tid|er du ledig)\b/i,
  /\bfind et tidspunkt\b/i,
  /\btil (din |jeres )?(gennemgang|gennemsyn|analyse|overvejelse|godkendelse|opmærksomhed|handling|feedback|underskrift|kommentering)\b/i,
  /\b(gennemgå og )?godkend(e)?\b/i,
  /\b(din|jeres) godkendelse\b/i,
];

function matchesAnyPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function dedupeStringItems(items) {
  return Array.from(
    new Map(
      (Array.isArray(items) ? items : [])
        .map((item) => normalizeWhitespace(item))
        .filter(Boolean)
        .map((item) => [item.toLowerCase(), item]),
    ).values(),
  );
}

function dedupeDeadlineItems(items) {
  return Array.from(
    new Map(
      (Array.isArray(items) ? items : [])
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
          const text = normalizeWhitespace(item.text);

          return text
            ? [`${text.toLowerCase()}::${String(item.deadlineAt ?? '')}`, {
              text,
              deadlineAt: item.deadlineAt ?? null,
            }]
            : null;
        })
        .filter(Boolean),
    ).values(),
  );
}

export function extractReplyMatches(bodyText) {
  const normalizedText = normalizeWhitespace(bodyText);
  const matches = [];

  for (const pattern of REPLY_PATTERNS) {
    const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);

    for (const match of normalizedText.matchAll(globalPattern)) {
      const matchedText = normalizeWhitespace(match[0]);

      if (!matchedText) {
        continue;
      }

      matches.push(matchedText);
    }
  }

  return dedupeStringItems(matches).slice(0, 5);
}

export function extractActionItems(bodyText) {
  return dedupeStringItems(
    splitSentences(bodyText)
      .filter((sentence) => matchesAnyPattern(sentence, OTHER_ACTION_PATTERNS)),
  ).slice(0, 5);
}

const DEADLINE_PATTERNS = [
  // English — by / before a day, relative date, or calendar date
  /\b(by|before|no later than|at the latest)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|tonight|eod|end of (the )?(day|week)|cob|close of business|\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?|\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?)/i,
  /\bdeadline(\s+is|:)\s+([^.!?\n]+)/i,
  /\bdue(\s+date)?(\s+is|:)?\s+(?!to\b)([^.!?\n]+)/i,
  /\b(due|needed|required)\s+(by|before)\b/i,
  /\bwithin\s+\d+\s+(hours?|days?|weeks?)\b/i,
  /\b(asap|as soon as possible)\b/i,

  // Danish — senest / inden / frist
  /\b(senest|inden|ikke senere end)\s+(mandag|tirsdag|onsdag|torsdag|fredag|lørdag|søndag|i morgen|i dag|i aften|dagens udgang|fyraften|ugens udgang|\d{1,2}[./-]\d{1,2}([./-]\d{2,4})?|\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?)/i,
  /\b(deadline|frist)(\s+er|:)\s+([^.!?\n]+)/i,
  /\b(inden dagens udgang|senest i dag|inden fyraften|snarest muligt|hurtigst muligt)\b/i,
  /\binden\s+\d+\s+(timer|dage|uger)\b/i,
  /\bgyldig(?:t)?\s+i\s+\d+\s+(timer|dage|uger)\b/i,
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
  const deadlineItems = [];

  for (const pattern of DEADLINE_PATTERNS) {
    const matches = normalizedText.matchAll(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`));

    for (const match of matches) {
      const deadlineText = normalizeWhitespace(match[0]);

      if (!deadlineText) {
        continue;
      }

      deadlineItems.push({
        text: deadlineText,
        deadlineAt: normalizeDeadlineAt(match[1] ?? deadlineText),
      });
    }
  }

  return dedupeDeadlineItems(deadlineItems).slice(0, 5);
}

export function classifyEmailContent({ subject = '', bodyText = '' }) {
  const normalizedText = normalizeWhitespace(`${subject}\n${bodyText}`);
  const replyItems = extractReplyMatches(normalizedText);
  const questionAsked = /\?\s/.test(normalizedText);
  const actionItems = extractActionItems(normalizedText);
  const deadlineItems = extractDeadlines(normalizedText);
  const replyExpected = replyItems.length > 0;
  const otherActionRequired = actionItems.length > 0;
  const importance = /\burgent\b|\basap\b|\bimmediately\b|\bimportant\b/i.test(normalizedText)
    ? 'high'
    : /\bfyi\b|\bnewsletter\b/i.test(normalizedText)
      ? 'low'
      : 'normal';
  const deadlineMentioned = deadlineItems.length > 0;
  const reason = {
    replyExpected: replyExpected
      ? 'The message contains explicit request-for-reply language.'
      : null,
    questionAsked: questionAsked
      ? 'The message contains a question mark.'
      : null,
    otherActionRequired: otherActionRequired
      ? 'The message contains action-oriented language.'
      : null,
    deadlineMentioned: deadlineMentioned
      ? 'The message includes time-bound language.'
      : null,
    none: !replyExpected && !questionAsked && !otherActionRequired && !deadlineMentioned
      ? 'No strong reply, non-reply action, or deadline signal was detected.'
      : null,
  };

  return {
    replyExpected,
    questionAsked,
    otherActionRequired,
    deadlineMentioned,
    importance,
    reason,
  };
}

export function buildCachedEmailHeuristics({ subject = '', bodyText = '' }) {
  const normalizedText = normalizeWhitespace(`${subject}\n${bodyText}`);

  return {
    classification: classifyEmailContent({
      subject,
      bodyText,
    }),
    replyItems: extractReplyMatches(normalizedText),
    actionItems: extractActionItems(bodyText),
    deadlineItems: extractDeadlines(bodyText),
  };
}