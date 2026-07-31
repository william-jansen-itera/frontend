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
	[is_active] [bit] NOT NULL,
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
ALTER TABLE [dbo].[tree_nodes] ADD  CONSTRAINT [DF_tree_nodes_is_expanded]  DEFAULT ((0)) FOR [is_expanded]
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
GO
ALTER TABLE [dbo].[tree_nodes] CHECK CONSTRAINT [FK_tree_nodes_parent]
GO
ALTER TABLE [dbo].[tree_nodes]  WITH CHECK ADD  CONSTRAINT [FK_tree_nodes_tree_instance] FOREIGN KEY([tree_instance_id])
REFERENCES [dbo].[tree_instance] ([id])
GO
ALTER TABLE [dbo].[tree_nodes] CHECK CONSTRAINT [FK_tree_nodes_tree_instance]
GO
ALTER TABLE [dbo].[tree_setting]  WITH CHECK ADD  CONSTRAINT [FK_tree_setting_tree_instance] FOREIGN KEY([tree_instance_id])
REFERENCES [dbo].[tree_instance] ([id])
GO
ALTER TABLE [dbo].[tree_setting] CHECK CONSTRAINT [FK_tree_setting_tree_instance]
GO
ALTER DATABASE [mds_data] SET  READ_WRITE 
GO
