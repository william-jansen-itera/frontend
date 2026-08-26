IF OBJECT_ID('dbo.tree_instance', 'U') IS NULL
BEGIN
  THROW 50010, 'The dbo.tree_instance table does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_instance', 'is_private') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD is_private BIT NULL
  CONSTRAINT DF_tree_instance_is_private DEFAULT ((1));
END;

UPDATE dbo.tree_instance
SET is_private = 0
WHERE is_private IS NULL;

IF EXISTS (
  SELECT 1
  FROM sys.columns
  WHERE object_id = OBJECT_ID('dbo.tree_instance')
    AND name = 'is_private'
    AND is_nullable = 1
)
BEGIN
  ALTER TABLE dbo.tree_instance
  ALTER COLUMN is_private BIT NOT NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'owner_object_id') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD owner_object_id NVARCHAR(100) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'owner_user_details') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD owner_user_details NVARCHAR(320) NULL;
END;

IF COL_LENGTH('dbo.tree_instance', 'owner_display_name') IS NULL
BEGIN
  ALTER TABLE dbo.tree_instance
  ADD owner_display_name NVARCHAR(200) NULL;
END;