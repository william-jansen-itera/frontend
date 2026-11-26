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

For the deployment named exactly `gpt-5.4`, frontend model calls and published prompt agents explicitly use `reasoning.effort=medium`. The upload-processing and tree-population Function workers apply the same setting. Other deployment names, including `gpt-4.1`, receive no reasoning override. Prompts, schemas, and workflow validation are unchanged by this reasoning setting.

Tree Populate reuses the server-only `AZURE_STORAGE_CONNECTION_STRING` for its Storage Queue; the Function queue worker uses `AzureWebJobsStorage`, which must point to the same storage account. The frontend submits a job ID to the queue and polls its own API for SQL-backed status; it does not call a Populate Function HTTP endpoint, so no additional Function URL or key is needed. The existing purge and secret HTTP functions still use their own URLs and keys. The shared `tree_jobs` table records typed tree jobs; the Populate worker uses `job_type = 'populate'`. Populate generation uses the Function App's Foundry endpoint/model settings and identity, not the browser; job submission and polling remain authorized by tree write access.

For Populate, enable the Function App's system-assigned managed identity and grant it **Foundry User** (formerly **Azure AI User**) on the Foundry resource. The Function worker uses that identity for Foundry calls when no service-principal credentials are configured on the Function App; the frontend's credentials are not required there.

Optional chat settings:

The chat textarea shows localized, task-oriented help for the currently selected agent family (Email, Investment, or Knowledge Trees), updating immediately when the selection changes.

Each saved prompt in the Insert prompt picker has a trash button that asks for confirmation before permanently deleting its personal-cache note for the current application, user, and agent family. Cancelling leaves the stored prompt unchanged. Deleting a saved prompt leaves the current draft unchanged; failed deletions keep the entry visible and show an error.

Chat's right-hand composer buttons save the current draft and open a saved-prompt picker. The top button (`message-square-more`) opens the picker; the lower button (`message-square-plus`) saves. Selecting a saved prompt replaces the draft without sending it; saving does not clear it. Prompts are stored server-side in the current application's authenticated user's private personal-cache tree at `Chat / Prompts / <agent family> / <prompt title>`. New notes use a short identifier such as `Prompt a1b2c3d4`, extending it if that title is already occupied; existing note titles are not renamed. Edit or delete these leaf notes in Notes; reopening the picker reads the current saved content. Identical content is saved once per family, preserving whitespace and line breaks. Collections are separate for each application, user, and family, regardless of chat visibility.

- `AZURE_AI_AGENT_NAME` defaults to `tree-search-agent`
- `APPLICATION_DEBUG` controls whether debug data is included in chat and search responses

Reply-language instructions treat a standalone human `ja` as Danish (`responseLanguage="da"`), regardless of the app-language fallback. Matching ignores case, surrounding whitespace, and trailing punctuation; an explicit language request still wins. This language rule does not change approval or tool-permission handling.

Chat displays the confirm tool's "View note" and "View attachment" links using the same agent-selected language translator as its waiting messages (Danish/English, with the app-language fallback). Only the displayed label is localized; the tool output, saved content, and destination URL remain unchanged.

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

- Next.js serves `src/app/robots.js` at `/robots.txt` and `src/app/sitemap.js` at `/sitemap.xml`. It calls each file's default export and serializes the returned metadata; no separate API route or static text/XML file is needed.
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

For chat, `src/app/api/chat/route.js` passes the server-read principal to the agent. The email agent uses it to select the signed-in user's private personal-cache tree. `src/server/utils/agentOrchestration/personalCacheTreeRepository.js` checks that the tree's stored owner ID matches the principal before cache reads and writes. Authentication identifies the caller; these ownership checks authorize access to a particular tree. The owner ID comes from the principal's object ID when present, otherwise its Static Web Apps `userId`, which is app-specific and should not be assumed to be an Entra object ID.

### Private tree authorization

The notes API checks `assertTreeAccess(...)` against the request principal before reading or changing a tree. An ordinary private tree can be shared with assigned editors: its owner and editors can read and write it. Public trees can be read by anyone, but only their owners and editors can write to them. Only the owner can manage tree access. The check uses the tree's stored owner and editor IDs, not a client-supplied claim of ownership. A client can submit a different tree ID or a direct mutation request, but that does not grant permission to modify the tree. Unlike a shared private tree, personal-cache operations are owner-only; being an editor is not sufficient.

On the Notes page, a viewer without write access can expand and collapse nodes in a public tree. These toggles change only that viewer's current page state: the client does not send an update request, and reloading restores the stored expansion state. A direct update request still requires owner or editor access on the server.

The Refresh tree command above the Notes tree reloads the selected tree and its selected node's details without reloading the page. It keeps the selection if that node still exists and restores stored expansion state, opening the path to the selected node. Unsaved editor changes or selected files require confirmation before they are discarded; refresh failures are shown above the tree without clearing the current view.

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

Each execution allows at most **five tool rounds**; several calls in one model response share a round.
After the fifth round, the application requests a final response with further tool calls disabled,
then still validates that response. Up to two final-format correction requests are allowed separately
and do not consume tool rounds. A model response requesting a sixth tool round is rejected before
any of its tools execute.

The agent runtime then decides:

- whether to call a tool at all
- which tool to call
- whether to call several tools in one round
- whether to continue into another round after seeing tool outputs
- when to stop and return a final answer

In other words, tool-choice behavior is not hardcoded in the application, but it is strongly shaped by the tool definitions, instructions, and history that the application sends to the agent.

### Instruction sources and responsibilities

The knowledge-tree agent's behavior comes from several sources, not just its published prompt. These layers have different responsibilities:

| Source | Responsibility | Main implementation |
| --- | --- | --- |
| Static agent instructions | Stable conversational policy: grounding and broadening, reply language, trust boundaries, turn routing, preview/confirmation workflow, and user-facing response format. | [instructions/index.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/instructions/index.js) composes family-wide rules and each lane's local instructions |
| Tool definitions | Each operation's purpose, prerequisites, side effects, and argument contract. Parameter descriptions specify exact IDs, content provenance, allowed values, and when fields must be empty. Tree search descriptions supply tree-specific routing hints, not exhaustive inventories. | Lane-owned definitions in [knowledgeTrees/lanes](src/server/utils/agentOrchestration/agents/knowledgeTrees/lanes); cross-lane tools/helpers in [knowledgeTrees/tools](src/server/utils/agentOrchestration/agents/knowledgeTrees/tools) |
| Per-turn runtime instructions | Trusted current-request context: visibility scope, available search tools, eligible preview ID or its absence, upload IDs, automated completion versus human follow-up, and the selected app-language fallback. | `invokeKnowledgeTreesAgent` in [treeAgentService.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/treeAgentService.js); `buildReplyLanguageInstruction` and `buildInitialAgentInput` in [agentConversationInput.js](src/server/utils/agentOrchestration/agentConversationInput.js) |
| Validation-triggered correction instructions | Targeted repair of a rejected final response, such as a missing upload-processing call, invalid answer state, language metadata mismatch, incorrect persistence claim, or omitted preview/saved-note content. These are corrections within the same user turn, not new requests or approvals. | Family validation in [treeAgentService.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/treeAgentService.js) and retry execution in [agentFamilyExecution.js](src/server/utils/agentOrchestration/agentFamilyExecution.js) |

`buildInitialAgentInput` inserts the language and request-context instructions as system messages before replayed history and the current user message. If final-response validation rejects an answer, the shared executor sends a corrective system message using `previous_response_id` to continue the same turn.

In the current `agent_reference` execution mode, static instructions and tool definitions come from the published Foundry agent. Editing their local source does not update that published definition. Per-turn context and validation corrections are generated by the running application.

Server enforcement is a separate layer, not another prompt source. The knowledge-tree service restricts handlers for upload turns and rejects confirmation without an eligible immediately preceding preview, a matching preview ID, or when a new preview was already created in the same turn. Tool handlers also validate access, upload provenance, cached preview state, and offered save modes. Instructions guide the model; they do not themselves authorize a write. Tool results supply the actual IDs, paths, available modes, and operation outcomes used by subsequent steps.

When maintaining these sources:

- Keep cross-tool conversational policy in the static instructions, including what a human approval means and what must be displayed to the user.
- Keep detailed argument construction next to the relevant tool parameters.
- Use runtime instructions to identify the current facts that activate a workflow rather than restating the entire workflow.
- Use validation corrections to explain the specific failed requirement and how to repair it.
- Retain short, intentional safety reminders at sensitive decision points. For example, previewing does not save, accepting a save offer only authorizes previewing, and confirmation requires a later human approval of the latest displayed preview.

The goal is one primary home for each rule, not eliminating every repetition. Experience-driven exceptions and examples should be preserved when reorganizing these sources.

All three published agents (`knowledgeTrees`, `email`, and `investment`) include the same complete language policy from `buildReplyLanguagePolicy` in [agentConversationInput.js](src/server/utils/agentOrchestration/agentConversationInput.js). The shared policy covers explicit language requests, message-language inference, the standalone Danish `ja` rule, automated-completion evidence boundaries, untranslated evidence, and language reporting. Direct quotations and content explicitly required verbatim stay unchanged; workflows that allow rewriting may faithfully paraphrase evidence in its source language while preserving supported facts, technical terms, measurements, and uncertainty. Browser-generated messages can supply language signals, while workflow continuation requires trusted server authorization and human approval remains separate. Runtime language messages refer to that published policy rather than repeating it: they supply the current app-language fallback, identify authorized upload-completion turns, specify response-envelope requirements, and retain brief evidence-language and no-approval reminders. This applies generically to all three agents without family-specific language-selection branches.

The static knowledge-tree prompt uses five top-level sections: 1 Shared rules, 2 Lane routing, 3 Retrieval, 4 Saving, and 5 Quiz. The three lanes are siblings, with their own numbered subsections. Shared rules define the JSON response contract and field meanings, reply-language policy, general trust boundaries, truthful success reporting, and the clarification outcome available in every lane. Routing reads the server's active lane, identifies whether the current intent belongs there or requires a switch, and handles ambiguous intent and server-bound automated turns. After a successful switch, the destination lane's ordered action rules choose the workflow. Retrieval owns grounding, broadening permission, save offers, and its response outcomes and example. Saving owns upload evidence and classification, placement, previews, revision, confirmation, and its response outcomes and examples. Quiz owns source selection, quiz generation, assessment, results, and resume. Knowledge common rules remain explicitly scoped to retrieval and saving, not Quiz. The shared language policy retains its automated-message language-selection rules. Tool workflow subsections distinguish prerequisites, content-source selection, and presentation. Detailed preview argument rules live in the tool's parameter descriptions: exact human excerpts, original-message versus follow-up provenance, empty fields, routing questions, and preparation of earlier broad answers. The static prompt retains conversational source selection, missing-content recovery, the worked upload example, and consent reminders.

The [agentOrchestration](src/server/utils/agentOrchestration) folder contains shared orchestration, execution, approval, cache, and interaction infrastructure. Its [agents](src/server/utils/agentOrchestration/agents) subfolder contains the three agent families:

```text
agentOrchestration/
  agents/
    email/
    investment/
    knowledgeTrees/
  interactions/
  agentFamilyRegistry.js
  agentFamilyExecution.js
```

Within Knowledge Trees, the physical source layout groups each lane's instructions with its tools, using the existing lowercase directory naming:

```text
knowledgeTrees/
  instructions/                 # Family-wide composition, shared rules, and routing
    index.js
    shared.js
    routing.js
  lanes/
    retrieval/
      instructions.js
      tools/treeSearchTools/
    saving/
      instructions.js
      tools/                    # Preview, revision, confirmation, upload, and snapshots
    quiz/
      instructions.js
      tools/testInteractionTool/
  tools/                        # Cross-lane tools and shared tool helpers
    switchTreeLaneTool/
    collectStructuredInputTool/
    persistenceToolShared.js
```

Tool-local tests live beside their tools. Family orchestration, lane state/runtime, conversation repositories, and reusable interaction persistence retain their existing shared locations. This layout does not change the composed instruction text, published tool names/contracts, lane permissions, or workflows.

The prompt template is unindented, with blank lines before headings and around lists; optional blank lines after headings are omitted. Both the source text and generated prompt retain their Markdown structure rather than rendering as code blocks. Turn routes use consecutive list numbers, and literal Preview ID examples are formatted as inline code so Markdown previews do not hide them as HTML comments.

Save previews and revisions describe the proposed action in ordinary language in the reply language and show the exact default destination once, rather than exposing internal field labels or save-mode enums such as `merge_existing`. A separate new-note destination is shown only when the preview returns one different from the default. Exact upload evidence, Preview ID markers, and the later human confirmation requirement remain unchanged.

Turn routing includes clarification after the specific upload/preview/save routes and before broadening or default search. If the intended request, subject, or content to save is missing, the agent asks one concise question instead of guessing, calling tools to infer intent, or asking permission to broaden. For example, "save this in tree" without usable content or an authorized upload prompts the user to paste text or attach a file, unless an accepted earlier broad-answer save offer already identifies the content. Clear questions with unknown answers still follow search rules. Clarification uses grounded answer state with permission/save-offer flags false, `persistenceAction="none"`, and `isWaitingForContinuation=false`; it awaits a human reply rather than an automatic continuation.

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

### Untrusted content labeling

Email and knowledge-tree tool results label source-authored content with `meta.contentTrust: "untrusted_source"`. Where the result mixes source text with operational fields, `meta.untrustedDataPaths` names the present fields under `data` that contain source-derived content; status-only results do not receive this label. The original content is preserved. These labels help the agent distinguish data from instructions, but do not sanitize content, enforce trust boundaries, or authorize tool calls. See `buildUntrustedContentMeta` in `src/server/utils/agentOrchestration/agentToolResult.js` and its tests for the precise contract.

### Email deletion approval

The server requires a registered approval policy for each tool; `delete_email` is the only approval-gated tool. A pending action expires after five minutes, and its approve/cancel decision is claimed once for the authenticated principal. The resolved email targets are checked again before any IMAP deletion. Prompt instructions alone do not authorize a delete. Do not validate this workflow using a real mailbox deletion.

When the agent calls `delete_email`, the executor pauses that call. The email service invokes the handler in preview-only mode, then stores the tool arguments, resolved-target preview, authenticated principal, expiry, and model continuation (including the original call ID) in `agent_action_approvals`. The browser receives a pending-action ID and shows one Approve/Cancel prompt. The approval endpoint atomically claims that ID for the same principal; replay, another principal, and expired requests cannot authorize execution. Approval invokes the handler with the saved target identities, which must still match the freshly resolved targets before IMAP is called. Cancellation never invokes the delete handler. The service records the outcome and resumes the model with the original call ID; it does not retry a claimed delete automatically.

The approval prompt uses the shared chat interaction control as a single-step confirmation, with localized Approve/Cancel labels and read-only review details from the existing frozen preview. The control forwards only the chosen decision to the unchanged approval handler, which sends the existing ID/decision request to `/api/chat/approval`; it does not submit approval as ordinary chat, interpret typed yes/no as approval, or create a second saved interaction record. Approval policy, expiry, ownership, target checks, single-use claims, execution, and continuation remain owned by the existing approval system, not the presentation control.

Approval security depends on the deployed Static Web App boundary: `staticwebapp.config.json` requires the `mdsusers` role for `/api/chat*`, including `POST /api/chat/approval`. The handler also requires an authenticated principal, accepts a supplied `Origin` only from `https://www.mds.net` (or the configured `SITE_URL`) in production, and accepts only `approve` or `cancel` with a UUID-shaped ID. Local development checks the request URL's origin instead. The SQL claim requires the same application and principal, a pending state, and an unexpired record before marking it claimed. The handler does not independently check the `mdsusers` role or verify the principal header; direct access that bypasses Static Web Apps must not be exposed. A local Next.js server uses a development principal and does not enforce Static Web Apps route roles. The origin check is an additional browser-request safeguard, not a substitute for authentication or approval ownership.

This table is an operational record, not a complete audit trail: it records states and outcomes but has no history view or retention cleanup, and a process interruption can leave an action in `executing` with an uncertain outcome. It also contains potentially sensitive previews and continuation data. The account configuration, live cache, and mailbox are loaded separately at execution time; permanent tool policies live in server code, not in this table or the personal cache tree.

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
- `persistenceAction` (`knowledgeTrees` only: `none`, `previewed`, `revised`, or `saved`)

The application does not infer answer mode from tool results or prose. For agent-generated `knowledgeTrees` replies, it provides a structured final-response format and validates the returned JSON and allowed state combinations before accepting the turn. If validation fails, the shared execution loop asks the agent to correct its final response; the result builder reads the accepted state from that response. Deterministic structured-collector card transitions are the exception: the server returns the saved prompt/status and explicit grounded, no-offer/no-continuation flags without invoking a model.

Validation checks the response shape and state combinations, not whether every factual claim in the answer is grounded in evidence.

### Structural validation of reported actions

For `knowledgeTrees`, structural validation compares what the final JSON reports with what the server observed during the current tool loop. The strict final-response schema requires `persistenceAction`; the server then compares it with the latest `preview_save_to_tree`, `revise_save_preview`, or `confirm_save_to_tree` result in the current turn. A successful preview requires `previewed`, a successful revision requires `revised`, and only a successful confirmation that created or updated a note permits `saved`. With no successful latest persistence action, the reported action must be `none`. A failed confirmation does not turn an earlier preview into a save.

The comparison also checks that a preview or revision answer contains the returned destination and exact preview ID marker, or that a saved-note answer contains the returned note text and link. A mismatch causes the final response validator to request a corrected answer instead of accepting the turn. These checks use server-recorded current-turn tool outputs, not chat history or the agent's prose as proof of a write. They do not verify every free-form factual claim or validate tool outputs against their passive output schemas; the individual tool contracts still control authorization and persistence.

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

Within the `knowledgeTrees` family, dynamic tool generation still stays centralized in `src/server/utils/agentOrchestration/agents/knowledgeTrees/treeAgentCatalog.js`, while lower-level search-result shaping and debug payload construction live in `src/server/utils/agentOrchestration/agents/knowledgeTrees/lanes/retrieval/tools/treeSearchTools/treeToolSearchResults.js`.

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
2. `src/server/utils/agentOrchestration/agentFamilyInvoker.js` normalizes the selected family name and dispatches the request to the registered family service.
3. `src/server/utils/agentOrchestration/agentFamilyRegistry.js` maps the family name `investment` to the `invokeInvestmentAgent` entry point.
4. `src/server/utils/agentOrchestration/agents/investment/investmentAgentService.js` is the investment-family entry point that prepares the request, builds runtime context, calls the shared executor, and then shapes the final result.
5. `src/server/utils/agentOrchestration/agents/investment/investmentAgentCatalog.js` defines the investment tool registry, instructions, and handler map used by the investment service.
6. `src/server/utils/agentOrchestration/agents/investment/tools/` contains one module per investment tool, plus a small shared helper module for code that is genuinely reused across those tool implementations.
7. `src/server/utils/agentOrchestration/agentConversationInput.js` builds the initial message array that is sent to the model.
8. `src/server/utils/agentOrchestration/agentDebug.js` creates the shared debug state that tracks timing, tool calls, and other execution details.
9. `src/server/utils/agentOrchestration/agentFamilyExecution.js` runs the shared model/tool loop by sending input to the model, detecting function calls, executing handlers, and sending tool outputs back.
10. `src/server/utils/agentOrchestration/agents/investment/investmentAgentCatalog.js` is consulted again during the tool loop because its registered tool handlers are looked up from the `handlerMap`, and those handlers now live under `src/server/utils/agentOrchestration/agents/investment/tools/`.
11. For families such as `knowledgeTrees` that require answer state, `src/server/utils/agentOrchestration/agentAnswerState.js` defines the structured final-answer format, parses the agent's final JSON, and validates its reported state. The investment family does not require this contract.
12. `src/server/utils/agentOrchestration/agentFamilyExecution.js` runs a final response validator and requests a retry only when the family supplies one; investment does not.
13. `src/server/utils/agentOrchestration/agents/investment/investmentAgentResultBuilder.js` converts the final model response and tool history into the normalized investment-family result, derives the latest recommendation, and then wraps everything in the top-level response schema.
14. `src/server/utils/agentOrchestration/agentTurnStateReader.js` reads the final answer and summarizes actual tool invocations for the client. For families that require answer state, it also reads the accepted state from the final response.
15. `src/server/utils/agentOrchestration/agentFamilyResult.js` builds the shared result envelope that all agent families return in a consistent shape.
16. `src/server/utils/agentOrchestration/agents/investment/investmentAgentResultBuilder.js` also builds the investment agent descriptor used in the top-level response, so the catalog remains focused on registry and runtime setup.

### Investment Tools

- `get_stock_price` retrieves price history for a ticker.
- `get_buy_sell_volatility_recommendation` runs the rule-based buy/sell/hold analysis on price history.
- `get_volatility_events` filters saved recommendation events, such as rotations and episode-low updates.
- `portfolio_stock_holdings` stores holdings as JSON in the notes of Investment > Portfolio > Stocks > List in personal cache. The CSV attachment is written only by an explicit export:
	- `update_holdings` saves user-provided share counts, average purchase prices, or returns by ticker. Returns entered in DKK are converted to USD. A new return clears the old average purchase price; a new average purchase price clears the old return. If both are supplied, average purchase price takes precedence.
	- `remove_holdings` deletes requested ticker rows from the notes.
	- `refresh_calculations` fetches latest closing prices and recalculates values, portfolio percentages, returns, and return percentages. If the average purchase price is missing, it can derive one from a stored return and share count. This recalculation is separate from `update_holdings`.
	- `export_calculations` writes the current JSON holdings rows as a Portfolio stock holdings.csv attachment on the same node. It does not refresh calculations; refresh first when current values are needed.

The investment family's shared persistence uses the public tree selected by `INVESTMENT_PERSISTENCE_TREE_ID`, not the caller's tree owner/editor permissions. An authenticated user who can invoke the investment agent can trigger its server-side tools to write to that configured tree, but can edit the tree directly through Notes or the tree API only if they are its owner or an editor. The portfolio holdings tool instead stores user-specific data in personal cache.

### Email Tools

- `retrieve_emails` finds and filters a bounded set of messages from a mailbox folder, using a cached snapshot when fresh or IMAP when a refresh is needed. A refresh fetches up to the latest 150 emails; the filtered response still returns at most 25. Use `forceRefresh: true` to replace an older, smaller snapshot immediately.
- `show_email` displays cached message headers and body text without model analysis; `analyze_email` provides a deeper interpretation of selected messages.
- `flag_email` adds or removes the flagged/starred state; `delete_email` moves messages to Trash by default or permanently deletes them when requested.
- `draft_email` saves a new or reply draft without sending, after explicit confirmation; `send_email` delivers a new message, reply, or saved draft through SMTP.
- `unsubscribe_email` acts on a parsed, actionable unsubscribe link after explicit confirmation. An HTTP response alone does not confirm that the unsubscribe completed.

When `retrieve_emails` refreshes a folder from IMAP (for example, Inbox), it replaces that folder's `-latest` retrieval snapshot with the fetched messages and attempts to prune numeric UID nodes from that folder's personal cache if their UIDs are not in the fetched set. Setting `forceRefresh: true` bypasses even a fresh cached snapshot and runs this same refresh and pruning path; without it, a fresh snapshot is reused and no pruning occurs. The fetch is bounded, so this is cache cleanup relative to the fetched window, not a check of the entire mailbox or a deletion of mail on the server. Pruning is best-effort and does not fail the retrieval if it errors.

When `delete_email` moves a message from Inbox to Trash, IMAP assigns it a Trash UID that may differ from its Inbox UID. The tool records the mapping from the original Inbox UID to the Trash folder and UID, so a later confirmed permanent delete using that original UID can target the correct message in Trash. UIDs come from `retrieve_emails`, not a message's position in the result list. If the mapping is unavailable, retrieve Trash and use the message's Trash UID instead; do not guess a UID.

### Knowledge Trees Tools

The lane-switch tool definition and handler factory live in [tools/switchTreeLaneTool/index.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/tools/switchTreeLaneTool/index.js). [treeLaneRuntime.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/treeLaneRuntime.js) owns transition persistence and tool guards; [treeLaneState.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/treeLaneState.js) holds shared lane constants and state validation.

- `switch_tree_lane` requests a server-validated transition between `knowledge.retrieval`, `knowledge.saving`, and `quiz`. Search and knowledge answers belong to retrieval; uploads, placement, previews, revision, and confirmation belong to saving; quizzes belong only to quiz. The server persists a successful transition before allowing destination tools, including subsequent calls queued in the same model response. Switching grants neither permission to broaden nor approval to save.
- `collect_structured_input` remains available in every lane without switching. Quiz instructions use it for missing source selections; its general guide and former test trigger remain documentation-only. It collects information using an immutable agent-provided specification and returns one saved step at a time; it does not evaluate answers or execute another tool.
- `quiz` is the quiz-lane-only tool for source discovery, preparation, tool-owned generation and grading, explicit reveal, results, listing, and resume. It reuses shared interactions without creating a generic collection per question.
- `search_tree_<name>_<id>` is generated for each accessible tree with a published description. It searches that tree's notes and attachments for evidence to answer grounded questions; available tools depend on the user's tree access and visibility scope.
- `preview_save_to_tree` proposes a location for factual text supplied in the current user message, for an already-delivered broad answer after the user accepts its save offer, or for a completed chat upload's classified note or attachment. Select `contentSource` by the origin of the substantive text: a yes to a broad answer's save offer uses `prior_broad_answer` and the answer from history, not `current_user_text` or the approval wording. Do not require the user to repeat an available answer. For direct text, the server checks that the proposed note text is present verbatim in the current message; a rejected source selection must be corrected explicitly, not silently reclassified. For an upload, the server verifies ownership and completion and freezes the stored classification and payload rather than trusting agent-supplied content. If no tree was named, the agent selects the best fit from available trees or asks when the choice is ambiguous. It returns a preview ID; previewing does not write a tree node or attachment.
- `revise_save_preview` accepts a user's complete `>`-separated path (optionally starting with the tree name) after a preview. The path must end with the note title at the configured leaf depth. It reuses existing branches, previews any missing intermediate nodes, and replaces the previous preview ID; users can revise again before saving.
- `confirm_save_to_tree` creates or updates the note, or attaches the verified original file, from the saved preview after the user separately confirms the proposed destination. A missing or stale preview ID requires a new preview.

The upload flow uses the same preview and later human confirmation steps as text supplied in chat:

For upload previews, the tool's `uploadId` argument uses the exact server-authorized `previewUploadId` on an automated completion turn or `pendingUploadId` on a human follow-up. Both routes use `contentSource="completed_upload_note"`; non-upload previews use an empty `uploadId`.

An upload without typed text uses a localized browser default requesting processing and a save preview, not processing only. The chat route supplies `uploadHasHumanMessage` as trusted runtime context; completion and follow-up turns derive it from the owned upload's stored `original_human_message`, not a client-supplied flag or the current reply. When no human upload text exists, even older browser defaults mentioning only a temporary placement note imply preview intent: proceed to preview when evidence suffices or ask the required clarification. A genuinely typed processing-only request still suppresses previewing, and final saving always requires later human approval.

The initial default upload message uses the localized browser sender label (`Browser (automated)` in English), just like the completion turn. Its outgoing message and replayed history also carry that label; typed upload messages and ordinary chat messages retain the human sender.

1. `process_upload` starts asynchronous processing. The worker stores a server-owned `save_kind` and, for complete non-image documents of at most 4,000 extracted characters, `extracted_note_text`. Images, longer documents, and unreadable or incomplete files use `attachment`. The short placement note and filtered caption are separate evidence.
2. The browser waits for completion and starts an automated preview turn when the original request permits saving. Its evidence contains the processed `note`, filtered `caption`, and normalized `fileName`: filename topic words joined with spaces, excluding the extension and single-letter segments (for example, `sea_bass_w.JPG` becomes `sea bass`). The stored attachment keeps its original filename. The server binds the initial typed human message to the owned upload, never the browser's filename-based default request. After processing, the agent can ask for one relevant placement detail. A later human reply uses `pendingUploadId` without reprocessing or polling; an explicit processing-only request does not automatically preview.
3. `preview_save_to_tree` verifies the original human excerpt and any current human clarification, and passes them separately to placement alongside the processed note and filtered caption. It freezes the upload and exact labeled incoming notes in a 30-minute snapshot. A path revision keeps that content. The preview shows the incoming notes, not a predicted final existing-note merge. Nothing is written before separate human approval.
4. On confirmation, the server rechecks ownership, expiry, original blob metadata, size, and SHA-256. A short extractable file saves the frozen labeled note, including verbatim extraction. If an existing note is selected, the merge happens at confirmation and must retain that incoming block verbatim. An attachment to an existing leaf leaves its notes unchanged; a new leaf stores its labeled incoming notes alongside the original file. Permanent attachments survive the separate daily cleanup of 24-hour staging uploads.

See [Chat Upload Placement and Notes](docs/chat-upload-placement-plan.md) for the upload preview and confirmation design and verification criteria.

`preview_save_to_tree` searches for an existing destination before proposing new nodes. Its handler calls `previewLeafFromChat`, which selects from the tree's active nodes using these model-call stages:

1. `root` offers the root categories. If none fits, the preview plans a new path from the root level.
2. `structural` offers direct non-leaf children of the selected category, one level at a time. Selection stays within that branch.
3. `leaf` offers direct leaf children at the configured leaf level, if any exist. A selected leaf becomes the merge target. If the call evaluates leaves but selects none, selection stops there; it does not shortlist those same leaves again.
4. If traversal stopped before evaluating leaf candidates, `shortlist` checks existing leaf titles and paths in the selected subtree in bounded batches. Only shortlisted leaf notes are read; `rank` then chooses one of those leaves for merging. If none qualifies, `anchor` checks deeper structural nodes in that subtree from deepest to shallowest to find where a new path should start.

If an existing leaf is selected, the preview returns its `mergePath` with `defaultSaveMode: "merge_existing"`. Otherwise, path generation fills any missing levels from the selected anchor and proposes a new `createPath` with `defaultSaveMode: "create_leaf"`. The preview returns paths and a preview ID without writing nodes; `confirm_save_to_tree` writes only after the user approves the destination.

### Chat history and tool history

Chat history is for the agent. It contains the user and assistant messages that are replayed as conversational context on later turns.

Tool history is for the application. During a turn, the shared executor accumulates tool invocations and tool outputs in memory. That tool history is used for several server-side responsibilities after or during the tool loop, including:

- deriving citations
- summarizing tool usage and result counts
- building debug output

The raw tool history is not automatically replayed to the model as structured prior-turn tool state on the next request. The model primarily sees replayed chat history plus whatever runtime instructions and tool outputs are explicitly sent during the current turn.

Answer-state fields are read from the final structured response, not from a special tool invocation.

### Where turn state lives

The application distinguishes browser UI state, per-request server execution state, information exchanged with the agent, and durable workflow records. These are related, but they are not the same object. Knowledge Trees additionally persists a small authoritative lane record; it does not persist the complete chat.

#### Browser state and outgoing requests

`src/app/chat/ChatPageClient.js` keeps an in-memory `turns` array containing questions, answers, response-language metadata, answer-state flags, citations, tool summaries, family payloads, debug data, and pending/error status.

On a new submission, the browser sends to `src/app/api/chat/route.js`:

- The current message.
- Previous user and assistant messages as plain `role`/`content` history.
- The selected agent family, app language, and visibility.
- Relevant upload identifiers and flags.
- A request identifier in the HTTP header.
- For Knowledge Trees, a required `conversationId`, a stable `turnId`, and `expectedVersion`. Missing, null, or invalid values are rejected with HTTP 400; the server does not generate compatibility defaults. These identify the conversation and turn and protect against stale updates; the client cannot select the authoritative lane or stage.

It does not send the complete previous turn objects back to the server. Previous answer-state flags, tool summaries, citations, and family payloads are not automatically replayed as structured agent context. Some workflow references, such as a displayed preview ID, can be present in the replayed message text.

#### Server execution and agent interaction

For each request, the server constructs runtime context and invokes the selected agent. The model receives only information explicitly supplied through published or inline instructions and tool definitions, runtime messages, chat history, the current message, and tool outputs.

During ordinary tool-loop execution:

1. The agent can request tool calls.
2. The server checks the applicable tool policy, executes permitted calls, and returns their results to the agent. Tools requiring application approval can suspend execution for a separate approval request.
3. The server accumulates tool invocations and results for the current execution.
4. The agent produces a final response; a reply does not always require a tool call.
5. Where a final-response validator is configured, the server validates the response and applicable workflow invariants. A rejected response can trigger bounded correction attempts within the same request. The Knowledge Trees family uses this validation.

This internal exchange can include information that is absent from the normal browser response. It is not automatically a durable conversation-state store.

Knowledge Trees loads its owner- and application-scoped lane record before invoking the agent. A fresh conversation starts in `knowledge.retrieval`. The server injects trusted lane, stage, version, and workflow references as runtime instructions. The agent requests lane changes through `switch_tree_lane`; runtime guards recheck every operation against the current lane. Shared rules and the active lane's rules apply; Knowledge common rules apply only to the two Knowledge lanes. Numbered prompt headings are navigation, while semantic `lane:` identifiers control routing. This remains one family, one published prompt agent, and the existing tool loop. The third lane, `quiz`, supports source-grounded quizzes. Available-tool guidance is refreshed after switching and advertises only handlers allowed in the destination lane.

A preview created or revised during a turn still requires a later human confirmation. Confirmation must match both the displayed preview and the durable workflow reference. Leaving saving revokes the old confirmation authority; returning does not restore it. A saving tool result must be reported before switching away on a later turn.

Successful preview and revision tool outputs set the lane record's `previewId` and `awaiting_approval` stage. A successful confirmation clears that reference and sets the stage to `completed`. The lane runtime reads these outcomes from the handlers' tool output, keeping optional debug data separate.

#### Agent response versus browser response

The agent's final structured response is not forwarded unchanged. Server-side parsers and family result builders validate and reshape it into the browser-facing response.

For example:

| Field or data | Role |
| --- | --- |
| `language` | Browser-supplied app-language fallback, included in runtime context. |
| `responseLanguage` | Agent-reported reply language, returned to the browser. |
| `languageReason` | Agent-reported explanation of language selection; diagnostic, not part of the normal response. |
| `knowledgeMode` and persistence flags | Agent-reported answer state, validated and returned where applicable. |
| Tool results | Evidence and action outcomes used during execution; normally exposed through summaries, citations, or selected result fields. |
| `laneContext` | Server-generated Knowledge Trees conversation identity, version, active lane, stage, and workflow references; returned at the top level and in `familyPayload`, and also on applicable errors. |

For Knowledge Trees, validation checks the structured response and specific behavioral invariants, such as whether a claimed save matches a successful tool outcome and whether a preview includes its actual path and ID. It does not independently establish the factual correctness of every sentence.

Diagnostic information, including internal messages and tool details, may also reach the browser when debug output is enabled. "Internal" therefore does not mean "guaranteed never to reach the browser."

#### What survives between requests

Knowledge Trees stores its lane record under `Knowledge Trees > Conversations > <conversationId> > State` in the user's private personal-cache tree. It contains the lane (`knowledge.retrieval`, `knowledge.saving`, or `quiz`), stage (`idle`, `upload_processing`, `awaiting_details`, `awaiting_approval`, or `completed`), preview/upload references, version, and latest turn ID and status. Retrieval and quiz use `idle`; interaction-step progress lives in the separate saved interaction record, not a saving workflow stage. Stages describe workflow progress, not consent. This uses existing cache-note storage.

Updates use short transactional cache locks and compare-and-set versions; no database lock is held during model calls. Concurrent requests and stale versions fail explicitly rather than overwrite newer state. Reusing the latest turn ID is rejected with HTTP 409, whether the turn is running, completed, or failed and regardless of whether the request content changed. Older requests are rejected when their version is stale. A process interrupted while a turn is marked running is not automatically taken over: check any potentially completed save before starting a fresh conversation (reloading chat creates a new conversation). Corrupt cache state also fails explicitly.

Knowledge Trees conversation state expires after **24 hours without a successful state-note update**, using the database's `tree_node_details.updated_at` and UTC clock rather than browser time or timestamps inside the saved JSON. Each successful state mutation refreshes that timestamp; rejected operations do not. Expiry applies to unfinished workflows and turns still marked `running`, as well as completed/failed turns. The server checks expiry before accepting a new turn and under the note lock before subsequent state updates. Expired state cannot be continued or revived, even if it has not yet been physically deleted. Expiry errors use HTTP 410 and tell the user to reload chat for a new conversation and check previous action outcomes before retrying.

When a Knowledge Trees request needs to create a conversation-state path, it first cleans up a bounded batch of expired conversation states for the same owner and application. Cleanup examines at most 20 eligible candidates, oldest first, excludes the conversation being created, and rechecks identity, schema, scope, and inactivity under the shared transactional path/note locks. Records updated while cleanup waited are retained. Cleanup permanently removes only the old conversation branch and its `State` leaf under `Knowledge Trees > Conversations`. Branches with additional nodes, branch notes, or file attachments are retained, and separately stored uploads, preview snapshots, and saved knowledge are untouched. Cleanup errors fail the new request explicitly before it claims a running turn.

There is **no scheduled conversation-state cleanup**. Expired candidates remain stored until a new conversation is created by that owner in that application, and a backlog can require multiple creations to clear. Physical retention does not extend their usable lifetime. An existing version or delayed callback cannot recreate a cleaned-up conversation's state.

The browser adopts matching, non-stale server context rather than treating its own copy as authoritative. Automated upload completion is bound to the conversation and version that initiated it. If another turn has advanced that workflow, the callback is rejected rather than switching lanes or overwriting newer work; the user must explicitly continue the upload workflow. Completion is never human save approval.

Conversational text still comes from browser-supplied history and explicitly loaded workflow records. The Knowledge Trees service limits replayed history to the last eight messages, not eight user/assistant pairs. Raw prior-turn tool outputs are not automatically replayed as structured tool history. Other agent families retain their existing state behavior.

Some workflow data is persisted separately, including upload records, save-preview snapshots, personal-cache data, and pending application approvals. These records support particular operations; they are not a persisted copy of the complete conversation. A stored approval continuation is a specific execution-resumption mechanism, not a general conversation-mode store.

Browser preferences such as visibility can survive through `localStorage`, but that is separate from durable server-side conversation state. The browser's in-memory `turns` array is not itself durable chat storage.

#### Saved multistep interactions

##### Shared structured collector

[collectStructuredInputTool](src/server/utils/agentOrchestration/agents/knowledgeTrees/tools/collectStructuredInputTool) is a sibling of the lane-switch tool, not a quiz-lane tool. Its published name is `collect_structured_input`. Quiz instructions prescribe it narrowly for missing tree/root setup selections; quiz answers use the quiz-owned workflow instead. The general standing usage guide and **"test structured interaction"** trigger remain absent from composed agent instructions; the general guide is retained here. The registered tool remains callable across lanes.

To integrate it before another tool, instruct the agent which missing information requires collection and supply a suitable declarative specification. Call `start` with `interactionId=null`, `response=null`, and that specification. Once the user's final Submit is successfully processed, the agent can use the returned values and continue the original request in the same turn, subject to normal lane, access, validation, and approval rules. No extra user Continue message is required. Completion releases the collector's turn restriction; it does not authorize an otherwise unapproved action.

The handoff applies to server-processed card Submit and textarea `respond`, and to `resume` when it successfully finishes a captured pending final Submit. Merely reading an already-completed record does not release the turn. Intermediate Continue/Back, clarification, cancellation, and failed processing retain the owning-tool restriction. After successful completion, the agent may start a fresh collection in the same turn; it gets a new identity and no inherited answers, owns the presented card, and restricts the turn again until completed.

For manual testing or future restoration of the former **"test structured interaction"** instruction, use `specification=buildCollectionTestSpecification(replyLanguage)` from [sampleSpecification.js](src/server/utils/agentOrchestration/agents/knowledgeTrees/tools/collectStructuredInputTool/sampleSpecification.js), with `operation="start"`, `interactionId=null`, and `response=null`. The sample collects topic (single choice), a short note (text, maximum 500 characters), optional features (multiple choice), and usefulness (Yes/No). The last specified step uses Submit instead of Continue and saves its fields while completing the collection; there is no additional review step. A one-step collection therefore offers Submit immediately. Final Yes/No fields use radio choices plus Submit, while intermediate Yes/No steps retain their immediate choice buttons. Only the current workflow version two is accepted; older records are not migrated or reinterpreted. This sample is an example, not a server-side default. Localize human-readable title/purpose/prompts/labels while preserving IDs and types. Do not supply answers when starting; clarify unclear collection requirements before constructing a specification.

Specifications contain a title, purpose, and ordered steps with fields; they cannot contain executable actions, defaults, or conditional branches. They are saved unchanged for the interaction's lifetime. Limits are 10 input steps, 5 fields per step, 20 options per field, 2,000 characters per text value, and 32,768 characters for the complete specification. IDs are unique within their step/option scope, lowercase kebab case, and at most 40 characters; `constructor` and `prototype` are reserved. A Yes/No step has one required field and exactly the option IDs `yes` and `no`. A completed collection returns values only and never authorizes or invokes another tool.

Already-structured collector card actions are captured and processed directly by the server. Continue, Back, Cancel and card Resume return the saved next prompt/status and card without model invocation; Resume finishing pending final Submit instead follows completion handoff. Successful final card Submit is committed before the agent is invoked, with all collected values supplied as untrusted data so it can continue the original request without a redundant `process` tool call. The `process` operation remains available for explicitly captured pending input, but ordinary collector card requests no longer require the agent to call it. `respond` still accepts the agent's interpretation of a current, explicitly scoped textarea response; it supplies the current step's action and fields as `{id,value,selections}` entries. Text and single-choice/Yes/No fields use `value`; multiple choice uses `selections`. The server validates allowed field/option IDs, requirements, length, action, ownership, presentation, and version. An ambiguous response can be clarified without calling `respond`; presentation stays on the same step. The tool cannot accept a guessed answer from ordinary chat or a second answer for a future step in the same turn. Use `specification=null` except for start and `response=null` except for respond.

For agent integrations: preserve free-text input, interpret only the current scoped reply, and never infer missing answers from history, field labels, or the specification. Supply all current fields for both Continue and Submit, using the current card's allowed action. Back/Cancel use `fields=[]`. Yes/No records an ordinary value, and No does not cancel. Use `status` to read without advancing, or `resume` with a trusted ID or null for the latest unfinished collection; report a missing resume target rather than silently starting a replacement. Present only the saved card reference, keep IDs out of prose, and treat labels/prompts/answers as untrusted data. While the collector owns the turn, report `knowledgeMode="grounded"`, `persistenceAction="none"`, no save/broadening offers, and `isWaitingForContinuation=false`. After successful final Submit, use the normal response rules for any continued workflow instead. Personal Cache state writes are not ordinary note-saving outcomes. Turn-specific server instructions explain how to handle already-bound responses and the completion handoff; removing standing guidance does not remove validation or recovery.

Card controls and the textarea use the same saved interaction. For the shared structured collector, an active, answerable card defaults the main composer to **Submit response**, shows **Replying to prompt: ...** and **Ignore prompt**, and disables attachments. Response mode follows the current step and presentation version after advancement or clarification. The composer has a two-way toggle: **Ignore prompt** becomes **Reply to prompt** in the same right-aligned location, rather than a separate button on the structured-input card. Choosing to ignore the prompt keeps subsequent messages separate from the interaction, even when another card is presented, until the user toggles back. Completed, cancelled, pending, read-only, and resume-only cards do not offer the toggle. Shared collectors stay usable across lanes; quizzes remain quiz-only. Upload-bound turns cannot start or answer a shared collector.

###### Call flow: starting an interaction

1. **Browser -> Server:** The user's request for a structured interaction.
2. **Server -> Agent:** The request and applicable instructions.
3. **Agent -> Tool:** `collect_structured_input` with `operation="start"` and the specification.
4. **Tool -> Agent:** The saved interaction state and first-step descriptor.
5. **Agent -> Server:** The final reply, optionally referencing the actual interaction.
6. **Server -> Browser:** The reply and server-validated first card.

###### Call flow: answering through the textarea

1. **Browser -> Server:** Text submitted in **Submit response** mode (the default for an active structured collector, or reselected using **Reply to prompt**), with the interaction, workflow, step, and version context.
2. **Server -> Agent:** The text and validated current-step context. Runtime instructions explicitly tell the agent to interpret this response, preserve free text, map choices to actual option IDs, and call `respond` only when unambiguous. The text is not yet an accepted field value.
3. **Agent -> Tool:** `collect_structured_input` with `operation="respond"` and the interpreted action and structured fields.
4. **Tool:** Validates the current explicit reply, allowed action, fields/options, and saved-state binding; persists the normalized submission, applies it, and saves the advanced state.
5. **Tool -> Agent:** The updated interaction state, collected values, progress, and next-step descriptor.
6. **Agent -> Server:** The final reply, optionally referencing the actual interaction.
7. **Server -> Browser:** The reply and server-validated next card.

For example, "just choices" can become `response={"action":"continue","fields":[{"id":"features","value":null,"selections":["choices"]}]}`. The server validates the structure and allowed values, not whether the agent understood the user's meaning correctly.

###### Call flow: answering through card controls

1. **Browser -> Server:** Already-structured field values, the chosen action, and interaction/workflow/step/version context.
2. **Server:** Validates the submission, persists it as pending input, then applies the transition using the same locked repository processing as the tool. A card Resume processes any pending input once or reloads/rebinds the current step.
3. **Server -> Browser, unless this turn completed final Submit:** The saved prompt/status and server-validated next card. This path makes **zero model calls**, does not initialize the invocation client or look up a published agent in the interaction service, and does not discover or execute downstream tools. Existing route-level family activation/publication availability checks still apply.
4. **Server -> Agent, after successful final Submit:** The completed collection and all collected values, with instructions not to resubmit/process them. Normal lane/access/approval rules apply.
5. **Agent -> Server -> Browser:** The final reply and completed card, or further permitted tool work and its resulting card/response.

An intermediate/navigation/cancel/ordinary-resume collector card request uses **zero model calls and no agent tool calls**. A final card Submit normally needs **one model call** for the final reply, plus any calls required for further orchestration. Textarea input still normally uses **one `respond` tool call and two model calls within one chat request**, since interpretation is required. The server-only response has `agent=null`, no tools/citations, and the saved collection language; debug reports `executionMode="server-interaction"` and an empty model-call list. The internal agent/tool exchange appears in diagnostics, not as separate chat-history messages; the browser shows the submitted message and final reply/card.

Direct processing preserves pending-input recovery: a processing failure leaves the captured input available to explicit Resume, without silently advancing or falling back to the model. If final Submit commits but a subsequent model call fails, the completed values remain saved and cannot be submitted again using the old presentation. This optimization applies only to the generic collector. Quiz turns still invoke the conversational agent, which delegates grading to the quiz tool; closed-answer grading is deterministic and free-answer grading uses an internal model call.

###### Call flow: clarification without a tool call

1. **Browser -> Server:** An explicit textarea response with interaction/step/version context.
2. **Server -> Agent:** The validated current-step context and instructions to ask for clarification if the response is unclear or incomplete.
3. **Agent -> Server:** A clarification question, without calling `respond`; no answer is accepted and the step does not advance.
4. **Server:** Calls the internal runtime's `present()` function for the already-loaded interaction, rebinding the current card with a fresh presentation version.
5. **Server -> Browser:** The clarification question and the unchanged step's validated card.

There is **no explicit "clarifying" flag or semantic detection of the agent's wording**. The server attaches the loaded interaction's current card when presenting the final response, whether or not a tool advanced it. Without a `respond` call, it remains on the same step. Consequently, any final reply without advancement would redisplay that card, not only a clarification question. The agent does not rebuild the UI; the server supplies the descriptor and the browser renders it. `present()` is internal server code, not an agent tool call. Ordinary chat without explicit interaction context does not implicitly load or redisplay a visible card.

##### Source-grounded quizzes

Ask **"Quiz me about..."** and identify a tree and one or more top-level roots, or choose them in the setup cards. The agent switches to `quiz`; retrieval and saving tools are unavailable until it switches away again. Republish Knowledge Trees normally after updating the application to publish the new tool and instructions.

The [quiz tool](src/server/utils/agentOrchestration/agents/knowledgeTrees/lanes/quiz/tools/quizTool/toolDefinition.js) has ten operations:

| Operation | Purpose |
| --- | --- |
| `sources` | Discover eligible trees or actual top-level roots and the server-bound selection specification. |
| `prepare` | Validate chosen sources and freeze their evidence in a durable preparing record. |
| `create` | Infer source language, generate the supported bank, and start the chosen run size (default 25); pause for a human language choice when inference is unclear. |
| `question` | Repeat the bound quiz's current question without advancing. |
| `answer` | Grade the captured attempt inside the tool, then resolve once or request unscored clarification. |
| `reveal` | Reveal and skip the current question once, only on explicit human request. |
| `results` | Read server-derived provisional or completed scores and spoiler-free outcomes. |
| `list` | List this user's saved quizzes in bounded metadata pages using `offset`. |
| `resume` | Rebind a selected saved quiz, including an interrupted preparation or pending assessment. |
| `restart` | Replace the saved run with a fresh sample at the newly chosen size (default 25), reusing the bank without generation or attempt history. |

Use the strict published schema: every declared argument is present and unused properties are null. The server owns counts and accepted human answers; the conversational agent supplies neither a question bank, verdict, replacement answer nor score.

Quiz entries in `responseToolInvocations` expose a redacted argument object with the operation, source/setup/quiz/question IDs, version, requested question count, explicit language choice and pagination offset. JSON-string tool arguments are parsed before redaction; captured/scoped human answer text and reveal/restart-request text are omitted. Malformed argument JSON produces an explicit `argumentParseError` in the summary rather than breaking response shaping.

Rejected typed questions report their one-based bank position and the violated field or type rule
(for example an overlong option label or missing explanation), without including source content,
question text, option text or answer keys. Invalid banks still fail rather than being silently repaired.

**Saved quizzes and taking one again**

Ask **"Show my saved quizzes"**, **"Continue my pike quiz"**, or **"Take that quiz again"**. Before preparing a new bank, the agent checks saved quiz metadata and offers **Continue**, **Take again**, or **Generate fresh** when relevant, unless the human already chose the action explicitly. Source tree/root IDs identify scope; similar titles alone are not proof of a match. Listing includes source IDs, saved size, bank size, status and progress, but never questions or keys. Current source-tree access and catalog eligibility are still required.

Continue preserves questions, order, run size and scores without asking for a new size. Before a new quiz or Take again starts, the agent offers **25 questions by default**, or a custom size of **1-45**, and waits unless the human already chose. The bank always aims for **45 supported questions**, independently of run size; when fewer are supported, use the available questions without padding.

Take again requires the exact current human request in `restartRequest` and the current quiz version; a size reply to the immediately preceding Take again size offer confirms that request. It resets the **same quiz record**, discarding previous answers, feedback, scores, pending input and clarification, without storing attempt history. The frozen source, question bank and language remain unchanged. The new size may differ from the previous run: `restart.questionCount=null` means 25, not the previous size. The tool samples from the existing bank (possibly overlapping the previous sample), without generation; resume then preserves that selection. Old card versions and in-flight grading cannot modify the restarted run. Existing chat messages are not deleted. A preparing quiz has no bank to restart; continue its preparation instead. Generate fresh uses normal source preparation and model generation.

**Sources and setup**

- Eligible trees are exactly those in the current request's authorized search-tool catalog, not every otherwise-readable tree. The picker offers the **20 most recently updated eligible trees**, ordered by `tree_instance.updated_at` with an ID tie-break. An explicitly identified eligible tree may bypass the picker.
- Roots come from actual topology, not relevance hits. More than 20 matching roots requires title-substring narrowing before showing a selection card; roots are never silently truncated. Require at least one root, all from that tree. Explicit unambiguous human selections can bypass the cards but receive the same validation.
- Tree single choice and root multiple choice are separate one-step generic collections. Their final Submit immediately permits the next setup operation. Server-owned setup records bind immutable specifications and canonical option mappings to the exact collection; arbitrary completed forms are not accepted as source selections. Cancellation creates no playable quiz.
- Preparation deduplicates selected roots/leaves and uses nonempty ordinary leaf notes. Empty, attachment-only, and secret-backed leaves are excluded with reasons; attachment contents and secret values are never fetched.
- Source preparation freezes **up to 45 eligible leaves**. If the selected roots contain more (for example 60), it randomly selects 45 rather than rejecting the roots or truncating to the first 45. Unselected eligible leaves are recorded as `random-sample-limit` exclusions. The tool reports selected, total eligible and sampled-out counts in `sourceSummary`; the sample is persisted and reused for post-generation validation and retries, never redrawn on resume.
- The frozen notes must still satisfy **8,000 characters per leaf** and **100,000 source characters total**, using exact JavaScript string length including markup and whitespace. Empty selections and character-limit violations fail explicitly; notes are never truncated. A smaller requested `questionCount` does not shrink the 45-note sampling limit or the generation target.
- **Quiz language follows the selected source notes**, not chat or interface language. Trees have no language setting; the existing planning call infers the dominant source language, currently English or Danish, without an extra model call. If no clear supported language is found, the tool returns `requiresLanguageChoice` and waits for the human to choose from `supportedLanguages`; the facilitator then supplies that choice in `create.language`. Otherwise `language` stays null in tool arguments. The selected language and requested quiz size are saved before question writing and retained across retries and resume; restart preserves the language but uses the newly chosen run size. Quiz content, saved explanations and grading feedback use that language; brief conversational replies still follow the normal reply-language policy. Existing saved banks keep their language.
- Normally, two sequential internal calls to the existing configured Foundry model create a bank of **up to 45 questions**:
  1. **Plan language, evidence and objectives:** infer or preserve the quiz language, assess every frozen leaf and aim for 45 distinct objectives when the evidence supports them, without padding thin content. Return the language and reason, a `note` or `tree_path` evidence basis, exact supporting note quotations or ancestor category labels, and suitable question types. The server validates leaf coverage, evidence anchors, uniqueness and the 45-objective limit, then orders objectives coverage-first and assigns stable IDs and balanced type preferences. Unclear language pauses before question writing.
  2. **Write questions:** generate exactly one question per approved objective ID, using only its approved evidence basis and a supported type. A supported alternative type may replace the preference when more appropriate; type balance is not a forced quota. The server rejects invented, omitted or duplicated objective IDs, unsupported types and invalid option/explanation contracts, and derives bank metadata from the approved plan rather than accepting replacements.
- Thin notes are not padded; leaves without assessable content retain an explicit reason. The writing prompt has separate allocation, authoring, self-review and output sections. Self-review is part of the second call, not a third reviewer call. Exact anchors prove that quoted text/categories exist, not that every generated interpretation is semantically correct.
- `create.questionCount=null` retains the prepared size, initially **25**. Any chosen size from **1-45** randomly samples the full bank with distinct-note coverage first; if the size is smaller than the number of usable notes, select that many distinct notes. Both the full bank and chosen sequence are saved: resume never redraws questions. If fewer supported questions exist than requested, the actual available count is returned.
- Planning, question writing and free-answer assessment use strict structured output, focused instructions and frozen evidence, not the conversational agent's chat history. No additional deployed agent or worker is introduced. Activation rechecks access and the source fingerprint **after both generation stages**; changed evidence requires fresh preparation. Either stage failing leaves the preparing record retryable, not partially playable. The intermediate plan is not persisted: explicit retry reruns planning and writing, while already-activated banks and selected question sequences remain unchanged. Two generation calls add latency and model usage; live examples are needed to measure any quality improvement.
- Both generation and free-answer assessment receive each relevant leaf's title and full breadcrumb path. Besides disambiguating the subject, semantic category ancestors can supply classification questions explicitly framed as **according to this tree**. The path determines those answers, even if the notes suggest a different real-world classification. Comparable alternative category labels may come from supplied paths or be invented as distractors, without claiming invented branches exist. Administrative folders are not subject categories. Other subject-matter facts still require note evidence. Questions stand alone; answers need not repeat the entire path.

**Answering and scoring**

Quiz questions reuse the existing interaction card, transport, descriptor validation, normalized-response parser, presentation/input checks, and composer. The default composer replies to the question; **Ignore prompt** keeps normal chat separate until toggled back. Card answers are validated and saved before invoking the agent. Scoped textarea replies preserve the exact human text when accepted; ordinary chat does not silently become an answer.

**From the card to the agent and tool**

1. The user submits the card; the server validates and saves the answer as pending.
2. The agent calls `quiz` with **`operation="answer"` to request grading**, using `response=null` because the answer is already saved.
3. The tool grades, saves feedback/progress, and returns the result plus the next question, clarification or final results.
4. The agent receives that result; the server builds the corresponding card and the browser displays it. No separate next-question call is needed.

For a scoped composer reply, the agent passes the exact text or mapped option IDs in `response`; the tool captures it before grading.

The conversational agent calls `answer`; it never retrieves an unrevealed key to grade the attempt itself. Single selection and yes/no compare saved option IDs; multiple selection requires the exact ID set, independent of order, with no partial credit. Free answers receive an internal model assessment against the frozen evidence/reference/essential criteria. Genuinely ambiguous free answers may request clarification without scoring or advancing; the card retains the draft and asks for a complete restated answer. Wrong or incomplete answers are not automatically given another chance.

The tool atomically saves feedback and resolves the question, returning the next question or final results. There is no generic collector `process` wrapper and no Back/editing of resolved quiz answers. **Show answer and skip** reveals the current solution, counts skipped once, and advances. The next question cannot be answered or revealed using the same human turn.

Normally, **one `quiz` tool call with `operation="answer"` handles each submitted answer**:

1. The tool grades the captured answer and saves the outcome and progress. Free-text grading invokes an internal model within this tool call, not another agent tool call.
2. Its response informs the conversational agent of the saved feedback, progress and next-question data, or clarification/final results.
3. Before returning the resulting chat response, the server builds the validated interaction card from that same saved state. The browser renders the next question card, the clarification card without advancing, or the completed card.

The tool does not render the UI directly. The same answer call drives both the agent's result context and the card returned to the browser; no separate next-question tool call is needed.

Every single/multiple-choice option and both Yes/No responses require a saved, evidence-grounded explanation of why that answer is correct or incorrect in context. Generation can contrast explicit attributes (for example concealed/exposed or short/long distance), or use plausible but insufficient alternatives when the question states a clear selection criterion. A generally true statement can be an incorrect answer because it does not establish the requested information; explanations must distinguish that from factual falsity. Single choice requires one clearly best answer; multiple choice uses an explicit inclusion criterion for every option. Preserve the note's qualifiers and situation rather than treating an unmentioned claim as false. If defensible distractors are unavailable, the model must choose free answer instead. Structural validation rejects missing, blank, duplicated or unknown option explanations; semantic correctness still requires model judgment.

The card owns question text, answer options and the expandable **Answer explanations** review. Each review option shows one correctness label followed by its explanation, without repeating a matching label already present in the saved explanation. Chat is limited to brief acknowledgement, short saved feedback or clarification, errors, and server-derived progress/final results; the facilitator must not copy or paraphrase the question/options or narrate the option-by-option review. The user chooses when to expand that review. The runtime supplies the current question and option IDs/labels as interpretation context for scoped textarea replies, so normalization does not depend on duplicating the card in chat history.

Explanations and option correctness stay out of unresolved question cards and question retrieval. After an answer or explicit reveal resolves the question, the tool returns its saved review data, and the next/completed card provides the collapsed **Answer explanations** review of that resolved question. The review survives resume and committed-response failures. Results include explanations only for resolved questions, never future questions. Unscored clarification does not release the current answer key. A returned reference answer may be stated for an explicit **Show answer and skip** request, not for ordinary question presentation.

Progress/card metadata comes from saved server state: `answered = correct + incorrect`, `remaining = total - correct - incorrect - skipped`, and percentage is `100 * correct / total`, including skipped questions in the denominator. Results are provisional until completion. Question quality and semantic grading remain model judgments; local mocked tests do not establish live-model accuracy.

**Durability and recovery**

Quiz banks, frozen evidence, accepted attempts, outcomes, and presentation versions live together under `Knowledge Trees > Quizzes > By Quiz ID > <quizId>` in the owner's application-specific private Personal Cache. Setup records and collection reverse-links live under `Knowledge Trees > Quiz Setups`. These domain records have **no automatic expiry or deletion policy** and are not subject to transient interaction/conversation cleanup.

Leaving quiz detaches conversation bindings without deleting progress. Ask **"Resume my quiz"**; the agent lists saved metadata when necessary and resumes the chosen quiz without reconstructing it from chat history. Another or detached quiz must be explicitly resumed before presenting, answering, or revealing it. Pending attempts survive model/storage failures; if grading already committed before a response failure, resume presents the next unresolved question without scoring twice. Clarification drafts persist too. Interrupted preparations retain frozen evidence internally for a retried `create`; source notes and unrevealed keys are not returned to the facilitator. To resume an unfinished setup collection instead, resume that structured collection in the quiz lane; its saved setup association is restored.

Question cards, normal tool summaries, and results omit unrevealed reference answers and grading criteria. The owner's stored bank and technical debug data are not an anti-cheating secrecy boundary.

Only current interaction formats are accepted: contexts/submissions require an explicit `workflow` (`structured-input` or `quiz`), conversation records require current quiz-binding fields, and quiz documents use schema version 3. Older quiz documents and missing-workflow payloads are rejected, not upgraded; listings include only the current quiz format. Start fresh instead of relying on compatibility behavior. The former fixed interaction-testing tool is removed and replaced by `quiz`; its saved test records cannot be resumed.

##### Shared collector persistence and recovery

Continue, Back, Submit, Cancel, and Resume clicks create visible ordinary user messages, labeled **Browser (automated)** because the browser composed their wording. Submitted field labels and values appear in those messages. This is a deliberate human submission, not an automatic upload-completion notice, and grants no save approval or permission to broaden. The collector lets the agent interpret explicitly scoped textarea replies. Ambiguous input requires clarification rather than invented values. Unsubmitted card edits remain browser drafts.

Each interaction is saved independently under `Interactions > By Interaction ID > <interactionId>` in the user's private Personal Cache. The record includes workflow/schema version, current step, submitted values, pending input, completion/cancellation status, presentation binding, and concurrency version. It is not a quiz record or a complete chat transcript. Interaction cleanup is separate from conversation cleanup.

All saved interactions expire after **24 hours without a successful state-note update**, including active, completed, cancelled, and pending interactions. The age check uses the database's `tree_node_details.updated_at` and UTC clock, not an editable timestamp inside the saved JSON. Reads, input capture, processing, presentation, and resume reject expired records; mutation checks run under the note lock before changing anything. Successful mutations refresh the inactivity clock, but a read-only lookup does not. Expired input cannot be processed or recovered, and resuming cannot revive an expired or deleted record. Expiry errors use HTTP 410 and instruct the user to reload chat.

Creating a new interaction first cleans up at most 20 expired interactions, oldest first, including unfinished ones. Cleanup is scoped to the same owner's application-specific private Personal Cache and the exact interaction-record path. It permanently deletes only matching schema-version-1 interaction leaves without children or attachments, rechecking eligibility under the shared transactional path/note locks before each deletion. Records updated while cleanup waits are retained. Cleanup failures are surfaced rather than silently ignored.

Separate quiz/domain records and email approval records are untouched; email approvals retain their existing five-minute approval window. There is no scheduled interaction cleanup: expired records remain stored until that owner creates another interaction, and clearing a backlog may take several creations, but they are already unusable. Reading, processing, presenting, or resuming an existing interaction does not trigger physical cleanup.

The server saves validated card input as pending before processing it. For the generic collector it applies card transitions directly, invoking the agent only after final-submit completion. A collector textarea reply is turn-scoped input, not an accepted answer until the agent calls `respond`; that operation captures validated structured values and processes them through the same repository. Applying a transition and clearing its pending input occur in one locked record update. A structured collector restricts the turn to its owning tool until successful final Submit; after that, ordinary tool and lane permissions apply again, allowing same-turn continuation. Intermediate steps and cancellation do not release the restriction. Stale versions, duplicate submissions, wrong conversations, unavailable actions, and invalid fields fail explicitly. Controls become read-only after submission; a failed turn can return a Resume control without pretending the step succeeded. Errors and recovery state remain visible.

Interaction IDs remain internal to tool arguments and structured metadata; they are not shown on the card or in the agent's answer prose. After switching lanes, reloading, or signing back in, ask **"resume my structured interaction"** for the shared collector while it is still unexpired. The agent calls the collector's `resume` operation without a supplied ID. Trusted current interaction context takes precedence; otherwise, the tool finds the most recently updated unfinished collection in the same user's application-specific private Personal Cache, across conversations. Lookup uses the database note timestamp, excludes completed/cancelled/expired records, and breaks timestamp ties by node ID. If none is available, the tool reports that instead of silently creating a replacement. Exact IDs remain supported internally for explicitly selected interactions, and `status` still requires an exact ID.

Resume rechecks expiry and unfinished status under the mutation lock before changing an automatically selected record. It finishes any captured pending input once and presents the saved step; it does not reconstruct answers from chat history. Resuming in another conversation rebinds the controls and invalidates older versions. A conversation left marked running still requires a fresh conversation, as described above; interactions do not bypass that guard. IDs may still exist in technical metadata/debug output; hiding them from the answer and card is a presentation choice, not a secrecy boundary.

Interaction cards travel in the optional top-level `interaction` response field (also in the Knowledge Trees family payload). Agent final JSON may reference an actual tool-owned card with `interaction: { "interactionId": "..." }`, or null/omission; the server supplies the validated descriptor, not model-invented UI. Existing plain replies and other families retain their existing contract. Quiz/domain persistence is separate from the transient collector records described here.

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
- With no saved preference or URL override, visibility defaults to `private`. Changing the visibility dropdown immediately saves the selection to browser `localStorage`, so a choice such as `public` persists across full page loads and browser sessions until changed or the browser's site data is cleared. An explicit `?visibility=...` in the URL takes precedence over the saved selection.
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

