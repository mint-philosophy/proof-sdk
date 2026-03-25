## Current state

- Live build on `proof-test.mintresearch.org`: `265eb632eb2070c138de4c60145fb815b6aff423`
- Branch: `codex/simple-markup-rebuild-20260322`
- Last commit in this session: `265eb63` `Avoid preflush mark writes before review mutations`

## What changed

The client no longer forces a fresh marks-only `PUT /documents/:slug` before persisted share review mutations.

File changed:
- `src/editor/index.ts`

Rationale:
- In collab reject flows, `flushShareReviewMutationState()` was forcing `flushShareMarks({ persistContent: false, forcePersistMarks: true })` immediately before `POST /marks/reject`.
- In live repros this produced a `PUT /documents/:slug` carrying fragmented/stale mark metadata, which polluted the server projection before the real reject request ran.
- The review mutation itself already sends a full snapshot (`markdown` + `marks`) and the server already supports snapshot overlay.
- The new behavior cancels any queued async marks flush, waits for any in-flight persist to settle, then falls back to `forcePersistCurrentShareReviewState()` only if authoritative pending marks are still unavailable.

Tests updated:
- `src/tests/editor-suggestion-api-regression.test.ts`
- `src/tests/share-review-persisted-canonical-sync-regression.test.ts`

## Verification completed

Passed:
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/share-review-persisted-canonical-sync-regression.test.ts`
- `PATH=/opt/homebrew/Cellar/node/25.8.0/bin:$PATH npx tsx src/tests/proof-mark-rehydration.test.ts`
- `PATH=/opt/homebrew/Cellar/node/25.8.0/bin:$PATH npm test`
- `PATH=/opt/homebrew/Cellar/node/25.8.0/bin:$PATH npm run build`

## Important live observations

### Single-window

The old pre-review `PUT /documents/:slug` race is gone in hosted fetch logs for the simple reject path.

Script:
- `/tmp/inspect_single_reject_timing.py`

Hosted doc used:
- `4c1nmg35`

Observed:
- No pre-reject `PUT /documents/:slug`
- `POST /marks/reject` returned `200`

### Collab

The exact Seth repro was **not** decisively re-verified from this shell.

Script:
- `/tmp/inspect_collab_sequential_reject.py`

Hosted doc used:
- `fffw45k6`

Observed:
- The bad pre-review `PUT /documents/:slug` is gone here too
- But the collab typing state in this automation is already fragmented before the first reject
- Pre-reject server/open-context state showed split inserts for the second paragraph:
  - `m1774460056720_3` => `TC `
  - `m1774460057208_5` => `tw`
  - `m1774460057697_6` => `.`
- After first reject, the remaining suggestion state was still fragmented, so the second visible review action never stabilized in this script

This means:
- The specific client-side preflush race from the original report is addressed
- But the browser automation available here is now hitting a separate earlier collab fragmentation problem, so it is not a clean oracle for Seth's original "second reject gets 409" report

## Most likely next step

Use Seth/QA's exact collab sequential reject repro against build `265eb63`.

If that still fails, inspect whether the failure is now:
- the original `MARK_NOT_HYDRATED` path, or
- the earlier collab mark fragmentation path seen in `fffw45k6`

If the latter, the next debugging target is not `flushShareReviewMutationState()` anymore. It is the collab typing/mark healing pipeline that leaves the second paragraph as split inserts before any reject action runs.
