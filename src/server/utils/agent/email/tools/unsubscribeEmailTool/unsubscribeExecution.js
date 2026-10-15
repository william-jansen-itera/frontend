import { normalizeWhitespace } from '@/server/utils/agent/email/emailHeuristics';
import { sendEmailViaSmtp } from '@/server/utils/agent/email/emailTransport';
import {
  MANUAL_UNSUBSCRIBE_KEYWORDS,
  UNSUBSCRIBE_BODY_LINK_LABELS,
} from '@/server/utils/agent/email/tools/unsubscribeEmailTool/unsubscribeDetectionConfig';

const MAX_UNSUBSCRIBE_RESPONSE_TEXT_CHARS = 2000;
const MAX_FORM_MATCHES = 5;
const MAX_BUTTON_MATCHES = 10;
const MAX_INPUT_MATCHES = 50;

function normalizeHeaderToken(value) {
  return String(value ?? '').trim();
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

function stripHtmlTagsForAnalysis(value) {
  const html = String(value ?? '');
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

function containsManualUnsubscribeKeyword(value) {
  const normalizedValue = String(value ?? '').toLowerCase();

  return MANUAL_UNSUBSCRIBE_KEYWORDS.some((keyword) => normalizedValue.includes(keyword));
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

function normalizeUnsubscribeResponseText(value) {
  return String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUnsubscribeResponseText(value, maxLength = MAX_UNSUBSCRIBE_RESPONSE_TEXT_CHARS) {
  const normalizedText = normalizeUnsubscribeResponseText(value);

  if (!normalizedText) {
    return null;
  }

  return normalizedText.slice(0, maxLength);
}

function buildCookieHeaderFromResponse(response) {
  const rawSetCookie = response?.headers?.get?.('set-cookie');

  if (!rawSetCookie) {
    return '';
  }

  return rawSetCookie
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map((entry) => String(entry ?? '').split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function extractHtmlTagMatches(html, tagName, maxMatches = MAX_BUTTON_MATCHES) {
  const normalizedTagName = String(tagName ?? '').trim();

  if (!normalizedTagName) {
    return [];
  }

  const pattern = new RegExp(`<${normalizedTagName}\\b([^>]*)>([\\s\\S]*?)<\\/${normalizedTagName}>`, 'gi');
  const matches = [];
  let match = pattern.exec(String(html ?? ''));

  while (match && matches.length < maxMatches) {
    matches.push({
      attributes: String(match[1] ?? ''),
      bodyContent: String(match[2] ?? ''),
    });
    match = pattern.exec(String(html ?? ''));
  }

  return matches;
}

function extractHtmlSelfClosingTagAttributes(html, tagName, maxMatches = MAX_INPUT_MATCHES) {
  const normalizedTagName = String(tagName ?? '').trim();

  if (!normalizedTagName) {
    return [];
  }

  const pattern = new RegExp(`<${normalizedTagName}\\b([^>]*)>`, 'gi');
  const matches = [];
  let match = pattern.exec(String(html ?? ''));

  while (match && matches.length < maxMatches) {
    matches.push(String(match[1] ?? ''));
    match = pattern.exec(String(html ?? ''));
  }

  return matches;
}

function normalizeFormControlLabel(value) {
  return normalizeWhitespace(decodeBasicHtmlEntities(stripHtmlTagsForAnalysis(value))).toLowerCase();
}

function resolveAbsoluteUrl(value, baseUrl) {
  const normalizedValue = normalizeHeaderToken(value);

  if (!normalizedValue) {
    return normalizeHeaderToken(baseUrl);
  }

  try {
    return new URL(normalizedValue, baseUrl).toString();
  } catch {
    return normalizedValue;
  }
}

function extractConfirmationFormFields(formHtml) {
  const inputAttributes = extractHtmlSelfClosingTagAttributes(formHtml, 'input', MAX_INPUT_MATCHES);
  const fields = [];
  let requiresUserInput = false;

  for (const attributes of inputAttributes) {
    const type = normalizeHeaderToken(extractHtmlAttributeValue(attributes, 'type')).toLowerCase() || 'text';
    const name = normalizeHeaderToken(extractHtmlAttributeValue(attributes, 'name'));
    const value = decodeBasicHtmlEntities(extractHtmlAttributeValue(attributes, 'value'));
    const checked = /\bchecked\b/i.test(attributes);

    if (!name) {
      continue;
    }

    if (type === 'hidden') {
      fields.push([name, value]);
      continue;
    }

    if (type === 'submit') {
      fields.push([name, value]);
      continue;
    }

    if ((type === 'checkbox' || type === 'radio') && checked) {
      fields.push([name, value || 'on']);
      continue;
    }

    requiresUserInput = true;
  }

  if (/<textarea\b|<select\b/i.test(formHtml)) {
    requiresUserInput = true;
  }

  return {
    fields,
    requiresUserInput,
  };
}

function extractUnsubscribeConfirmationForm(html, baseUrl) {
  const forms = extractHtmlTagMatches(html, 'form', MAX_FORM_MATCHES);

  for (const form of forms) {
    const formAttributes = String(form.attributes ?? '');
    const formBody = String(form.bodyContent ?? '');
    const formText = normalizeFormControlLabel(formBody);
    const buttonMatches = extractHtmlTagMatches(formBody, 'button', MAX_BUTTON_MATCHES);
    const submitInputAttributes = extractHtmlSelfClosingTagAttributes(formBody, 'input', 25)
      .filter((attributes) => normalizeHeaderToken(extractHtmlAttributeValue(attributes, 'type')).toLowerCase() === 'submit');
    const buttonLabels = [
      ...buttonMatches.map((match) => normalizeFormControlLabel(match.bodyContent)),
      ...submitInputAttributes.map((attributes) => normalizeFormControlLabel(extractHtmlAttributeValue(attributes, 'value'))),
    ].filter(Boolean);
    const hasUnsubscribeButton = buttonLabels.some((label) => containsManualUnsubscribeKeyword(label) || UNSUBSCRIBE_BODY_LINK_LABELS.has(label));
    const looksLikeUnsubscribeForm = containsManualUnsubscribeKeyword(formText) || hasUnsubscribeButton;

    if (!looksLikeUnsubscribeForm || !hasUnsubscribeButton) {
      continue;
    }

    const { fields, requiresUserInput } = extractConfirmationFormFields(formBody);

    if (requiresUserInput) {
      continue;
    }

    const actionValue = extractHtmlAttributeValue(formAttributes, 'action');
    const methodValue = normalizeHeaderToken(extractHtmlAttributeValue(formAttributes, 'method')).toUpperCase();

    return {
      actionUrl: resolveAbsoluteUrl(actionValue, baseUrl),
      method: methodValue === 'POST' ? 'POST' : 'GET',
      fields,
    };
  }

  return null;
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

export async function unsubscribeViaMetadata(accountConfig, unsubscribe, execution = null) {
  const normalizedUrl = String(unsubscribe?.link ?? '').trim();

  if (!normalizedUrl) {
    throw new Error('This email does not have an actionable unsubscribe URL.');
  }

  const lowerUrl = normalizedUrl.toLowerCase();
  const unsubscribeExecution = execution && typeof execution === 'object'
    ? execution
    : null;

  if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
    const method = unsubscribeExecution?.httpMethod === 'POST' ? 'POST' : 'GET';
    const response = await fetch(normalizedUrl, {
      method,
      redirect: 'follow',
      headers: method === 'POST'
        ? {
          'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
          'List-Unsubscribe': 'One-Click',
        }
        : undefined,
      body: method === 'POST' ? '' : undefined,
    });

    if (!response.ok) {
      throw new Error(`Unsubscribe request failed with HTTP ${response.status}.`);
    }

    const responseBody = await response.text();
    const responseText = extractUnsubscribeResponseText(responseBody);
    const confirmationForm = extractUnsubscribeConfirmationForm(responseBody, response.url || normalizedUrl);

    if (confirmationForm) {
      const searchParams = new URLSearchParams();

      for (const [name, value] of confirmationForm.fields) {
        searchParams.append(name, value);
      }

      const cookieHeader = buildCookieHeaderFromResponse(response);
      const followUpResponse = await fetch(
        confirmationForm.method === 'GET'
          ? `${confirmationForm.actionUrl}${confirmationForm.actionUrl.includes('?') ? '&' : '?'}${searchParams.toString()}`
          : confirmationForm.actionUrl,
        {
          method: confirmationForm.method,
          redirect: 'follow',
          headers: {
            ...(confirmationForm.method === 'POST'
              ? { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' }
              : {}),
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: confirmationForm.method === 'POST' ? searchParams.toString() : undefined,
        },
      );

      if (!followUpResponse.ok) {
        throw new Error(`Unsubscribe confirmation request failed with HTTP ${followUpResponse.status}.`);
      }

      const followUpBody = await followUpResponse.text();

      return {
        actionType: 'http_request',
        method,
        url: normalizedUrl,
        finalUrl: followUpResponse.url || confirmationForm.actionUrl,
        status: followUpResponse.status,
        ok: followUpResponse.ok,
        responseText: extractUnsubscribeResponseText(followUpBody),
        followUpAction: {
          method: confirmationForm.method,
          url: confirmationForm.actionUrl,
        },
      };
    }

    return {
      actionType: 'http_request',
      method,
      url: normalizedUrl,
      finalUrl: response.url || normalizedUrl,
      status: response.status,
      ok: response.ok,
      responseText,
    };
  }

  if (lowerUrl.startsWith('mailto:')) {
    const mailtoMessage = parseMailtoUnsubscribeUrl(normalizedUrl);

    if (mailtoMessage.to.length === 0) {
      throw new Error('This email does not have a usable mailto unsubscribe recipient.');
    }

    const emailResult = await sendEmailViaSmtp(accountConfig, {
      to: mailtoMessage.to,
      cc: mailtoMessage.cc,
      bcc: mailtoMessage.bcc,
      subject: mailtoMessage.subject || 'Unsubscribe',
      body: mailtoMessage.body || 'Please unsubscribe me from this mailing list.',
      htmlBody: null,
      replyTo: null,
      inReplyTo: null,
      references: [],
      from: null,
    });

    return {
      actionType: 'email_send',
      method: 'MAILTO',
      url: normalizedUrl,
      accepted: emailResult.accepted,
      rejected: emailResult.rejected,
      messageId: emailResult.messageId,
      response: emailResult.response,
      responseText: emailResult.response ?? null,
      to: mailtoMessage.to,
      cc: mailtoMessage.cc,
      bcc: mailtoMessage.bcc,
      subject: mailtoMessage.subject || 'Unsubscribe',
    };
  }

  throw new Error('This unsubscribe link uses an unsupported protocol.');
}