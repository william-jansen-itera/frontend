import { NextResponse } from 'next/server';
import { requireAuthenticatedPrincipal } from '@/server/utils/auth';
import { getTreeList } from '@/server/utils/tree/treeCatalog';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';
import { queryTreeAttachmentsByReviewStatus, queryTreeNodesByReviewStatus } from '@/server/utils/tree/treeRecordRepository';

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
    const principal = requireAuthenticatedPrincipal(request);
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
        queryTreeNodesByReviewStatus(getRequiredApplicationIdentifier(), reviewStatus),
        queryTreeAttachmentsByReviewStatus(getRequiredApplicationIdentifier(), reviewStatus),
      ]);

      return {
        trees: treeResult.recordset.filter((tree) => reviewableTreeIds.has(String(tree.id))),
        nodes: nodeResult.filter((node) => reviewableTreeIds.has(String(node.treeId))),
        attachments: attachmentResult.filter((attachment) => reviewableTreeIds.has(String(attachment.treeId))),
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