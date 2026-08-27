IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50000, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.TR_tree_nodes_set_updated_at', 'TR') IS NOT NULL
BEGIN
  DROP TRIGGER dbo.TR_tree_nodes_set_updated_at;
END;

EXEC('CREATE TRIGGER dbo.TR_tree_nodes_set_updated_at
ON dbo.tree_nodes
AFTER UPDATE
AS
BEGIN
  SET NOCOUNT ON;

  DECLARE @now DATETIME2(7) = SYSUTCDATETIME();

  WITH ChangedPathNodes AS (
    SELECT i.id
    FROM inserted i
    INNER JOIN deleted d ON d.id = i.id
    WHERE ISNULL(i.[text], N'''') <> ISNULL(d.[text], N'''')
       OR ISNULL(i.parent_id, -1) <> ISNULL(d.parent_id, -1)
       OR ISNULL(i.sort_order, -2147483648) <> ISNULL(d.sort_order, -2147483648)
  ),
  Descendants AS (
    SELECT id
    FROM ChangedPathNodes

    UNION ALL

    SELECT child.id
    FROM dbo.tree_nodes child
    INNER JOIN Descendants parent_descendant ON child.parent_id = parent_descendant.id
  )
  UPDATE tn
  SET updated_at = @now
  FROM dbo.tree_nodes tn
  WHERE tn.id IN (
    SELECT i.id FROM inserted i
    UNION
    SELECT d.id FROM Descendants d
  );
END;');