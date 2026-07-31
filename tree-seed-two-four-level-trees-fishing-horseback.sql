DECLARE @app_identifier NVARCHAR(100) = N'knowledge-app-dev';

DECLARE @tree_1_key NVARCHAR(100) = N'fishing-basics-guide';
DECLARE @tree_1_display_name NVARCHAR(200) = N'Fishing Basics Guide';

DECLARE @tree_2_key NVARCHAR(100) = N'horseback-riding-basics';
DECLARE @tree_2_display_name NVARCHAR(200) = N'Horseback Riding Basics';

IF OBJECT_ID('dbo.application_instance', 'U') IS NULL
BEGIN
  THROW 50300, 'The dbo.application_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_instance', 'U') IS NULL
BEGIN
  THROW 50301, 'The dbo.tree_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_setting', 'U') IS NULL
BEGIN
  THROW 50302, 'The dbo.tree_setting table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50303, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  THROW 50304, 'The dbo.tree_node_details table does not exist.', 1;
END;

IF OBJECT_ID('dbo.TR_tree_nodes_create_details_row', 'TR') IS NULL
BEGIN
  THROW 50305, 'The dbo.TR_tree_nodes_create_details_row trigger does not exist.', 1;
END;

DECLARE @application_instance_id INT;

SELECT @application_instance_id = ai.id
FROM dbo.application_instance ai
WHERE ai.app_identifier = @app_identifier;

IF @application_instance_id IS NULL
BEGIN
  THROW 50306, 'The supplied app_identifier was not found in dbo.application_instance.', 1;
END;

IF EXISTS (
  SELECT 1
  FROM dbo.tree_instance ti
  WHERE ti.application_instance_id = @application_instance_id
    AND ti.tree_key IN (@tree_1_key, @tree_2_key)
)
BEGIN
  THROW 50307, 'One or more target tree keys already exist for this application instance.', 1;
END;

DECLARE @trees_to_create TABLE (
  slot TINYINT NOT NULL PRIMARY KEY,
  tree_key NVARCHAR(100) NOT NULL,
  display_name NVARCHAR(200) NOT NULL
);

INSERT INTO @trees_to_create (slot, tree_key, display_name)
VALUES
  (1, @tree_1_key, @tree_1_display_name),
  (2, @tree_2_key, @tree_2_display_name);

DECLARE @root_content TABLE (
  tree_slot TINYINT NOT NULL,
  root_index INT NOT NULL,
  title NVARCHAR(255) NOT NULL,
  PRIMARY KEY (tree_slot, root_index)
);

INSERT INTO @root_content (tree_slot, root_index, title)
VALUES
  (1, 1, N'Equipment'),
  (1, 2, N'Fishing Methods'),
  (2, 1, N'Rider Preparation'),
  (2, 2, N'Handling The Horse');

DECLARE @level_1_content TABLE (
  tree_slot TINYINT NOT NULL,
  root_index INT NOT NULL,
  level_1_index INT NOT NULL,
  title NVARCHAR(255) NOT NULL,
  PRIMARY KEY (tree_slot, root_index, level_1_index)
);

INSERT INTO @level_1_content (tree_slot, root_index, level_1_index, title)
VALUES
  (1, 1, 1, N'Rods And Reels'),
  (1, 1, 2, N'Line And Tackle'),
  (1, 2, 1, N'Casting From Shore'),
  (1, 2, 2, N'Boat Fishing'),
  (2, 1, 1, N'Clothing And Gear'),
  (2, 1, 2, N'Mounting Basics'),
  (2, 2, 1, N'Steering And Pace'),
  (2, 2, 2, N'After-Ride Care');

DECLARE @level_2_content TABLE (
  tree_slot TINYINT NOT NULL,
  root_index INT NOT NULL,
  level_1_index INT NOT NULL,
  level_2_index INT NOT NULL,
  title NVARCHAR(255) NOT NULL,
  PRIMARY KEY (tree_slot, root_index, level_1_index, level_2_index)
);

INSERT INTO @level_2_content (tree_slot, root_index, level_1_index, level_2_index, title)
VALUES
  (1, 1, 1, 1, N'Choosing The Rod'),
  (1, 1, 1, 2, N'Choosing The Reel'),
  (1, 1, 2, 1, N'Fishing Line Types'),
  (1, 1, 2, 2, N'Hooks And Sinkers'),
  (1, 2, 1, 1, N'Basic Casting Setup'),
  (1, 2, 1, 2, N'Reading The Bank'),
  (1, 2, 2, 1, N'Boat Positioning'),
  (1, 2, 2, 2, N'Landing The Fish'),
  (2, 1, 1, 1, N'Helmet And Footwear'),
  (2, 1, 1, 2, N'Fit And Comfort'),
  (2, 1, 2, 1, N'Approaching The Horse'),
  (2, 1, 2, 2, N'Swinging Into The Saddle'),
  (2, 2, 1, 1, N'Rein Control'),
  (2, 2, 1, 2, N'Walk And Trot Cues'),
  (2, 2, 2, 1, N'Cooling Down'),
  (2, 2, 2, 2, N'Grooming And Checkup');

DECLARE @leaf_content TABLE (
  tree_slot TINYINT NOT NULL,
  root_index INT NOT NULL,
  level_1_index INT NOT NULL,
  level_2_index INT NOT NULL,
  leaf_index INT NOT NULL,
  title NVARCHAR(255) NOT NULL,
  notes NVARCHAR(MAX) NOT NULL,
  PRIMARY KEY (tree_slot, root_index, level_1_index, level_2_index, leaf_index)
);

INSERT INTO @leaf_content (tree_slot, root_index, level_1_index, level_2_index, leaf_index, title, notes)
VALUES
  (1, 1, 1, 1, 1, N'Rod Length For Beginners', N'A medium rod is easier for most beginners to control.' + CHAR(13) + CHAR(10) + N'It handles a wide range of common freshwater fish.' + CHAR(13) + CHAR(10) + N'Start simple before buying specialized gear.'),
  (1, 1, 1, 1, 2, N'Rod Power And Action', N'Light to medium power works well for smaller local species.' + CHAR(13) + CHAR(10) + N'Fast action helps with hook setting, but moderate action is forgiving.' + CHAR(13) + CHAR(10) + N'Comfort matters more than technical perfection at first.'),
  (1, 1, 1, 2, 1, N'Spinning Reel For First Trips', N'A spinning reel is usually the easiest reel for a new angler.' + CHAR(13) + CHAR(10) + N'It handles light lures and simple casting without much adjustment.' + CHAR(13) + CHAR(10) + N'Keep the drag smooth and the reel size moderate.'),
  (1, 1, 1, 2, 2, N'Reel Maintenance Basics', N'Rinse and dry the reel after use, especially near sand or salt.' + CHAR(13) + CHAR(10) + N'Check the line roller and handle for grit.' + CHAR(13) + CHAR(10) + N'Small maintenance prevents big frustrations later.'),
  (1, 1, 2, 1, 1, N'Monofilament For Simplicity', N'Monofilament line is inexpensive and easy to manage.' + CHAR(13) + CHAR(10) + N'It stretches more, which helps beginners avoid pulling hooks free.' + CHAR(13) + CHAR(10) + N'It is a good default line for early practice.'),
  (1, 1, 2, 1, 2, N'Braided Line Tradeoffs', N'Braided line is strong and thin, but it shows mistakes quickly.' + CHAR(13) + CHAR(10) + N'It can tangle if casting technique is rough.' + CHAR(13) + CHAR(10) + N'Use it after basic casting feels natural.'),
  (1, 1, 2, 2, 1, N'Choosing Hook Size', N'Match hook size to bait size and target fish, not to guesswork.' + CHAR(13) + CHAR(10) + N'Smaller hooks are often more forgiving for common freshwater fishing.' + CHAR(13) + CHAR(10) + N'Oversized hooks can make simple rigs awkward.'),
  (1, 1, 2, 2, 2, N'When To Add Sinkers', N'Add enough weight to keep bait where the fish are feeding.' + CHAR(13) + CHAR(10) + N'Too much weight makes the rig clumsy and less natural.' + CHAR(13) + CHAR(10) + N'Adjust by current, depth, and bait choice.'),
  (1, 2, 1, 1, 1, N'Casting Stance On Shore', N'Face slightly sideways and keep the motion smooth rather than forceful.' + CHAR(13) + CHAR(10) + N'A balanced stance improves control more than extra power.' + CHAR(13) + CHAR(10) + N'Practice accuracy before distance.'),
  (1, 2, 1, 1, 2, N'Checking Behind You Before Casting', N'Always make sure the area behind you is clear before swinging the rod.' + CHAR(13) + CHAR(10) + N'Hooks and sinkers can injure people or snag brush.' + CHAR(13) + CHAR(10) + N'A quick look prevents most casting accidents.'),
  (1, 2, 1, 2, 1, N'Spotting Fish-Holding Water', N'Look for shade, rocks, weed edges, or current breaks.' + CHAR(13) + CHAR(10) + N'Fish often gather where food drifts or cover is nearby.' + CHAR(13) + CHAR(10) + N'Reading the bank turns random casting into purposeful fishing.'),
  (1, 2, 1, 2, 2, N'Avoiding Snaggy Areas', N'Watch for submerged branches, thick weeds, and exposed roots.' + CHAR(13) + CHAR(10) + N'Some cover attracts fish, but too much cover costs tackle.' + CHAR(13) + CHAR(10) + N'Work the edge before casting into the mess.'),
  (1, 2, 2, 1, 1, N'Keeping The Boat Steady', N'Boat position affects lure control more than many beginners expect.' + CHAR(13) + CHAR(10) + N'Try to hold the boat so lines drift naturally through the target area.' + CHAR(13) + CHAR(10) + N'A stable angle helps everyone fish more effectively.'),
  (1, 2, 2, 1, 2, N'Fishing Safely Around Other Anglers', N'Give each angler room before casting or moving the boat.' + CHAR(13) + CHAR(10) + N'Crossed lines and swinging hooks create avoidable problems.' + CHAR(13) + CHAR(10) + N'Clear communication matters on small boats.'),
  (1, 2, 2, 2, 1, N'Using A Landing Net', N'Guide the fish into the net headfirst once it is tired enough.' + CHAR(13) + CHAR(10) + N'Do not chase it aggressively with the net.' + CHAR(13) + CHAR(10) + N'Patience near the boat saves more fish than force.'),
  (1, 2, 2, 2, 2, N'Handling Fish Carefully', N'Wet your hands before touching the fish to protect its slime coat.' + CHAR(13) + CHAR(10) + N'Support the fish gently and remove the hook quickly.' + CHAR(13) + CHAR(10) + N'Careful handling matters whether you keep or release it.'),
  (2, 1, 1, 1, 1, N'Why A Riding Helmet Matters', N'A certified riding helmet is basic safety equipment every time you ride.' + CHAR(13) + CHAR(10) + N'Falls happen even during calm sessions.' + CHAR(13) + CHAR(10) + N'A helmet is not optional gear.'),
  (2, 1, 1, 1, 2, N'Choosing Boots With A Heel', N'Riding boots should have a small heel to help prevent the foot from sliding through the stirrup.' + CHAR(13) + CHAR(10) + N'Avoid flat-soled casual shoes.' + CHAR(13) + CHAR(10) + N'Proper footwear is both a comfort and safety issue.'),
  (2, 1, 1, 2, 1, N'Clothes That Let You Move', N'Wear fitted clothing that allows movement without flapping or snagging.' + CHAR(13) + CHAR(10) + N'Comfort helps the rider stay balanced and relaxed.' + CHAR(13) + CHAR(10) + N'Practical clothing is more useful than stylish clothing here.'),
  (2, 1, 1, 2, 2, N'Checking Tack Fit Before Riding', N'Before riding, check that saddle and bridle sit correctly and feel secure.' + CHAR(13) + CHAR(10) + N'Poor fit can make the horse uncomfortable and the ride unstable.' + CHAR(13) + CHAR(10) + N'A short check prevents many beginner problems.'),
  (2, 1, 2, 1, 1, N'Approaching Calmly', N'Approach the horse from the side where it can see you clearly.' + CHAR(13) + CHAR(10) + N'Move calmly and avoid sudden gestures.' + CHAR(13) + CHAR(10) + N'A quiet approach builds trust before the ride begins.'),
  (2, 1, 2, 1, 2, N'Positioning For Mounting', N'Hold the reins and mane or saddle securely before placing your foot in the stirrup.' + CHAR(13) + CHAR(10) + N'Keep your body close to the horse as you prepare to mount.' + CHAR(13) + CHAR(10) + N'Good setup makes mounting smoother and safer.'),
  (2, 1, 2, 2, 1, N'Getting Into The Saddle Gently', N'Swing the leg over without kicking the horse or dropping heavily into the saddle.' + CHAR(13) + CHAR(10) + N'A gentle mount keeps the horse settled.' + CHAR(13) + CHAR(10) + N'It also helps the rider start in balance.'),
  (2, 1, 2, 2, 2, N'Finding Balanced Seat Position', N'Sit tall with shoulders over hips and heels under the body.' + CHAR(13) + CHAR(10) + N'A centered seat gives the rider more control with less tension.' + CHAR(13) + CHAR(10) + N'Balance should come before speed.'),
  (2, 2, 1, 1, 1, N'Light Rein Contact', N'Keep a steady, light contact instead of pulling constantly.' + CHAR(13) + CHAR(10) + N'The horse responds better to clear signals than to force.' + CHAR(13) + CHAR(10) + N'Soft hands help create calm steering.'),
  (2, 2, 1, 1, 2, N'Turning With Hands And Body', N'Use both rein direction and body alignment when turning.' + CHAR(13) + CHAR(10) + N'Looking where you want to go helps the horse follow.' + CHAR(13) + CHAR(10) + N'Balanced turns are easier than abrupt ones.'),
  (2, 2, 1, 2, 1, N'Cueing The Walk', N'To ask for walk, sit quietly and apply a gentle leg aid.' + CHAR(13) + CHAR(10) + N'If the horse does not respond, repeat clearly rather than randomly.' + CHAR(13) + CHAR(10) + N'Consistency teaches both rider and horse.'),
  (2, 2, 1, 2, 2, N'Preparing For The Trot', N'Before trotting, make sure the rider is relaxed and the horse is straight.' + CHAR(13) + CHAR(10) + N'A rushed transition often creates bouncing and confusion.' + CHAR(13) + CHAR(10) + N'Start with short, controlled trot intervals.'),
  (2, 2, 2, 1, 1, N'Cooling Down After Work', N'Let the horse walk calmly after harder work so breathing and muscles can settle.' + CHAR(13) + CHAR(10) + N'Do not stop abruptly after effort.' + CHAR(13) + CHAR(10) + N'A proper cool-down is part of good riding, not an extra step.'),
  (2, 2, 2, 1, 2, N'Checking For Sweat And Rubs', N'After the ride, check areas under the tack for sweat patterns or sore spots.' + CHAR(13) + CHAR(10) + N'Uneven marks can signal fit or comfort problems.' + CHAR(13) + CHAR(10) + N'Quick checks catch issues early.'),
  (2, 2, 2, 2, 1, N'Basic Grooming After Riding', N'Brush away sweat and dirt after the ride to keep the coat clean and comfortable.' + CHAR(13) + CHAR(10) + N'Pay attention to girth and saddle areas.' + CHAR(13) + CHAR(10) + N'Routine grooming also helps the rider notice small problems.'),
  (2, 2, 2, 2, 2, N'Watching The Horse After Work', N'Notice whether the horse moves normally and behaves comfortably once untacked.' + CHAR(13) + CHAR(10) + N'Stiffness or unusual sensitivity may need attention.' + CHAR(13) + CHAR(10) + N'Good horse care continues after the ride ends.');

DECLARE @created_trees TABLE (
  slot TINYINT NOT NULL PRIMARY KEY,
  tree_instance_id INT NOT NULL,
  tree_key NVARCHAR(100) NOT NULL,
  display_name NVARCHAR(200) NOT NULL
);

BEGIN TRY
  BEGIN TRANSACTION;

  DECLARE @tree_slot TINYINT = 1;
  DECLARE @tree_key NVARCHAR(100);
  DECLARE @display_name NVARCHAR(200);
  DECLARE @tree_instance_id INT;

  WHILE @tree_slot <= 2
  BEGIN
    SELECT
      @tree_key = tree_key,
      @display_name = display_name
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

    INSERT INTO @created_trees (slot, tree_instance_id, tree_key, display_name)
    VALUES (@tree_slot, @tree_instance_id, @tree_key, @display_name);

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
    DECLARE @leaf_notes NVARCHAR(MAX);
    DECLARE @leaf_id INT;

    SELECT @tree_instance_id = tree_instance_id
    FROM @created_trees
    WHERE slot = @tree_slot;

    WHILE @root_index <= 2
    BEGIN
      SELECT @root_title = title
      FROM @root_content
      WHERE tree_slot = @tree_slot
        AND root_index = @root_index;

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
        SELECT @level_1_title = title
        FROM @level_1_content
        WHERE tree_slot = @tree_slot
          AND root_index = @root_index
          AND level_1_index = @level_1_index;

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
          SELECT @level_2_title = title
          FROM @level_2_content
          WHERE tree_slot = @tree_slot
            AND root_index = @root_index
            AND level_1_index = @level_1_index
            AND level_2_index = @level_2_index;

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
            SELECT
              @leaf_title = title,
              @leaf_notes = notes
            FROM @leaf_content
            WHERE tree_slot = @tree_slot
              AND root_index = @root_index
              AND level_1_index = @level_1_index
              AND level_2_index = @level_2_index
              AND leaf_index = @leaf_index;

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
            SET notes = @leaf_notes
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