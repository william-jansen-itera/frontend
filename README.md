This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Configuration

The app reads its server-side settings from environment variables, typically through `.env.local` in local development and Azure Static Web App application settings in deployment.

Required Foundry settings:

- `AZURE_AI_PROJECT_ENDPOINT`
- `AZURE_AI_MODEL_DEPLOYMENT_NAME`

Optional chat settings:

- `AZURE_AI_AGENT_NAME` defaults to `tree-search-agent`
- `AZURE_AI_AGENT_SYNC_TOKEN` enables manual `/api/chat/sync` protection
- `APPLICATION_DEBUG` controls whether debug data is included in chat and search responses

Optional Azure AI Search settings:

- `AZURE_SEARCH_ENDPOINT`
- `AZURE_SEARCH_INDEX_NAME`
- `AZURE_SEARCH_QUERY_KEY` for search/query requests
- `AZURE_SEARCH_ADMIN_KEY` for server-side indexer run requests
- `AZURE_SEARCH_SQL_INDEXER_NAME` defaults to `tree-sql-indexer`
- `AZURE_SEARCH_BLOB_INDEXER_NAME` defaults to `tree-blob-indexer`

`APPLICATION_DEBUG` accepts common boolean values such as `true`, `false`, `1`, `0`, `yes`, `no`, `on`, and `off`. If the setting is missing or invalid, the default is `false`.

For deployed environments, set the same variables in the Azure Static Web App under `Configuration` -> `Application settings` so runtime behavior matches local development.

## Attachment Indexing Lifecycle

Blob soft delete for attachments is implemented as a combination of SQL state, Blob Storage account settings, and Azure AI Search indexer behavior.

Current setup:

- The attachment metadata row in `tree_node_detail_files` is never hard-deleted during a normal attachment delete, node delete, or tree delete. Instead, the app sets `tree_node_detail_files.deleted_at` so the attachment can still be matched back to its blob and search document lifecycle.
- The application still calls the normal Azure Blob delete API for attachments. When Blob Storage soft delete is enabled on the storage account, that delete moves the blob into the storage account's soft-delete retention state instead of physically erasing it immediately.
- The blob datasource in `azure-search/tree-blob-datasource.json` uses `NativeBlobSoftDeleteDeletionDetectionPolicy`, so the blob indexer can remove attachment documents from Azure AI Search after the blob has been soft-deleted.
- This setup assumes blob versioning is not enabled on the storage account. Native blob soft-delete deletion detection does not support versioned blobs.
- Tree and node search documents are separate from attachment blob documents. They still rely on the SQL search view `dbo.vw_tree_search_nodes` and its `isDeletedMarker` soft-delete policy.

Current runtime behavior:

- Deleting only an attachment sets `tree_node_detail_files.deleted_at` and soft-deletes the blob.
- Deleting a node subtree sets `tree_nodes.deleted_at`, sets `tree_node_detail_files.deleted_at` for descendant attachments, and soft-deletes descendant blobs.
- Deleting a whole tree sets `tree_instance.deleted_at`, sets `tree_node_detail_files.deleted_at` for the tree's attachments, and soft-deletes those blobs.
- The Admin page exposes individually deleted attachments separately from deleted nodes and trees, with explicit `Undelete` and `Purge` actions when the parent node and tree are still active.
- Undelete restores blobs by calling the Blob Storage undelete API, then rewrites the blob's existing metadata so Blob Storage updates `LastModified` and the blob indexer can reprocess the restored attachment. The app also clears matching `tree_node_detail_files.deleted_at` values when the attachment was deleted as part of that same node or tree delete lifecycle.
- Live attachment reads only return rows where `tree_node_detail_files.deleted_at IS NULL`.

Purge behavior is intentionally different from normal soft delete:

- Admin purge first deletes the related node and attachment documents directly from Azure AI Search by document id.
- Only after that succeeds does the app hard-delete the SQL rows.
- The blob delete call still follows the storage account's soft-delete retention policy, so purge does not guarantee immediate physical blob destruction inside the storage account.

In short, normal delete and undelete are reversible, index cleanup for attachments is blob-indexer-driven, and purge is the irreversible step for SQL data plus direct search document removal.

## Attachment Delete and Purge Runbook

Use this checklist when validating attachment soft delete, restore, indexing, and purge behavior.

### Preconditions
3. Confirm Blob Storage soft delete is enabled on the storage account.
4. Confirm blob versioning is disabled on the storage account.
5. Confirm `AZURE_SEARCH_ADMIN_KEY` is configured in the app environment used for purge testing.

### Attachment Delete

1. Upload an attachment to a leaf node in Notes.
2. Delete only that attachment.
3. Verify the attachment disappears from the Notes UI immediately.
4. Verify the SQL row remains and `deleted_at` is populated.
5. Verify the blob is soft-deleted rather than permanently missing.
6. Run the blob indexer and verify the attachment search document disappears.

### Attachment Undelete and Purge

1. Open Admin and confirm the deleted attachment appears in the Deleted Attachments panel.
2. Undelete the attachment from Admin.
3. Verify the SQL row returns to `deleted_at = NULL` and the blob is restored.
4. Run the blob indexer and verify the attachment search document returns.
5. Soft-delete the same attachment again.
6. Purge it from Admin.
7. Verify the attachment search document is removed immediately without waiting for the blob indexer.
8. Verify the SQL row is hard-deleted and the blob is deleted into storage soft-delete retention.

### Node Delete and Undelete

1. Create a node subtree with at least one descendant attachment.
2. Soft-delete the node from Notes.
3. Verify the subtree disappears from the active tree view.
4. Verify descendant `tree_nodes.deleted_at` values are set.
5. Verify descendant `tree_node_detail_files.deleted_at` values are set.
6. Verify descendant blobs are soft-deleted.
7. Run the SQL indexer and verify node search documents disappear.
8. Run the blob indexer and verify attachment search documents disappear.
9. Undelete the node from Admin.
10. Verify the subtree, attachments, and blobs return and matching attachment rows are cleared back to `deleted_at = NULL`.

### Tree Delete and Undelete

1. Soft-delete a whole tree that has nodes and attachments.
2. Verify the tree no longer appears in active Trees and Notes lists.
3. Verify `tree_instance.deleted_at` is set.
4. Verify related attachment rows have `deleted_at` set.
5. Verify related blobs are soft-deleted.
6. Run both indexers and verify node and attachment search documents disappear.
7. Undelete the tree from Admin.
8. Verify the tree, nodes, attachments, and blobs return.

### Purge Safety

1. Soft-delete a node subtree with attachments.
2. Purge it from Admin or the node purge flow.
3. Verify the API succeeds only when Azure AI Search document delete succeeds.
4. Verify node search documents are removed immediately.
5. Verify attachment search documents are removed immediately.
6. Verify the SQL rows for the purged nodes are hard-deleted.
7. Verify blobs are deleted into storage soft-delete retention.
8. Repeat the same test for whole-tree purge.

### Failure Check

1. Remove or invalidate `AZURE_SEARCH_ADMIN_KEY` in a non-production environment.
2. Attempt a purge.
3. Verify purge fails closed and SQL hard-delete does not proceed.
4. Verify the soft-deleted state remains intact for retry.
5. Restore configuration and verify the same purge succeeds.

### Regression Check

1. Verify ordinary note edits still work.
2. Verify attachment upload still works.
3. Verify chat and search still return expected tree-scoped results.
4. Verify deleted attachments no longer appear in node detail payloads.
5. Verify deleted attachments no longer contribute to attachment metadata in `dbo.vw_tree_search_nodes`.

## Admin Search Indexing

The Admin page now separates `Search indexing` from `Deletions`.

- `Search indexing` can start Azure AI Search indexer operations for `node data`, `blob content`, or `all`.
- `incremental` means the app calls `run` on the selected indexer or indexers.
- `full` means the app calls `reset` and then `run` on the selected indexer or indexers.
- `node data` targets the SQL indexer configured by `AZURE_SEARCH_SQL_INDEXER_NAME`.
- `blob content` targets the blob indexer configured by `AZURE_SEARCH_BLOB_INDEXER_NAME`.
- `all` starts both indexers in the selected mode.

## Security

Security is currently handled in three layers.

1. Azure Static Web Apps route protection in `staticwebapp.config.json` is the first gate. Protected pages and API routes are assigned roles such as `mdsusers` and `mdsadmin`, and unauthenticated requests are redirected to `/.auth/login/aad`.
2. Navigation trimming in `src/app/layout.js` is a user-experience layer. The nav defines role requirements per link and hides links when the signed-in principal does not have the required role. This uses the shared role helper in `src/shared/clientPrincipal.js` together with auth state from `src/app/useAuth.js`.
3. Server-side in-code checks remain the enforcement boundary inside the app. API routes parse the client principal with `src/server/utils/auth.js`, then apply route-specific authorization such as `assertTreeAccess(...)` for tree-scoped access and `assertAdminPrincipal(...)` or `hasClientPrincipalRole(..., 'mdsadmin')` for admin-only operations.

The important distinction is that navigation trimming is not security by itself. Even if a link is hidden, the request still blocked by Static Web Apps route rules and/or server-side authorization checks.

For Azure AI Search SQL indexing, soft-delete detection now depends on the string column `isDeletedMarker` in `dbo.vw_tree_search_nodes`, matched by the datasource policy value `true`. The older computed `bit` column `isDeleted` remains useful for querying and admin UI filtering, but it did not reliably trigger document deletion in the SQL indexer.

The application only requests an on-demand SQL indexer run for the confirmed `create-leaf-from-chat` flow. Regular edits such as manual note text changes, rename operations, generated child nodes, tree population, expand/collapse state changes, and other routine updates do not trigger the indexer from application code. The scheduled indexer remains the general backstop. `AZURE_SEARCH_ADMIN_KEY` is also required for admin purge flows because purge now directly deletes Azure AI Search documents before hard-deleting SQL records.

## Agent Behavior

### Is tool selection behavior internal to the agent?

Yes, mostly.

The decision to call a tool, call multiple tools, or continue into another tool round is internal to the Foundry-backed agent/model runtime once the app submits a chat turn.

The application controls the boundaries and context for that decision:

- which tools are available for the turn
- how those tools are described
- which recent chat history is included
- how many tool rounds are allowed
- how tool outputs are formatted and sent back

The agent runtime then decides:

- whether to call a tool at all
- which tool to call
- whether to call several tools in one round
- whether to continue into another round after seeing tool outputs
- when to stop and return a final answer

In other words, tool-choice behavior is not hardcoded in the application, but it is strongly shaped by the tool definitions, instructions, and history that the application sends to the agent.

### Chat History vs. `priorToolInvocations`

The application uses two different continuity mechanisms for follow-up behavior, and they serve different purposes.

Chat history is for the agent. It contains the user and assistant messages that should be replayed as conversational context on later turns. This is the material that gets sent back to the model as prior dialogue.

`priorToolInvocations` are for the server-side broader-answer workflow and related UI affordances. They do not represent general conversation history, and they are not replayed to the model as structured history. Instead, they preserve the immediately preceding grounded-search context when the user chooses the broader-answer option.

The conversation history now keeps all user and assistant turns, including `no_result_offer` and `broader_answer` turns, so the agent can see the full nuance of the exchange. Follow-up submissions are sent to the model with the user's message verbatim rather than being rewritten by the server. In practice:

- chat history preserves the full conversational record for the agent, including no-result and broader-answer turns
- the current user message is sent to the model as written
- `priorToolInvocations` preserve prior search context for server-side follow-up handling and UI actions
- UI actions such as `Add to: [tool]` on broader-answer turns can still know which earlier tool context the answer came from even though those tool references are not part of structured model history

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
