IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50000, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  THROW 50001, 'The dbo.tree_node_details table does not exist.', 1;
END;

INSERT INTO dbo.tree_node_details (tree_node_id, notes, created_at, updated_at)
SELECT
  tn.id,
  '',
  SYSUTCDATETIME(),
  SYSUTCDATETIME()
FROM dbo.tree_nodes tn
LEFT JOIN dbo.tree_node_details tnd ON tnd.tree_node_id = tn.id
WHERE tnd.tree_node_id IS NULL
  AND tn.is_leaf_node = 1;

IF OBJECT_ID('dbo.TR_tree_nodes_create_details_row', 'TR') IS NOT NULL
BEGIN
  DROP TRIGGER dbo.TR_tree_nodes_create_details_row;
END;

EXEC('CREATE TRIGGER dbo.TR_tree_nodes_create_details_row
ON dbo.tree_nodes
AFTER INSERT
AS
BEGIN
  SET NOCOUNT ON;

  INSERT INTO dbo.tree_node_details (tree_node_id, notes, created_at, updated_at)
  SELECT
    inserted.id,
    '''',
    SYSUTCDATETIME(),
    SYSUTCDATETIME()
  FROM inserted
  LEFT JOIN dbo.tree_node_details existing_details ON existing_details.tree_node_id = inserted.id
  WHERE existing_details.tree_node_id IS NULL
    AND inserted.is_leaf_node = 1;
END;');