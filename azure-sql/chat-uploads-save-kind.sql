IF COL_LENGTH('dbo.chat_uploads', 'save_kind') IS NULL
BEGIN
  ALTER TABLE dbo.chat_uploads ADD save_kind NVARCHAR(20) NULL;
END;

IF COL_LENGTH('dbo.chat_uploads', 'extracted_note_text') IS NULL
BEGIN
  ALTER TABLE dbo.chat_uploads ADD extracted_note_text NVARCHAR(4000) NULL;
END;

IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = 'CK_chat_uploads_save_kind')
BEGIN
  ALTER TABLE dbo.chat_uploads ADD CONSTRAINT CK_chat_uploads_save_kind
    CHECK (CASE
      WHEN save_kind IS NULL AND extracted_note_text IS NULL THEN 1
      WHEN save_kind = N'attachment' AND extracted_note_text IS NULL THEN 1
      WHEN save_kind = N'note' AND extracted_note_text IS NOT NULL AND LEN(extracted_note_text) BETWEEN 1 AND 4000 THEN 1
      ELSE 0
    END = 1);
END;