# Azure AI Search Artifacts

These files capture the current Azure AI Search setup for the tree content search prototype.

Files:
- `tree-content-index.json`: shared index schema for SQL node records and blob attachment records.
- `tree-sql-datasource.json`: Azure SQL data source pointing at `dbo.vw_tree_search_nodes`.
- `tree-sql-indexer.json`: SQL indexer that writes node documents into the shared index.
- `tree-blob-datasource.json`: blob container data source for node attachments.
- `tree-blob-indexer.json`: blob indexer that writes attachment documents into the shared index.

Before using these in the portal or REST:
- Replace placeholder values such as `<search-index-name>`, `<storage-account>`, `<container-name>`, `<your-server>`, `<your-database>`, `<your-user>`, and `<your-password>`.
- The SQL data source uses a high-water-mark change detection policy on `updatedAt`, so the source view must keep that value advancing whenever a searchable node row changes.
- Keep custom blob metadata source field names lowercase in the blob indexer: `sourcetype`, `treeid`, `nodeid`, `blobname`, `applicationidentifier`.
- After changing indexer mappings or source metadata, use `Reset` and then `Run` on the indexer.

Current design notes:
- Deep links are computed in the app from `treeId` and `nodeId`.
- SQL and blob records live in the same index but use different document keys.
- Vector fields and semantic configuration are intentionally omitted from this first saved version to keep the baseline portal setup simple.
