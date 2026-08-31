IF COL_LENGTH('dbo.tree_nodes', 'deleted_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_nodes
  ADD deleted_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'deleted_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD deleted_at DATETIME2(7) NULL;
END;

IF COL_LENGTH('dbo.tree_node_detail_files', 'deleted_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_detail_files
  ADD deleted_at DATETIME2(7) NULL;
END;