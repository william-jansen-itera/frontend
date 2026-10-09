## Plan: Email Attachment Search

Move email cache storage from one shared message leaf to one leaf per email UID, store each email's JSON and uploaded attachment files together under that per-message node, and add a dedicated email attachment search tool that reuses the existing Azure Search attachment pipeline scoped to the current user's personal cache tree. This keeps normal email retrieval cheap while making attachment-content search a separate, search-backed capability.

**Steps**
1. Phase 1: Reshape email cache storage in `emailCacheRepository.js` so cached message JSON is written and read from a per-email leaf path rather than the shared `Cache/Messages` leaf. The chosen path is `Email / <Provider> / Messages / <Uid>` so every email gets a distinct tree `nodeId`. This phase blocks later attachment indexing because Azure Search groups attachment hits by node.
2. Phase 1: Make `emailCacheRepository.js` a clean cutover to the new per-email path `Email / <Provider> / Messages / <Uid>` with no migration or fallback lookup. Reads and writes should both use that per-email leaf shape only. Keep retrieval snapshots where they are unless there is a separate reason to move them.
3. Phase 1: Add attachment persistence helpers in the personal-cache/email repository layer. Reuse the existing tree attachment writer path behind `replaceInvestmentLeafAttachment()` for JSON and add a binary-upload helper for actual email attachments. This should ensure the per-email leaf exists, then upload each attachment file to that leaf.
4. Phase 1: Extend the IMAP parsing/normalization path in `emailTransport.js` so cached message metadata includes attachment descriptors and, when a message is promoted into per-message cache, its non-inline attachments can also be uploaded into that message leaf. Decide whether upload happens during refresh caching, first `show_email`, first `analyze_email`, or a dedicated hydration step. Recommendation: hydrate on first per-message cache write so attachment availability stays coupled to cached message availability.
5. Phase 2: Define a new email attachment search tool under the email family. It should accept a search string plus provider and optional folder/uid narrowing, then call the existing `searchTreeContent()` helper in `azureSearch.js` with `treeId` and `allowedTreeIds` both set to the current `personalCacheTreeId`.
6. Phase 2: Post-filter search results so the tool only returns hits that belong to the email attachment subtree, not unrelated personal-cache content. The cleanest approach is to infer email membership from the per-email node path convention and return `{ provider, folder, uid, attachmentFileName, snippet, blobUrl, matchSource }` per hit.
7. Phase 2: Add a stable reverse-mapping helper from search hit to email context. Prefer deriving `uid` and `provider` from the per-email path segments and persisting `folder` in the cached email JSON that lives on the same node. Avoid relying only on blob file names for identity.
8. Phase 2: Wire the new tool into `emailAgentCatalog.js`, add instructions for when to use it versus `retrieve_emails`, `show_email`, and `analyze_email`, and keep the current UID-copy contract for follow-up actions once a hit has been mapped back to an email.
9. Phase 3: Add an explicit index-refresh option to the new email attachment search tool so it can trigger the blob indexer when the user wants newly uploaded attachments searchable now. Reuse `requestTreeBlobIndexerRun()` from `azureSearch.js` and expose it through a narrow boolean input such as `requestReindex` or `refreshSearchIndex` rather than making every search trigger an indexer run.
10. Phase 3: Keep the default behavior cheap: if the caller does not request index refresh, run search against the current index state and communicate that recent uploads may still be pending indexing.
11. Phase 3: Add cleanup rules and scope boundaries. Do not attempt a full lifecycle/purge redesign in the first pass. Keep deletion behavior limited to new writes and searches unless attachment cleanup on email delete is already cheap to hook into the existing delete flow.

**Relevant files**
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/src/server/utils/agent/email/emailCacheRepository.js` — change cache path strategy and coordinate per-message attachment persistence.
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/src/server/utils/agent/email/emailTransport.js` — source attachment metadata and determine when parsed attachments are hydrated into the per-message tree leaf.
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/src/server/utils/agent/personalCacheTreeRepository.js` — extend with binary attachment helper(s) or thin wrappers needed by email cache persistence.
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/src/server/utils/agent/investment/investmentTreeRepository.js` — reuse existing leaf attachment persistence behavior for both JSON and binary uploads.
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/src/server/utils/azureSearch.js` — reuse `searchTreeContent()` and optionally `requestTreeBlobIndexerRun()` for attachment-content search and freshness.
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/src/server/utils/agent/email/emailAgentCatalog.js` — register the new tool and document when it should be used.
- `c:/Users/william.jansen/Documents/projects/knowledge application/code2/frontend/azure-search/tree-blob-indexer.json` — reference only; validates that attachment content and file names are already indexed and likely needs no first-pass change.

**Verification**
1. Create or refresh one email with one attachment and verify that the personal cache tree contains a dedicated per-email leaf with the cached JSON plus uploaded attachment file(s).
2. Run a focused search against the personal cache tree using the new tool and confirm that the result returns the correct `uid`, `provider`, attachment file name, and a meaningful snippet from file name, content, OCR text, or image description.
3. Verify that unrelated personal-cache attachments do not appear in email attachment search results.
4. Verify that a hit can be followed by `show_email` or `analyze_email` without inventing identifiers.
5. Run focused diagnostics and lint on the touched email repository, search helper integration, and email catalog files.

**Decisions**
- Included scope: per-email cache-node layout, attachment upload to the personal cache tree, and a dedicated attachment-search tool over existing Azure Search infrastructure.
- Included scope: reuse of existing Azure Search blob indexing rather than parsing attachment content inside `analyze_email`.
- Excluded scope: full purge/retention redesign, immediate strong-consistency indexing guarantees, and broad restructuring of retrieval snapshots.
- Cutover rule: no migration or backward compatibility is required; the implementation can switch directly to the new per-email cache layout.
- Recommended storage convention: keep retrieval snapshots in their current branch and move only per-message cache plus attachments to per-email leaves.
- Index-refresh rule: the new attachment-search tool should be able to trigger the blob indexer on demand, but indexer runs should remain opt-in rather than automatic on every search.
- Recommended identity rule: derive provider and uid from tree path, keep folder in cached email JSON, and do not depend on file-name parsing for identity.

**Further Considerations**
1. Attachment hydration timing: upload attachments when a message is first cached at the per-email leaf rather than on every retrieval response. Recommendation: yes, because it keeps retrieval cheap while ensuring later searchability.
2. Inline assets: skip inline images and other clearly decorative inline parts in the first pass unless users specifically ask to search them. Recommendation: skip them initially to reduce noise.
3. Index freshness: decide whether to automatically request a blob indexer run after attachment upload. Recommendation: no for the first pass unless the current environment requires near-real-time attachment discovery.
