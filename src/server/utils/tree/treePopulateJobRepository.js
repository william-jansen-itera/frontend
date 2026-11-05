import { randomUUID } from 'crypto';
import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

const jobColumns = `
  job.id AS jobId, job.tree_instance_id AS treeId, job.job_type AS jobType, job.status,
  TRY_CAST(JSON_VALUE(job.result_payload, '$.rootNodeCount') AS INT) AS rootNodeCount,
  TRY_CAST(JSON_VALUE(job.result_payload, '$.totalNodeCount') AS INT) AS totalNodeCount,
  job.failure_summary AS failureSummary, job.created_at AS createdAt
`;

export async function createOrGetPopulateJob({ tree, principal }) {
  return withSqlConnection(async () => {
    const transaction = new sql.Transaction();
    await transaction.begin();

    try {
      const result = await new sql.Request(transaction)
        .input('tree_id', sql.Int, Number(tree.id))
        .input('application_identifier', sql.NVarChar(100), getRequiredApplicationIdentifier())
        .input('job_id', sql.UniqueIdentifier, randomUUID())
        .input('input_payload', sql.NVarChar(sql.MAX), JSON.stringify({ treeName: tree.name, description: tree.description }))
        .input('requested_by', sql.NVarChar(100), principal?.objectId ?? principal?.userId ?? null)
        .query(`
          DECLARE @application_instance_id INT;
          SELECT @application_instance_id = ti.application_instance_id
          FROM dbo.tree_instance ti WITH (UPDLOCK, HOLDLOCK)
          INNER JOIN dbo.application_instance ai ON ai.id = ti.application_instance_id
          WHERE ti.id = @tree_id AND ai.app_identifier = @application_identifier AND ti.deleted_at IS NULL;

          IF @application_instance_id IS NULL THROW 50001, 'Tree was not found', 1;

          SELECT ${jobColumns}, CAST(0 AS BIT) AS isNew
          FROM dbo.tree_jobs job
          WHERE job.application_instance_id = @application_instance_id
            AND job.tree_instance_id = @tree_id AND job.status IN ('queued', 'running');

          IF @@ROWCOUNT = 0
          BEGIN
            INSERT dbo.tree_jobs
              (id, application_instance_id, tree_instance_id, job_type, input_payload, requested_by_object_id, status)
            VALUES (@job_id, @application_instance_id, @tree_id, 'populate', @input_payload, @requested_by, 'queued');

            SELECT ${jobColumns}, CAST(1 AS BIT) AS isNew
            FROM dbo.tree_jobs job WHERE job.id = @job_id;
          END;
        `);

      await transaction.commit();
      return result.recordsets.at(-1)[0];
    } catch (error) {
      if (transaction._aborted !== true) await transaction.rollback();
      throw error;
    }
  });
}

export async function getTreeJob({ jobId, treeId }) {
  return withSqlConnection(async () => {
    const result = await new sql.Request()
      .input('job_id', sql.UniqueIdentifier, jobId || null)
      .input('tree_id', sql.Int, Number(treeId))
      .input('application_identifier', sql.NVarChar(100), getRequiredApplicationIdentifier())
      .query(`
        SELECT TOP 1 ${jobColumns}
        FROM dbo.tree_jobs job
        INNER JOIN dbo.application_instance ai ON ai.id = job.application_instance_id
        INNER JOIN dbo.tree_instance ti ON ti.id = job.tree_instance_id AND ti.application_instance_id = ai.id
        WHERE ai.app_identifier = @application_identifier AND ti.deleted_at IS NULL
          AND job.tree_instance_id = @tree_id
          AND (@job_id IS NULL OR job.id = @job_id)
        ORDER BY job.created_at DESC;
      `);

    return result.recordset[0] ?? null;
  });
}

export async function failQueuedPopulateJob(jobId) {
  return withSqlConnection(async () => new sql.Request()
    .input('job_id', sql.UniqueIdentifier, jobId)
    .query(`
      UPDATE dbo.tree_jobs SET status = 'failed', failure_summary = 'Could not queue tree population.',
        finished_at = SYSUTCDATETIME(), updated_at = SYSUTCDATETIME()
      WHERE id = @job_id AND job_type = 'populate' AND status = 'queued';
    `));
}