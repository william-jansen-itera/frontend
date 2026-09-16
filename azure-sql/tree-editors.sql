IF OBJECT_ID('dbo.tree_instance', 'U') IS NULL
BEGIN
  THROW 50010, 'The dbo.tree_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_editors', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tree_editors (
    id INT IDENTITY(1,1) NOT NULL,
    tree_instance_id INT NOT NULL,
    editor_object_id NVARCHAR(100) NOT NULL,
    editor_user_details NVARCHAR(320) NULL,
    editor_display_name NVARCHAR(200) NULL,
    deleted_at DATETIME2(7) NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_tree_editors_created_at DEFAULT (SYSUTCDATETIME()),
    updated_at DATETIME2(0) NOT NULL CONSTRAINT DF_tree_editors_updated_at DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_tree_editors PRIMARY KEY CLUSTERED (id ASC),
    CONSTRAINT FK_tree_editors_tree_instance FOREIGN KEY (tree_instance_id)
      REFERENCES dbo.tree_instance (id)
      ON DELETE CASCADE
  );
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.tree_editors')
    AND name = 'UQ_tree_editors_tree_editor_active'
)
BEGIN
  CREATE UNIQUE NONCLUSTERED INDEX UQ_tree_editors_tree_editor_active
    ON dbo.tree_editors (tree_instance_id ASC, editor_object_id ASC)
    WHERE deleted_at IS NULL;
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.indexes
  WHERE object_id = OBJECT_ID('dbo.tree_editors')
    AND name = 'IX_tree_editors_tree_instance_active'
)
BEGIN
  CREATE NONCLUSTERED INDEX IX_tree_editors_tree_instance_active
    ON dbo.tree_editors (tree_instance_id ASC, editor_display_name ASC, editor_user_details ASC)
    WHERE deleted_at IS NULL;
END;