import { getRequiredApplicationIdentifier, sql, withSqlConnection } from '@/server/utils/sql';

export async function createChatUpload({ uploadId, ownerObjectId, fileName, contentType, byteSize, sha256, blobName, createdAt, expiresAt }) {
  const result = await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .input('owner_object_id', sql.NVarChar(100), ownerObjectId)
    .input('file_name', sql.NVarChar(255), fileName)
    .input('content_type', sql.NVarChar(255), contentType)
    .input('byte_size', sql.Int, byteSize)
    .input('sha256', sql.Char(64), sha256)
    .input('blob_name', sql.NVarChar(512), blobName)
    .input('created_at', sql.DateTime2, createdAt)
    .input('expires_at', sql.DateTime2, expiresAt)
    .query(`
      INSERT INTO dbo.chat_uploads (
        id, application_instance_id, owner_object_id, file_name, content_type,
        byte_size, sha256, blob_name, status, created_at, expires_at
      )
      SELECT @id, ai.id, @owner_object_id, @file_name, @content_type,
        @byte_size, @sha256, @blob_name, N'staged', @created_at, @expires_at
      FROM dbo.application_instance ai
      WHERE ai.app_identifier = @application_identifier;
    `));

  if (result.rowsAffected[0] !== 1) {
    throw new Error('Application instance was not found for this upload.');
  }
}

export async function getOwnedChatUpload({ uploadId, ownerObjectId }) {
  const result = await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .input('owner_object_id', sql.NVarChar(100), ownerObjectId)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      SELECT TOP 1 u.id, u.file_name AS fileName, u.content_type AS contentType,
        u.byte_size AS byteSize, u.sha256, u.blob_name AS blobName,
        u.save_kind AS saveKind, u.extracted_note_text AS extractedNoteText,
        u.status, u.note, u.caption, u.failure_summary AS failureSummary,
        u.expires_at AS expiresAt
      FROM dbo.chat_uploads u
      INNER JOIN dbo.application_instance ai ON ai.id = u.application_instance_id
      WHERE u.id = @id AND u.owner_object_id = @owner_object_id
        AND ai.app_identifier = @application_identifier
        AND u.expires_at > SYSUTCDATETIME();
    `));

  return result.recordset[0] ?? null;
}

export async function queueOwnedChatUpload({ uploadId, ownerObjectId }) {
  const result = await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .input('owner_object_id', sql.NVarChar(100), ownerObjectId)
    .input('application_identifier', sql.NVarChar, getRequiredApplicationIdentifier())
    .query(`
      UPDATE u SET status = N'queued', updated_at = SYSUTCDATETIME()
      OUTPUT inserted.id
      FROM dbo.chat_uploads u
      INNER JOIN dbo.application_instance ai ON ai.id = u.application_instance_id
      WHERE u.id = @id AND u.owner_object_id = @owner_object_id
        AND ai.app_identifier = @application_identifier AND u.status = N'staged'
        AND u.expires_at > SYSUTCDATETIME();
    `));
  return result.rowsAffected[0] === 1;
}

export async function failQueuedChatUpload(uploadId) {
  await withSqlConnection(() => new sql.Request()
    .input('id', sql.UniqueIdentifier, uploadId)
    .query(`
      UPDATE dbo.chat_uploads SET status = N'failed',
        failure_summary = N'Could not queue file processing.', updated_at = SYSUTCDATETIME()
      WHERE id = @id AND status = N'queued';
    `));
}