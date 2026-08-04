DECLARE @tree_instance_id INT = 1;
DECLARE @generated_parent_prefix NVARCHAR(200) = N'Generated parent';

IF @tree_instance_id IS NULL
BEGIN
  THROW 50020, 'Set @tree_instance_id before running this script.', 1;
END;

IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50021, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_setting', 'U') IS NULL
BEGIN
  THROW 50022, 'The dbo.tree_setting table does not exist.', 1;
END;

DECLARE @max_depth INT;
DECLARE @current_max_depth INT;
DECLARE @root_count INT;

SELECT TOP 1 @max_depth = TRY_CAST(setting_value AS INT)
FROM dbo.tree_setting
WHERE tree_instance_id = @tree_instance_id
  AND setting_key = 'nodes.max_depth';

IF @max_depth IS NULL
BEGIN
  THROW 50023, 'No numeric nodes.max_depth setting was found for the supplied tree_instance_id.', 1;
END;

WITH RecursiveTree AS (
  SELECT
    id,
    parent_id,
    0 AS depth
  FROM dbo.tree_nodes
  WHERE tree_instance_id = @tree_instance_id
    AND parent_id IS NULL

  UNION ALL

  SELECT
    child.id,
    child.parent_id,
    parent.depth + 1 AS depth
  FROM dbo.tree_nodes child
  INNER JOIN RecursiveTree parent ON parent.id = child.parent_id
  WHERE child.tree_instance_id = @tree_instance_id
)
SELECT
  @current_max_depth = ISNULL(MAX(depth), -1),
  @root_count = SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END)
FROM RecursiveTree;

IF ISNULL(@root_count, 0) = 0
BEGIN
  THROW 50024, 'The supplied tree_instance_id does not have any root nodes to wrap.', 1;
END;

IF @current_max_depth > @max_depth
BEGIN
  THROW 50025, 'The current tree depth already exceeds nodes.max_depth.', 1;
END;

IF @current_max_depth = @max_depth
BEGIN
  PRINT CONCAT('Tree already matches nodes.max_depth (', @max_depth, '). No changes were applied.');
  RETURN;
END;

BEGIN TRY
  BEGIN TRANSACTION;

  WHILE @current_max_depth < @max_depth
  BEGIN
    DECLARE @current_roots TABLE (
      row_num INT IDENTITY(1, 1) PRIMARY KEY,
      root_id INT NOT NULL,
      root_text NVARCHAR(MAX) NULL,
      root_sort_order INT NOT NULL
    );

    INSERT INTO @current_roots (root_id, root_text, root_sort_order)
    SELECT
      id,
      text,
      sort_order
    FROM dbo.tree_nodes
    WHERE tree_instance_id = @tree_instance_id
      AND parent_id IS NULL
    ORDER BY sort_order, id;

    DECLARE @root_total INT = @@ROWCOUNT;
    DECLARE @row_num INT = 1;
    DECLARE @created_parent TABLE (id INT NOT NULL);

    WHILE @row_num <= @root_total
    BEGIN
      DECLARE @root_id INT;
      DECLARE @root_text NVARCHAR(MAX);
      DECLARE @root_sort_order INT;
      DECLARE @new_parent_id INT;

      SELECT
        @root_id = root_id,
        @root_text = root_text,
        @root_sort_order = root_sort_order
      FROM @current_roots
      WHERE row_num = @row_num;

      DELETE FROM @created_parent;

      INSERT INTO dbo.tree_nodes (
        tree_instance_id,
        parent_id,
        text,
        is_leaf_node,
        is_expanded,
        draggable,
        sort_order
      )
      OUTPUT INSERTED.id INTO @created_parent (id)
      VALUES (
        @tree_instance_id,
        NULL,
        CONCAT(@generated_parent_prefix, N' for ', COALESCE(NULLIF(@root_text, N''), CAST(@root_id AS NVARCHAR(20)))),
        0,
        1,
        1,
        @root_sort_order
      );

      SELECT TOP 1 @new_parent_id = id
      FROM @created_parent
      ORDER BY id DESC;

      IF @new_parent_id IS NULL
      BEGIN
        THROW 50026, 'Failed to capture the generated parent node id.', 1;
      END;

      UPDATE dbo.tree_nodes
      SET
        parent_id = @new_parent_id,
        sort_order = 0
      WHERE tree_instance_id = @tree_instance_id
        AND id = @root_id;

      SET @row_num += 1;
    END;

    SET @current_max_depth += 1;
  END;

  COMMIT TRANSACTION;

  PRINT CONCAT('Tree depth normalization complete. Tree ', @tree_instance_id, ' now reaches nodes.max_depth ', @max_depth, '.');
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
  BEGIN
    ROLLBACK TRANSACTION;
  END;

  THROW;
END CATCH;