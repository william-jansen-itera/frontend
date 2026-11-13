# Azure AI Search Artifacts

These files capture the current Azure AI Search setup for the tree content search prototype.

## Temporary chat uploads

`chat-upload-index.json`, `chat-upload-datasource.json`, `chat-upload-skillset.json`, and `chat-upload-indexer.json` describe an isolated, on-demand OCR and image-caption index for staged chat files. They are not deployed by this repository. Apply `frontend/azure-sql/chat-uploads.sql` separately before enabling uploads; for an existing table, rerun it to add the nullable `caption` column. The frontend stages one file, passes its ID to the `process_upload` agent tool, and polls the owner-scoped status endpoint for a temporary placement note and caption. The Function worker saves both in the same upload row before deleting the Search document. The browser includes `{ note, caption }` in the existing automated ready-for-preview message sent to the agent; this does not preview, approve, or save tree content. Publish the updated agent tool configuration before enabling this feature.

Provision a private `chat-uploads` container in a **separate** staging storage account; disable blob soft delete and versioning on that account without changing the existing attachment account. Set `CHAT_UPLOAD_STORAGE_CONNECTION_STRING` on both the frontend and Function App for the `chat-upload-jobs` queue; blob access may alternatively use `CHAT_UPLOAD_STORAGE_ACCOUNT_URL`. Set `CHAT_UPLOAD_CONTAINER_NAME=chat-uploads` on both apps. Keep `AzureWebJobsStorage` and `AZURE_STORAGE_CONNECTION_STRING` on the existing tree/host storage account. Configure `CHAT_UPLOAD_SEARCH_INDEX_NAME=chat-upload-index`, `CHAT_UPLOAD_SEARCH_INDEXER_NAME=chat-upload-indexer`, and the existing `AZURE_SEARCH_ENDPOINT`/`AZURE_SEARCH_ADMIN_KEY` on the Function App. Replace the placeholder Search data-source credential with the staging account connection string or its managed-identity resource ID, and the skillset placeholders with a permitted Foundry enrichment resource and the existing custom-skill-processor Function key. Apply the SQL migration first, then deploy the index schema, datasource, skillset, and indexer before the updated Function worker and frontend; do not schedule the indexer. The skillset generates raw captions and confidence scores, then filters captions using the same custom skill and threshold as the tree index; only filtered captions appear in the browser's completion message. A one-day Blob lifecycle deletion rule is only a fallback for orphaned files, not a 24-hour deletion guarantee. The dedicated `chatUploadCleanup` timer runs daily at midnight UTC and deletes uploads that have expired; the existing tree purge is unchanged.

Private trees named `personal cache` are not indexed: the SQL search view excludes their nodes, and blob attachments are marked for the blob indexer to skip.

Files:
- `tree-content-index.json`: shared index schema for SQL node records and blob attachment records.
- `tree-sql-datasource.json`: Azure SQL data source pointing at `dbo.vw_tree_search_nodes`.
- `tree-sql-indexer.json`: SQL indexer that writes node documents into the shared index.
- `tree-blob-datasource.json`: blob container data source for node attachments.
- `tree-blob-indexer.json`: blob indexer that writes attachment documents into the shared index.
- `tree-image-enrichment-skillset.json`: OCR and image-description enrichment for image attachments and embedded document images.

Custom skill notes:
- The image-enrichment skillset now expects a deployed Azure Function custom skill endpoint for confidence-based qualification.
- Replace `<custom-skill-function-uri>` in `tree-image-enrichment-skillset.json` with the full HTTPS function invoke URL before updating the skillset in Azure.
- The custom skill writes filtered descriptions into `imageDescriptionFiltered`, while `imageDescription` and `imageDescriptionConfidence` remain available for debugging.

Before using these in the portal or REST:
- Replace placeholder values such as `<search-index-name>`, `<storage-account>`, `<container-name>`, `<your-server>`, `<your-database>`, `<your-user>`, and `<your-password>`.
- The SQL data source uses a high-water-mark change detection policy on `updatedAt`, so the source view must keep that value advancing whenever a searchable node row changes.
- Keep custom blob metadata source field names lowercase in the blob indexer: `sourcetype`, `treeid`, `nodeid`, `blobname`, `applicationidentifier`.
- After changing skillsets, indexer mappings, or source metadata, use `Reset` and then `Run` on the blob indexer.

VS Code Azure MCP access: The dev Search service `mds-ai-search-dev-wj` is in subscription `03a40ea8-84cc-4182-85a2-a8d0c61ceb76`, tenant `a18232f7-c6f8-48da-b8e1-838c7fac8ab1`. To check the tenant for another subscription, open that subscription in the Azure portal and read its **Tenant ID** on the Overview or Properties page. In VS Code, run **Preferences: Open User Settings (JSON)** from the Command Palette and add `"@azure.argTenant": "a18232f7-c6f8-48da-b8e1-838c7fac8ab1"` inside the existing JSON object (with a comma if needed). Fully restart VS Code and the Azure MCP server. The tenant setting does not select a subscription; select the dev subscription separately if it is not the default. Do not run `Powershell/Delete-ChatUploadSearchDocument.ps1` to test access: it deletes a document.

Current design notes:
- Deep links are computed in the app from `treeId` and `nodeId`.
- SQL and blob records live in the same index but use different document keys.
- The SQL search view excludes private trees named `personal cache`. New attachments in those trees carry the `AzureSearch_Skip=true` blob metadata marker, so the blob indexer skips them too.
- To roll this out to an existing index, deploy the SQL view and application change, then find the affected tree IDs in `dbo.tree_instance` using `is_private = 1` and a trimmed, case-insensitive `display_name = 'personal cache'`. For each ID, query the search index with a `treeId` filter, collect document `id` values, and delete those documents using the Search Documents delete action. Filtering the SQL view or marking blobs to skip does not delete documents already in the index. Recheck those tree IDs after both indexers run.
- Attachment documents can now project OCR text and image descriptions into dedicated search fields.
- Searchable image-description matches should come from `imageDescriptionFiltered`, not the raw caption field.
- Vector fields and semantic configuration are intentionally omitted from this first saved version to keep the baseline portal setup simple.
