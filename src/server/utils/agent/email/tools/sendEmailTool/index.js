import { attachDebugToError } from '@/server/utils/agent/agentDebug';
import { buildEmailToolResult } from '@/server/utils/agent/email/emailToolShared';
import { loadEmailAccountConfig } from '@/server/utils/agent/email/emailAccountConfigRepository';
import { sendEmailViaSmtp } from '@/server/utils/agent/email/emailTransport';

export const SEND_EMAIL_TOOL = 'send_email';

export const sendEmailToolDefinition = {
  type: 'function',
  name: SEND_EMAIL_TOOL,
  description: 'Send an email using the configured SMTP account settings.',
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
      references: { type: 'array', items: { type: 'string' } },
      from: { type: ['string', 'null'] },
    },
    required: ['provider', 'to', 'cc', 'bcc', 'subject', 'body', 'htmlBody', 'replyTo', 'inReplyTo', 'references', 'from'],
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

      const { accountConfig } = await loadEmailAccountConfig({
        treeId: resolvedTreeId,
        provider: args.provider,
      });
      const output = await sendEmailViaSmtp(accountConfig, args);

      return buildEmailToolResult({
        toolName: SEND_EMAIL_TOOL,
        toolResultType: 'email_send',
        data: output,
        includeDebug,
        debug: includeDebug ? output : null,
      });
    } catch (error) {
      throw attachDebugToError(error, includeDebug ? args : null);
    }
  };
}