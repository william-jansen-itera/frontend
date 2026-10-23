# Azure AI Search Artifacts

These files capture the current Azure AI Search setup for the tree content search prototype.

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

Current design notes:
- Deep links are computed in the app from `treeId` and `nodeId`.
- SQL and blob records live in the same index but use different document keys.
- The SQL search view excludes private trees named `personal cache`. New attachments in those trees carry the `AzureSearch_Skip=true` blob metadata marker, so the blob indexer skips them too.
- To roll this out to an existing index, deploy the SQL view and application change, then find the affected tree IDs in `dbo.tree_instance` using `is_private = 1` and a trimmed, case-insensitive `display_name = 'personal cache'`. For each ID, query the search index with a `treeId` filter, collect document `id` values, and delete those documents using the Search Documents delete action. Filtering the SQL view or marking blobs to skip does not delete documents already in the index. Recheck those tree IDs after both indexers run.
- Attachment documents can now project OCR text and image descriptions into dedicated search fields.
- Searchable image-description matches should come from `imageDescriptionFiltered`, not the raw caption field.
- Vector fields and semantic configuration are intentionally omitted from this first saved version to keep the baseline portal setup simple.
