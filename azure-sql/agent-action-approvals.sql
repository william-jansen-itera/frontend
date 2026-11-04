IF OBJECT_ID('dbo.agent_action_approvals', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_action_approvals (
    id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_agent_action_approvals PRIMARY KEY,
    application_identifier NVARCHAR(200) NOT NULL,
    principal_key NVARCHAR(400) NOT NULL,
    family NVARCHAR(100) NOT NULL,
    tool_name NVARCHAR(100) NOT NULL,
    arguments_json NVARCHAR(MAX) NOT NULL,
    preview_json NVARCHAR(MAX) NOT NULL,
    continuation_json NVARCHAR(MAX) NOT NULL,
    state NVARCHAR(20) NOT NULL CONSTRAINT DF_agent_action_approvals_state DEFAULT ('pending'),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_agent_action_approvals_created_at DEFAULT (SYSUTCDATETIME()),
    expires_at DATETIME2(3) NOT NULL,
    resolved_at DATETIME2(3) NULL,
    outcome_json NVARCHAR(MAX) NULL,
    CONSTRAINT CK_agent_action_approvals_state CHECK (state IN ('pending', 'executing', 'declined', 'completed', 'failed'))
  );
END;

IF NOT EXISTS (
  SELECT 1 FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.agent_action_approvals')
    AND name = 'IX_agent_action_approvals_principal_pending'
)
BEGIN
  CREATE INDEX IX_agent_action_approvals_principal_pending
    ON dbo.agent_action_approvals (application_identifier, principal_key, state, expires_at);
END;