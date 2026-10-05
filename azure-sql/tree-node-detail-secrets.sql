IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  THROW 50020, 'The dbo.tree_node_details table does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_node_details', 'is_secret') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_details
  ADD is_secret BIT NOT NULL CONSTRAINT DF_tree_node_details_is_secret DEFAULT ((0));
END;

IF COL_LENGTH('dbo.tree_node_details', 'secret_metadata') IS NULL
BEGIN
  ALTER TABLE dbo.tree_node_details
  ADD secret_metadata NVARCHAR(MAX) NULL;
END;