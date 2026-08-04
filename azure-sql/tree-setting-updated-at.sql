IF OBJECT_ID('dbo.tree_setting', 'U') IS NULL
BEGIN
  THROW 50000, 'The dbo.tree_setting table does not exist.', 1;
END;

IF COL_LENGTH('dbo.tree_setting', 'updated_at') IS NULL
BEGIN
  ALTER TABLE dbo.tree_setting
  ADD updated_at DATETIME2(7) NOT NULL
    CONSTRAINT DF_tree_setting_updated_at DEFAULT SYSUTCDATETIME();
END;

DECLARE @primaryKeyJoin NVARCHAR(MAX);

SELECT @primaryKeyJoin = STRING_AGG(
  CONCAT('target.', QUOTENAME(column_name), ' = inserted.', QUOTENAME(column_name)),
  ' AND '
)
FROM (
  SELECT c.name AS column_name
  FROM sys.key_constraints kc
  INNER JOIN sys.index_columns ic
    ON ic.object_id = kc.parent_object_id
    AND ic.index_id = kc.unique_index_id
  INNER JOIN sys.columns c
    ON c.object_id = ic.object_id
    AND c.column_id = ic.column_id
  WHERE kc.parent_object_id = OBJECT_ID('dbo.tree_setting')
    AND kc.[type] = 'PK'
) primary_key_columns;

IF @primaryKeyJoin IS NULL OR LEN(@primaryKeyJoin) = 0
BEGIN
  THROW 50001, 'The dbo.tree_setting table must have a primary key before creating the updated_at trigger.', 1;
END;

IF OBJECT_ID('dbo.TR_tree_setting_set_updated_at', 'TR') IS NOT NULL
BEGIN
  DROP TRIGGER dbo.TR_tree_setting_set_updated_at;
END;

DECLARE @triggerSql NVARCHAR(MAX) = N'
CREATE TRIGGER dbo.TR_tree_setting_set_updated_at
ON dbo.tree_setting
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;

  UPDATE target
  SET updated_at = SYSUTCDATETIME()
  FROM dbo.tree_setting target
  INNER JOIN inserted ON ' + @primaryKeyJoin + N';
END;';

EXEC sp_executesql @triggerSql;