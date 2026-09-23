IF OBJECT_ID('dbo.contact_requests', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.contact_requests (
    id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
    app_identifier NVARCHAR(128) NOT NULL,
    contact_profile NVARCHAR(20) NOT NULL,
    name NVARCHAR(200) NOT NULL,
    company NVARCHAR(200) NULL,
    email NVARCHAR(320) NOT NULL,
    phone NVARCHAR(64) NULL,
    wants_call BIT NOT NULL CONSTRAINT DF_contact_requests_wants_call DEFAULT (0),
    message NVARCHAR(4000) NOT NULL,
    user_agent NVARCHAR(1000) NULL,
    created_at DATETIME2(7) NOT NULL CONSTRAINT DF_contact_requests_created_at DEFAULT (SYSUTCDATETIME())
  );

  CREATE INDEX IX_contact_requests_app_identifier_created_at
    ON dbo.contact_requests (app_identifier, created_at);
END;