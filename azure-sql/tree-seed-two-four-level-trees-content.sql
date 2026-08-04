DECLARE @app_identifier NVARCHAR(100) = N'knowledge-app-dev';

DECLARE @tree_1_key NVARCHAR(100) = N'azure-ai-search-playbook';
DECLARE @tree_1_display_name NVARCHAR(200) = N'Azure AI Search Implementation Playbook';

DECLARE @tree_2_key NVARCHAR(100) = N'knowledge-app-product-operations';
DECLARE @tree_2_display_name NVARCHAR(200) = N'Knowledge App Product Operations';

IF OBJECT_ID('dbo.application_instance', 'U') IS NULL
BEGIN
  THROW 50200, 'The dbo.application_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_instance', 'U') IS NULL
BEGIN
  THROW 50201, 'The dbo.tree_instance table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_setting', 'U') IS NULL
BEGIN
  THROW 50202, 'The dbo.tree_setting table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_nodes', 'U') IS NULL
BEGIN
  THROW 50203, 'The dbo.tree_nodes table does not exist.', 1;
END;

IF OBJECT_ID('dbo.tree_node_details', 'U') IS NULL
BEGIN
  THROW 50204, 'The dbo.tree_node_details table does not exist.', 1;
END;

IF OBJECT_ID('dbo.TR_tree_nodes_create_details_row', 'TR') IS NULL
BEGIN
  THROW 50205, 'The dbo.TR_tree_nodes_create_details_row trigger does not exist.', 1;
END;

DECLARE @application_instance_id INT;

SELECT @application_instance_id = ai.id
FROM dbo.application_instance ai
WHERE ai.app_identifier = @app_identifier;

IF @application_instance_id IS NULL
BEGIN
  THROW 50206, 'The supplied app_identifier was not found in dbo.application_instance.', 1;
END;

IF EXISTS (
  SELECT 1
  FROM dbo.tree_instance ti
  WHERE ti.application_instance_id = @application_instance_id
    AND ti.tree_key IN (@tree_1_key, @tree_2_key)
)
BEGIN
  THROW 50207, 'One or more target tree keys already exist for this application instance.', 1;
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
  (1, 1, N'Index Design'),
  (1, 2, N'Search Experience'),
  (2, 1, N'Content Governance'),
  (2, 2, N'User Enablement');

DECLARE @level_1_content TABLE (
  tree_slot TINYINT NOT NULL,
  root_index INT NOT NULL,
  level_1_index INT NOT NULL,
  title NVARCHAR(255) NOT NULL,
  PRIMARY KEY (tree_slot, root_index, level_1_index)
);

INSERT INTO @level_1_content (tree_slot, root_index, level_1_index, title)
VALUES
  (1, 1, 1, N'Schema Modeling'),
  (1, 1, 2, N'Content Ingestion'),
  (1, 2, 1, N'Query Interaction'),
  (1, 2, 2, N'Relevance Tuning'),
  (2, 1, 1, N'Editorial Standards'),
  (2, 1, 2, N'Lifecycle Management'),
  (2, 2, 1, N'Author Training'),
  (2, 2, 2, N'Support Workflow');

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
  (1, 1, 1, 1, N'Field Attributes'),
  (1, 1, 1, 2, N'Metadata Filters'),
  (1, 1, 2, 1, N'Chunking Strategy'),
  (1, 1, 2, 2, N'Indexer Scheduling'),
  (1, 2, 1, 1, N'Result Layout'),
  (1, 2, 1, 2, N'Query Guidance'),
  (1, 2, 2, 1, N'Scoring Profiles'),
  (1, 2, 2, 2, N'Synonyms And Language'),
  (2, 1, 1, 1, N'Naming Conventions'),
  (2, 1, 1, 2, N'Writing Style'),
  (2, 1, 2, 1, N'Review Cadence'),
  (2, 1, 2, 2, N'Archive Rules'),
  (2, 2, 1, 1, N'Onboarding Guides'),
  (2, 2, 1, 2, N'Coach The Authors'),
  (2, 2, 2, 1, N'Escalation Paths'),
  (2, 2, 2, 2, N'Feedback Loop');

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
  (1, 1, 1, 1, 1, N'Searchable Versus Filterable Fields', N'Mark only genuinely queryable text as searchable.' + CHAR(13) + CHAR(10) + N'Keep IDs, status flags, and ownership tags filterable instead.' + CHAR(13) + CHAR(10) + N'This reduces noise and improves predictable retrieval.'),
  (1, 1, 1, 1, 2, N'Facetable Fields For Navigation', N'Use facetable fields only when users will narrow results with them.' + CHAR(13) + CHAR(10) + N'Keep value sets stable and human readable.' + CHAR(13) + CHAR(10) + N'Facets work best when they mirror real filtering decisions.'),
  (1, 1, 1, 2, 1, N'Tenant Isolation Metadata', N'Add tenant or audience tags at ingestion time, not after indexing.' + CHAR(13) + CHAR(10) + N'Use those fields in every secured query path.' + CHAR(13) + CHAR(10) + N'Consistent metadata is the easiest way to prevent result leakage.'),
  (1, 1, 1, 2, 2, N'Freshness And Source Flags', N'Store source system and last-updated markers on every document.' + CHAR(13) + CHAR(10) + N'They help with both filtering and debugging stale search results.' + CHAR(13) + CHAR(10) + N'Without them, support teams lose context quickly.'),
  (1, 1, 2, 1, 1, N'When To Split Long Documents', N'Split by stable topic boundaries, not by fixed page counts alone.' + CHAR(13) + CHAR(10) + N'Each chunk should answer one user intent cleanly.' + CHAR(13) + CHAR(10) + N'Overly large chunks dilute ranking and summary quality.'),
  (1, 1, 2, 1, 2, N'Chunk Headers That Survive Search', N'Repeat the local heading in each chunk so results stand on their own.' + CHAR(13) + CHAR(10) + N'Users often land directly on a chunk without document context.' + CHAR(13) + CHAR(10) + N'Good chunk headers improve trust in the result.'),
  (1, 1, 2, 2, 1, N'Incremental Indexer Refreshes', N'Prefer incremental schedules when the source exposes reliable change tracking.' + CHAR(13) + CHAR(10) + N'It shortens rebuild time and reduces operational load.' + CHAR(13) + CHAR(10) + N'Full rebuilds should be reserved for schema or transformation changes.'),
  (1, 1, 2, 2, 2, N'Indexer Failure Triage', N'Capture source path, failing field, and last successful run in operations logs.' + CHAR(13) + CHAR(10) + N'That makes broken documents easier to isolate.' + CHAR(13) + CHAR(10) + N'Fast triage matters more than perfect error wording.'),
  (1, 2, 1, 1, 1, N'Useful Result Titles', N'Result titles should echo the user problem, not just the source file name.' + CHAR(13) + CHAR(10) + N'Clear titles make scanning faster on crowded result pages.' + CHAR(13) + CHAR(10) + N'If the source title is vague, generate a better display title.'),
  (1, 2, 1, 1, 2, N'Context In Result Snippets', N'Snippets should include the line or phrase that justified the match.' + CHAR(13) + CHAR(10) + N'Context reduces wasted clicks and improves confidence.' + CHAR(13) + CHAR(10) + N'A highlighted fragment is usually enough when it is well chosen.'),
  (1, 2, 1, 2, 1, N'Example Queries For Users', N'Show one or two concrete example queries near the search box.' + CHAR(13) + CHAR(10) + N'Examples teach vocabulary faster than instruction text.' + CHAR(13) + CHAR(10) + N'This is especially helpful in domain-specific search experiences.'),
  (1, 2, 1, 2, 2, N'Zero Result Recovery', N'When nothing matches, suggest nearby terms, filters, or trusted fallback pages.' + CHAR(13) + CHAR(10) + N'An empty state should still help the user move forward.' + CHAR(13) + CHAR(10) + N'Good recovery patterns protect overall search trust.'),
  (1, 2, 2, 1, 1, N'When To Use Scoring Profiles', N'Use scoring profiles when business importance should consistently outrank raw term frequency.' + CHAR(13) + CHAR(10) + N'Keep the rules small enough for teams to explain and maintain.' + CHAR(13) + CHAR(10) + N'If no one can describe the boost logic, it is too complex.'),
  (1, 2, 2, 1, 2, N'Boosting Fresh And Authoritative Content', N'Boost freshness only when newer content is genuinely better for the task.' + CHAR(13) + CHAR(10) + N'Authority signals such as approved status often matter more.' + CHAR(13) + CHAR(10) + N'Combine those signals carefully to avoid noisy ranking shifts.'),
  (1, 2, 2, 2, 1, N'Synonym Lists That Age Well', N'Build synonym maps from real user language, not only from system terminology.' + CHAR(13) + CHAR(10) + N'Review them periodically as products and labels change.' + CHAR(13) + CHAR(10) + N'Stable synonym coverage improves recall without changing source content.'),
  (1, 2, 2, 2, 2, N'Language Settings Per Content Type', N'Choose analyzers based on the actual language and token behavior of the content.' + CHAR(13) + CHAR(10) + N'Mixed-language collections often need separate handling.' + CHAR(13) + CHAR(10) + N'Ignoring analyzer choice creates subtle ranking defects.'),
  (2, 1, 1, 1, 1, N'Scannable Leaf Headers', N'Use headers that describe one answerable topic in plain language.' + CHAR(13) + CHAR(10) + N'Avoid vague titles such as General Notes or Miscellaneous.' + CHAR(13) + CHAR(10) + N'Clear headers make both navigation and search results stronger.'),
  (2, 1, 1, 1, 2, N'Consistent Prefix Rules', N'Use predictable prefixes only when they help users group related topics quickly.' + CHAR(13) + CHAR(10) + N'Prefix sprawl makes lists harder to scan.' + CHAR(13) + CHAR(10) + N'Every naming rule should reduce ambiguity, not add ceremony.'),
  (2, 1, 1, 2, 1, N'Writing For Fast Retrieval', N'Put the answer in the first two sentences and follow with short supporting detail.' + CHAR(13) + CHAR(10) + N'Long openings weaken both scanability and search snippet quality.' + CHAR(13) + CHAR(10) + N'Writers should assume the note will be read in fragments.'),
  (2, 1, 1, 2, 2, N'When To Split A Topic', N'Split a leaf when it starts answering two different user questions.' + CHAR(13) + CHAR(10) + N'If one note needs multiple headings, it may already be too broad.' + CHAR(13) + CHAR(10) + N'Smaller leaves are easier to maintain and easier to retrieve.'),
  (2, 1, 2, 1, 1, N'Review Triggers After Product Change', N'Review affected notes whenever labels, flows, or screenshots change in the product.' + CHAR(13) + CHAR(10) + N'Tie review work to release milestones, not to memory.' + CHAR(13) + CHAR(10) + N'Operational drift starts when releases outrun editorial review.'),
  (2, 1, 2, 1, 2, N'Owner And Reviewer Cadence', N'Every leaf should have a clear owner and a lightweight review rhythm.' + CHAR(13) + CHAR(10) + N'Quarterly is enough for stable policies; volatile areas need more attention.' + CHAR(13) + CHAR(10) + N'Ownership is the simplest defense against stale knowledge.'),
  (2, 1, 2, 2, 1, N'Archive Versus Delete', N'Archive when a note may still provide historical or compliance context.' + CHAR(13) + CHAR(10) + N'Delete only when the content is duplicated or actively harmful.' + CHAR(13) + CHAR(10) + N'Keeping the distinction explicit avoids accidental knowledge loss.'),
  (2, 1, 2, 2, 2, N'Redirecting Retired Topics', N'When a note is retired, point users to the replacement leaf in the archive note.' + CHAR(13) + CHAR(10) + N'That preserves continuity for saved links and old habits.' + CHAR(13) + CHAR(10) + N'Archive pages should still help users reach the current answer.'),
  (2, 2, 1, 1, 1, N'First-Day Author Checklist', N'Give new authors a short checklist for headers, scope, tone, and ownership.' + CHAR(13) + CHAR(10) + N'They should be able to publish a good first note in one session.' + CHAR(13) + CHAR(10) + N'Onboarding should remove friction, not add process weight.'),
  (2, 2, 1, 1, 2, N'Examples That Teach Good Notes', N'Show side-by-side examples of weak and strong leaf notes.' + CHAR(13) + CHAR(10) + N'Examples teach judgment faster than abstract writing rules.' + CHAR(13) + CHAR(10) + N'Use real product language so the examples feel relevant.'),
  (2, 2, 1, 2, 1, N'Coaching Through Review Comments', N'Review comments should explain why a change helps users find or trust the answer.' + CHAR(13) + CHAR(10) + N'That turns review into coaching instead of gatekeeping.' + CHAR(13) + CHAR(10) + N'Over time the quality bar becomes shared, not enforced.'),
  (2, 2, 1, 2, 2, N'When To Escalate Editorial Gaps', N'Escalate when repeated edits reveal a missing standard, not only when a note is weak.' + CHAR(13) + CHAR(10) + N'Patterns in review feedback usually point to a process problem.' + CHAR(13) + CHAR(10) + N'Fixing the standard scales better than fixing one note at a time.'),
  (2, 2, 2, 1, 1, N'Missing Knowledge Escalation Path', N'Give support teams a clear route for flagging missing or outdated content.' + CHAR(13) + CHAR(10) + N'The route should identify owner, urgency, and user impact.' + CHAR(13) + CHAR(10) + N'Fast escalation protects both support efficiency and trust in the knowledge base.'),
  (2, 2, 2, 1, 2, N'Capturing Repeat Support Questions', N'If a question repeats, turn it into a candidate leaf with real examples from support.' + CHAR(13) + CHAR(10) + N'Frequency is strong evidence that a topic deserves structured knowledge.' + CHAR(13) + CHAR(10) + N'Repeat questions are often the best seed for useful notes.'),
  (2, 2, 2, 2, 1, N'Closing The Feedback Loop', N'Tell contributors when their flagged issue led to a new or improved note.' + CHAR(13) + CHAR(10) + N'Visible follow-through encourages future contributions.' + CHAR(13) + CHAR(10) + N'Without a feedback loop, reporting gaps feels pointless.'),
  (2, 2, 2, 2, 2, N'Measuring Knowledge Utility', N'Track whether notes reduce repeat questions, shorten handling time, or improve self-service.' + CHAR(13) + CHAR(10) + N'Useful metrics should reflect user outcomes, not only page views.' + CHAR(13) + CHAR(10) + N'If no one uses a note, the content or placement likely needs work.');

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