## Current state

- Live client bundle on `proof-test.mintresearch.org`: `f9ab76c759aa6a36ed0f2f14b15f0de1b2b5ecf363ee9c6c78aa9837aa0d410f`
- `/health` still reports server SHA `13d34ac958362cee902869c4214768bb6d77c3e9`, so treat the public asset hash as the deploy-freshness check
- Branch: `codex/simple-markup-rebuild-20260322`
- Last commits in this session:
  - `c9615af` `fix25: repair fragmented share insert marks on reload`
  - `a004086` `build: resolve finalize script paths via fileURLToPath`

## Fix37 suppress handled text-input DOM echoes

Shared reports:
- browser QA on fix36: the freeze eased, but tracked typing can still corrupt text by duplicating every character (`aabbcc...`)
- the duplicated output stays inside insert suggestions, which implies a second immediate local insertion is being tracked after the first handled keystroke
- the append-time mark healers do not insert text; the more plausible lane is a raw DOM/input echo after `handleTextInput` already dispatched the tracked insert

Requested:
- stop tracked typing from double-inserting characters while preserving legitimate continued typing

What changed:
- `src/editor/plugins/suggestions.ts`
  - added a one-shot handled-text-input echo guard keyed by `proof-handled-text-input`
  - `handleTextInput` now tags its own dispatched transaction with that meta and records the expected immediate plain-text echo position
  - added `shouldSuppressHandledTextInputEcho()` to drop only the next matching plain insertion within a short TTL
  - reset paths now clear any pending handled-input echo state on TC reset/doc reset
- `src/editor/index.ts`
  - `setupSuggestionsInterceptor()` now calls `shouldSuppressHandledTextInputEcho(beforeState, tr)` before wrapping local typing transactions
  - matching immediate echoes are logged as `tc.dispatch.suppressHandledTextInputEcho` and skipped instead of being wrapped into a second tracked insert
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a focused regression proving:
    - the immediate identical post-handle echo is suppressed
    - suppression is one-shot
    - a different legitimate next character is not suppressed
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard for the interceptor call and handled-input meta key

Why this likely addresses the duplication:
- `handleTextInput` already dispatches the tracked insert and returns `true`
- if the browser/DOM observer emits a second immediate raw insertion for the same keystroke, the interceptor previously wrapped it too, producing `aa`, `bb`, `cc`
- the new guard only drops that immediate matching echo instead of broadly suppressing subsequent typing

## Fix36 quiet tracked-insert hot-path diagnostics

Shared reports:
- browser QA on fix34/fix35: typed insert suggestions now survive local follow-up actions much better, but long TC typing can freeze the tab
- the freeze reproduces during tracked insert typing, not during delete review flows
- fresh-tab local typing survival improved enough that the remaining hot path is the insert/coalesce repair machinery itself

Requested:
- stop tracked typing from stalling the browser while insert persistence/collab work continues

What changed:
- `src/editor/plugins/suggestions.ts`
  - moved the high-frequency tracked-insert diagnostics behind a disabled `DEBUG_VERBOSE_INSERT_REPAIR` flag
  - this covers the per-keystroke logs emitted by:
    - insert coalescing candidate resolution
    - whitespace-gap repair
    - insert-decision routing
    - adjacent split-merge run/window/skip scans
- `src/tests/suggestions-split-merge-fixed-point.test.ts`
  - added a fixed-point regression proving adjacent split-insert healing returns `null` once the healed state is already stable

Why this likely addresses the freeze:
- fix34 left very chatty diagnostics in the hottest typing path
- when insert typing is fragmented, each keystroke can traverse and log multiple merge windows across the document
- local helper simulation reached a fixed point instead of looping, which points to hot-path logging pressure rather than an endless appendTransaction repair cycle

## Fix35 preserve missing remote insert metadata follow-up

Shared reports:
- browser QA on fix34: typed insert suggestions now appear locally, but warm collab sync to a fresh tab still drops most of them
- paste suggestions survive, but fragmented typed insert suggestions often disappear across Yjs/collab propagation
- the fresh-tab failure indicates a remote metadata/apply problem, not only the local TC-off strip path

Requested:
- stop remote mark resync from deleting pending insert ids just because the live doc has not surfaced them yet during collab/apply lag

What changed:
- `src/editor/share-collab-insert-metadata.ts`
  - added `preservePendingRemoteInsertMetadata()` to keep authoritative remote pending insert marks when `syncInsertSuggestionMetadataFromDoc()` cannot currently resolve them from the live doc
  - added `mergeResyncedPendingInsertServerMarks()` to merge updated live insert metadata back into the authoritative server mark cache without deleting still-pending remote inserts
- `src/editor/index.ts`
  - `resyncPendingInsertMetadataAfterRemoteApply()` now preserves missing remote insert ids instead of deleting them from local/server metadata during collab reapply
- `src/tests/share-collab-insert-metadata.test.ts`
  - added a focused regression proving:
    - missing remote insert ids are preserved
    - visible insert ids still merge their updated live ranges/content back into the server mark cache
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard for the new remote-preservation path

Why this likely addresses the new collab loss:
- `syncInsertSuggestionMetadataFromDoc()` deletes insert metadata when the current live doc does not expose the insert id
- on a fresh collab tab, the Yjs/content side can lag behind the authoritative remote marks snapshot
- the old resync path treated that temporary absence as authoritative removal and deleted the insert from `lastReceivedServerMarks`
- this patch keeps those pending insert ids alive until the doc catches up

Verified locally:
- `npx tsx src/tests/share-collab-insert-metadata.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/share-collab-hydration.test.ts`
- `npx tsx src/tests/suggestions-disabled-strip-regression.test.ts`
- `npm run build`

Scope note:
- this patch is aimed at warm collab/new-tab insert loss during remote metadata resync
- local insert fragmentation is still a separate lane if the marks survive but remain split

## Fix34 TC-off strip diff guard follow-up

Shared reports:
- browser QA: insert suggestions now appear after hard reload, but later transactions can strip them back out
- after hard reload + TC on, first typing produced a partial insert mark that was removed on a subsequent transaction
- after toggle off/on, typing produced full insert marks, but the next user action could still strip them
- deletions continued to track correctly, so the regression narrowed to post-insert cleanup rather than insert creation itself

Requested:
- stop the TC-off appendTransaction cleanup from stripping pre-existing insert suggestions that merely fall inside a later changed diff range
- add diagnostics that show exactly which suggestion ids and runtime flags were present when TC-off cleanup decides to strip or skip

What changed:
- `src/editor/plugins/suggestions.ts`
  - added diff-analysis helpers that compare old/new suggestion ids by kind across the changed range
  - `appendTransaction.tcOffStrip` now removes only suggestion ids that are newly introduced by the current changed diff, instead of blanket-removing every suggestion mark in the diff range
  - added `tcOffStripSkip` diagnostics plus richer `tcOffStrip` / `historyRestoreEnable` logs, including:
    - `isEnabled`
    - `suggestionsModuleEnabled`
    - `suggestionsDesiredEnabled`
    - explicit disable meta detection
    - per-transaction origin/meta summaries
    - old/new/introduced suggestion-id summaries by kind
- `src/tests/suggestions-disabled-strip-regression.test.ts`
  - added a focused regression proving:
    - a later diff that still contains an existing insert id does not count as a new strip target
    - a genuinely newly introduced insert id still does count as a strip target

Why this likely addresses the current browser symptom:
- the previous TC-off cleanup only asked "is there any suggestion mark anywhere in the changed diff range?"
- that is too coarse once insert suggestions exist: a later unrelated transaction can produce a diff that overlaps an existing insert mark, and the cleanup would remove it even though that mark was not introduced by the new transaction
- by narrowing strip targets to newly introduced suggestion ids, existing insert marks should survive follow-up edits while still allowing true TC-off leaks to be removed

Verified locally:
- `npx tsx src/tests/suggestions-disabled-strip-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npm run build`

Scope note:
- this patch is for the "insert mark created, then stripped later" lane
- it adds diagnostics for the remaining TC-state mystery if stripping still happens

## Fix33 document-load undo-boundary follow-up

Shared reports:
- browser QA Bug 17: with TC on, deleting a word and pressing `Cmd+Z` repeatedly could eventually erase the entire document, remove the Edit/Track Changes toggle, and persist the empty state through reload

Requested:
- stop undo history from walking back into editor bootstrap / document-load transactions

What changed:
- `src/editor/index.ts`
  - added `addToHistory: false` to every full-document `document-load` transaction in the share/editor load path:
    - the pre-collab reset before binding a Yjs doc
    - the stale-suggestions reset transaction during `loadDocument()`
    - the main `loadDocument()` full replace transaction
- `src/tests/document-load-history-regression.test.ts`
  - added a focused regression proving:
    - `document-load` replace stays out of undo history
    - a subsequent user edit is still undoable
    - a second undo cannot walk back into the initial loaded document state

Why this likely addresses Bug 17:
- the browser repro matches ProseMirror history containing bootstrap/document-load replacements
- once those transactions are undoable, repeated undo can walk past "undo my delete" into "undo the loaded document itself"
- on a shared doc, that empty/reset state can then sync and persist as the new canonical content

Verified locally:
- `npx tsx src/tests/document-load-history-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

Scope note:
- this fix is specifically the undo-boundary / total-document-wipe lane
- it does not address the still-open typed-insertion Root Cause A lane

## Fix32 actual-plugin-state reapply follow-up

Shared reports:
- browser QA confirmed Bug 16 was fixed by fix30
- Root Cause A was still live after hard refresh: Track Changes looked active, but typed insertions still landed as plain black text with zero suggestion spans

Requested:
- finish the insert-tracking reload race by distinguishing the real ProseMirror suggestions-plugin state from the fallback desired/module state

What changed:
- `src/editor/plugins/suggestions.ts`
  - added `isSuggestionsPluginEnabled(state)` to read only the real plugin state
  - `toggleSuggestions()` now uses the real plugin state instead of the OR-combined fallback helper
  - `appendTransaction()` now treats `desiredSuggestionsEnabled` as enough to block the TC-off cleanup path, so freshly wrapped suggestions are not stripped during a reload/reconnect gap
- `src/editor/index.ts`
  - `scheduleDesiredSuggestionsReapply()` now skips only when the real plugin state is already enabled
  - `setSuggestionsEnabled()` now verifies success against the real plugin state after dispatch, not the OR-combined helper
  - public `isSuggestionsEnabled()` now returns the real plugin state, which matches the QA/debug expectation for `window.__PROOF_EDITOR__.isSuggestionsEnabled()`
- `src/tests/authored-tracker-suggestions-mode.test.ts`
  - added assertions covering the split between effective TC intent and raw plugin-enabled state
- `src/tests/editor-suggestion-api-regression.test.ts`
  - extended source guards for the new plugin-state helper and the desired-state cleanup/reapply behavior

Why this likely addresses the remaining typed-insert failure:
- before this patch, reload/reconnect code could latch desired TC state, reset the underlying plugin to disabled, and then falsely conclude that TC was already restored because the fallback helper returned true
- in the same gap, wrapped suggestion transactions could still be scrubbed by the TC-off appendTransaction cleanup because that cleanup only checked plugin/module state
- the result was the exact QA symptom: the UI looked like TC was on, but typing still produced plain text with no insertion suggestion

Verified locally:
- `npx tsx src/tests/authored-tracker-suggestions-mode.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npx tsx src/tests/track-changes-structural-delete-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

Scope note:
- this is still Root Cause A work for typed insertion tracking after hard refresh / share reconnect
- cold-reload persistence and structural paragraph edits remain separate lanes

## Fix31 plugin-side TC intent follow-up

Shared reports:
- browser QA: fix29 client bundle was live, but typed insertions still produced zero suggestion marks after hard refresh in TC mode

Requested:
- finish the Root Cause A fix by making the plugin-side TC guards respect the latched desired Track Changes state, not just the editor dispatch interceptor

What changed:
- `src/editor/plugins/suggestions.ts`
  - added a plugin-level `suggestionsDesiredEnabled` latch plus `setSuggestionsDesiredEnabled()`
  - `isSuggestionsEnabled()` now returns true when any of: plugin state, module flag, or desired TC state is on
  - enable/disable/toggle paths now keep the desired latch in sync with the live plugin/module state
- `src/editor/index.ts`
  - now mirrors the editor’s `desiredSuggestionsEnabled` into the shared suggestions helper during `setSuggestionsEnabled()` and after `loadDocument()` resets module state
- `src/editor/plugins/authored-tracker.ts`
  - `shouldTrackHumanAuthorship()` now uses the shared `isSuggestionsEnabled()` helper instead of reading only `suggestionsPluginKey`
  - this prevents human-authored fallback marks from treating TC as off while the editor still intends TC to be on
- `src/tests/authored-tracker-suggestions-mode.test.ts`
  - added a regression proving desired TC state disables authored tracking even before plugin state catches up
- `src/tests/editor-suggestion-api-regression.test.ts`
  - extended source guards for the desired-state mirror and authored-tracker integration

Why this likely addresses the failed fix29 retest:
- fix29 only taught the editor dispatch interceptor about desired TC state
- the plugin props still used the older plugin/module-only checks, so typed input and authored-tracker could continue behaving as if TC were off
- this change removes that split-brain by making the shared suggestions helper and authored-tracker honor the same desired TC latch

Verified locally:
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/authored-tracker-suggestions-mode.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npx tsx src/tests/track-changes-structural-delete-regression.test.ts`
- `npm run build`

Scope note:
- this is still part of Root Cause A for typed/pasted insertions
- cold-reload persistence and formatting-as-suggestions remain separate lanes

## Fix30 mixed-delete paragraph selection follow-up

Shared reports:
- browser QA Bug 16: triple-click full paragraph selection + Backspace deleted all paragraph text with zero new marks and destroyed an existing delete mark inside the selection

Requested:
- stop full-paragraph tracked deletes from erasing already-pending delete marks when the selection contains a mix of plain text plus existing delete-marked text

What changed:
- `src/editor/plugins/suggestions.ts`
  - broadened the mixed-delete helper so it handles `plain + delete` and `plain + replace` ranges, not just `plain + insert`
  - plain text inside the selection now gets a new delete suggestion while pre-existing delete/replace segments are preserved instead of being wiped by a raw `tr.delete(...)`
- `src/tests/track-changes-structural-delete-regression.test.ts`
  - added a focused regression for the new repro:
    - full-paragraph selection over plain text plus an existing delete mark
    - wrapped delete must preserve the visible paragraph text
    - wrapped delete must keep the original delete mark id alive
    - wrapped delete must add one new delete mark for the previously plain text

Why this likely addresses Bug 16:
- the previous fallback only knew how to decompose `plain + insert` selections
- when a selection mixed plain text with an existing delete mark, the helper returned `handled: false`
- the surrounding delete path then executed a raw document delete, which removed both the plain text and the nested pending delete mark

Verified locally:
- `npx tsx src/tests/track-changes-structural-delete-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npm run build`

Scope note:
- this fixes the mixed `plain + delete` data-loss path for full-paragraph selections
- paragraph-break tracking itself is still a separate structural lane

## Fix29 intended-TC-state follow-up

Shared reports:
- `/tmp/codex-qa-stress-test-v4.md`

Requested:
- address the still-open Root Cause A lane where share-doc Track Changes could appear enabled, but typed and pasted insertions still fell through as direct edits because the live suggestions state had been cleared by a disruptive share/collab path

What changed:
- `src/editor/index.ts`
  - added a `desiredSuggestionsEnabled` latch so Track Changes behaves like a persistent intended mode, not a fragile one-shot plugin flag
  - the suggestions interceptor now honors that desired state for local doc-changing transactions, so tracked inserts still wrap even if the live plugin/module flags were transiently reset
  - `loadDocument()` now schedules a Track Changes restore when the desired mode is on, which should cover canonical reloads and share mutation result loads
  - `updateShareEditGate()` now re-applies the desired Track Changes mode once share editing is live again after collab reconnect or hydration
- `src/tests/editor-suggestion-api-regression.test.ts`
  - added source guards for the desired-state latch, the share-edit-gate restore, the load-document restore, and the interceptor’s new desired-state fallback

Why this likely addresses the current browser report:
- the QA pattern points to a reset-after-toggle failure more than a pure paste bug:
  - `Accept All` was already observed switching the editor back to Edit mode
  - share mutation apply paths call `loadDocument()`, which explicitly resets the module-level suggestions flag
  - nothing previously restored the user’s intended TC mode after that reset unless pending suggestions happened to force it back on
- with this patch, local insert wrapping no longer depends on the live plugin/module flags being continuously intact across share/collab resets

Verified locally:
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/authored-tracker-suggestions-mode.test.ts`
- `npm run build`

Scope note:
- this is targeted at Root Cause A for typed/pasted insertions plus the observed TC-mode drop after disruptive share loads
- cold-reload mark persistence and cross-paragraph structural edit tracking remain separate lanes

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
