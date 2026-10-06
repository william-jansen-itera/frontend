import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';

export const AUTHOR_EMAIL_TOOL = 'author_email';

export const authorEmailToolDefinition = {
  type: 'function',
  name: AUTHOR_EMAIL_TOOL,
  description: 'Prepare a structured email draft without sending it.',
  strict: true,
  parameters: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      to: { type: 'array', items: { type: 'string' } },
      cc: { type: 'array', items: { type: 'string' } },
      bcc: { type: 'array', items: { type: 'string' } },
      subject: { type: 'string' },
      body: { type: 'string' },
      htmlBody: { type: ['string', 'null'] },
      replyTo: { type: ['string', 'null'] },
      inReplyTo: { type: ['string', 'null'] },
    },
    required: ['provider', 'to', 'cc', 'bcc', 'subject', 'body', 'htmlBody', 'replyTo', 'inReplyTo'],
    additionalProperties: false,
  },
};

export function buildAuthorEmailHandler() {
  return async function authorEmailHandler(args) {
    return buildEmailToolResult({
      toolName: AUTHOR_EMAIL_TOOL,
      toolResultType: 'email_draft',
      data: {
        provider: args.provider,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body: args.body,
        htmlBody: args.htmlBody,
        replyTo: args.replyTo,
        inReplyTo: args.inReplyTo,
      },
    });
  };
}