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