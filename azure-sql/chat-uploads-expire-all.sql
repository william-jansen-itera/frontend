UPDATE dbo.chat_uploads
SET created_at = DATEADD(day, -1, created_at),
    expires_at = DATEADD(day, -1, expires_at);