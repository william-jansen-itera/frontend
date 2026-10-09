# Repository LOC Baseline Plan

Establish a repeatable repository line-count baseline that excludes generated, dependency, editor, and repository-metadata folders. Use the resulting number as the current working estimate of authored project code volume.

## Steps

1. Count non-binary files in the workspace while excluding any path containing `node_modules`, `.next`, `.vscode`, or `.git`.
2. Exclude `.json` files from the count to remove lockfiles, package manifests, and infrastructure/config definitions from the baseline.
3. Exclude `.md` files from the count to remove documentation from the baseline.
4. Use the resulting total as the current source-heavy LOC baseline for the repo.
5. If a stricter application-only number is needed later, run one more pass excluding `.sql` as well.

## Scope

- `frontend`
- `functions`

## Current Baseline

- Total lines: `42,763`
- Total files: `166`

## Current Breakdown

- `.js`: `34,793`
- `.css`: `4,561`
- `.sql`: `2,951`
- `other`: `458`

## Verification

1. Re-run the repository count with the same exclusions: `node_modules`, `.next`, `.vscode`, `.git`, `.json`, and `.md`.
2. Confirm that the result remains `42,763` lines across `166` non-binary files unless the repository contents have changed.
3. Confirm extension totals remain approximately: `.js` `34,793`, `.css` `4,561`, `.sql` `2,951`, `other` `458`.

## Decisions

- Included in the baseline: JavaScript, CSS, SQL, and other remaining non-binary project files.
- Excluded from the baseline: dependency folders, build output, VS Code metadata, Git metadata, JSON config/data, and Markdown docs.
- This is a total-line baseline, not a code/comment/blank-line separated `cloc` report.

## Follow-up

1. Exclude `.sql` too if you want a narrower application-only count.
2. If `cloc` becomes available later, rerun the baseline to separate code, comments, and blank lines.
