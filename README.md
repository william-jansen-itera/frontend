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

`APPLICATION_DEBUG` accepts common boolean values such as `true`, `false`, `1`, `0`, `yes`, `no`, `on`, and `off`. If the setting is missing or invalid, the default is `false`.

For deployed environments, set the same variables in the Azure Static Web App under `Configuration` -> `Application settings` so runtime behavior matches local development.

## TODO

- Implement attachment cleanup and retention handling so blob/file records do not accumulate indefinitely after node or tree lifecycle changes.
- Because attachments are indexed through their own blob indexer, implement attachment soft delete by writing delete-state metadata to the blob and preserving the SQL/blob records long enough for index cleanup before final purge removes the blob and metadata.

## Security

Security is currently handled in three layers.

1. Azure Static Web Apps route protection in `staticwebapp.config.json` is the first gate. Protected pages and API routes are assigned roles such as `mdsusers` and `mdsadmin`, and unauthenticated requests are redirected to `/.auth/login/aad`.
2. Navigation trimming in `src/app/layout.js` is a user-experience layer. The nav defines role requirements per link and hides links when the signed-in principal does not have the required role. This uses the shared role helper in `src/shared/clientPrincipal.js` together with auth state from `src/app/useAuth.js`.
3. Server-side in-code checks remain the enforcement boundary inside the app. API routes parse the client principal with `src/server/utils/auth.js`, then apply route-specific authorization such as `assertTreeAccess(...)` for tree-scoped access and `assertAdminPrincipal(...)` or `hasClientPrincipalRole(..., 'mdsadmin')` for admin-only operations.

The important distinction is that navigation trimming is not security by itself. Even if a link is hidden, the request still blocked by Static Web Apps route rules and/or server-side authorization checks.

For Azure AI Search SQL indexing, soft-delete detection now depends on the string column `isDeletedMarker` in `dbo.vw_tree_search_nodes`, matched by the datasource policy value `true`. The older computed `bit` column `isDeleted` remains useful for querying and admin UI filtering, but it did not reliably trigger document deletion in the SQL indexer.

The application only requests an on-demand SQL indexer run for the confirmed `create-leaf-from-chat` flow. Regular edits such as manual note text changes, rename operations, generated child nodes, tree population, expand/collapse state changes, and other routine updates do not trigger the indexer from application code. The scheduled indexer remains the general backstop, and the app-triggered refresh requires `AZURE_SEARCH_ADMIN_KEY` on the server.

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
