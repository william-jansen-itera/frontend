IF OBJECT_ID(N'dbo.page_visit_counters', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.page_visit_counters (
    id INT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
    app_identifier NVARCHAR(128) NOT NULL,
    page_path NVARCHAR(32) NOT NULL,
    is_authenticated BIT NOT NULL,
    referrer_host NVARCHAR(255) NOT NULL,
    device_class NVARCHAR(32) NOT NULL,
    browser_family NVARCHAR(32) NOT NULL,
    visit_count BIGINT NOT NULL CONSTRAINT DF_page_visit_counters_visit_count DEFAULT (1),
    first_visited_at DATETIME2(7) NOT NULL CONSTRAINT DF_page_visit_counters_first_visited_at DEFAULT (SYSUTCDATETIME()),
    latest_visited_at DATETIME2(7) NOT NULL CONSTRAINT DF_page_visit_counters_latest_visited_at DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(7) NOT NULL CONSTRAINT DF_page_visit_counters_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT CK_page_visit_counters_referrer_host CHECK (LEN(referrer_host) > 0),
    CONSTRAINT CK_page_visit_counters_device_class CHECK (LEN(device_class) > 0),
    CONSTRAINT CK_page_visit_counters_browser_family CHECK (LEN(browser_family) > 0)
  );
END;

IF OBJECT_ID(N'dbo.page_visit_counters', N'U') IS NOT NULL
BEGIN
  IF EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID(N'dbo.page_visit_counters')
      AND name = N'CK_page_visit_counters_page_path'
  )
  BEGIN
    ALTER TABLE dbo.page_visit_counters DROP CONSTRAINT CK_page_visit_counters_page_path;
  END;

  ALTER TABLE dbo.page_visit_counters
    ADD CONSTRAINT CK_page_visit_counters_page_path
    CHECK (page_path IN (N'/', N'/about', N'/contact'));
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.page_visit_counters')
    AND name = N'UX_page_visit_counters_grouping'
)
BEGIN
  CREATE UNIQUE INDEX UX_page_visit_counters_grouping
    ON dbo.page_visit_counters (
      app_identifier,
      page_path,
      is_authenticated,
      referrer_host,
      device_class,
      browser_family
    );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID(N'dbo.page_visit_counters')
    AND name = N'IX_page_visit_counters_reporting'
)
BEGIN
  CREATE INDEX IX_page_visit_counters_reporting
    ON dbo.page_visit_counters (app_identifier, page_path, updated_at)
    INCLUDE (visit_count, latest_visited_at, is_authenticated, referrer_host, device_class, browser_family);
END;