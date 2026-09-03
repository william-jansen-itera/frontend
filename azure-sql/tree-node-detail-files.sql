IF OBJECT_ID('dbo.tree_node_detail_files', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tree_node_detail_files (
    id INT IDENTITY(1,1) NOT NULL,
    tree_node_id INT NOT NULL,
    original_file_name NVARCHAR(260) NOT NULL,
    content_type NVARCHAR(200) NOT NULL,
    byte_size BIGINT NOT NULL,
    blob_name NVARCHAR(1024) NOT NULL,
    blob_url NVARCHAR(2048) NOT NULL,
    updated_by_object_id NVARCHAR(100) NULL,
    updated_by_user_details NVARCHAR(320) NULL,
    deleted_at DATETIME2(7) NULL,
    created_at DATETIME2(7) NOT NULL CONSTRAINT DF_tree_node_detail_files_created_at DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2(7) NOT NULL CONSTRAINT DF_tree_node_detail_files_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_tree_node_detail_files PRIMARY KEY CLUSTERED (id),
    CONSTRAINT FK_tree_node_detail_files_tree_node_details FOREIGN KEY (tree_node_id)
      REFERENCES dbo.tree_node_details (tree_node_id)
      ON DELETE CASCADE,
    CONSTRAINT UQ_tree_node_detail_files_blob_name UNIQUE (blob_name)
  );

  CREATE INDEX IX_tree_node_detail_files_tree_node_id_created_at
    ON dbo.tree_node_detail_files (tree_node_id, created_at DESC, id DESC);
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'updated_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files
  ADD updated_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'updated_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files
  ADD updated_by_user_details NVARCHAR(320) NULL;
END;

IF OBJECT_ID('dbo.TR_tree_node_detail_files_set_updated_at', 'TR') IS NULL
BEGIN
  EXEC('CREATE TRIGGER dbo.TR_tree_node_detail_files_set_updated_at
  ON dbo.tree_node_detail_files
  AFTER UPDATE
  AS
  BEGIN
    SET NOCOUNT ON;

    UPDATE files
    SET updated_at = SYSUTCDATETIME()
    FROM dbo.tree_node_detail_files files
    INNER JOIN inserted changed ON changed.id = files.id;
  END;');
END;