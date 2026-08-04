IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.tree_node_details (
    tree_node_id INT NOT NULL,
    notes NVARCHAR(MAX) NULL,
    created_at DATETIME2(7) NOT NULL CONSTRAINT DF_tree_node_details_created_at DEFAULT SYSUTCDATETIME(),
    updated_at DATETIME2(7) NOT NULL CONSTRAINT DF_tree_node_details_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_tree_node_details PRIMARY KEY CLUSTERED (tree_node_id),
    CONSTRAINT FK_tree_node_details_tree_nodes FOREIGN KEY (tree_node_id)
      REFERENCES dbo.tree_nodes (id)
      ON DELETE CASCADE
  );
END;

IF OBJECT_ID('dbo.TR_tree_node_details_set_updated_at', 'TR') IS NULL
BEGIN
  EXEC('CREATE TRIGGER dbo.TR_tree_node_details_set_updated_at
  ON dbo.tree_node_details
  AFTER UPDATE
  AS
  BEGIN
    SET NOCOUNT ON;

    UPDATE details
    SET updated_at = SYSUTCDATETIME()
    FROM dbo.tree_node_details details
    INNER JOIN inserted changed ON changed.tree_node_id = details.tree_node_id;
  END;');
END;

IF OBJECT_ID('dbo.TR_tree_node_details_require_leaf_nodes', 'TR') IS NOT NULL
BEGIN
  DROP TRIGGER dbo.TR_tree_node_details_require_leaf_nodes;
END;

EXEC('CREATE TRIGGER dbo.TR_tree_node_details_require_leaf_nodes
ON dbo.tree_node_details
AFTER INSERT, UPDATE
AS
BEGIN
  SET NOCOUNT ON;

  IF EXISTS (
    SELECT 1
    FROM inserted changed
    INNER JOIN dbo.tree_nodes nodes ON nodes.id = changed.tree_node_id
    WHERE nodes.is_leaf_node = 0
  )
  BEGIN
    THROW 50010, ''Only leaf nodes can have detail rows.'', 1;
  END;
END;');