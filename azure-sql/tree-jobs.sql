IF OBJECT_ID(N'dbo.tree_jobs', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.tree_jobs (
    id UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_tree_jobs PRIMARY KEY,
    application_instance_id INT NOT NULL REFERENCES dbo.application_instance(id),
    tree_instance_id INT NOT NULL CONSTRAINT FK_tree_jobs_tree
      REFERENCES dbo.tree_instance(id) ON DELETE CASCADE,
    job_type NVARCHAR(50) NOT NULL,
    input_payload NVARCHAR(MAX) NOT NULL CONSTRAINT CK_tree_jobs_input CHECK (ISJSON(input_payload) = 1),
    result_payload NVARCHAR(MAX) NULL CONSTRAINT CK_tree_jobs_result CHECK (result_payload IS NULL OR ISJSON(result_payload) = 1),
    requested_by_object_id NVARCHAR(100) NULL,
    status NVARCHAR(20) NOT NULL CONSTRAINT CK_tree_jobs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    attempts INT NOT NULL CONSTRAINT DF_tree_jobs_attempts DEFAULT 0,
    attempt_token UNIQUEIDENTIFIER NULL,
    lease_until DATETIME2(7) NULL,
    created_at DATETIME2(7) NOT NULL CONSTRAINT DF_tree_jobs_created DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2(7) NOT NULL CONSTRAINT DF_tree_jobs_updated DEFAULT SYSUTCDATETIME(),
    finished_at DATETIME2(7) NULL,
    failure_summary NVARCHAR(500) NULL
  );

  CREATE UNIQUE INDEX UX_tree_jobs_active
    ON dbo.tree_jobs(application_instance_id, tree_instance_id)
    WHERE status IN ('queued', 'running');

  CREATE INDEX IX_tree_jobs_tree
    ON dbo.tree_jobs(application_instance_id, tree_instance_id, created_at DESC);

  CREATE INDEX IX_tree_jobs_recovery
    ON dbo.tree_jobs(status, lease_until, updated_at);
END;