This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Configuration

The app reads its server-side settings from environment variables, typically through `.env.local` in local development and Azure Static Web App application settings in deployment.

Graph role-mapping settings:

- `MDSUSERS_ENTRA_GROUP_ID` for the Entra group that maps to `mdsusers`
- `MDSADMINS_ENTRA_GROUP_ID` for the Entra group that maps to `mdsadmins`

When `auth.rolesSource` is enabled in `staticwebapp.config.json`, the deployed Static Web App calls `POST /api/get-roles` after sign-in. That route resolves Entra group membership through Microsoft Graph and returns the matching app roles. The current deployment uses the Entra app registration identified by `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_CLIENT_SECRET` for Graph access.

The Entra groups are not used directly by the application. They are mapped to the app-facing Static Web Apps roles `mdsusers` and `mdsadmins`, and the rest of the application continues to authorize only against those role names. This keeps route protection, navigation trimming, and server-side checks stable even if the underlying Entra group structure changes.

These custom role names do not need to appear as pre-created objects in the Azure portal Role Management view. That portal surface reflects Static Web Apps-managed user-role assignments, while this app can also receive `mdsusers` and `mdsadmins` dynamically from `rolesSource` at sign-in. As a result, the Role Management list can be empty even though those role names are still valid and actively used by route protection and application checks.

With `Assignment required` set to `No` on the Entra enterprise application, day-to-day user access is now effectively managed through the two Entra groups rather than through individual Static Web Apps role assignments. Users who can sign in receive `mdsusers` and `mdsadmins` dynamically from `rolesSource` based on their current group membership, so the Static Web Apps Role Management list can be cleared unless you intentionally want a second, manual assignment path.

Before enabling this in Azure, grant that app registration the minimum Microsoft Graph application permissions needed for membership checks, and set the two group ID application settings in the Static Web App configuration.

Required Foundry settings:

- `AZURE_AI_PROJECT_ENDPOINT`
- `AZURE_AI_MODEL_DEPLOYMENT_NAME`

Optional chat settings:

- `AZURE_AI_AGENT_NAME` defaults to `tree-search-agent`
- `APPLICATION_DEBUG` controls whether debug data is included in chat and search responses

Optional Azure AI Search settings:

- `AZURE_SEARCH_ENDPOINT`
- `AZURE_SEARCH_INDEX_NAME`
- `AZURE_SEARCH_QUERY_KEY` for search/query requests
- `AZURE_SEARCH_ADMIN_KEY` for server-side indexer run requests
- `AZURE_SEARCH_SQL_INDEXER_NAME` defaults to `tree-sql-indexer`
- `AZURE_SEARCH_BLOB_INDEXER_NAME` defaults to `tree-blob-indexer`

Optional maintenance settings:

- `AZURE_PURGE_FUNCTION_URL` is the full HTTP purge Function URL used by frontend admin routes for manual purge actions
- `AZURE_PURGE_FUNCTION_KEY` is the server-side function key used when the frontend calls the purge Function
- `AZURE_SECRET_FUNCTION_URL` is the full HTTP secret-broker Function URL used by frontend notes routes for tree secret save and reveal actions
- `AZURE_SECRET_FUNCTION_KEY` is the server-side function key used when the frontend calls the secret-broker Function

### Tree Secret Flow

Leaf-node secrets are stored and revealed through a brokered server flow rather than direct client access.

1. The Notes page saves ordinary explanatory text in `notes`, but sends secret values to the Next.js notes API separately.
2. The notes API authorizes tree access, then calls the Azure Function secret broker using `AZURE_SECRET_FUNCTION_URL` and `AZURE_SECRET_FUNCTION_KEY`.
3. The Function App uses its own Azure identity to write the secret to Key Vault and returns only safe reference metadata for SQL storage.
4. The client never receives or stores the underlying Key Vault secret name.
5. When a user clicks `Reveal`, the client sends only the tree and node identifiers back to the notes API.
6. The notes API looks up the stored server-side secret metadata for that leaf, calls the broker, and returns the secret value only for that authorized request.

This keeps secret values out of searchable note content, keeps Key Vault identity off the client, and avoids exposing the actual Key Vault secret name in normal browser traffic.

Optional analytics settings:

- `ANALYTICS_IGNORED_IPS` is a comma-separated list of client IP addresses that should be ignored by page-visit logging, for example `203.0.113.10,198.51.100.7`

Search engine metadata:

- Set `SITE_URL` to the canonical production origin (for example `https://example.com`) so `robots.txt` and `sitemap.xml` always use that hostname. If unset, they use the incoming request's host.
- The sitemap lists only `/`, `/about`, and `/contact`. Protected routes rely on authentication, not `robots.txt`, for access control.

`APPLICATION_DEBUG` accepts common boolean values such as `true`, `false`, `1`, `0`, `yes`, `no`, `on`, and `off`. If the setting is missing or invalid, the default is `false`.

For deployed environments, set the same variables in the Azure Static Web App under `Configuration` -> `Application settings` so runtime behavior matches local development.

## Attachment Indexing Lifecycle

Blob soft delete for attachments is implemented as a combination of SQL state, Blob Storage account settings, and Azure AI Search indexer behavior.

Current setup:

- For ordinary trees, the attachment metadata row in `tree_node_detail_files` is not hard-deleted during an attachment delete, node delete, or tree delete. Instead, the app sets `tree_node_detail_files.deleted_at` so the attachment can still be matched back to its blob and search document lifecycle.
- The application still calls the normal Azure Blob delete API for attachments. When Blob Storage soft delete is enabled on the storage account, that delete moves the blob into the storage account's soft-delete retention state instead of physically erasing it immediately.
- The blob datasource in `azure-search/tree-blob-datasource.json` uses `NativeBlobSoftDeleteDeletionDetectionPolicy`, so the blob indexer can remove attachment documents from Azure AI Search after the blob has been soft-deleted.
- This setup assumes blob versioning is not enabled on the storage account. Native blob soft-delete deletion detection does not support versioned blobs.
- Tree and node search documents are separate from attachment blob documents. They still rely on the SQL search view `dbo.vw_tree_search_nodes` and its `isDeletedMarker` soft-delete policy.

Current runtime behavior:

- Deleting only an attachment sets `tree_node_detail_files.deleted_at` and soft-deletes the blob.
- Deleting an ordinary node subtree sets `tree_nodes.deleted_at`, sets `tree_node_detail_files.deleted_at` for descendant attachments, and soft-deletes descendant blobs.
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
1. Confirm Blob Storage soft delete is enabled on the storage account.
2. Confirm blob versioning is disabled on the storage account.
3. Confirm `AZURE_SEARCH_ADMIN_KEY` is configured in the app environment used for purge testing.

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

Personal Cache nodes are an exception: deleting one permanently removes its SQL subtree, notes, and attachment records, so it cannot be undeleted from Admin. The app deletes descendant blobs first; if a blob delete fails, SQL deletion is rolled back and any blobs already deleted in that attempt are restored on a best-effort basis. A blob that is already absent does not block SQL deletion. Blob Storage soft-delete retention applies only after a successful blob delete request; the scheduled SQL purge cannot retry a failed blob delete after the Personal Cache rows are gone.

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

## Review Workflow

The application supports an approval workflow for trees, nodes, and attachments. The workflow is opt-in per tree.

### Status model

Review status uses four values:

- `draft`
- `submitted`
- `approved`
- `rejected`

When a tree does not have approval enabled, the effective status for its content is treated as `draft`.

### Enabling approval

- Tree owners can enable or disable approval on the Trees page.
- When approval is disabled for a tree, the app resets the tree, all of its nodes, and all of its attachments back to `draft` and clears review audit metadata and rejection comments.
- Only content from approval-enabled trees appears on the Review page.

### Where review actions happen

- Trees page: whole-tree submit, approve, and reject actions.
- Notes page: node and attachment submit, approve, and reject actions.
- Review page: submitted and rejected items across approval-enabled trees, with bulk actions for the submitted view.

Reject actions require a rejection comment. The comment is stored on the reviewed object and is shown in Notes node details and in the rejected Review view.

### Tree-level behavior

Tree review actions are hierarchical.

- Submitting a tree submits the tree and all nodes and attachments in that tree.
- Approving a tree approves the tree and all nodes and attachments in that tree.
- Rejecting a tree rejects the tree and all nodes and attachments in that tree.

For tree-level reject, the entered rejection comment is written to the tree and also propagated to descendant nodes and attachments that do not already have a rejection comment. Existing child rejection comments are preserved. Approving a tree clears rejection comments in that tree scope.

### Node-level behavior

Node review actions apply only to nodes, not to attachments.

- Submitting a leaf node submits only that leaf node.
- Approving a leaf node approves only that leaf node.
- Rejecting a leaf node rejects only that leaf node.
- Submitting a branch node submits that branch and all descendant nodes.
- Approving a branch node approves that branch and all descendant nodes.
- Rejecting a branch node rejects that branch and all descendant nodes.

Node cascades do not change attachments under those nodes. Attachments remain separately reviewable from the Notes page and Review page.

For node-level reject, the entered rejection comment is applied to the selected node scope. Existing descendant-node rejection comments are preserved. Approving a node scope clears rejection comments in that node scope.

### Attachment-level behavior

Attachments are always reviewed individually.

- Submitting an attachment affects only that attachment.
- Approving an attachment affects only that attachment.
- Rejecting an attachment affects only that attachment.

Attachment approve clears the stored rejection comment for that attachment.

### Review page behavior

- The Review page only lists content from approval-enabled trees.
- The `submitted` view is for approval decisions and supports `Approve`, `Reject`, `Approve All`, and `Reject All`.
- The `rejected` view is for inspection and reopening the underlying item in Trees or Notes. It does not expose resubmit actions.
- Rejection comments are visible in the rejected view.

### Permissions

- Tree owners manage approval enablement.
- Users who can write to a tree, meaning the owner or an editor, can perform node and attachment review actions.
- Review actions still respect the tree's visibility and access rules.

## Security

Security is currently handled in three layers.

1. Azure Static Web Apps route protection in `staticwebapp.config.json` is the first gate. Protected pages and API routes are assigned roles such as `mdsusers` and `mdsadmins`, and unauthenticated requests are redirected to `/.auth/login/aad`.
2. Navigation trimming in `src/app/layout.js` is a user-experience layer. The nav defines role requirements per link and hides links when the signed-in principal does not have the required role. This uses the shared role helper in `src/shared/clientPrincipal.js` together with auth state from `src/app/useAuth.js`.
3. Server-side in-code checks remain the enforcement boundary inside the app. API routes parse the client principal with `src/server/utils/auth.js`, then apply route-specific authorization such as `assertTreeAccess(...)` for tree-scoped access and `assertAdminPrincipal(...)` or `hasClientPrincipalRole(..., 'mdsadmins')` for admin-only operations.

The important distinction is that navigation trimming is not security by itself. Even if a link is hidden, the request still blocked by Static Web Apps route rules and/or server-side authorization checks.

### Principal trust boundary

In production, Entra authenticates the user and Azure Static Web Apps manages the signed-in session. At sign-in, `POST /api/get-roles` maps Entra group membership to app roles; the route rules in `staticwebapp.config.json` then require the appropriate role before forwarding protected API requests. Static Web Apps supplies the Base64-encoded `x-ms-client-principal` header. `src/server/utils/auth.js` decodes that header; the app does not independently verify a signature on it. The header is evidence of identity only because the request arrived through the trusted Static Web Apps gateway, not because Base64 makes its contents tamper-proof.

For chat, `src/app/api/chat/route.js` passes the server-read principal to the agent. The email agent uses it to select the signed-in user's private personal-cache tree. `src/server/utils/agent/personalCacheTreeRepository.js` checks that the tree's stored owner ID matches the principal before cache reads and writes. Authentication identifies the caller; these ownership checks authorize access to a particular tree. The owner ID comes from the principal's object ID when present, otherwise its Static Web Apps `userId`, which is app-specific and should not be assumed to be an Entra object ID.

### Private tree authorization

The notes API checks `assertTreeAccess(...)` against the request principal before reading or changing a tree. An ordinary private tree can be shared with assigned editors: its owner and editors can read and write it. Public trees can be read by anyone, but only their owners and editors can write to them. Only the owner can manage tree access. The check uses the tree's stored owner and editor IDs, not a client-supplied claim of ownership. A client can submit a different tree ID or a direct mutation request, but that does not grant permission to modify the tree. Unlike a shared private tree, personal-cache operations are owner-only; being an editor is not sufficient.

This trust model requires that production API requests cannot bypass Static Web Apps. A direct localhost request can supply a fabricated principal header and is not an authentication test. In a signed-in production check against `GET /api/hello`, a caller-supplied fake principal did not replace the identity returned by the API; that check verifies this route and deployment, not every possible ingress path.

For Azure AI Search SQL indexing, soft-delete detection now depends on the string column `isDeletedMarker` in `dbo.vw_tree_search_nodes`, matched by the datasource policy value `true`. The older computed `bit` column `isDeleted` remains useful for querying and admin UI filtering, but it did not reliably trigger document deletion in the SQL indexer.

The application only requests an on-demand SQL indexer run for the confirmed `create-leaf-from-chat` flow. Regular edits such as manual note text changes, rename operations, generated child nodes, tree population, expand/collapse state changes, and other routine updates do not trigger the indexer from application code. The scheduled indexer remains the general backstop. `AZURE_SEARCH_ADMIN_KEY` is also required in the Function App because purge deletes Azure AI Search documents before hard-deleting SQL records.

## Scheduled Purge

Scheduled retention purge now runs directly inside the companion Azure Function instead of calling back into a frontend maintenance route.

- The Function App is the only place that executes purge logic across SQL, Blob Storage, and Azure AI Search.
- The timer-triggered purge job uses the current `APPLICATION_IDENTIFIER` scope and a fixed 7-day retention window.
- Manual admin purge still starts from the frontend, but the frontend server now proxies those requests to the HTTP purge Function using a server-side function key.
- Individual node purge, individual tree purge, individual attachment purge, and bulk purge actions all converge on the same `POST /api/purge` Function surface.
- The purge uses the current `APPLICATION_IDENTIFIER` scope and a fixed 7-day retention window.
- Cleanup runs in this order: expired individually deleted attachments, expired deleted nodes in still-active trees, then expired deleted trees.
- Each purge step removes Azure AI Search documents before hard-deleting SQL rows. Blob deletion still follows the storage account's own soft-delete retention behavior.
- Purge telemetry now distinguishes between `softDeletedBlobCount` for blobs whose storage delete happened in the current purge run and `alreadySoftDeletedBlobCount` for blobs that were already non-active in storage when the SQL cleanup ran.

If you need to verify those manual purge requests in Application Insights, use the KQL queries documented in [functions/README.md](../functions/README.md).

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

### Tool input schema vs. output schema

Tool definitions in this codebase usually contain two different schema concepts:

- an input schema under the tool definition's `parameters`
- a local output schema constant that documents the expected shape of the handler result

These do not currently behave the same way.

The input schema is active. It is part of the function/tool definition sent to the model runtime, so it directly affects what arguments the model is allowed or expected to send when it calls the tool.

The output schema is currently passive. It documents the intended shape of the tool-specific `data` payload returned by a handler, but the shared tool-result wrapper does not currently validate handler output against that schema before sending the function result back to the model.

In practice this means:

- if the input schema is wrong, tool calls can fail at runtime
- if the output schema is wrong or stale, the code will not automatically reject it unless downstream logic breaks when it reads the returned fields

So output schemas are still useful as code contracts and maintenance documentation, but they are not yet active runtime validators in the current chat execution path.

### Citation behavior

Citations are currently assembled by the server after the tool loop finishes. The model does not pick a single citation to display.

Instead, each family result builder examines the final tool invocations for the turn, derives any citation entries it knows how to map from those tool results, and then deduplicates the combined set before returning the final chat response.

In practice this means:

- if several tool calls in the same turn map to distinct citable artifacts, the response can contain several citations
- if multiple tool calls point to the same underlying tree/node/file, the server deduplicates those citations before returning them
- citation-building logic lives in the family-specific result builders rather than in the model itself

The `supportsCitations` tool-result metadata flag should be treated as per-tool capability metadata, mainly for debug and UI inspection. It is not the primary source of truth for building citations. The source of truth remains the result-builder logic that knows how to translate particular tool outputs into citation entries.

### Answer state reporting and validation

Answer state is agent-reported but application-validated for the families that opt into it. The agent classifies each completed turn in its final structured JSON response, alongside the user-facing `answer`. The state fields are:

- `knowledgeMode`
- `isPermissionToBroadenRequest`
- `isPersistenceOffer`
- `explanation` (an internal rationale)

The application does not infer answer mode from tool results or prose. For `knowledgeTrees`, it provides a structured final-response format and validates the returned JSON and allowed state combinations before accepting the turn. If validation fails, the shared execution loop asks the agent to correct its final response; the result builder reads the accepted state from that response.

Validation checks the response shape and state combinations, not whether every factual claim in the answer is grounded in evidence.

Family policy differs by family.

- `knowledgeTrees` uses final-response answer-state reporting. It requires explicit broadening consent, and completed broad answers must offer persistence.
- `email` and `investment` do not require this answer-state contract.

Allowed answer states by family:

- `knowledgeTrees`
	`knowledgeMode="grounded", isPermissionToBroadenRequest=false, isPersistenceOffer=false` for an ordinary grounded answer.
	`knowledgeMode="grounded", isPermissionToBroadenRequest=true, isPersistenceOffer=false` for a permission-to-broaden request.
	`knowledgeMode="broad", isPermissionToBroadenRequest=false, isPersistenceOffer=true` for a completed broad answer.

`email` and `investment` currently have no required answer-state contract. Their responses are still shaped into the shared top-level response schema.

Disallowed combinations for `knowledgeTrees`:

- `isPermissionToBroadenRequest=true` is only valid for `knowledgeTrees`, and only while `knowledgeMode="grounded"`.
- `isPersistenceOffer=true` is only valid while `knowledgeMode="broad"`.
- In `knowledgeTrees`, every completed broad answer must use `isPersistenceOffer=true`.
This answer-state contract is separate from tool-specific action confirmation and persistence in personal cache.

- The final answer-state fields describe how the agent is answering and what answer-mode policy applies to the completed turn.
- Business tools can still require explicit user confirmation for side effects such as sending an email, deleting an email, unsubscribing, saving a draft, or creating a tree note.
- Those side-effect confirmations are enforced by the individual tool contracts and tool instructions, not by the answer-state fields.

For example, the email family may retrieve and cache email data during normal grounded work without asking for a separate answer-mode consent turn, while actions such as send, delete, unsubscribe, or draft-save still rely on their own explicit confirmation requirements.

This means the application no longer infers turn lanes or answer mode from prose heuristics, but it still validates the answer-state contract.

In short:

- the agent owns state declaration
- the application owns state validation and policy enforcement

### Agent execution modes

The chat architecture currently supports two execution modes for agent families.

`agent_reference` uses a published Foundry prompt agent by name. In this mode, the application sends the turn to a persisted prompt-agent definition in Microsoft Foundry. That prompt agent supplies its published instructions and tool definitions, while the application still runs the local tool loop and sends function outputs back through the Responses API. The current `knowledgeTrees`, `email`, and `investment` families all use this mode.

Within the `knowledgeTrees` family, dynamic tool generation still stays centralized in `src/server/utils/agent/knowledgeTrees/treeAgentCatalog.js`, while lower-level search-result shaping and debug payload construction now live in `src/server/utils/agent/knowledgeTrees/treeToolSearchResults.js`.

`direct_model` calls the model deployment directly and sends instructions plus tool definitions inline on each request. In this mode, the application itself is the source of truth for the family's instructions and tool schema for that turn. The model can still emit function calls, and the server executes those through the same local handler map and tool loop used by prompt-agent mode. The shared executor still supports this mode, but no current chat family is using it.

In short:

- use `agent_reference` when the family should exist as a published, named Foundry prompt agent
- use `direct_model` when the family is local, dynamic, or still evolving in application code

After that initial configuration difference, both modes follow the same local execution loop in application code:

1. send the request to the model or prompt agent
2. receive model output
3. detect function calls in the response
4. run the matching local handlers on the server
5. send the tool outputs back through the Responses API
6. receive the final answer when the model stops calling tools

So the main difference is where the instructions and tool definitions come from at request start. The downstream tool-call loop is shared.

### Agent Code Flow

Investment family example:

1. `src/app/api/chat/route.js` receives the chat request, normalizes the payload, and hands the request off to the agent-family dispatcher.
2. `src/server/utils/agent/agentFamilyInvoker.js` normalizes the selected family name and dispatches the request to the registered family service.
3. `src/server/utils/agent/agentFamilyRegistry.js` maps the family name `investment` to the `invokeInvestmentAgent` entry point.
4. `src/server/utils/agent/investment/investmentAgentService.js` is the investment-family entry point that prepares the request, builds runtime context, calls the shared executor, and then shapes the final result.
5. `src/server/utils/agent/investment/investmentAgentCatalog.js` defines the investment tool registry, instructions, and handler map used by the investment service.
6. `src/server/utils/agent/investment/tools/` contains one module per investment tool, plus a small shared helper module for code that is genuinely reused across those tool implementations.
7. `src/server/utils/agent/agentConversationInput.js` builds the initial message array that is sent to the model.
8. `src/server/utils/agent/agentDebug.js` creates the shared debug state that tracks timing, tool calls, and other execution details.
9. `src/server/utils/agent/agentFamilyExecution.js` runs the shared model/tool loop by sending input to the model, detecting function calls, executing handlers, and sending tool outputs back.
10. `src/server/utils/agent/investment/investmentAgentCatalog.js` is consulted again during the tool loop because its registered tool handlers are looked up from the `handlerMap`, and those handlers now live under `src/server/utils/agent/investment/tools/`.
11. For families such as `knowledgeTrees` that require answer state, `src/server/utils/agent/agentAnswerState.js` defines the structured final-answer format, parses the agent's final JSON, and validates its reported state. The investment family does not require this contract.
12. `src/server/utils/agent/agentFamilyExecution.js` runs a final response validator and requests a retry only when the family supplies one; investment does not.
13. `src/server/utils/agent/investment/investmentAgentResultBuilder.js` converts the final model response and tool history into the normalized investment-family result, derives the latest recommendation, and then wraps everything in the top-level response schema.
14. `src/server/utils/agent/agentTurnStateReader.js` reads the final answer and summarizes actual tool invocations for the client. For families that require answer state, it also reads the accepted state from the final response.
15. `src/server/utils/agent/agentFamilyResult.js` builds the shared result envelope that all agent families return in a consistent shape.
16. `src/server/utils/agent/investment/investmentAgentResultBuilder.js` also builds the investment agent descriptor used in the top-level response, so the catalog remains focused on registry and runtime setup.

### Chat history and tool history

Chat history is for the agent. It contains the user and assistant messages that are replayed as conversational context on later turns.

Tool history is for the application. During a turn, the shared executor accumulates tool invocations and tool outputs in memory. That tool history is used for several server-side responsibilities after or during the tool loop, including:

- deriving citations
- summarizing tool usage and result counts
- building debug output

The raw tool history is not automatically replayed to the model as structured prior-turn tool state on the next request. The model primarily sees replayed chat history plus whatever runtime instructions and tool outputs are explicitly sent during the current turn.

Answer-state fields are read from the final structured response, not from a special tool invocation.

### Where turn state lives

Turn state is split between browser memory and per-request server execution.

- The client is the main holder of chat-turn UI state. `src/app/chat/ChatPageClient.js` keeps the in-memory `turns` array with fields such as `question`, `answer`, `knowledgeMode`, `isPermissionToBroadenRequest`, `isPersistenceOffer`, `toolInvocations`, `citations`, `familyPayload`, `debug`, and pending/error status.
- On each new submission, the client rebuilds plain chat history from those turns and sends that history back to `src/app/api/chat/route.js` together with the current message.
- The server does not load prior turn state from a database or session store. It derives the current turn's normalized state from the current request and from the model/tool results produced during that request.
- During execution, the server keeps the current turn's tool results in memory, separately from the agent's final structured answer state.
- Family result builders then shape that per-turn derived state into the response fields returned to the client, such as `answer`, `knowledgeMode`, `isPermissionToBroadenRequest`, `isPersistenceOffer`, citations, family payloads, and debug data.

The application does not keep a separate durable server-side conversation-mode store. There is no independent persisted lane or mode record that carries forward across turns on the server.

In practical terms, this means answer state is not maintained in a separate durable server-side conversation store. It is reported and validated per turn, then returned as part of that turn's response payload.

The main exception is UI preference persistence such as the selected visibility filter, which is stored separately in browser `localStorage`. That preference storage is not the same thing as persisted chat-turn state.

### How information reaches the agent

The model does not have direct access to arbitrary server-side or UI state. In the current architecture, information reaches the agent only through a small number of explicit channels:

- published static instructions and published tool definitions when a family runs in `agent_reference` mode
- inline instructions and inline tool definitions when a family runs in `direct_model` mode
- runtime system messages added by the application for the current request
- replayed chat history from prior user and assistant turns
- the current user message
- tool outputs sent back during the tool loop

This means server-side orchestration state is not automatically visible to the model just because the application knows it. Data such as normalized answer-state fields, citations, family payload fields, and UI affordances are application-owned state unless the server explicitly translates them into one of the channels above.

In practice, this is why dynamic request facts such as knowledge-tree visibility scope must be turned into a runtime system message if the model itself needs to act on them during the turn.

### How visibility is used in chat

Visibility in the chat UI is primarily a request-scoping input for the `knowledgeTrees` family.

- The selected visibility value is a UI preference stored in browser `localStorage` and reflected in the chat page URL.
- On each knowledge-tree chat request, the client sends the current visibility value to `src/app/api/chat/route.js`.
- The knowledge-tree service uses that value when loading the runtime tree set, so the available search tools are already filtered to the selected scope before the model starts the turn.
- In practice this means `public`, `private`, and `both` do not just change post-processing labels. They change which trees are available to the grounded tool set for that request.

The same visibility input is also turned into runtime agent context.

- The service computes a `visibilityScope` object for the current request.
- That scope is used to build a runtime system message that tells the model whether the current grounded tool scope is `public`, `private`, or `both`.
- That same scope is also returned in knowledge-tree `familyPayload` and debug output so the inspector can show what scope applied during the turn.

This visibility scope is dynamic runtime context, not part of the published static Foundry agent instructions. It depends on the current user, the current request visibility, and the set of trees available after access filtering.

When visibility is restricted to only `public` or only `private`, the model is instructed to keep that limitation in mind and to remind the user about it when the model decides not to call a tool and that limitation matters to the answer. The application no longer force-appends that reminder after the fact; it is now model-driven behavior based on the runtime scope instruction.

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

You can start editing the page by modifying `src/app/page.js`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

