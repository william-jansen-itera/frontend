# Knowledge Trees lanes and subsequent quiz feature

## Status and authorization

- This document consolidates the planning conversation and has been reconciled with the current local source.
- The user authorized Phase 1 with "start implementation of phase 1".
- Phase 1 and the subsequently requested conversation cleanup, instruction clarifications, and Notes refresh command are implemented locally.
- The current authorization is to update this plan. Quiz implementation, cloud publication, deployment, and live model/data tests require separate authorization.
- Phase 2 remains a separately scoped follow-up. Its product decisions below are retained; its implementation design is a proposal for review, not implemented functionality.
- Before implementation, reread this document for user edits and recheck the relevant source files.

## Problem and approach

The original Knowledge Trees prompt mixed retrieval, broadening, uploads, placement, previews, revision, and save confirmation. Phase 1 has separated those concerns into instruction lanes with server-enforced transitions. Phase 2 will extend that mechanism for quizzes while preserving the implemented retrieval and saving behavior.

Retain one Knowledge Trees family and one published prompt agent. Do not introduce a separate quiz family, a direct-model quiz worker, or a second conversational execution system.

Use numbered hierarchical Markdown headings for organization, stable semantic identifiers for routing, one active leaf lane, and a separate workflow stage. The agent requests lane changes; the server validates, persists, and enforces them.

## Confirmed architectural decisions

### Instruction organization

The current prompt has numbered Shared, Routing, and Knowledge sections, with retrieval and saving leaf lanes. Phase 2 adds Quiz as a sibling of Knowledge in this conceptual hierarchy:

```markdown
# 1. Shared rules
# 2. Lane routing
# 3. Knowledge
## 3.1 Retrieval [lane: knowledge.retrieval]
### 3.1.1 Grounding
### 3.1.2 Permission to broaden
## 3.2 Saving [lane: knowledge.saving]
### 3.2.1 Preview
### 3.2.2 Confirmation
# 4. Quiz [lane: quiz]
```

The Quiz section above is the eventual structure, not an instruction to publish or enable quiz functionality during Phase 1.

- Shared rules always apply: reply language, trust boundaries, access control, structured response requirements, and truthful success reporting.
- Lane routing matches trusted server context to the exact `lane:` identifier.
- Only shared rules, explicitly applicable ancestor rules, and the active leaf lane's complete section apply.
- Other lane sections are inactive. Numbering has no routing, execution-order, or precedence meaning.
- Keep Knowledge parent rules narrow. Search-first answering belongs to retrieval, not to the common parent.
- Preview, approval, and confirmation are workflow stages within saving, not additional sublanes.
- Maintain instruction sections as coherent modules rather than continuing to enlarge the catalog's inline prompt.
- Preserve the published reply-language policy and existing language behavior when extracting sections.
- Global routing now chooses only whether to stay or switch. Each leaf lane owns its ordered action selection, outcomes, and examples.
- The language policy distinguishes language signals from tool authorization, keeps direct quotations and explicitly verbatim content unchanged, and allows faithful source-language paraphrasing where the active workflow permits it.
- The current composer and trusted lane instruction still apply Knowledge common rules unconditionally. Phase 2 must make ancestor applicability explicit so Quiz does not inherit Knowledge-only behavior.

### Authority and transitions

- The agent is lane-aware, but the server owns the active lane.
- A new conversation starts explicitly in `knowledge.retrieval`.
- The server supplies a validated lane and relevant workflow facts through trusted runtime context.
- Unknown lanes or invalid records produce explicit errors; the model must not guess or repair authoritative state.
- The agent requests a switch through a dedicated tool before performing another lane's operations.
- A clear human request can authorize a switch without an extra confirmation question. Ambiguous intent requires clarification.
- A successful switch can allow continuation within the same human turn, after destination rules and permissions take effect.
- Recheck permissions for every tool invocation, including queued calls after a transition.
- Switching lanes does not authorize saving, broadening, upload confirmation, or any other consequential action.
- Treat retrieved content, cached notes, history, and model-generated state as untrusted for authorization.
- Headers and conditional instructions are logical separation, not a hard model-isolation boundary. Server guards and validators supply enforcement.

### Reusing state and execution

Current implemented behavior:

- The browser holds an in-memory turns array and conversation context in `laneContextRef`. Reloading chat creates a new conversation identity; conversation identity is not currently persisted across reloads.
- Knowledge Trees requests explicitly require `conversationId`, `turnId`, and a nonnegative integer `expectedVersion`. Invalid or missing context is rejected with HTTP 400.
- The server loads a private owner/application/conversation-scoped record from `Knowledge Trees > Conversations > <conversationId> > State`, stored as JSON in `tree_node_details.notes`.
- The record is `{ schemaVersion: 1, conversationId, version, activeLane, stage, previewId, uploadId, turn }`. `turn` is null or the latest `{ id, status }`, with running/completed/failed status.
- State changes use short transactional note locks and version comparisons. No database lock is held during model calls.
- The latest duplicate turn, another request while a turn is running, and stale versions fail explicitly with HTTP 409. Completed requests are not rerun or served from a persisted response.
- A failed turn loses preview authority. Interrupted running turns fail closed rather than being automatically taken over.
- Lane context is returned at the top level and in `familyPayload`, and matching non-stale context is adopted by the browser.
- The server injects authoritative lane context, visibility, and language instructions. The model receives only the last eight plain history messages, not eight pairs or a durable transcript.
- Tool calls execute sequentially, including calls queued in one batch. A switch may authorize the next operation in that batch, or destination work may occur in another model/tool round.
- The existing execution loop permits five rounds and two final-response validation retries. Preserve those limits unless measured evidence and separate approval justify a change.
- Successful identical tool calls within one execution are memoized to avoid duplicate side effects. Durable quiz scoring still needs its own protection across conversations and requests.
- Persistence handlers may return `{ toolOutput, debug }`; the lane runtime normalizes with `result?.toolOutput ?? result` and returns the original handler result. Production-shaped tests must retain this distinction.
- Other families retain their existing state and response semantics.

Extend these mechanisms rather than adding another chat stack or treating browser/model state as authoritative.

### Conversation retention and related follow-ups

- Before creating a conversation-state path, the server cleans up at most 20 eligible old conversations belonging to the same owner and application, oldest first.
- Completed/failed turns become eligible after seven days without a state-note update, using the existing database `updated_at` timestamp. Running turns are retained indefinitely under the approved policy.
- Cleanup rechecks eligibility under transactional path/note locks. Only canonical conversation branches containing their State leaf are removed; extra nodes, branch notes, or file attachments prevent removal.
- This is creation-triggered retention, not access-time expiry. There is no scheduled conversation-state cleanup. Cleanup errors fail the new request before it claims a running turn.
- Upload storage and preview-snapshot storage remain separate. Quiz records must also be separate so conversation cleanup cannot remove resumable quizzes.
- The Notes page now has Refresh tree as the last toolbar command above the tree, with English/Danish labels, selection retention, unsaved-change confirmation, and visible refresh errors. No additional quiz UI or Notes-page changes are required.

## Phase 1: existing functionality only (implemented)

### Scope

Implemented `knowledge.retrieval` and `knowledge.saving`, instruction extraction, lane state, a guarded transition tool, lane-aware validation, minimal invisible client/API plumbing, documentation, and focused regression tests.

No quiz generation, quiz tools, quiz records, dedicated quiz UI, new agent family, new model, background quiz service, or generalized arbitrary-depth workflow framework.

### Lane responsibilities

Retrieval:

- Search authorized trees and produce grounded answers.
- Preserve per-question permission-to-broaden rules and existing save offers.
- On acceptance of an eligible save offer, transition to saving with the identifiable prior answer and correct content origin.
- Do not execute preview revision or save confirmation while still in retrieval.

Saving:

- Handle direct factual text, accepted broad answers, and supported upload evidence.
- Preserve upload processing, classification, clarification, placement, preview, revision, and later human confirmation.
- Permit destination searches inside placement tools; these are not ordinary knowledge-answering searches.
- Preserve exact previews, markers, ownership checks, expiry checks, and save-result reporting.
- A new substantive retrieval request requires a transition before answering it.

The stages must describe actual workflow progress rather than provide new authorization. In particular, `awaiting_approval` is not proof of approval.

### Save and upload invariants

- Accepting a broad answer's save offer authorizes a preview, not confirmation.
- The origin of saved content remains `prior_broad_answer`, `current_user_text`, or the existing verified upload source as appropriate.
- A bare yes must not be reinterpreted as factual content.
- A preview created during the current turn cannot be confirmed during that turn.
- A later human approval must still refer to the exact eligible displayed preview.
- Leaving and returning to saving must not resurrect stale confirmation authority.
- A transition failure must not partially execute the destination operation.
- An upload or automated completion is not human confirmation.
- Preserve ownership and workflow binding on asynchronous upload callbacks. They must not silently overwrite an unrelated foreground lane; explicitly define deferral/resumption where needed and regression-test it.
- Retain existing observable behavior unless a directly necessary conflict is identified and approved.

### Implementation components

Inspect and update only directly related components:

- `frontend/src/server/utils/agent/knowledgeTrees/treeAgentCatalog.js`: compose instruction sections, publish transition tools, and register lane-aware runtime handlers/policies.
- New focused instruction and lane-state modules within the existing Knowledge Trees structure.
- `frontend/src/server/utils/agent/knowledgeTrees/treeAgentService.js`: load authoritative context, inject lane facts, preserve current confirmation checks, and apply lane-aware validation.
- `frontend/src/server/utils/agent/knowledgeTrees/treeAgentResultBuilder.js`: expose trusted lane/stage metadata without changing existing result semantics.
- `frontend/src/server/utils/agent/personalCacheTreeRepository.js`: reuse owner checks and persistence primitives; add only narrowly needed concurrency support.
- `frontend/src/server/utils/agent/agentFamilyExecution.js`: change only if necessary to enforce transition boundaries and refresh trusted context during the existing loop. Preserve other families and the current tool-round limit unless targeted evidence requires a change.
- `frontend/src/app/api/chat/route.js` and `frontend/src/app/chat/ChatPageClient.js`: transport conversation and stable turn identity without new user-visible controls.
- Existing upload completion paths: retain the relevant context binding.
- Existing catalog, service, executor, route, and directly related tests.
- `frontend/README.md`: explain current instruction organization, state ownership, transition behavior, and retention. Keep documentation focused on behavior rather than rollout status.

Do not assume that removing handlers also removes published tool definitions from the model. Enforce server-side regardless; verify supported request-level tool restrictions before relying on them for model exposure.

### Completed implementation sequence

1. Define the concrete context schema, stage meanings, transition table, tool allowlists, and upload interaction rules using the current source behavior.
2. Extract shared, routing, Knowledge common, retrieval, and saving instruction modules, preserving existing rules.
3. Implement owner-scoped durable context and retry/concurrency protections with minimal chat/API transport changes.
4. Add the transition tool and enforce lane guards at each operation and execution boundary.
5. Integrate trusted runtime lane messages, lane-specific final validation, and response metadata while preserving confirmation invariants.
6. Add and run focused behavioral/regression tests; verify existing user workflows end to end.
7. Update behavior documentation. Cloud publication, deployment, and live smoke tests remain separately authorized actions.

### Acceptance and validation

The change is not accepted merely because the prompt has new headings. Verify:

- Fresh conversation defaults to retrieval; context is application/user/conversation scoped.
- Lane identifiers map exactly to prompt sections; unrelated rules are inactive by instruction and unrelated tools are blocked by the server.
- Search -> grounded answer.
- Insufficient evidence -> explicit broadening permission -> broad answer with save offer.
- Accepted save offer -> transition -> preview -> later human approval -> exact save.
- Direct factual text and eligible short-document/image/attachment upload paths.
- Optional upload clarification and preview path revision.
- Switching away from a preview, returning later, ambiguous yes, and stale preview references.
- No confirm on the same turn as a newly created preview.
- Cross-lane calls, multiple queued calls, and transition failure have no unauthorized side effects.
- Duplicate requests, concurrent tabs, and stale context versions cannot duplicate saves or overwrite lane state.
- Automated upload completion cannot be treated as consent or silently hijack another workflow.
- Reply language, response shape, citations, visibility, debug data, and other agent families remain compatible.
- Missing/corrupt context or failed persistence is surfaced explicitly.

Use the existing Node test runner and affected `.test.mjs` files, then targeted ESLint. Run the existing frontend build for integration validation when implementation is ready. Expand testing only as evidence requires, and preserve the repository's existing test/runtime requirements rather than adding tooling for convenience.

Do not report live verification from mocked tests. Publication or deployment is not authorized by a planning or local-code request.

## Phase 1 implementation and verification

- Composed numbered shared/routing/retrieval/saving instruction modules and registered a guarded `switch_tree_lane` definition in the publication code. Retained one family, published-agent execution, executor limits, the response schema, language policy, and existing save/upload tools.
- Added owner/application/conversation-scoped cache state, transactional mutation, optimistic versions, explicit request context, and duplicate/concurrency/corruption failures.
- Added invisible request identity/version transport and trusted response context, including version-bound automated upload continuation.
- Preserved later-human confirmation and exact preview matching. Switching away revokes prior preview authority; superseded previews cannot be resurrected by memoized tool retries.
- Fixed wrapped persistence-tool result handling so successful previews install their durable ID and successful confirmations update the saving stage. Tests use actual persistence output builders, with debug enabled and disabled.
- Moved saving/retrieval policies and examples out of Shared, replaced global workflow dispatch with stay/switch routing, and added ordered action selection inside each lane. Confirmation instructions match the displayed preview marker to the trusted preview ID.
- Clarified browser-message authorization and verbatim quotations versus permitted faithful paraphrasing in the shared language policy used by all three agent families.
- Added the approved seven-day, creation-triggered conversation cleanup and the Notes refresh command described above.
- README documents current behavior without the removed rollout-status narrative.
- Previously recorded checks: 15 targeted policy/language tests passed; the cleanup/repository/lane regression selection passed 26 tests; affected ESLint and production builds passed. Notes refresh was checked in the browser with isolated API fixtures for updates, selection, failures, confirmation, loading state, read-only access, and final toolbar position.
- An earlier broader run had one confirmed pre-existing preview-description assertion failure. It is not a new quiz defect and was not repaired as unrelated work. Reestablish the relevant baseline before Phase 2 implementation rather than assuming that older suite is now fully green.
- Model and SQL boundaries were mocked in relevant integration/repository checks. This plan refresh has not rerun code tests or verified a live deployment.

## Phase 2: quiz lane follow-up

The following design builds on the current code. Start implementation only after the user separately approves it. Preserve the existing retrieval/saving regression baseline; live verification remains an explicit later step.

### Confirmed product scope

- Chat-only quizzes in the same family and published prompt; no dedicated quiz UI.
- User chooses one or more actual top-level roots from one authorized tree.
- Default: one question per eligible leaf; deduplicate selected roots/leaves.
- Source material is leaf notes only in v1. Explicitly report attachment-only or otherwise unsupported leaves.
- Enumerate the tree deterministically; relevance search is not a complete leaf inventory.
- Generate and persist questions, reference answers, grading criteria, source IDs, and source snapshots in the user's personal-cache tree.
- Persist progress independently of conversation history; allow explicit resume from another conversation.
- The agent assesses correct/incorrect and explains. The server owns progress, counts, and score arithmetic.
- Show feedback and the next question automatically.
- Revealing a solution marks the question skipped; continue automatically, with no later scored retry for that question.
- Track correct, incorrect, skipped, and remaining separately.
- Percentage is correct divided by all quiz questions; incomplete results are explicitly provisional.
- Proposed initial safety limits accepted for verification: 25 unique selected leaves, 8,000 characters per leaf, and 100,000 source characters total. These are product limits, not measured provider limits.
- Reject oversized selections with actionable narrowing guidance; never silently truncate.
- Verify exact boundary cases and a maximum-size smoke test before treating those limits as validated.

### Integration boundaries found in the current code

- `treeLaneState.js` currently recognizes only two lanes and five stages, and maps saving/search tools to those lanes. Add `quiz` and its explicit tool permissions; do not make unknown tools implicitly available.
- `tools/switchTreeLaneTool/index.js` publishes a two-value enum. Extend both that enum and the runtime validator.
- `treeLaneRuntime.js` currently resets stage and preview/upload references on transitions and only tracks saving outcomes. Add quiz binding/progress handling without reviving saving confirmation authority.
- `treeAgentCatalog.js` builds static definitions, management previews, runtime handlers, and tool policies separately. Register quiz tools consistently in all four places.
- The catalog currently gates search tools on a stored tree description. Quiz root/leaf discovery must use authorized tree inventory, not search hits or the presence of a retrieval-tool description. Keep retrieval tool selection unchanged and represent quiz source scope distinctly.
- `treeAgentService.js` supplies trusted context, wraps tools, and validates final answers. Add quiz checks here and in the lane runtime, retaining all existing upload and later-human save guards.
- `agentTurnStateReader.js` includes tool arguments in normal response summaries. Quiz-creation arguments will contain reference answers, so curate quiz summaries in the Knowledge Trees result path rather than exposing the full generated question bank in ordinary chat tool details. Debug and the owner's cache are not anti-cheating boundaries.
- `mutatePersonalCacheNotes` locks one note per transaction. Keep scoring and question advancement in one quiz document; do not assume a quiz write and a conversation-pointer write are already atomic together.

### Proposed source discovery and preparation

1. Switch to `quiz` for an explicit human request to start or resume quizzing. If the tree/root selection is unclear, ask a concise selection question within the quiz lane.
2. Discover trees with `getTreeList({ principal, visibility, enforceAccess: true })` and recheck the selected tree with `assertTreeAccess`. Do not require write access merely to quiz on readable notes.
3. Use current SQL topology, as exposed by `queryTreeData`/`getTreeData`, as prior art for deterministic enumeration. Add only the narrow inventory/note query needed for preparation, using stable sibling ordering with an ID tie-breaker.
4. Validate that every supplied root belongs to that same tree and has no parent. A top-level leaf can itself be the selected root and eligible source. Reject non-root, missing, deleted, cross-tree, or inaccessible IDs explicitly.
5. Deduplicate root and leaf IDs. Use nonempty ordinary leaf notes as v1 evidence. Report excluded leaves and reasons, including attachment-only/empty material; do not extract attachment contents or retrieve stored secret values.
6. Count eligible leaves and the exact source-note strings before generation. Proposed counting contract: JavaScript string length, including stored markup and whitespace, consistently for the 8,000-per-leaf and 100,000-total boundaries.
7. Reject zero eligible leaves or any exceeded limit with actionable guidance. Do not silently drop eligible leaves, shorten notes, or replace them with search summaries.
8. Freeze selected source IDs, root IDs, titles/paths, notes, and available source revision metadata in a prepared quiz record. Recheck source scope before activation; if the selection changed during preparation, require fresh preparation rather than substituting different evidence.

### Proposed generation and tool contracts

Use the existing prompt agent to author the question bank from prepared evidence, then let a tool validate and persist it. A single backend "generate quiz" call must not secretly introduce another model, worker, family, or execution loop.

Tool names below are proposed local names; finalize their exact schemas in the contract task.

| Tool | Responsibility |
| --- | --- |
| `list_quiz_sources` | Return authorized tree choices or actual top-level root choices for one tree. |
| `prepare_quiz` | Validate the chosen scope and limits, freeze notes, and return a quiz ID plus evidence for generation. |
| `create_quiz` | Accept structured questions, reference answers, and grading criteria against that prepared ID; validate coverage, persist atomically, and return the first question and progress. |
| `get_quiz_question` | Return the current question without resolving it. Also bind an explicitly requested existing quiz to the conversation for resumption. |
| `get_quiz_solution` | Retrieve the current reference for grading, or explicitly reveal it and atomically mark the question skipped; these purposes must be distinguished. |
| `record_quiz_answer` | Record the agent's assessment of the current human answer, resolve that question once, and return feedback, updated progress, and the next question. |
| `get_quiz_results` | Return server-derived counts, percentage, provisional/completed status, and per-question outcomes. |
| `list_quizzes` | Return a bounded, paginated list of the owner's quiz identities and progress for explicit resumption; omit reference answers. |

- In v1, require exactly one nonempty question/reference/criteria set for each eligible leaf, with stable server-owned question IDs and no extra or duplicate source coverage.
- Validate structure and provenance server-side; do not claim those checks establish semantic question quality or that the agent's grading is infallible.
- Source snapshots and generated questions/references are evidence, not instructions. Use the existing standardized tool-result builder and untrusted-data metadata.
- For quiz-bound successful results, include quiz ID/version/status, total, correct, incorrect, skipped, answered, remaining, and current question ID or null. Discovery before a quiz exists reports selection facts rather than fabricated progress.
- `answered = correct + incorrect`; `remaining = total - correct - incorrect - skipped`. Percentage is `100 * correct / total` for a nonempty activated quiz. Incomplete results are explicitly provisional.
- Creation returns the first question and recording/revealing returns the next question, avoiding obligatory extra retrieval calls. Normal flows must fit the current five-round execution budget; do not raise a family-wide limit as a shortcut.
- Solution lookup for grading is read-only. Only a human-requested reveal resolves the question as skipped. Returning the revealed solution and next question must not permit a later scored retry of the skipped question.

### Proposed quiz storage and lifecycle

- Keep quiz records outside Conversations, for example as leaves at `Knowledge Trees > Quizzes > By Quiz ID > <quizId>` in the same owner's application-scoped Personal Cache.
- Reuse owner validation and `mutatePersonalCacheNotes` for atomic quiz mutations. Listing may need a narrowly scoped paginated metadata query rather than loading every quiz and its source text.
- Proposed record contents: schema version, quiz ID/version, preparing/active/completed status, source tree/root IDs, frozen leaf snapshots, ordered questions/references/criteria, per-question resolutions, presentation binding, and creation/update metadata.
- Keep each quiz's immutable question bank and mutable resolution/progress state in one document. Derive counts from resolutions instead of accepting model-supplied scores or maintaining unrelated counters.
- Each resolution records correct/incorrect/skipped, server-captured human answer where applicable, feedback, and originating conversation/turn identity. Retain bounded per-question resolution identity so another conversation or a changed tool retry cannot score that question twice.
- Add a nullable active quiz reference to conversation context and define/test how existing valid schema-version-1 conversation records acquire that additive field. Existing mandatory request IDs and unknown-lane/corrupt-record errors remain strict.
- A question's presentation is bound to the conversation and turn where it is actually shown. Creation or question retrieval alone is not evidence that a human has answered it.
- Record presentation only after validating the final reply's server-provided question identity and question content. A later human turn may answer or request a skip/reveal; the generation turn and same-turn model correction cannot resolve a newly presented question.
- On explicit resume in another conversation, use the stored question/progress rather than reconstructing them from history. Bind the new presentation to that conversation. Competing submissions are serialized by quiz version/question checks; only the current valid presentation may resolve it.
- A successful score write followed by a failed conversation update must be recoverable from the quiz record. A new turn reads the committed resolution/progress and must not score again. Do not attempt to replay a saved conversational response.
- Leaving quiz detaches its conversation binding while retaining the quiz. Entering retrieval or saving does not implicitly discard a quiz, generate new questions, or authorize a tree save.
- Seven-day conversation cleanup may delete a detached conversation reference but must never delete quiz records. Add a regression for cleanup followed by resume from a fresh conversation.
- Do not add quiz expiry, scheduled cleanup, or automatic deletion of preparing/completed quizzes without a separately approved retention policy.
- Recheck ownership, application, requested visibility, and source access on quiz operations/resume. Do not silently replace the source tree, bypass revoked access using a snapshot, or regenerate an active quiz when its source notes change.

### Lane instructions, output, and existing workflows

- Add a coherent `instructions/quiz.js` module with quiz-local ordered actions: clarify selection, prepare/create, resume, assess an answer, reveal/skip, explain stored evidence, or summarize results.
- Keep shared JSON/language/trust policies truly shared, Knowledge common policies scoped to Knowledge descendants, and quiz behavior out of the retrieval/saving modules.
- Route replies to a presented quiz question within quiz instead of treating every substantive-looking answer as a new retrieval request. Clear unrelated search/save intent still requires `switch_tree_lane`.
- Preserve new-upload and server-bound automated-upload precedence. An automated completion cannot become a quiz answer or switch lanes.
- Extend the current structured response without inventing `knowledgeMode="quiz"` or using persistence save flags to describe quiz-cache writes. Proposed quiz outcomes use grounded mode, no broadening/save offer, and `persistenceAction="none"`.
- A question waiting for a human is not an automatic continuation: use `isWaitingForContinuation=false`. After assessment or reveal, show feedback and the next question in the same response, or final results if complete.
- Keep reference answers out of ordinary question responses and curated tool summaries. This is spoiler control, not a secrecy guarantee against the owner or debug access.
- Preserve the shared prose-language and untranslated-evidence policy. Generated question wording/feedback follows its prose rules; quoted source material retains its language. Do not introduce a quiz-specific translation exception implicitly.
- Use server-generated progress in final validation and response metadata. Do not let a fluent reply claim a score, quiz creation, completion, or question advancement that did not persist.
- Preserve the runtime's wrapped-tool-output handling and memoization. Quiz tool result types must not be mistaken for saving results or trigger save-preview markers/actions.

### Proposed implementation tasks and real dependencies

Task IDs below are mirrored into the session SQL todos. All Phase 2 implementation tasks remain pending separate approval.

1. `quiz-contracts`: finalize additive conversation fields, quiz schema/status/presentation rules, tool parameters/results, grading versus reveal semantics, and explicit recovery paths. Preserve the product scope and limits above.
2. `quiz-sources` (depends on `quiz-contracts`): implement authorized tree/root discovery, deterministic leaf inventory, exclusions, bounded source validation, and snapshots.
3. `quiz-cache` (depends on `quiz-contracts`): implement owner/application-scoped quiz persistence, versioned atomic resolutions, bounded listing, and cross-conversation recovery.
4. `quiz-tools` (depends on `quiz-sources`, `quiz-cache`): implement the source preparation, creation, question/solution, assessment, list/resume, and results handlers using existing tool conventions.
5. `quiz-lane` (depends on `quiz-contracts`): extend lane/stage/tool allowlists, transition enum/context, ancestor scoping, global stay/switch rules, and quiz-local instructions.
6. `quiz-integration` (depends on `quiz-tools`, `quiz-lane`): register publication definitions/previews/handlers/policies; wire trusted quiz context, presentation/final validation, safe tool summaries, and response metadata through the existing service/result path.
7. `quiz-tests` (depends on `quiz-integration`): add focused tests to affected existing suites plus quiz repository/tool suites; run targeted Node tests, ESLint, and production build. Preserve retrieval/saving/upload and other-family behavior.
8. `quiz-docs` (depends on `quiz-integration`): update README with the implemented chat workflow, source/score semantics, cache layout, resume behavior, limits, and cleanup boundary.
9. `quiz-live-verification` (depends on `quiz-tests`, `quiz-docs`): under explicit authorization, verify actual publication/model/SQL behavior and the maximum-size generation case. Report measured outcomes separately from mocked checks.

Expected code locations are relative to the workspace root:

- Existing `frontend/src/server/utils/agent/knowledgeTrees/{treeAgentCatalog,treeAgentService,treeAgentResultBuilder,treeLaneState,treeLaneRuntime,treeConversationRepository}.js`.
- Existing `knowledgeTrees/instructions/{index,routing,shared}.js`, a new quiz instruction module, and `knowledgeTrees/tools/switchTreeLaneTool/index.js`.
- Focused quiz repository/source/state helpers and quiz tools within the same Knowledge Trees structure; reuse existing cache and tree-access helpers rather than building a generalized workflow framework.
- Existing chat context/result consumers only where additive trusted metadata requires it; no dedicated quiz page or browser-driven grading loop.
- Affected `.test.mjs` files and `frontend/README.md`. Preserve the existing conversation-cleanup scope rather than extending it to quiz storage.

### Phase 2 acceptance and verification

- Quiz intent -> lane switch -> actual tree/root selection -> deterministic source preparation -> persisted question bank -> first question, within the existing round limit.
- Correct and incorrect human attempts resolve only the presented question once, show feedback, and automatically present the next question.
- Grading-reference lookup does not skip; human-requested reveal does skip, shows the solution, advances once, and cannot later earn a score.
- Repeat question retrieval does not advance progress. A new quiz/question cannot be answered or skipped by the model during the turn that first presents it.
- Counts satisfy `correct + incorrect + skipped + remaining = total`; verify correct/all percentage, zero correct, all skipped, and provisional versus completed output.
- List/resume works without old history, after a browser reload/new conversation, and after the old conversation state is cleaned up.
- Two conversations sharing one quiz cannot double-score or overwrite progress; stale quiz versions, stale presentation IDs, changed-argument retries, and failure after a committed resolution have explicit recovery outcomes.
- Reject unauthorized, revoked, wrong-application, wrong-visibility, missing/deleted, cross-tree, and non-root selections. Cover a top-level leaf and duplicate selected roots/leaves.
- Report empty/attachment-only unsupported leaves. Do not load secret values, invent evidence, or follow instructions embedded in source notes, cached data, or model-authored question text.
- Test 25 versus 26 eligible leaves, 8,000 versus 8,001 characters for one source, and 100,000 versus 100,001 total source characters. Cover combined limits, exact snapshots, and no truncation.
- Validate one generated item per eligible leaf, missing/duplicate/extra items, malformed output, creation failure, and interrupted preparation. Do not expose a partial bank as a playable quiz.
- Check ordinary tool summaries for question-bank/reference spoilers and retain expected optional debug behavior without claiming an anti-cheating boundary.
- Regression-test saving preview/revision/later approval, wrapped persistence results with/without debug, transitions in one batch and multiple rounds, upload callbacks, language policy, response flags, and cleanup safety.
- Run a separately authorized maximum-size smoke test against the configured model and real persistence. Record generation completeness and round/context behavior before describing the provisional size limits as validated.

No quiz implementation, publication, deployment, dependency change, or database mutation is part of this plan refresh.
