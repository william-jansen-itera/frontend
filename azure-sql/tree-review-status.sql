IF OBJECT_ID('dbo.tree_instance', 'U') IS NULL
BEGIN
  THROW 50020, 'The dbo.tree_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50021, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_node_detail_files', 'U') IS NULL
BEGIN
  THROW 50022, 'The dbo.tree_node_detail_files table does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_instance', 'approval_enabled') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD approval_enabled BIT NOT NULL CONSTRAINT DF_tree_instance_approval_enabled DEFAULT ((0));
END;

IF COL_LENGTH('dbo.tree_instance', 'review_status') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD review_status NVARCHAR(20) NOT NULL CONSTRAINT DF_tree_instance_review_status DEFAULT (N'draft');
END;

IF COL_LENGTH('dbo.tree_instance', 'submitted_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD submitted_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'submitted_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD submitted_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'submitted_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD submitted_by_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'reviewed_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD reviewed_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'reviewed_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD reviewed_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'reviewed_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD reviewed_by_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'rejection_comment') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance ADD rejection_comment NVARCHAR(2000) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'review_status') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes
  ADD review_status NVARCHAR(20) NOT NULL CONSTRAINT DF_tree_nodes_review_status DEFAULT (N'draft');
END;

IF COL_LENGTH('dbo.tree_nodes', 'submitted_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD submitted_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'submitted_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD submitted_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'submitted_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD submitted_by_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'reviewed_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD reviewed_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'reviewed_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD reviewed_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'reviewed_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD reviewed_by_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_nodes', 'rejection_comment') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes ADD rejection_comment NVARCHAR(2000) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'review_status') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files
  ADD review_status NVARCHAR(20) NOT NULL CONSTRAINT DF_tree_node_detail_files_review_status DEFAULT (N'draft');
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'submitted_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD submitted_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'submitted_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD submitted_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'submitted_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD submitted_by_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'reviewed_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD reviewed_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'reviewed_by_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD reviewed_by_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'reviewed_by_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD reviewed_by_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'rejection_comment') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files ADD rejection_comment NVARCHAR(2000) NULL;
END;

EXEC sys.sp_executesql N'
UPDATE dbo.tree_instance
SET approval_enabled = COALESCE(approval_enabled, 0),
   review_status = COALESCE(NULLIF(review_status, N''''), N''draft'')
WHERE approval_enabled IS NULL
  OR review_status IS NULL
  OR LTRIM(RTRIM(review_status)) = N'''';
';

EXEC sys.sp_executesql N'
UPDATE dbo.tree_nodes
SET review_status = COALESCE(NULLIF(review_status, N''''), N''draft'')
WHERE review_status IS NULL
  OR LTRIM(RTRIM(review_status)) = N'''';
';

EXEC sys.sp_executesql N'
UPDATE dbo.tree_node_detail_files
SET review_status = COALESCE(NULLIF(review_status, N''''), N''draft'')
WHERE review_status IS NULL
  OR LTRIM(RTRIM(review_status)) = N'''';
';

IF NOT EXISTS (
  SELECT 1
  FROM sys.check_constraints
  WHERE parent_object_id = OBJECT_ID('dbo.tree_instance')
    AND name = 'CK_tree_instance_review_status'
)
BEGIN
  EXEC sys.sp_executesql N'
  ALTER TABLE dbo.tree_instance WITH CHECK ADD CONSTRAINT CK_tree_instance_review_status
    CHECK (review_status IN (N''draft'', N''submitted'', N''approved'', N''rejected''));
  ';
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.check_constraints
  WHERE parent_object_id = OBJECT_ID('dbo.tree_nodes')
    AND name = 'CK_tree_nodes_review_status'
)
BEGIN
  EXEC sys.sp_executesql N'
  ALTER TABLE dbo.tree_nodes WITH CHECK ADD CONSTRAINT CK_tree_nodes_review_status
    CHECK (review_status IN (N''draft'', N''submitted'', N''approved'', N''rejected''));
  ';
END;

IF NOT EXISTS (
  SELECT 1
  FROM sys.check_constraints
  WHERE parent_object_id = OBJECT_ID('dbo.tree_node_detail_files')
    AND name = 'CK_tree_node_detail_files_review_status'
)
BEGIN
  EXEC sys.sp_executesql N'
  ALTER TABLE dbo.tree_node_detail_files WITH CHECK ADD CONSTRAINT CK_tree_node_detail_files_review_status
    CHECK (review_status IN (N''draft'', N''submitted'', N''approved'', N''rejected''));
  ';
END;