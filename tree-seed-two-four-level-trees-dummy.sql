DECLARE @app_identifier NVARCHAR(100) = N'knowledge-app-dev';

DECLARE @tree_1_key NVARCHAR(100) = N'seed-tree-dummy-a';
DECLARE @tree_1_display_name NVARCHAR(200) = N'Seed Tree Dummy A';
DECLARE @tree_1_prefix NVARCHAR(100) = N'Tree A';

DECLARE @tree_2_key NVARCHAR(100) = N'seed-tree-dummy-b';
DECLARE @tree_2_display_name NVARCHAR(200) = N'Seed Tree Dummy B';
DECLARE @tree_2_prefix NVARCHAR(100) = N'Tree B';

IF OBJECT_ID('dbo.application_instance', 'U') IS NULL
BEGIN
  THROW 50100, 'The dbo.application_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_instance', 'U') IS NULL
BEGIN
  THROW 50101, 'The dbo.tree_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_setting', 'U') IS NULL
BEGIN
  THROW 50102, 'The dbo.tree_setting table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50103, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  THROW 50104, 'The dbo.tree_node_details table does not exist.', 1;
END;

IF OBJECT_ID('dbo.TR_tree_nodes_create_details_row', 'TR') IS NULL
BEGIN
  THROW 50105, 'The dbo.TR_tree_nodes_create_details_row trigger does not exist.', 1;
END;

DECLARE @application_instance_id INT;

SELECT @application_instance_id = ai.id
FROM dbo.application_instance ai
WHERE ai.app_identifier = @app_identifier;

IF @application_instance_id IS NULL
BEGIN
  THROW 50106, 'The supplied app_identifier was not found in dbo.application_instance.', 1;
END;

IF EXISTS (
  SELECT 1
  FROM dbo.tree_instance ti
  WHERE ti.application_instance_id = @application_instance_id
    AND ti.tree_key IN (@tree_1_key, @tree_2_key)
)
BEGIN
  THROW 50107, 'One or more target tree keys already exist for this application instance.', 1;
END;

DECLARE @trees_to_create TABLE (
  slot TINYINT NOT NULL PRIMARY KEY,
  tree_key NVARCHAR(100) NOT NULL,
  display_name NVARCHAR(200) NOT NULL,
  title_prefix NVARCHAR(100) NOT NULL
);

INSERT INTO @trees_to_create (slot, tree_key, display_name, title_prefix)
VALUES
  (1, @tree_1_key, @tree_1_display_name, @tree_1_prefix),
  (2, @tree_2_key, @tree_2_display_name, @tree_2_prefix);

DECLARE @created_trees TABLE (
  slot TINYINT NOT NULL PRIMARY KEY,
  tree_instance_id INT NOT NULL,
  tree_key NVARCHAR(100) NOT NULL,
  display_name NVARCHAR(200) NOT NULL,
  title_prefix NVARCHAR(100) NOT NULL
);

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @tree_slot TINYINT = 1;
  DECLARE @tree_key NVARCHAR(100);
  DECLARE @display_name NVARCHAR(200);
  DECLARE @title_prefix NVARCHAR(100);
  DECLARE @tree_instance_id INT;

  WHILE @tree_slot <= 2
  BEGIN
    SELECT
      @tree_key = tree_key,
      @display_name = display_name,
      @title_prefix = title_prefix
    FROM @trees_to_create
    WHERE slot = @tree_slot;

    INSERT INTO dbo.tree_instance (
      application_instance_id,
      tree_key,
      display_name,
      is_active
    )
    VALUES (
      @application_instance_id,
      @tree_key,
      @display_name,
      1
    );

    SET @tree_instance_id = CAST(SCOPE_IDENTITY() AS INT);

    INSERT INTO @created_trees (slot, tree_instance_id, tree_key, display_name, title_prefix)
    VALUES (@tree_slot, @tree_instance_id, @tree_key, @display_name, @title_prefix);

    INSERT INTO dbo.tree_setting (
      tree_instance_id,
      setting_key,
      setting_value
    )
    VALUES (
      @tree_instance_id,
      N'nodes.max_depth',
      N'3'
    );

    SET @tree_slot += 1;
  END;

  SET @tree_slot = 1;

  WHILE @tree_slot <= 2
  BEGIN
    DECLARE @root_index INT = 1;
    DECLARE @root_id INT;
    DECLARE @level_1_index INT;
    DECLARE @level_1_id INT;
    DECLARE @level_2_index INT;
    DECLARE @level_2_id INT;
    DECLARE @leaf_index INT;
    DECLARE @root_title NVARCHAR(255);
    DECLARE @level_1_title NVARCHAR(255);
    DECLARE @level_2_title NVARCHAR(255);
    DECLARE @leaf_title NVARCHAR(255);
    DECLARE @leaf_id INT;

    SELECT
      @tree_instance_id = tree_instance_id,
      @title_prefix = title_prefix
    FROM @created_trees
    WHERE slot = @tree_slot;

    WHILE @root_index <= 2
    BEGIN
      SET @root_title = CONCAT(@title_prefix, N' Header ', @root_index, N' Level 0');

      INSERT INTO dbo.tree_nodes (
        tree_instance_id,
        parent_id,
        text,
        is_leaf_node,
        is_expanded,
        draggable,
        sort_order
      )
      VALUES (
        @tree_instance_id,
        NULL,
        @root_title,
        0,
        1,
        1,
        @root_index - 1
      );

      SET @root_id = CAST(SCOPE_IDENTITY() AS INT);
      SET @level_1_index = 1;

      WHILE @level_1_index <= 2
      BEGIN
        SET @level_1_title = CONCAT(@title_prefix, N' Header ', @root_index, N'.', @level_1_index, N' Level 1');

        INSERT INTO dbo.tree_nodes (
          tree_instance_id,
          parent_id,
          text,
          is_leaf_node,
          is_expanded,
          draggable,
          sort_order
        )
        VALUES (
          @tree_instance_id,
          @root_id,
          @level_1_title,
          0,
          1,
          1,
          @level_1_index - 1
        );

        SET @level_1_id = CAST(SCOPE_IDENTITY() AS INT);
        SET @level_2_index = 1;

        WHILE @level_2_index <= 2
        BEGIN
          SET @level_2_title = CONCAT(@title_prefix, N' Header ', @root_index, N'.', @level_1_index, N'.', @level_2_index, N' Level 2');

          INSERT INTO dbo.tree_nodes (
            tree_instance_id,
            parent_id,
            text,
            is_leaf_node,
            is_expanded,
            draggable,
            sort_order
          )
          VALUES (
            @tree_instance_id,
            @level_1_id,
            @level_2_title,
            0,
            1,
            1,
            @level_2_index - 1
          );

          SET @level_2_id = CAST(SCOPE_IDENTITY() AS INT);
          SET @leaf_index = 1;

          WHILE @leaf_index <= 2
          BEGIN
            SET @leaf_title = CONCAT(
              @title_prefix,
              N' Header ',
              @root_index,
              N'.',
              @level_1_index,
              N'.',
              @level_2_index,
              N'.',
              @leaf_index,
              N' Level 3'
            );

            INSERT INTO dbo.tree_nodes (
              tree_instance_id,
              parent_id,
              text,
              is_leaf_node,
              is_expanded,
              draggable,
              sort_order
            )
            VALUES (
              @tree_instance_id,
              @level_2_id,
              @leaf_title,
              1,
              0,
              1,
              @leaf_index - 1
            );

            SET @leaf_id = CAST(SCOPE_IDENTITY() AS INT);

            UPDATE dbo.tree_node_details
            SET notes = CONCAT(
              N'Dummy notes for ',
              @leaf_title,
              CHAR(13),
              CHAR(10),
              N'Root: ',
              @root_title,
              CHAR(13),
              CHAR(10),
              N'Subheader: ',
              @level_1_title,
              CHAR(13),
              CHAR(10),
              N'Subsubheader: ',
              @level_2_title,
              CHAR(13),
              CHAR(10),
              N'Leaf header: ',
              @leaf_title,
              CHAR(13),
              CHAR(10),
              N'Tree slot: ',
              @tree_slot,
              N', branch: ',
              @root_index,
              N'.',
              @level_1_index,
              N'.',
              @level_2_index,
              N'.',
              @leaf_index
            )
            WHERE tree_node_id = @leaf_id;

            SET @leaf_index += 1;
          END;

          SET @level_2_index += 1;
        END;

        SET @level_1_index += 1;
      END;

      SET @root_index += 1;
    END;

    SET @tree_slot += 1;
  END;

  COMMIT TRANSACTION;
END TRY
BEGIN CATCH
  IF XACT_STATE() <> 0
  BEGIN
    ROLLBACK TRANSACTION;
  END;

  THROW;
END CATCH;

SELECT
  ct.tree_instance_id,
  ct.tree_key,
  ct.display_name
FROM @created_trees ct
ORDER BY ct.slot;

SELECT
  ts.tree_instance_id,
  ts.setting_key,
  ts.setting_value
FROM dbo.tree_setting ts
INNER JOIN @created_trees ct ON ct.tree_instance_id = ts.tree_instance_id
ORDER BY ts.tree_instance_id, ts.setting_key;

WITH RecursiveTree AS (
  SELECT
    tn.tree_instance_id,
    tn.id,
    tn.parent_id,
    tn.is_leaf_node,
    0 AS depth
  FROM dbo.tree_nodes tn
  INNER JOIN @created_trees ct ON ct.tree_instance_id = tn.tree_instance_id
  WHERE tn.parent_id IS NULL

  UNION ALL

  SELECT
    tn.tree_instance_id,
    tn.id,
    tn.parent_id,
    tn.is_leaf_node,
    rt.depth + 1 AS depth
  FROM dbo.tree_nodes tn
  INNER JOIN RecursiveTree rt ON rt.id = tn.parent_id
)
SELECT
  rt.tree_instance_id,
  COUNT(*) AS total_nodes,
  SUM(CASE WHEN rt.is_leaf_node = 1 THEN 1 ELSE 0 END) AS leaf_nodes,
  MAX(rt.depth) AS max_depth
FROM RecursiveTree rt
GROUP BY rt.tree_instance_id
ORDER BY rt.tree_instance_id;

SELECT
  tn.tree_instance_id,
  SUM(CASE WHEN tn.is_leaf_node = 1 THEN 1 ELSE 0 END) AS leaf_detail_rows,
  SUM(CASE WHEN tn.is_leaf_node = 0 THEN 1 ELSE 0 END) AS non_leaf_detail_rows
FROM dbo.tree_node_details tnd
INNER JOIN dbo.tree_nodes tn ON tn.id = tnd.tree_node_id
INNER JOIN @created_trees ct ON ct.tree_instance_id = tn.tree_instance_id
GROUP BY tn.tree_instance_id
ORDER BY tn.tree_instance_id;