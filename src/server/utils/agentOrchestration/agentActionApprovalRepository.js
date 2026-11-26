import { randomUUID } from 'node:crypto';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

const APPROVAL_LIFETIME_MS = 5 * 60 * 1000;

function principalKey(principal) {
  const userId = String(principal?.userId ?? '').trim();
  const identityProvider = String(principal?.identityProvider ?? '').trim();
  const tenantId = principal?.claims?.find((claim) => claim?.typ === 'http://schemas.microsoft.com/identity/claims/tenantid')?.val ?? '';

  if (!userId || !identityProvider) {
    throw new Error('An authenticated user identity is required for approval.');
  }

  return `${identityProvider}:${tenantId}:${userId}`;
}

export async function createPendingAgentApproval({ principal, family, toolName, arguments: args, preview, continuation }) {
  const id = randomUUID();
  const expiresAt = new Date(Date.now() + APPROVAL_LIFETIME_MS);

  await withSqlConnection(async (pool) => pool.request()
    .input('id', sql.UniqueIdentifier, id)
    .input('application', sql.NVarChar(200), getRequiredApplicationIdentifier())
    .input('principal', sql.NVarChar(400), principalKey(principal))
    .input('family', sql.NVarChar(100), family)
    .input('tool', sql.NVarChar(100), toolName)
    .input('args', sql.NVarChar(sql.MAX), JSON.stringify(args))
    .input('preview', sql.NVarChar(sql.MAX), JSON.stringify(preview))
    .input('continuation', sql.NVarChar(sql.MAX), JSON.stringify(continuation))
    .input('expires', sql.DateTime2(3), expiresAt)
    .query(`INSERT INTO dbo.agent_action_approvals
      (id, application_identifier, principal_key, family, tool_name, arguments_json, preview_json, continuation_json, expires_at)
      VALUES (@id, @application, @principal, @family, @tool, @args, @preview, @continuation, @expires)`));

  return { id, toolName, preview, expiresAt: expiresAt.toISOString() };
}

export async function claimAgentApproval({ id, principal, decision }) {
  if (!['approve', 'cancel'].includes(decision) || !/^[0-9a-f-]{36}$/i.test(String(id ?? ''))) {
    return null;
  }

  const nextState = decision === 'approve' ? 'executing' : 'declined';
  const result = await withSqlConnection(async (pool) => pool.request()
    .input('id', sql.UniqueIdentifier, id)
    .input('application', sql.NVarChar(200), getRequiredApplicationIdentifier())
    .input('principal', sql.NVarChar(400), principalKey(principal))
    .input('state', sql.NVarChar(20), nextState)
    .query(`UPDATE dbo.agent_action_approvals
      SET state = @state, resolved_at = SYSUTCDATETIME()
      OUTPUT inserted.family, inserted.tool_name, inserted.arguments_json, inserted.preview_json, inserted.continuation_json
      WHERE id = @id AND application_identifier = @application AND principal_key = @principal
        AND state = 'pending' AND expires_at > SYSUTCDATETIME()`));
  const row = result.recordset[0];

  return row ? {
    family: row.family,
    toolName: row.tool_name,
    arguments: JSON.parse(row.arguments_json),
    preview: JSON.parse(row.preview_json),
    continuation: JSON.parse(row.continuation_json),
  } : null;
}

export async function finishAgentApproval({ id, outcome, failed = false }) {
  await withSqlConnection(async (pool) => pool.request()
    .input('id', sql.UniqueIdentifier, id)
    .input('application', sql.NVarChar(200), getRequiredApplicationIdentifier())
    .input('state', sql.NVarChar(20), failed ? 'failed' : 'completed')
    .input('outcome', sql.NVarChar(sql.MAX), JSON.stringify(outcome))
    .query(`UPDATE dbo.agent_action_approvals SET state = @state, outcome_json = @outcome, resolved_at = SYSUTCDATETIME()
      WHERE id = @id AND application_identifier = @application AND state = 'executing'`));
}