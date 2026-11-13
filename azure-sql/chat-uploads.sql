IF OBJECT_ID(N'dbo.chat_uploads', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.chat_uploads (
    id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_chat_uploads PRIMARY KEY,
    application_instance_id INT NOT NULL REFERENCES dbo.application_instance(id),
    owner_object_id NVARCHAR(100) NOT NULL,
    file_name NVARCHAR(255) NOT NULL,
    content_type NVARCHAR(255) NOT NULL,
    byte_size INT NOT NULL,
    sha256 CHAR(64) NOT NULL,
    blob_name NVARCHAR(512) NOT NULL,
    status NVARCHAR(20) NOT NULL CONSTRAINT CK_chat_uploads_status
      CHECK (status IN ('staged', 'queued', 'running', 'succeeded', 'failed', 'purging')),
    note NVARCHAR(1000) NULL,
    caption NVARCHAR(2000) NULL,
    failure_summary NVARCHAR(500) NULL,
    attempts INT NOT NULL CONSTRAINT DF_chat_uploads_attempts DEFAULT 0,
    attempt_token UNIQUEIDENTIFIER NULL,
    lease_until DATETIME2(7) NULL,
    created_at DATETIME2(7) NOT NULL,
    expires_at DATETIME2(7) NOT NULL,
    updated_at DATETIME2(7) NOT NULL CONSTRAINT DF_chat_uploads_updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_chat_uploads_size CHECK (byte_size BETWEEN 1 AND 10485760),
    CONSTRAINT CK_chat_uploads_expiry CHECK (expires_at > created_at)
  );

  CREATE INDEX IX_chat_uploads_owner
    ON dbo.chat_uploads(application_instance_id, owner_object_id, created_at DESC);
  CREATE INDEX IX_chat_uploads_expiry ON dbo.chat_uploads(expires_at, status);
  CREATE INDEX IX_chat_uploads_recovery ON dbo.chat_uploads(status, lease_until);
END;

IF COL_LENGTH('dbo.chat_uploads', 'caption') IS NULL
BEGIN
  ALTER TABLE dbo.chat_uploads ADD caption NVARCHAR(2000) NULL;
END;

IF COL_LENGTH('dbo.chat_uploads', 'original_human_message') IS NULL
BEGIN
  ALTER TABLE dbo.chat_uploads ADD original_human_message NVARCHAR(MAX) NULL;
END;