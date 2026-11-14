# Plan: Let Azure SQL Pause Between Jobs

This document records the intended change, not an implementation. Recheck the code before starting work. No Azure resource changes or deployment are included.

## Problem

The Functions app's `functions/src/lib/sql.js` caches an `mssql` pool without closing it. The frontend has a separate pool that closes after five idle minutes. The `treePopulateRecovery` Function also queries SQL every 15 minutes, even when there are no jobs to recover. Either behavior can prevent serverless SQL from reaching its auto-pause window.

The Function App uses the normal Consumption plan. `functions/host.json` sets a ten-minute execution timeout; this limits an invocation, not the lifetime of a pooled SQL session in a warm process. The populate job's 11-minute SQL lease is separate.

## Changes

1. **Close the Functions pool after SQL inactivity.** In `functions/src/lib/sql.js`, count active operations before awaiting connection acquisition, decrement after the awaited callback completes, and cancel a pending idle-close timer when new work arrives. Close the pool after five minutes with no active operations. Serialize asynchronous close and reconnect, and preserve the existing callback API and connection-failure retry behavior. The pool is shared by overlapping invocations in one host process, so do not close it in the populate worker's `finally` block. Each scaled-out host manages its own pool.
2. **Reconcile stale jobs before creating another.** In `frontend/src/server/utils/tree/treePopulateJobRepository.js`, perform a scoped, idempotent stale-job update within the existing `createOrGetPopulateJob` transaction, after locking and validating the tree but before selecting an active job or inserting a new one. Preserve the recovery timer's existing predicates: queued jobs whose `updated_at` is more than two hours old, and running jobs whose `lease_until` expired more than 15 minutes ago. Scope the update to the current application and tree, retain its failure summary and timestamps, and preserve the active-job uniqueness guard. The existing generate route already calls this method.
3. **Reconcile when status is read.** In the same repository's `getTreeJob`, apply the same application/tree-scoped stale-job check before returning status, so a user polling an abandoned job sees a failure without waiting for the daily timer. Keep the existing authorization check in `frontend/src/app/api/trees/jobs/route.js` intact. Only user-driven requests trigger these checks.
4. **Retain a daily fallback.** Change only the `treePopulateRecovery` schedule in `functions/src/functions/treePopulateWorker.js` from every 15 minutes to daily, preferably at 16:00 UTC alongside the default scheduled purge. Keep its existing application-scoped stale-job update for jobs nobody checks. Do not change queue processing, leases, heartbeats, retries, or tree generation.

## Verification

- Add focused Functions SQL-helper tests for five-minute idle close, overlapping operations, a new operation arriving during asynchronous close, reconnect after closure, and failed connection retry. Verify the recovery timer's daily registration without running live Azure jobs.
- Add focused frontend repository tests for stale queued and running jobs, healthy or renewed jobs, idempotency, application/tree scoping, status reads, and creation after a stale job is cleared. Keep the original two-hour and 15-minute thresholds in tests.
- Run focused Node tests, the Functions `npm run validate` script, relevant existing tests, diagnostics, and `git diff --check` in each repository. Do not change SQL schema or unrelated workflows.
- After a separately approved deployment, verify that SQL sessions close after five idle minutes, a status read or new job request clears stale jobs, and the fallback runs daily. Observe pause/resume metrics over at least one configured auto-pause window. Confirm auto-pause is enabled and no other clients, health probes, or database features prevent it; the daily purge and upload cleanup can still wake SQL briefly.

## Scope

Expected production changes: `functions/src/lib/sql.js`, the recovery schedule in `functions/src/functions/treePopulateWorker.js`, and `frontend/src/server/utils/tree/treePopulateJobRepository.js`. Add only the focused tests needed for these contracts. The frontend SQL helper, API route authorization, job schema, Foundry generation, queue behavior, and Azure hosting configuration remain unchanged. No deployment is authorized by this plan.