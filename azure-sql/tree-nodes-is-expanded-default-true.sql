IF EXISTS (
    SELECT 1
    FROM sys.default_constraints dc
    INNER JOIN sys.columns c
        ON c.default_object_id = dc.object_id
    INNER JOIN sys.tables t
        ON t.object_id = c.object_id
    INNER JOIN sys.schemas s
        ON s.schema_id = t.schema_id
    WHERE s.name = 'dbo'
      AND t.name = 'tree_nodes'
      AND c.name = 'is_expanded'
      AND dc.name = 'DF_tree_nodes_is_expanded'
)
BEGIN
    ALTER TABLE [dbo].[tree_nodes] DROP CONSTRAINT [DF_tree_nodes_is_expanded];
END
GO

ALTER TABLE [dbo].[tree_nodes]
ADD CONSTRAINT [DF_tree_nodes_is_expanded] DEFAULT ((1)) FOR [is_expanded];
GO