/****** Object:  Database [mds_data]    Script Date: 7/31/2026 4:11:41 PM ******/
CREATE DATABASE [mds_data]  (EDITION = 'GeneralPurpose', SERVICE_OBJECTIVE = 'GP_S_Gen5_2', MAXSIZE = 32 GB) WITH CATALOG_COLLATION = SQL_Latin1_General_CP1_CI_AS, LEDGER = OFF;
GO
ALTER DATABASE [mds_data] SET COMPATIBILITY_LEVEL = 170
GO
ALTER DATABASE [mds_data] SET ANSI_NULL_DEFAULT OFF 
GO
ALTER DATABASE [mds_data] SET ANSI_NULLS OFF 
GO
ALTER DATABASE [mds_data] SET ANSI_PADDING OFF 
GO
ALTER DATABASE [mds_data] SET ANSI_WARNINGS OFF 
GO
ALTER DATABASE [mds_data] SET ARITHABORT OFF 
GO
ALTER DATABASE [mds_data] SET AUTO_SHRINK OFF 
GO
ALTER DATABASE [mds_data] SET AUTO_UPDATE_STATISTICS ON 
GO
ALTER DATABASE [mds_data] SET CURSOR_CLOSE_ON_COMMIT OFF 
GO
ALTER DATABASE [mds_data] SET CONCAT_NULL_YIELDS_NULL OFF 
GO
ALTER DATABASE [mds_data] SET NUMERIC_ROUNDABORT OFF 
GO
ALTER DATABASE [mds_data] SET QUOTED_IDENTIFIER OFF 
GO
ALTER DATABASE [mds_data] SET RECURSIVE_TRIGGERS OFF 
GO
ALTER DATABASE [mds_data] SET AUTO_UPDATE_STATISTICS_ASYNC OFF 
GO
ALTER DATABASE [mds_data] SET ALLOW_SNAPSHOT_ISOLATION ON 
GO
ALTER DATABASE [mds_data] SET PARAMETERIZATION SIMPLE 
GO
ALTER DATABASE [mds_data] SET READ_COMMITTED_SNAPSHOT ON 
GO
ALTER DATABASE [mds_data] SET  MULTI_USER 
GO
ALTER DATABASE [mds_data] SET AUTOMATIC_INDEX_COMPACTION = OFF 
GO
ALTER DATABASE [mds_data] SET ENCRYPTION ON
GO
ALTER DATABASE [mds_data] SET QUERY_STORE = ON
GO
ALTER DATABASE [mds_data] SET QUERY_STORE (OPERATION_MODE = READ_WRITE, CLEANUP_POLICY = (STALE_QUERY_THRESHOLD_DAYS = 30), DATA_FLUSH_INTERVAL_SECONDS = 900, INTERVAL_LENGTH_MINUTES = 60, MAX_STORAGE_SIZE_MB = 100, QUERY_CAPTURE_MODE = AUTO, SIZE_BASED_CLEANUP_MODE = AUTO, MAX_PLANS_PER_QUERY = 200, WAIT_STATS_CAPTURE_MODE = ON)
GO
/*** The scripts of database scoped configurations in Azure should be executed inside the target database connection. ***/
GO
-- ALTER DATABASE SCOPED CONFIGURATION SET MAXDOP = 8;
GO
/****** Object:  Table [dbo].[tree_nodes]    Script Date: 7/31/2026 4:11:41 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[tree_nodes](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[tree_instance_id] [int] NOT NULL,
	[parent_id] [int] NULL,
	[text] [nvarchar](255) NOT NULL,
	[is_leaf_node] [bit] NOT NULL,
	[is_expanded] [bit] NOT NULL,
	[draggable] [bit] NOT NULL,
	[sort_order] [int] NOT NULL,
	[deleted_at] [datetime2](7) NULL,
	[created_at] [datetime2](0) NOT NULL,
	[updated_at] [datetime2](0) NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  UserDefinedFunction [dbo].[SelectTreeNodes]    Script Date: 7/31/2026 4:11:42 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO

-- Author:      altskavaek
-- Create date: 7/27/2026
-- Description:
-- =============================================
CREATE FUNCTION [dbo].[SelectTreeNodes]
(
    -- Add the parameters for the function here
    @id int
)
RETURNS TABLE
AS
RETURN
(
    WITH RecursiveTree AS (
      SELECT 
        CAST(id AS VARCHAR(10)) as id, 
        CAST(parent_id AS VARCHAR(10)) parent, 
        text as name, 
        is_leaf_node,
        draggable,
        sort_order,
        CAST(sort_order AS VARCHAR(MAX)) AS path,
        0 AS _depth
      FROM tree_nodes
      WHERE id = @id
      UNION ALL
      SELECT 
        CAST(t.id AS VARCHAR(10)) as id, 
        CAST(t.parent_id AS VARCHAR(10)) parent, 
        t.text as name, 
        t.is_leaf_node,
        t.draggable,
        t.sort_order,
        rt.path + '-' + CAST(t.sort_order AS VARCHAR(MAX)) AS path,
        rt._depth + 1 AS _depth
      FROM tree_nodes t
      INNER JOIN RecursiveTree rt ON t.parent_id = rt.id      
    )
    SELECT * FROM RecursiveTree
)
GO
/****** Object:  Table [dbo].[application_instance]    Script Date: 7/31/2026 4:11:42 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[application_instance](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[app_identifier] [nvarchar](100) NOT NULL,
	[display_name] [nvarchar](200) NOT NULL,
	[is_active] [bit] NOT NULL,
	[created_at] [datetime2](0) NOT NULL,
	[updated_at] [datetime2](0) NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_application_instance_app_identifier] UNIQUE NONCLUSTERED 
(
	[app_identifier] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[tree_instance]    Script Date: 7/31/2026 4:11:42 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[tree_instance](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[application_instance_id] [int] NOT NULL,
	[tree_key] [nvarchar](100) NOT NULL,
	[display_name] [nvarchar](200) NOT NULL,
	[description] [nvarchar](max) NULL,
	[description_published_to_agent] [bit] NOT NULL,
	[is_private] [bit] NOT NULL,
	[owner_object_id] [nvarchar](100) NULL,
	[owner_user_details] [nvarchar](320) NULL,
	[owner_display_name] [nvarchar](200) NULL,
	[is_active] [bit] NOT NULL,
	[deleted_at] [datetime2](7) NULL,
	[created_at] [datetime2](0) NOT NULL,
	[updated_at] [datetime2](0) NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_tree_instance_app_tree_key] UNIQUE NONCLUSTERED 
(
	[application_instance_id] ASC,
	[tree_key] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO

ALTER TABLE [dbo].[tree_instance] ADD DEFAULT ((0)) FOR [description_published_to_agent]
GO
ALTER TABLE [dbo].[tree_instance] ADD DEFAULT ((1)) FOR [is_private]
GO
/****** Object:  Table [dbo].[tree_node_detail_files]    Script Date: 7/31/2026 4:11:42 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[tree_node_detail_files](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[tree_node_id] [int] NOT NULL,
	[original_file_name] [nvarchar](260) NOT NULL,
	[content_type] [nvarchar](200) NOT NULL,
	[byte_size] [bigint] NOT NULL,
	[blob_name] [nvarchar](1024) NOT NULL,
	[blob_url] [nvarchar](2048) NOT NULL,
	[created_at] [datetime2](7) NOT NULL,
	[updated_at] [datetime2](7) NOT NULL,
 CONSTRAINT [PK_tree_node_detail_files] PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_tree_node_detail_files_blob_name] UNIQUE NONCLUSTERED 
(
	[blob_name] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Table [dbo].[tree_node_details]    Script Date: 7/31/2026 4:11:42 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[tree_node_details](
	[tree_node_id] [int] NOT NULL,
	[notes] [nvarchar](max) NULL,
	[created_at] [datetime2](7) NOT NULL,
	[updated_at] [datetime2](7) NOT NULL,
 CONSTRAINT [PK_tree_node_details] PRIMARY KEY CLUSTERED 
(
	[tree_node_id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
/****** Object:  Table [dbo].[tree_setting]    Script Date: 7/31/2026 4:11:42 PM ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[tree_setting](
	[id] [int] IDENTITY(1,1) NOT NULL,
	[tree_instance_id] [int] NOT NULL,
	[setting_key] [nvarchar](100) NOT NULL,
	[setting_value] [nvarchar](500) NOT NULL,
	[created_at] [datetime2](0) NOT NULL,
	[updated_at] [datetime2](0) NOT NULL,
PRIMARY KEY CLUSTERED 
(
	[id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY],
 CONSTRAINT [UQ_tree_setting_tree_key] UNIQUE NONCLUSTERED 
(
	[tree_instance_id] ASC,
	[setting_key] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
) ON [PRIMARY]
GO
/****** Object:  Index [IX_tree_node_detail_files_tree_node_detail_id_created_at]    Script Date: 7/31/2026 4:11:42 PM ******/
CREATE NONCLUSTERED INDEX [IX_tree_node_detail_files_tree_node_detail_id_created_at] ON [dbo].[tree_node_detail_files]
(
	[tree_node_id] ASC,
	[created_at] DESC,
	[id] DESC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Object:  Index [IX_tree_nodes_parent_id]    Script Date: 7/31/2026 4:11:42 PM ******/
CREATE NONCLUSTERED INDEX [IX_tree_nodes_parent_id] ON [dbo].[tree_nodes]
(
	[parent_id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Object:  Index [IX_tree_nodes_tree_instance_id]    Script Date: 7/31/2026 4:11:42 PM ******/
CREATE NONCLUSTERED INDEX [IX_tree_nodes_tree_instance_id] ON [dbo].[tree_nodes]
(
	[tree_instance_id] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
/****** Object:  Index [IX_tree_nodes_tree_parent_sort]    Script Date: 7/31/2026 4:11:42 PM ******/
CREATE NONCLUSTERED INDEX [IX_tree_nodes_tree_parent_sort] ON [dbo].[tree_nodes]
(
	[tree_instance_id] ASC,
	[parent_id] ASC,
	[sort_order] ASC
)WITH (STATISTICS_NORECOMPUTE = OFF, DROP_EXISTING = OFF, ONLINE = OFF, OPTIMIZE_FOR_SEQUENTIAL_KEY = OFF) ON [PRIMARY]
GO
ALTER TABLE [dbo].[application_instance] ADD  CONSTRAINT [DF_application_instance_is_active]  DEFAULT ((1)) FOR [is_active]
GO
ALTER TABLE [dbo].[application_instance] ADD  CONSTRAINT [DF_application_instance_created_at]  DEFAULT (sysutcdatetime()) FOR [created_at]
GO
ALTER TABLE [dbo].[application_instance] ADD  CONSTRAINT [DF_application_instance_updated_at]  DEFAULT (sysutcdatetime()) FOR [updated_at]
GO
ALTER TABLE [dbo].[tree_instance] ADD  CONSTRAINT [DF_tree_instance_is_active]  DEFAULT ((1)) FOR [is_active]
GO
ALTER TABLE [dbo].[tree_instance] ADD  CONSTRAINT [DF_tree_instance_created_at]  DEFAULT (sysutcdatetime()) FOR [created_at]
GO
ALTER TABLE [dbo].[tree_instance] ADD  CONSTRAINT [DF_tree_instance_updated_at]  DEFAULT (sysutcdatetime()) FOR [updated_at]
GO
ALTER TABLE [dbo].[tree_node_detail_files] ADD  CONSTRAINT [DF_tree_node_detail_files_created_at]  DEFAULT (sysutcdatetime()) FOR [created_at]
GO
ALTER TABLE [dbo].[tree_node_detail_files] ADD  CONSTRAINT [DF_tree_node_detail_files_updated_at]  DEFAULT (sysutcdatetime()) FOR [updated_at]
GO
ALTER TABLE [dbo].[tree_node_details] ADD  CONSTRAINT [DF_tree_node_details_created_at]  DEFAULT (sysutcdatetime()) FOR [created_at]
GO
ALTER TABLE [dbo].[tree_node_details] ADD  CONSTRAINT [DF_tree_node_details_updated_at]  DEFAULT (sysutcdatetime()) FOR [updated_at]
GO
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_is_leaf_node]  DEFAULT ((0)) FOR [is_leaf_node]
GO
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_is_expanded]  DEFAULT ((1)) FOR [is_expanded]
GO
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_draggable]  DEFAULT ((1)) FOR [draggable]
GO
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_sort_order]  DEFAULT ((0)) FOR [sort_order]
GO
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_created_at]  DEFAULT (sysutcdatetime()) FOR [created_at]
GO
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_updated_at]  DEFAULT (sysutcdatetime()) FOR [updated_at]
GO
ALTER TABLE [dbo].[tree_setting] ADD  CONSTRAINT [DF_tree_setting_created_at]  DEFAULT (sysutcdatetime()) FOR [created_at]
GO
ALTER TABLE [dbo].[tree_setting] ADD  CONSTRAINT [DF_tree_setting_updated_at]  DEFAULT (sysutcdatetime()) FOR [updated_at]
GO
ALTER TABLE [dbo].[tree_instance]  WITH CHECK ADD  CONSTRAINT [FK_tree_instance_application_instance] FOREIGN KEY([application_instance_id])
REFERENCES [dbo].[application_instance] ([id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[tree_instance] CHECK CONSTRAINT [FK_tree_instance_application_instance]
GO
ALTER TABLE [dbo].[tree_node_detail_files]  WITH CHECK ADD  CONSTRAINT [FK_tree_node_detail_files_tree_node_details] FOREIGN KEY([tree_node_id])
REFERENCES [dbo].[tree_node_details] ([tree_node_id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[tree_node_detail_files] CHECK CONSTRAINT [FK_tree_node_detail_files_tree_node_details]
GO
ALTER TABLE [dbo].[tree_node_details]  WITH CHECK ADD  CONSTRAINT [FK_tree_node_details_tree_nodes] FOREIGN KEY([tree_node_id])
REFERENCES [dbo].[tree_nodes] ([id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[tree_node_details] CHECK CONSTRAINT [FK_tree_node_details_tree_nodes]
GO
ALTER TABLE [dbo].[tree_nodes]  WITH CHECK ADD  CONSTRAINT [FK_tree_nodes_parent] FOREIGN KEY([parent_id])
REFERENCES [dbo].[tree_nodes] ([id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[tree_nodes] CHECK CONSTRAINT [FK_tree_nodes_parent]
GO
ALTER TABLE [dbo].[tree_nodes]  WITH CHECK ADD  CONSTRAINT [FK_tree_nodes_tree_instance] FOREIGN KEY([tree_instance_id])
REFERENCES [dbo].[tree_instance] ([id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[tree_nodes] CHECK CONSTRAINT [FK_tree_nodes_tree_instance]
GO
ALTER TABLE [dbo].[tree_setting]  WITH CHECK ADD  CONSTRAINT [FK_tree_setting_tree_instance] FOREIGN KEY([tree_instance_id])
REFERENCES [dbo].[tree_instance] ([id])
ON DELETE CASCADE
GO
ALTER TABLE [dbo].[tree_setting] CHECK CONSTRAINT [FK_tree_setting_tree_instance]
GO
CREATE OR ALTER TRIGGER [dbo].[TR_tree_nodes_set_updated_at]
ON [dbo].[tree_nodes]
AFTER UPDATE
AS
BEGIN
	SET NOCOUNT ON;

	DECLARE @now DATETIME2(7) = SYSUTCDATETIME();

	WITH ChangedPathNodes AS (
		SELECT i.id
		FROM inserted i
		INNER JOIN deleted d ON d.id = i.id
		WHERE ISNULL(i.[text], N'') <> ISNULL(d.[text], N'')
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
END;
GO
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE OR ALTER VIEW [dbo].[vw_tree_search_nodes]
AS
WITH TreeHierarchy AS (
	SELECT
		tn.id,
		tn.tree_instance_id,
		tn.parent_id,
		tn.[text],
		tn.is_leaf_node,
		tn.sort_order,
		tn.deleted_at,
		tn.created_at,
		tn.updated_at,
		CAST(tn.updated_at AS DATETIME2(7)) AS path_updated_at,
		CAST(CAST(tn.id AS NVARCHAR(20)) AS NVARCHAR(MAX)) AS node_id_path,
		CAST(RIGHT(REPLICATE('0', 3) + CAST(tn.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS sort_path,
		CAST(tn.[text] AS NVARCHAR(MAX)) AS breadcrumb,
		0 AS depth
	FROM dbo.tree_nodes tn
	WHERE tn.parent_id IS NULL

	UNION ALL

	SELECT
		child.id,
		child.tree_instance_id,
		child.parent_id,
		child.[text],
		child.is_leaf_node,
		child.sort_order,
		child.deleted_at,
		child.created_at,
		child.updated_at,
		CAST(CASE
			WHEN child.updated_at >= parent.path_updated_at THEN child.updated_at
			ELSE parent.path_updated_at
		END AS DATETIME2(7)) AS path_updated_at,
		CAST(parent.node_id_path + N'/' + CAST(child.id AS NVARCHAR(20)) AS NVARCHAR(MAX)) AS node_id_path,
		CAST(parent.sort_path + '-' + RIGHT(REPLICATE('0', 3) + CAST(child.sort_order AS VARCHAR(3)), 3) AS VARCHAR(MAX)) AS sort_path,
		CAST(parent.breadcrumb + N' > ' + child.[text] AS NVARCHAR(MAX)) AS breadcrumb,
		parent.depth + 1 AS depth
	FROM dbo.tree_nodes child
	INNER JOIN TreeHierarchy parent ON parent.id = child.parent_id
),
AttachmentSummary AS (
	SELECT
		files.tree_node_id,
		COUNT(*) AS attachment_count,
		MAX(files.updated_at) AS latest_attachment_updated_at,
		MAX(files.created_at) AS latest_attachment_created_at
	FROM dbo.tree_node_detail_files files
	GROUP BY files.tree_node_id
)
SELECT
	CONCAT(N'node-', CAST(th.tree_instance_id AS NVARCHAR(20)), N'-', CAST(th.id AS NVARCHAR(20))) AS id,
	N'node' AS sourceType,
	CAST(ai.app_identifier AS NVARCHAR(100)) AS appIdentifier,
	CAST(ai.display_name AS NVARCHAR(200)) AS appDisplayName,
	CAST(ti.id AS NVARCHAR(20)) AS treeId,
	CAST(ti.tree_key AS NVARCHAR(100)) AS treeKey,
	CAST(COALESCE(NULLIF(ti.display_name, N''), CONCAT(N'Tree ', ti.id)) AS NVARCHAR(200)) AS treeDisplayName,
	CAST(th.id AS NVARCHAR(20)) AS nodeId,
	CAST(th.parent_id AS NVARCHAR(20)) AS parentNodeId,
	CAST(th.[text] AS NVARCHAR(255)) AS title,
	CAST(th.[text] AS NVARCHAR(MAX)) AS nodeText,
	CAST(ISNULL(details.notes, N'') AS NVARCHAR(MAX)) AS notes,
	CAST(th.breadcrumb AS NVARCHAR(MAX)) AS breadcrumb,
	CAST(th.node_id_path AS NVARCHAR(MAX)) AS nodeIdPath,
	CAST(ISNULL(details.notes, N'') AS NVARCHAR(MAX)) AS content,
	th.is_leaf_node AS isLeafNode,
	th.depth,
	th.sort_path AS sortPath,
	CAST(CASE WHEN th.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS bit) AS isDeleted,
	CAST(CASE WHEN th.deleted_at IS NOT NULL OR ti.deleted_at IS NOT NULL THEN N'true' ELSE N'false' END AS NVARCHAR(5)) AS isDeletedMarker,
	ISNULL(attachments.attachment_count, 0) AS attachmentCount,
	CAST(CASE WHEN ISNULL(attachments.attachment_count, 0) > 0 THEN 1 ELSE 0 END AS bit) AS hasAttachments,
	CAST((
		SELECT
			files.id AS id,
			files.original_file_name AS fileName,
			files.content_type AS contentType,
			files.byte_size AS byteSize,
			files.blob_name AS blobName,
			files.blob_url AS blobUrl,
			files.created_at AS createdAt,
			files.updated_at AS updatedAt
		FROM dbo.tree_node_detail_files files
		WHERE files.tree_node_id = th.id
		ORDER BY files.created_at DESC, files.id DESC
		FOR JSON PATH
	) AS NVARCHAR(MAX)) AS attachmentMetadataJson,
	CAST(CASE
		WHEN attachments.latest_attachment_updated_at IS NULL AND details.updated_at IS NULL THEN
			CASE WHEN ti.updated_at >= th.path_updated_at THEN ti.updated_at ELSE th.path_updated_at END
		WHEN attachments.latest_attachment_updated_at IS NULL THEN
			CASE
				WHEN details.updated_at >= ti.updated_at AND details.updated_at >= th.path_updated_at THEN details.updated_at
				WHEN ti.updated_at >= details.updated_at AND ti.updated_at >= th.path_updated_at THEN ti.updated_at
				ELSE th.path_updated_at
			END
		WHEN details.updated_at IS NULL THEN
			CASE
				WHEN attachments.latest_attachment_updated_at >= ti.updated_at AND attachments.latest_attachment_updated_at >= th.path_updated_at THEN attachments.latest_attachment_updated_at
				WHEN ti.updated_at >= attachments.latest_attachment_updated_at AND ti.updated_at >= th.path_updated_at THEN ti.updated_at
				ELSE th.path_updated_at
			END
		ELSE (
			CASE
				WHEN attachments.latest_attachment_updated_at >= details.updated_at AND attachments.latest_attachment_updated_at >= ti.updated_at AND attachments.latest_attachment_updated_at >= th.path_updated_at THEN attachments.latest_attachment_updated_at
				WHEN details.updated_at >= attachments.latest_attachment_updated_at AND details.updated_at >= ti.updated_at AND details.updated_at >= th.path_updated_at THEN details.updated_at
				WHEN ti.updated_at >= attachments.latest_attachment_updated_at AND ti.updated_at >= details.updated_at AND ti.updated_at >= th.path_updated_at THEN ti.updated_at
				ELSE th.path_updated_at
			END
		)
	END AS DATETIME2(7)) AS updatedAt,
	th.created_at AS createdAt
FROM TreeHierarchy th
INNER JOIN dbo.tree_instance ti ON ti.id = th.tree_instance_id
INNER JOIN dbo.application_instance ai ON ai.id = ti.application_instance_id
LEFT JOIN dbo.tree_node_details details ON details.tree_node_id = th.id
LEFT JOIN AttachmentSummary attachments ON attachments.tree_node_id = th.id;
GO
ALTER DATABASE [mds_data] SET  READ_WRITE 
GO
