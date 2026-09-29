IF OBJECT_ID('dbo.agent_family_state', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.agent_family_state (
    application_identifier NVARCHAR(200) NOT NULL,
    family NVARCHAR(100) NOT NULL,
    is_active BIT NOT NULL CONSTRAINT DF_agent_family_state_is_active DEFAULT (1),
    reason NVARCHAR(500) NULL,
    updated_by_object_id NVARCHAR(100) NULL,
    updated_by_user_details NVARCHAR(320) NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_agent_family_state_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_agent_family_state_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_agent_family_state PRIMARY KEY CLUSTERED (application_identifier ASC, family ASC)
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.agent_family_state')
    AND name = 'IX_agent_family_state_application_active'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_agent_family_state_application_active
    ON dbo.agent_family_state (application_identifier ASC, is_active ASC, family ASC);
END;

IF OBJECT_ID('dbo.TR_agent_family_state_set_updated_at', 'TR') IS NOT NULL
BEGIN
  DROP TRIGGER dbo.TR_agent_family_state_set_updated_at;
END;

EXEC sp_executesql N'
CREATE TRIGGER dbo.TR_agent_family_state_set_updated_at
ON dbo.agent_family_state
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;

  UPDATE target
  SET updated_at = SYSUTCDATETIME()
  FROM dbo.agent_family_state target
  INNER JOIN inserted
    ON target.application_identifier = inserted.application_identifier
   AND target.family = inserted.family;
END;';