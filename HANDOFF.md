## Current state

- Live browser-verified client bundle on `proof-test.mintresearch.org`: `b7e29754845c6c9dc477c96281a55d146c30f2295b95581e8b1677e94f4ceace`
- `/health` still reports server SHA `13d34ac958362cee902869c4214768bb6d77c3e9`, so treat the public asset hash as the deploy-freshness check
- Branch: `codex/simple-markup-rebuild-20260322`
- Last commits in this session:
  - `c9615af` `fix25: repair fragmented share insert marks on reload`
  - `a004086` `build: resolve finalize script paths via fileURLToPath`

## Fix27 hydration follow-up

Shared reports:
- `/tmp/codex-qa-stress-test-v4.md`

Requested:
- address the reload-time browser failures where shared docs could come back with zero visible suggestion marks, plain-text edits while TC looked enabled, and delayed or skipped mark rehydration after the collab doc reconnected

What changed:
- `src/editor/index.ts`
  - stopped treating an empty Yjs fragment as "hydrated" when the shared Y.Text cache still contains content
  - kept non-empty incoming `collab.onMarks` payloads in `pendingHydrationMarks` when the editor is still empty, so early marks snapshots are not dropped on the floor
  - added a late-arrival fallback on editor doc updates so pending hydration marks are re-applied as soon as the ProseMirror doc actually fills in
- `src/editor/share-collab-hydration.ts`
  - extracted the share-collab hydration gate into a pure helper
- `src/tests/share-collab-hydration.test.ts`
  - added a regression for the key race:
    - empty editor + empty fragment + non-empty Y.Text must stay "not hydrated"
    - truly empty docs can still hydrate immediately

Why this likely addresses the stress cluster:
- the previous gate could mark collab hydration complete while the editor was still empty
- once that happened, `rehydrateServerMarksAfterCollabHydration()` returned early and never re-ran, so:
  - pending suggestion marks were not re-applied
  - track changes was not re-enabled from pending server suggestions
  - reloads could look like raw text-only docs until some later marks event happened to arrive in a good order

Verified locally:
- `npx tsx src/tests/share-collab-hydration.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/share-open-context-canonical-fallback.test.ts`
- `npx tsx src/tests/share-marks-refresh.test.ts`
- `npm run build`

Scope note:
- this fix is aimed at the collab hydration / late mark reapply race
- the broader paragraph-structure TC gaps from the v4 report (Enter / empty-paragraph Backspace / formatting tracking) still need separate work

## Fix28 paste and undo follow-up

Shared reports:
- `/tmp/codex-qa-stress-test-v4.md`

Requested:
- address two new QA-confirmed lanes:
  - plain-text paste in TC mode creates no insertion suggestion
  - `Cmd+Z` after share-mode `Accept All` restores text without restoring the tracked deletion state

What changed:
- `src/editor/index.ts`
  - the suggestions interceptor now distinguishes mark-only internal transactions from authored-tracker paste transactions
  - `marksPluginKey: { type: 'INTERNAL' }` no longer auto-bypasses TC wrapping when the transaction also carries a real replace step
- `src/editor/plugins/suggestions.ts`
  - paragraph-wrapped plain-text slices are no longer misclassified as structural passthroughs, so ordinary paste can flow through the tracked-insert path
  - when TC is currently off and a history undo restores suggestion-marked content, appendTransaction now re-enables suggestions instead of stripping the restored marks as "leaks"
- `src/tests/track-changes-paste-regression.test.ts`
  - added a regression proving that a paragraph-shaped plain-text paste becomes one insert suggestion
- `src/tests/editor-suggestion-api-regression.test.ts`
  - extended source guards for the new internal-paste interceptor path and the history-restore re-enable logic

Why this likely addresses the new report:
- authored-tracker paste was dispatching an INTERNAL marks transaction that the interceptor skipped wholesale, so the paste never reached `wrapTransactionForSuggestions()`
- share-mode `Accept All` leaves TC off because there are no pending suggestions; undo was then restoring suggestion-marked content through the history plugin while the TC-off cleanup branch treated those restored marks as accidental leakage and removed them

Verified locally:
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/authored-tracker-suggestions-mode.test.ts`
- `npx tsx src/tests/share-collab-hydration.test.ts`
- `npm run build`

Scope note:
- this fix targets plain-text paste and undo-after-accept-all
- cold-reload mark persistence and paragraph-structure TC remain separate lanes

## Fix26 stress-report follow-up

Shared report:
- `/tmp/codex-qa-stress-test.md`

Requested:
- investigate the fresh browser QA stress failures where shared-doc tracked inserts were rendering as plain text, reloads were reading stale/degraded mark state, overwrite+reload showed both original and replacement content, and multi-paragraph reject still had a separate failing lane

What changed:
- `server/routes.ts`
  - switched `/api/documents/:slug` and `/api/documents/:slug/open-context` from the sync canonical reader to `await getCanonicalReadableDocument(slug, 'share')`
  - this makes share reads follow fragment-derived canonical authority instead of stale `Y.Text` snapshots when the live fragment is ahead
- `src/tests/share-open-context-canonical-fallback.test.ts`
  - extended the fallback regression so a live fragment can be ahead of `Y.Text`, and both `/api/documents/:slug` and `/open-context` must still serve the fragment-authoritative markdown
- `src/editor/index.ts`
  - normalized the dispatch interceptor to use the canonical suggestions-enabled helper instead of a stricter local `pluginEnabled && moduleFlag` gate
- `src/editor/plugins/suggestions.ts`
  - removed the extra module-flag hard stop inside `wrapTransactionForSuggestions`
  - relaxed appendTransaction’s “TC off” leak-strip gate so it only treats TC as disabled when both the plugin state and module flag are off
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to assert the new unified enabled-state wiring and the current `collab.onMarks` merge shape

Why this likely addresses the stress report:
- the browser delete-vs-insert asymmetry matched a concrete code split:
  - delete handlers were using the OR-combined suggestions-enabled helper
  - text wrapping was gated more strictly and could pass plain insertions through
- the share reload mismatch was also concrete:
  - `/state` already used the async canonical reader
  - `/open-context` and `/api/documents/:slug` were still using the sync reader, so the browser could rehydrate from a different truth than the one QA saw via `/state`

Verified locally:
- `npx tsx src/tests/share-open-context-canonical-fallback.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/track-changes-disabled-direct-edit.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/share-client-mark-preconditions.test.ts`
- `npx tsx src/tests/share-marks-refresh.test.ts`
- `npm run test:server-routes-share`
- `npm run test:proof-sdk`
- `npm run build`

Known note:
- `npx tsx src/tests/suggestions-replacement-decomposition.test.ts` still hits the existing `split-gap` adjacent-merge assertion (`Expected adjacent split insert merge to heal a bare-space split into a single pending insert`). I did not change that merge logic in this fix.

## Fix25 browser QA pass

Shared reports:
- `/tmp/codex-qa-loop.md`
- `/tmp/codex-qa-result-1.md`

Requested:
- fix reload-time mark fragmentation where shared-doc suggestion spans collapsed to the first 1-2 characters after refresh

What changed:
- `src/editor/plugins/marks.ts`
  - added repair logic that expands collapsed pending-insert share metadata back to the full nearby materialized text span during remote mark application
  - preserved canonical share persistence behavior, so repaired live spans still persist back as insertion-point metadata
- `src/tests/marks.test.ts`
  - added a regression for a fragmented live insert plus collapsed share metadata
- `scripts/finalize-web-build.mjs`
  - switched to `fileURLToPath(import.meta.url)` so local builds work from the `My Shared Files` path with spaces

Verified locally before push:
- `npm run test:proof-sdk`
- `npm run test:server-routes-share`
- `npm run build`
- `PORT=4010 npm run serve` + `/health` smoke check

Browser QA status on `proof-test.mintresearch.org`:
- PASS: fresh tracked insertion survives hard refresh with full span intact
- PASS: popover shows the full inserted sentence instead of the first character only
- PASS: deletion mark survives reload and popover shows the full deleted text
- PASS: select-and-replace survives reload with intact delete and insert marks
- PASS: `Accept & Next` after reload accepts deletion cleanly and advances to the intact insertion
- PASS: rail badges show one pending change per real mark, not split fragments

Meaning:
- fix25 resolves the core reload-time mark fragmentation bug for the exercised single-mark and replacement lanes
- the active QA loop has moved on to novel scenarios and recurring cron-based retests

## Fix11c full retest

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260327-fix11c-results.md`

Requested:
- verify the new `window.__PROOF_EDITOR__.simulateKeypress('enter')` path on build `00a23f8`

What improved:
- the Enter delivery problem is fixed on the exercised automation path
- pre-flight doc `gmfga1k5` now produces two correct paragraphs:
  - paragraph 1: authored `Alpha` + suggestion ` Beta`
  - paragraph 2: suggestion `Delta` + authored ` Gamma`
- `[simulateKeypress] Handled key: enter` appears
- `[suggestions.wrapForSuggestions.structuralPassthrough]` appears on the split

But full QA still fails:
- Test 1 (`0pvrxhdm`):
  - no one-line collapse anymore
  - but two authored baseline lines disappeared
  - tracked lines are split into multiple insert ids
  - empty paragraphs appear where authored lines should have survived
- Test 2 (`qeb6rjfm`):
  - tracked delete still fails to materialize
  - only the later ` Z` becomes a suggestion
- Test 3 (`5sllcoy7`):
  - mixed-doc composition still corrupts before review is safe
  - one `Accept & Next` accepts corrupted content and clears all remaining suggestions
- Test 4 (`bro8h27m`):
  - functionally correct paragraph structure and authored middle line
  - but tracked lines still split into separate insert ids (`Tracked` + rest)

Meaning:
- fix11c solves the paragraph-break delivery issue
- the remaining blockers are higher-level composition / mark-coalescing bugs, not missing Enter delivery
- next debugging should focus on why tracked lines are fragmenting into multiple insert ids and why authored paragraphs still vanish in alternating/mixed lanes

## Fix11b pre-flight stop

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260327-fix11b-results.md`

Requested:
- verify the new `beforeinput insertParagraph` split handling on build `c1a48f3`

Pre-flight result:
- hard refresh done first
- `/health` served `c1a48f3`
- toggle-state gate still looked healthy
  - `[setSuggestionsEnabled]` reported `willChange: true` both ways
  - `[suggestions.pluginState.transition]` fired both `false -> true` and `true -> false`
- but the new beforeinput split path did not activate

Doc:
- `7tc72l0s`

Exact observed shape:
- authored `Alpha`
- tracked ` Beta`
- Enter while TC-on
- `Delta`
- TC-off authored ` Gamma`

Actual result:
- final text became `Alpha BetaDelta Gamma`
- no paragraph split
- `Delta` glued straight onto the tracked insert

Missing logs:
- `[suggestions.beforeinput.insertParagraph.split]`: `0`
- `[suggestions.handleKeyDown.enter]`: `0`
- `[suggestions.handleKeyDown.enter.split]`: `0`
- `[suggestions.wrapForSuggestions.structuralPassthrough]`: `0`

Meaning:
- fix11b is not active on the exercised native-key path, or the path still bypasses both keydown and beforeinput split handlers
- I did not run the four broader QA lanes because the new pre-flight gate already failed

## Fix11 pre-flight stop

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix11-results.md`

Requested:
- verify the new explicit Enter handling in TC mode on build `0f2dfa5`

Pre-flight result:
- hard refresh done first
- `/health` served `0f2dfa5`
- toggle-state gate still looked healthy
  - `[setSuggestionsEnabled]` reported `willChange: true` both ways
  - `[suggestions.pluginState.transition]` fired both `false -> true` and `true -> false`
- but the new Enter path did not activate

Doc:
- `4fpxnvvg`

Exact observed shape:
- authored `Alpha`
- tracked ` Beta`
- Enter while TC-on
- `Delta`
- TC-off authored ` Gamma`

Actual result:
- final text became `Alpha BetaDelta Gamma`
- no paragraph split
- `Delta` glued straight onto the tracked insert

Missing logs:
- `[suggestions.handleKeyDown.enter]`: `0`
- `[suggestions.handleKeyDown.enter.split]`: `0`
- `[suggestions.wrapForSuggestions.structuralPassthrough]`: `0`

Meaning:
- fix11 is not live on the exercised native-key path, or that path still bypasses the new handler
- I did not run the four broader QA lanes because the new pre-flight gate already failed

## Fix10 full retest

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix10-results.md`

Pre-flight:
- hard refresh done first
- fix10 build prefix present on `/health`
- `[setSuggestionsEnabled]` reported `willChange: true` for both enable and disable
- `[suggestions.pluginState.transition]` fired both `false -> true` and `true -> false`
- the narrow same-line cursor-loss lane now passes:
  - authored `Alpha`
  - tracked ` Beta`
  - authored ` Gamma`
  - doc: `4q8ivzuk`

What this likely means:
- the explicit refocus after TC toggle fixed the simple “toggle, then keep typing in place” path

But the broader UI still fails:
- alternating-line lane still collapsed six intended lines into one paragraph and one rail cluster
  - doc: `2s9i3gts`
- dedicated delete lane still failed before cursor validation because the delete never became a tracked deletion
  - doc: `gdp20cpl`
- mixed-doc review still corrupted before any review button existed
  - doc: `vjj1qypv`
- TC-off-after-tracked lane still absorbed authored text into tracked structure
  - doc: `spamybx1`

Diagnostic note:
- `[tc.dispatch.passthrough]` now appears in all lanes, so the stale TC-on routing problem is no longer the main blocker
- still no hits for:
  - `[suggestions.toggleSuggestions]`
  - `[suggestions.appendTransaction.tcOffStrip]`
  - `[suggestions.appendTransaction.clearStoredMarks]`
  - `[suggestions.deleteMarkCursorSkip]`

Most likely next step:
- stop treating toggle-focus loss as the main explanation for the broad failures
- investigate why tracked delete creation is failing entirely in the dedicated delete lane
- investigate why authored paragraphs are still being absorbed into tracked structure even when passthrough traffic is present
- mixed review remains downstream of that composition corruption, not the first failing stage

## Fix9 full retest

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix9-results.md`

Pre-flight:
- hard refresh done first
- fix9 build prefix present on `/health`
- `[setSuggestionsEnabled]` reported `willChange: true` for both enable and disable
- `[suggestions.pluginState.transition]` fired both `false -> true` and `true -> false`

What improved:
- the stale cross-doc TC-state gate looks better now
- `[tc.dispatch.passthrough]` appeared in every requested lane, including the TC-off scenarios that previously showed wrap-only behavior

But full UI still fails:
- alternating-line lane still collapsed six intended lines into one paragraph and one rail cluster
  - doc: `8m4488dz`
- dedicated delete lane failed before cursor validation because the delete never became a tracked deletion
  - doc: `7jyikhgh`
- mixed-doc review still corrupted before any review button existed
  - doc: `uilm72s3`
- TC-off-after-tracked lane still absorbed authored text into tracked structure
  - doc: `ueyraxqa`

Diagnostic note:
- still no hits for:
  - `[suggestions.toggleSuggestions]`
  - `[suggestions.appendTransaction.tcOffStrip]`
  - `[suggestions.appendTransaction.clearStoredMarks]`
  - `[suggestions.deleteMarkCursorSkip]`
  - `[loadDocument] Resetting stale suggestions plugin state`

Most likely next step:
- stop focusing on the high-level toggle gate
- debug why the delete lane is still not producing a tracked delete at all, and why authored paragraphs still get absorbed into tracked structure even when passthrough traffic is present
- mixed review remains downstream of the same composition corruption; review is not the first failing stage here

## Fix8 full retest

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix8-full-results.md`

Pre-flight:
- hard refresh done
- fix8 build prefix present on `/health`
- `[setSuggestionsEnabled]` now reports `willChange: true` for both enable and disable
- `[suggestions.pluginState.transition]` now fires both `false -> true` and `true -> false`

But full UI still fails badly:
- alternating-line lane ended in a blank/no-op doc
  - doc: `66twbrkz`
- delete-marker lane picked up corrupt tracked content
  - doc: `g1iga144`
- mixed-doc review corrupted before review buttons existed
  - doc: `bwjmycke`
- TC-off-after-tracked lane ended in a blank/no-op doc
  - doc: `9886m1b6`

Diagnostic note:
- `[suggestions.toggleSuggestions]` still never appeared in logs
- some failing lanes ended with zero console diagnostics entirely, which suggests editor/page reset or lost-input behavior in addition to the mark-structure bugs

Most likely next step:
- do not focus only on the toggle logic anymore
- investigate why some fresh-doc lanes are ending in blank/no-op state with zero logs, and why cross-test-style corruption still appears in the delete/mixed lanes even after the toggle fix

## Fix7 pre-flight stop

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix7-results.md`

Requested:
- verify fix7 build `081c98d`

Observed:
- `/health` served `1e3303484ee0c8dc38c1ffb36319f8a1beb4eeec-dirty`
- hard refresh performed before testing
- pre-flight doc: `k0aldwkt`

Failure:
- no `[suggestions.toggleSuggestions]` logs at all
- `[suggestions.pluginState.transition]` appeared only for `false -> true`, not `true -> false`

Meaning:
- did not proceed to the four full QA lanes
- treat this as a deployed-build mismatch or missing-fix issue first, not as a fix7 product verdict

## UI retest on fix6 build `4737012`

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix6-results.md`

Pre-flight:
- fix6 bundle is active
- saw `[suggestions.pluginState.transition] {\"from\":false,\"to\":true,...}`
- did not see the expected toggle-off `true -> false` transition

Confirmed current:
- alternating normal + tracked lines still collapse into one shared insert mark and truncate/reorder text
  - doc: `ww1520xz`
- mixed-doc composition is still corrupted before review; one surviving insert remains and `Accept & Next` just clears that
  - doc: `luk0h0na`
- TC-off text after tracked content still leaks into tracked insert marks
  - doc: `kw1074mb`

Not reproduced this pass:
- sticky end-of-line delete-marker behavior
  - doc: `4ji4i6b4`
  - final DOM order was correct: authored text -> delete suggestion -> insert suggestion

Diagnostic note:
- fresh signal now present:
  - `[suggestions.pluginState.transition]`
  - `[generateMarkId]`
  - `[tc.dispatch.wrap]`
  - `[tc.dispatch.passthrough]` in some lanes
- still missing on the failing lanes:
  - `[suggestions.wrapTransactionForSuggestions.moduleDisabled]`
  - `[suggestions.appendTransaction.tcOffStrip]`
  - `[suggestions.appendTransaction.clearStoredMarks]`
  - `[suggestions.deleteMarkCursorSkip]`

Most likely next step:
- debug why the exact Test 4 shape (`Tracked start.` / `Normal after.` / `Tracked end.`) still never reaches passthrough
- do not assume the module-level enabled flag solved TC-off routing just because passthrough now appears in other lanes

## UI retest on rebuilt build `457fa61`

The stale-bundle explanation is no longer viable. Pre-flight on the rebuilt bundle showed `[generateMarkId]` in the live console, so the current failures are on the fresh client code.

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix5-rebuild-results.md`

Confirmed current:
- alternating normal + tracked lines still collapse into one shared insert mark, absorb authored lines, and reorder/truncate text
  - doc: `7mfcq7u9`
- mixed-doc composition is already corrupted before review; one surviving insert id remains and `Accept & Next` just clears that
  - doc: `yijlk160`
- TC-off text still leaks into tracked insert marks and collapses paragraphs together
  - doc: `1alu6gu2`

Not reproduced this pass:
- the old sticky end-of-line delete-marker behavior
  - doc: `frelg11w`
  - final DOM order was correct: authored text -> delete suggestion -> insert suggestion

Diagnostic note:
- fresh-bundle hooks now seen:
  - `[generateMarkId]`
  - `[tc.dispatch.wrap]`
  - `[tc.dispatch.passthrough]`
- hooks still missing on exercised native-input paths:
  - `[suggestions.appendTransaction.tcOffStrip]`
  - `[suggestions.appendTransaction.clearStoredMarks]`
  - `[suggestions.deleteMarkCursorSkip]`

Most likely next step:
- debug client composition on the fresh failing shapes from `7mfcq7u9`, `yijlk160`, and `1alu6gu2`
- do not spend more time on stale-bundle theories unless pre-flight loses `[generateMarkId]` again

## UI retest on build `457fa61`

Live build rechecked against the broader `/ui-test` sweep. The route-level 409s did not recur, but the editor is still not robust on real CGEvent input.

Shared report:
- `/Users/seth/Documents/proof-qa-shared/FAO-Claude--260326-fix5-results.md`

Raw artifact:
- `/tmp/proof-fix5-results-1774515895.json`

Confirmed current failures:
- alternating normal + tracked paragraphs still collapse into one shared insert mark, absorb authored lines, and truncate text
  - doc: `grjkjqk5`
- end-of-line delete markers are still sticky; right-edge typing lands before the delete marker
  - doc: `yajs7mo4`
- mixed-doc `Accept & Next` can still behave like `Accept All` and duplicate content
  - doc: `lpzyt3xc`
- TC-off text still leaks into tracked insert marks
  - doc: `t3pwmq8s`

Diagnostic note:
- the new fix5 console hooks did not fire on the real CGEvent path
- zero hits for:
  - `[generateMarkId]`
  - `[tc.dispatch.passthrough]`
  - `[tc.dispatch.wrap]`
  - `[suggestions.appendTransaction.tcOffStrip]`
  - `[suggestions.appendTransaction.clearStoredMarks]`
  - `[suggestions.deleteMarkCursorSkip]`
- the logs still showed the older `suggestions.handleTextInput`, `suggestions.insertDecision`, and `suggestions.mergeCheck.*` paths instead

Most likely next step:
- debug the client composition path with the real failing shapes from `grjkjqk5`, `yajs7mo4`, `lpzyt3xc`, and `t3pwmq8s`
- do not focus on route-level mutation retries first; those looked healthy in this pass

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
