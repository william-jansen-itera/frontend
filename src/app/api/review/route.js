import { NextResponse } from 'next/server';
import { parseClientPrincipal } from '@/server/utils/auth';
import { getTreeList } from '@/server/utils/treeCatalog';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

const ALLOWED_REVIEW_FILTERS = new Set(['submitted', 'rejected']);

function getErrorStatus(error, defaultStatus = 500) {
  const status = Number(error?.status);

  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return status;
  }

  return defaultStatus;
}

function normalizeReviewFilter(value) {
  const normalizedValue = String(value ?? '').trim().toLowerCase();
  return ALLOWED_REVIEW_FILTERS.has(normalizedValue) ? normalizedValue : 'submitted';
}

export async function GET(request) {
  try {
    const principal = parseClientPrincipal(request);
    const { searchParams } = new URL(request.url);
    const reviewStatus = normalizeReviewFilter(searchParams.get('status'));
    const availableTrees = await getTreeList({
      principal,
      visibility: 'both',
      enforceAccess: true,
    });
    const reviewableTreeIds = new Set(
      availableTrees
        .filter((tree) => Boolean(tree.approvalEnabled) && Boolean(tree.currentUserCanReview))
        .map((tree) => String(tree.id)),
    );

    if (reviewableTreeIds.size === 0) {
      return NextResponse.json({
        reviewStatus,
        trees: [],
        nodes: [],
        attachments: [],
      });
    }

    const result = await withSqlConnection(async () => {
      const requestBuilder = new sql.Request()
        .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
        .input('review_status', sql.NVarChar(20), reviewStatus);

      const [treeResult, nodeResult, attachmentResult] = await Promise.all([
        requestBuilder.query(`
          SELECT
            CAST(ti.id AS VARCHAR(10)) AS id,
            COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS name,
            CAST(ti.is_private AS bit) AS isPrivate,
            CAST(ti.review_status AS NVARCHAR(20)) AS reviewStatus,
            ti.submitted_at AS submittedAt,
            ti.submitted_by_user_details AS submittedByUserDetails,
            ti.reviewed_at AS reviewedAt,
            ti.reviewed_by_user_details AS reviewedByUserDetails,
            ti.rejection_comment AS rejectionComment
          FROM tree_instance ti
          INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
          WHERE ai.app_identifier = @application_identifier
            AND ti.deleted_at IS NULL
            AND COALESCE(ti.approval_enabled, 0) = 1
            AND ti.review_status = @review_status
          ORDER BY ti.updated_at DESC, ti.id DESC;
        `),
        new sql.Request()
          .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
          .input('review_status', sql.NVarChar(20), reviewStatus)
          .query(`
            WITH NodePaths AS (
              SELECT
                tn.id,
                tn.tree_instance_id,
                tn.parent_id,
                tn.text,
                CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
              FROM tree_nodes tn
              WHERE tn.parent_id IS NULL
                AND tn.deleted_at IS NULL

              UNION ALL

              SELECT
                child.id,
                child.tree_instance_id,
                child.parent_id,
                child.text,
                CAST(parent_path.breadcrumb + N' > ' + child.text AS NVARCHAR(MAX)) AS breadcrumb
              FROM tree_nodes child
              INNER JOIN NodePaths parent_path ON child.parent_id = parent_path.id
              WHERE child.deleted_at IS NULL
            )
            SELECT
              CAST(tn.id AS VARCHAR(10)) AS id,
              CAST(tn.tree_instance_id AS VARCHAR(10)) AS treeId,
              COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS treeName,
              CAST(ti.is_private AS bit) AS isPrivate,
              tn.text AS name,
              CAST(tn.is_leaf_node AS bit) AS isLeafNode,
              CAST(np.breadcrumb AS NVARCHAR(MAX)) AS breadcrumb,
              CAST(tn.review_status AS NVARCHAR(20)) AS reviewStatus,
              tn.submitted_at AS submittedAt,
              tn.submitted_by_user_details AS submittedByUserDetails,
              tn.reviewed_at AS reviewedAt,
              tn.reviewed_by_user_details AS reviewedByUserDetails,
              tn.rejection_comment AS rejectionComment
            FROM tree_nodes tn
            INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
            INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
            INNER JOIN NodePaths np ON np.id = tn.id
            WHERE ai.app_identifier = @application_identifier
              AND ti.deleted_at IS NULL
              AND tn.deleted_at IS NULL
              AND COALESCE(ti.approval_enabled, 0) = 1
              AND tn.review_status = @review_status
            ORDER BY ti.id DESC, np.breadcrumb ASC;
          `),
        new sql.Request()
          .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
          .input('review_status', sql.NVarChar(20), reviewStatus)
          .query(`
            WITH NodePaths AS (
              SELECT
                tn.id,
                tn.tree_instance_id,
                tn.parent_id,
                tn.text,
                CAST(tn.text AS NVARCHAR(MAX)) AS breadcrumb
              FROM tree_nodes tn
              WHERE tn.parent_id IS NULL
                AND tn.deleted_at IS NULL

              UNION ALL

              SELECT
                child.id,
                child.tree_instance_id,
                child.parent_id,
                child.text,
                CAST(parent_path.breadcrumb + N' > ' + child.text AS NVARCHAR(MAX)) AS breadcrumb
              FROM tree_nodes child
              INNER JOIN NodePaths parent_path ON child.parent_id = parent_path.id
              WHERE child.deleted_at IS NULL
            )
            SELECT
              CAST(files.id AS VARCHAR(10)) AS id,
              CAST(tn.id AS VARCHAR(10)) AS nodeId,
              CAST(tn.tree_instance_id AS VARCHAR(10)) AS treeId,
              COALESCE(NULLIF(ti.display_name, ''), CONCAT('Tree ', ti.id)) AS treeName,
              CAST(ti.is_private AS bit) AS isPrivate,
              CAST(np.breadcrumb AS NVARCHAR(MAX)) AS nodeBreadcrumb,
              files.original_file_name AS fileName,
              CAST(files.review_status AS NVARCHAR(20)) AS reviewStatus,
              files.submitted_at AS submittedAt,
              files.submitted_by_user_details AS submittedByUserDetails,
              files.reviewed_at AS reviewedAt,
              files.reviewed_by_user_details AS reviewedByUserDetails,
              files.rejection_comment AS rejectionComment
            FROM tree_node_detail_files files
            INNER JOIN tree_nodes tn ON tn.id = files.tree_node_id
            INNER JOIN tree_instance ti ON ti.id = tn.tree_instance_id
            INNER JOIN application_instance ai ON ai.id = ti.application_instance_id
            INNER JOIN NodePaths np ON np.id = tn.id
            WHERE ai.app_identifier = @application_identifier
              AND ti.deleted_at IS NULL
              AND tn.deleted_at IS NULL
              AND files.deleted_at IS NULL
              AND COALESCE(ti.approval_enabled, 0) = 1
              AND files.review_status = @review_status
            ORDER BY ti.id DESC, np.breadcrumb ASC, files.created_at DESC, files.id DESC;
          `),
      ]);

      return {
        trees: treeResult.recordset.filter((tree) => reviewableTreeIds.has(String(tree.id))),
        nodes: nodeResult.recordset.filter((node) => reviewableTreeIds.has(String(node.treeId))),
        attachments: attachmentResult.recordset.filter((attachment) => reviewableTreeIds.has(String(attachment.treeId))),
      };
    });

    return NextResponse.json({
      reviewStatus,
      trees: result.trees,
      nodes: result.nodes,
      attachments: result.attachments,
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: getErrorStatus(error) });
  }
}