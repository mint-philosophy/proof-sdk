## Current state

- Local built client bundle: `25e33cbb215adbbc2fd37266a3e81755e0134f7e46cd09dcb5e2f280da5f76af`
- Local `/health` before the next restart still reports build SHA `857ec7749106fca719eea3e03d62d6a1209f5b41`
- `/health` still reports server SHA `13d34ac958362cee902869c4214768bb6d77c3e9`, so treat the public asset hash as the deploy-freshness check
- Branch: `codex/simple-markup-rebuild-20260322`
- Browser QA on `fix64` (`857ec77`) confirmed the core review lane is now working end to end:
  - typed insertion marks create as single inline spans
  - overwrite creates both delete and insert marks
  - hard reload preserves inserts and deletes
  - `Accept & Next` no longer cascades across all marks
  - reject on insertion now removes the inserted text correctly
- `fix65` (`fce6f1f`) is the next browser candidate:
  - it targets the remaining undo blocker where `Cmd+Z` after a tracked deletion appears to do nothing
  - the fix reconciles stale suggestion metadata after history undo so a removed delete mark cannot be reconstructed from metadata on the next pass
- `fix66` is the immediate follow-up for a browser-blocking regression in `fix65`:
  - `appendTransaction(...)` was referencing `hasHistoryChange` outside the scope where it was declared
  - the result was `ReferenceError: hasHistoryChange is not defined` on every TC keystroke
  - the fix simply hoists that declaration to the top of `appendTransaction(...)` so both the TC-off history lane and the later history metadata reconciliation lane can use it safely
- `fix67` is the next browser candidate for the remaining review blocker on insertions:
  - browser QA on `fix66` showed `Accept & Next` worked for deletions and `Reject & Next` worked for insertions, but `Accept & Next` on insertions could advance the popover while leaving the insert pending
  - the new guard in `markAcceptPersisted(...)` verifies that the resolved insert ids are actually gone from the local pending-suggestion set after the persisted mutation
  - if they are still present, the editor now force-applies the canonical share mutation result instead of silently treating that lane as success
- `fix68` is the follow-up for the deletion review regression reported after `fix67`:
  - browser QA showed insertion accepts were fixed, but deletion accepts could still close the popover while leaving an equivalent pending delete mark behind under a remapped id
  - the local verification step now checks not just the original resolved ids, but also any equivalent pending suggestion that still matches the accepted source mark
  - if either survives, the editor force-applies the canonical result and rechecks before allowing the review flow to continue
- Remaining known follow-ups after fix64:
  - warm reload can still revert some overwrite-created inserts from inline to widget
  - formatting changes still bypass TC
- Last commits in this session:
  - `fix68` pending commit: verify deletion accepts against equivalent pending marks
  - `fix67` pending commit: verify persisted insert accepts are actually cleared locally
  - `fix66` pending commit: hoist `hasHistoryChange` so TC appendTransaction no longer crashes
  - `fce6f1f` `fix65: reconcile stale delete metadata after undo`
  - `9af1d9c` `docs: record fix64 rollout`
  - `857ec77` `fix64: stabilize review actions and insert reject fallback`
  - `d414693` `fix63: preserve rich live insert metadata in share sync`
  - `392fe58` `docs: record fix62 browser QA pass`
  - `a6d6ae4` `docs: record fix62 handoff`
  - `a54a0ba` `fix62: materialize collapsed inserts onto live text`
  - `fix53` pending commit: route recent raw Yjs plain-text self-echoes through remote repair
  - `fix52` pending commit: preserve exact metadata anchors for materialized pending inserts
  - `fix51` pending commit: move native typed-insert wrapping into appendTransaction on the matched passthrough cycle
  - `fix50` pending commit: restore dropped local insert marks after a remote plain-text self-echo replaces them
  - `fix49` `14e7edc`: carry the exact native typed-insert range into the delayed wrap
  - `fix48` `bfd049f`: defer native typed-input wrapping to a mark-only follow-up transaction
  - `bdea5d4` `fix47: wrap native typed inserts in place`
  - `ca60b7c` `fix46: passthrough native typed insert before wrapping`
  - `b32f272` `fix45: defer tracked typing to native prosemirror flow`
  - `273b3b6` `fix44: use prosemirror default text input transactions`
  - `c9615af` `fix25: repair fragmented share insert marks on reload`
  - `a004086` `build: resolve finalize script paths via fileURLToPath`

## Fix65 undo metadata reconciliation

Shared reports before the patch:
- after `fix64`, the create/reload/review workflow was finally stable, but `Cmd+Z` still appeared to do nothing for tracked deletions
- browser QA showed a delete mark could remain visible after undo even though the history transaction itself fired
- the most likely failure mode was stale suggestion metadata surviving outside the history stack and rehydrating the deleted mark immediately after undo

What changed:
- `src/editor/plugins/suggestions.ts`
  - added `collectActualSuggestionIdsInDoc(...)` to distinguish actual in-document `proofSuggestion` marks from metadata-only pending marks
  - added `buildHistorySuggestionMetadataReconciliationTransaction(...)`
  - on history transactions, if an actual suggestion id existed in the pre-undo doc but not in the post-undo doc, and that id still exists in marks metadata, the plugin now emits a metadata-only cleanup transaction
  - that cleanup runs with `addToHistory: false` and `suggestions-wrapped: true`, so it does not pollute undo history or trigger the normal TC strip path
- `src/tests/track-changes-undo-delete-regression.test.ts`
  - new regression proving that raw history undo can leave stale delete metadata behind, and that the new reconciliation transaction removes it
- `src/tests/editor-suggestion-api-regression.test.ts`
  - source guard updated so the history reconciliation path cannot silently drop out in a refactor

Why this is the right next step:
- the browser symptom was not “undo failed to dispatch”; it was “the deletion mark persisted”
- the marks system can rebuild decorations from metadata even when the corresponding document mark is gone
- history only knows about document changes, not sidecar metadata, so the delete mark could be removed by undo and then reconstructed from stale metadata on the next pass
- reconciling metadata against the actual post-history document state closes that gap without changing the normal review or Yjs lanes

Verified locally:
- `npx tsx src/tests/track-changes-undo-delete-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npm run build`

## Fix64 review-action regressions

Shared reports before the patch:
- `fix63` solved the multi-operation corruption lane, but browser QA still reported two high-severity review regressions:
  - `Accept & Next` appeared to accept every pending mark instead of just the current review item
  - insertion reject via the right-click review path kept the inserted text instead of removing it

What changed:
- `src/editor/plugins/mark-popover.ts`
  - `runSuggestionReviewAction(...)` now refuses to start a second review mutation while `suggestionReviewTransitionPending` is true
  - this is meant to block a trailing synthetic click from re-firing the next review button while the panel is auto-advancing
- `server/document-engine.ts`
  - added `buildRejectedSuggestionMarkdown(...)` for reject-side canonical rewrite fallback
  - reject fallback now removes materialized insert text instead of preserving the current markdown unchanged when hydration falls back
  - the same reject-side canonical rewrite is applied in both sync and async single-mark suggestion mutation paths
- `src/tests/document-engine-reject-insert-regression.test.ts`
  - new regression covering materialized insert rejection and anchor-based inline insert rejection
- `src/tests/mark-popover-review-followup-regression.test.ts`
  - updated source guard requiring the follow-up transition guard in review actions

Verified locally:
- `npx tsx src/tests/document-engine-reject-insert-regression.test.ts`
- `npx tsx src/tests/mark-popover-review-followup-regression.test.ts`
- `npx tsx src/tests/share-track-changes-multi-insert-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npm run build`

## Fix62 materialize collapsed inserts onto live text

Shared reports:
- `fix61` removed the stale settled-repair loop and preserved the initial typed insert
- the remaining duplication was now whole-sentence and architectural:
  - one green `mark-insert` widget copy
  - one plain underlying text copy
- QA confirmed the insert was rendering as a `ProseMirror-widget` preview after a later edit elsewhere, which meant the insert had fallen back to a collapsed metadata anchor instead of a live inline range

What changed:
- `src/editor/plugins/marks.ts`
  - `resolveStoredMarkRange(...)` now special-cases pending collapsed insert metadata
  - before accepting a zero-width insert anchor as final, it tries to materialize adjacent plain text that matches the stored insert content
  - if the inserted text is already present in the document, the resolver now returns that live text span instead of the collapsed insertion point
- `src/tests/marks.test.ts`
  - added a regression proving that collapsed insert metadata over already-materialized plain text resolves to the live text span and renders as a single inline insert decoration rather than a preview widget duplicate

Why this is the right next step:
- the fix59 diagnostics already proved the insert mark itself was surviving the transaction path
- by `fix61`, per-character duplication and settled-repair recursion were gone
- the remaining duplicate was renderer-level: collapsed insert metadata was still treated as anchor-only even when the inserted text had already materialized in the document
- resolving that stored mark range onto the live text span gives simple mode one inline insert to render instead of `widget + bare text`

Verified locally:
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/marks.test.ts` still has 4 pre-existing unrelated failures, and the new `applyRemoteMarks materializes collapsed insert metadata...` regression passes
- `npm run build`

## Fix53 route recent raw Yjs plain-text self-echoes through remote repair

Shared reports:
- browser QA on fix52 still showed the same widget-plus-bare-text duplicate
- the remaining strong clue was the event order:
  - local native passthrough + appendTransaction wrap fired first
  - then `tc.yjsIncoming` fired once after the visible duplicate
- that points to a raw Yjs self-echo arriving after local typing and bypassing the remote-repair path because it does not carry suggestion marks

What changed:
- `src/editor/index.ts`
  - the interceptor now computes `shouldTreatYjsPlainTextEchoAsRemote` for recent raw Yjs doc changes that arrive inside the local typing/coalescing window, do not carry incoming suggestion marks, and are not explicit `isChangeOrigin` transactions
  - those transactions now enter the remote-content branch and trigger `repairRemoteSuggestionBoundaryInheritance(...)` instead of falling through the local wrapping lane
  - `tc.yjsIncoming` payload now records `treatedAsRemotePlainEcho`
- `src/tests/editor-suggestion-api-regression.test.ts`
  - source guard updated to require the new raw-Yjs-plain-echo remote classification

Why this is the right next step:
- the appendTransaction native wrap path was already active
- the visible duplicate still survived until a subsequent raw Yjs event
- the remote boundary-repair logic already knows how to restore dropped local insert marks, but it was never reached for raw `y-sync$` plain-text self-echoes

Verified locally:
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/suggestion-boundaries-collab-regression.test.ts`
- `npm run build`

## Fix52 preserve exact metadata anchors for materialized pending inserts

Shared reports:
- browser QA on fix51 still showed the same widget-plus-bare-text duplicate
- the strongest clue was that the appendTransaction wrap path was clearly firing, but the rendered insert still fell back to a widget on top of the plain native text

What changed:
- `src/editor/plugins/marks.ts`
  - `normalizeMetadata(...)` now preserves `quote`, `startRel`, and `endRel` for pending insert suggestions when the live insert text exactly matches the stored insert content
  - `buildCanonicalShareMarkMetadata(...)` now preserves the same exact anchors for materialized inline pending inserts even though the serialized `range` remains collapsed to the insertion anchor
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a regression asserting that the native typed-insert follow-up leaves metadata with `quote: 'Y'` and precise `startRel/endRel` anchors

Why this is the right next step:
- the local wrap transaction itself looked correct
- the remaining duplicate pattern matched the marks plugin's metadata-only widget fallback
- preserving exact relative anchors gives the renderer a way to re-resolve the actual inserted text span even if the live insert mark is lost momentarily

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npm run build`

## Fix51 move native typed-input wrapping onto appendTransaction

Shared reports:
- browser QA on fix50 still showed `YY`
- the new decisive evidence was:
  - `scheduleNativeTextInputWrap` / `followupNativeTextInputWrap` fired
  - `appendTransactionFallback` did not fire
  - `tc.yjsIncoming` fired only after the visible duplication
  - the local helper still looked correct in isolated state, so the failure was not a literal `insertText(...)` in the follow-up helper itself

What changed:
- `src/editor/index.ts`
  - the interceptor still matches the native typed insert and lets it through unchanged
  - instead of scheduling a microtask follow-up transaction, it now annotates that native transaction with `proof-native-typed-input-match`
- `src/editor/plugins/suggestions.ts`
  - `appendTransaction(...)` now detects the matched native typed-input passthrough and immediately returns the mark-only wrap transaction for that exact range
  - this keeps the wrap inside the ProseMirror appendTransaction cycle instead of dispatching a later out-of-band follow-up transaction
- `src/tests/editor-suggestion-api-regression.test.ts`
  - source guard updated to require the meta-based appendTransaction wrap path and forbid the older queued microtask path

Why this is the right next step:
- the microtask follow-up path was still producing the widget-plus-bare-text duplication in the browser even though the isolated helper looked clean
- moving the wrap into appendTransaction should eliminate the delayed dispatch race and let the matched native insert be marked on the same transaction cycle

Verified locally:
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix50 restore dropped local insert marks after a Yjs self-echo

Shared reports:
- browser QA on fix49 still showed `YY` for a single typed character
- the new evidence narrowed it further:
  - `scheduleNativeTextInputWrap` and `followupNativeTextInputWrap` both fired
  - `appendTransactionFallback` did not fire
  - the final DOM showed one anchor/widget `Y` plus one bare native `Y`
  - a `tc.yjsIncoming` followed the local wrap
- that combination points to a remote self-echo replacing the newly wrapped local insert span with plain/authored text, leaving the pending insert metadata behind

What changed:
- `src/editor/plugins/suggestion-boundaries.ts`
  - `buildRemoteInsertSuggestionBoundaryRepair(...)` no longer bails out immediately when a recent local insert id disappears entirely from `newState`
  - if the old insert text is still present as plain text in the same range, and the insert is still pending, the repair path now reapplies the insert mark onto that existing text instead of leaving a metadata-only anchor
- `src/tests/suggestion-boundaries-collab-regression.test.ts`
  - added a regression for the exact self-echo case: old state has a pending insert-marked `Y`, new state has the same `Y` as plain text, and boundary repair must restore the insert mark without duplicating the character

Why this is the right next step:
- the fix49 local follow-up wrap was already running
- the remaining duplicate looked like a lost-mark remote echo, not a second local fallback insert
- the marks plugin only renders the widget-style insert when metadata survives but live insert marks do not

Verified locally:
- `npx tsx src/tests/suggestion-boundaries-collab-regression.test.ts`
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix46 passthrough the native typed-insert transaction before wrapping

Shared reports:
- browser QA on fix45 still showed `YY` for a single typed character
- the key new evidence was:
  - `handleTextInput` no longer dispatched anything
  - the only remaining TC log was `appendTransactionPersistenceFallback`
  - DOM inspection showed one plain native character plus one marked character
- that means the native insert was correct, but the interceptor was still wrapping a transaction too early and synthesizing an extra marked character before the plain-insert fallback could do its job

Requested:
- keep `handleTextInput` as metadata only
- allow the exact native typed-insert transaction to pass through the interceptor unwrapped
- let appendTransaction / plain-insert fallback add marks to the already-inserted native text

What changed:
- `src/editor/plugins/suggestions.ts`
  - added a short-lived pending native text-input record from `handleTextInput`
  - added `shouldPassthroughPendingNativeTextInputTransaction(oldState, tr)` to match the next plain inserted text transaction by text and range
  - reset paths now clear that pending record
- `src/editor/index.ts`
  - the suggestions interceptor now checks `shouldPassthroughPendingNativeTextInputTransaction(beforeState, tr)` before `wrapTransactionForSuggestions(...)`
  - when it matches, it logs `[tc.dispatch.passthroughNativeTextInput]` and dispatches the original native transaction unchanged
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a one-shot regression proving the matched native plain-insert transaction is passed through
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to require the new interceptor passthrough branch

Why this is the right next step:
- fix45 removed direct dispatch from `handleTextInput`, but the interceptor still treated the first native typing transaction like an arbitrary edit and wrapped it immediately
- the existing plain-insert fallback already knows how to mark already-inserted text
- the missing piece was letting that one native transaction reach appendTransaction first instead of synthesizing a second marked insertion on top of it

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-disabled-direct-edit.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npm run build`

## Fix48 defer native typed-insert wrapping to a follow-up mark-only transaction

Shared reports:
- browser QA on fix47 still showed `YY` for a single typed character
- the key new evidence was:
  - `appendTransactionFallback` was gone
  - the only remaining TC branch was `tc.dispatch.wrapNativeTextInput`
  - the duplication still appeared as one native character plus one tracked character
- that meant the remaining problem was timing, not a literal `insertText(...)` in the fallback helpers

Requested:
- let the matched native typed-insert transaction commit untouched first
- skip same-cycle append fallback for that transaction
- then run a mark-only follow-up wrap after the DOM/state settle

What changed:
- `src/editor/index.ts`
  - the matched native text-input branch now logs `[tc.dispatch.scheduleNativeTextInputWrap]`
  - it tags the native transaction with `proof-native-typed-input` and dispatches it unchanged
  - it then schedules a `queueMicrotask(...)` follow-up that builds a mark-only wrap against `view.state`, sets `addToHistory: false`, and logs `[tc.dispatch.followupNativeTextInputWrap]`
- `src/editor/plugins/suggestions.ts`
  - added `buildNativeTextInputFollowupWrapTransaction(oldState, newState)` as a thin wrapper around the existing plain-insert mark-only fallback
  - `appendTransaction` now detects `proof-native-typed-input` and returns `null` for that cycle so the same-cycle persistence fallback does not race the microtask wrap
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to require the new scheduled follow-up branch and the appendTransaction stand-down

Why this is the right next step:
- fix47 proved the native text-input matcher was correct and that the old fallback branch was no longer the only duplication source
- the remaining plausible failure mode was trying to mutate the native typing transaction too early, while the browser/ProseMirror input reconciliation was still in flight
- deferring the mark application preserves one real text insertion and converts it into a tracked insert only after that insertion is already stable in editor state

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-disabled-direct-edit.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npm run build`

## Fix49 carry the exact native typed-insert range into the delayed follow-up wrap

Shared reports:
- browser QA on fix48 still showed `YY` for a single typed character
- the key new evidence was:
  - `scheduleNativeTextInputWrap` and `followupNativeTextInputWrap` both fired
  - the visible DOM shape was one tracked `Y` widget inside the authored span plus one bare native `Y` outside it
  - that means the delayed follow-up did run, but it rediscovered the wrong boundary range and created an anchor-style insert preview instead of marking the real native character

Requested:
- stop rediscovering the delayed wrap range from a generic old/new diff
- carry the exact matched native insert range from the intercepted native transaction into the microtask follow-up
- only wrap that exact already-inserted text in the follow-up transaction

What changed:
- `src/editor/plugins/suggestions.ts`
  - added `consumePendingNativeTextInputTransactionMatch(oldState, tr)` which returns the exact matched native insert `{ text, from, to }` instead of only a boolean
  - `buildNativeTextInputFollowupWrapTransaction(...)` now accepts that exact match and prefers it over a generic doc diff
  - added a small range validator so the follow-up only marks the precise native inserted text when that text is actually present at the matched range in `newState.doc`
- `src/editor/index.ts`
  - the interceptor now captures `nativeTextInputMatch` once, dispatches the native transaction untouched, and passes that exact match into the delayed follow-up wrap
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added an authored-boundary regression where native typing happens at the edge of an authored span
  - the regression asserts the delayed follow-up produces exactly one suggestion-marked `Y` and zero extra plain `Y` characters
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to require the exact-match capture and follow-up call shape

Why this is the right next step:
- fix48 proved the timing needed to change, but the delayed follow-up still used `findDiffStart/findDiffEnd`
- in the typed-at-boundary case, that generic diff can lock onto the authored-boundary split rather than the actual native inserted character
- carrying the exact native insert match removes that ambiguity and tells the follow-up exactly which text span should become the tracked insert

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix47 wrap the matched native typed-insert transaction in place

Shared reports:
- browser QA on fix46 still showed `YY` for a single typed character
- the key new evidence was:
  - the matcher path worked: `nativePassthroughCheck` and `tc.dispatch.passthroughNativeTextInput` both fired
  - the remaining duplication happened only after that, when `appendTransactionFallback` ran
- that meant the matched native text-input transaction should not merely pass through; it needed to be converted into a tracked insert before appendTransaction ever saw it

Requested:
- use the native typed-insert transaction itself as the tracked-insert carrier
- add/remove marks and sync metadata on that existing transaction, instead of letting appendTransaction create a second tracked representation later

What changed:
- `src/editor/plugins/suggestions.ts`
  - added `wrapPendingNativeTextInputTransaction(oldState, tr)` which:
    - detects the plain inserted range on the native transaction
    - strips authored marks from that inserted text
    - adds the insert suggestion mark directly onto the already-inserted text
    - syncs insert metadata to the live doc
    - tags the result as `suggestions-wrapped`
- `src/editor/index.ts`
  - the matched native text-input branch now calls `wrapPendingNativeTextInputTransaction(beforeState, tr)` and dispatches that wrapped native transaction in place
  - logging changed from passthrough to `[tc.dispatch.wrapNativeTextInput]`
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a direct regression proving the native inserted character can be wrapped in place while preserving exactly one inserted character
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to require the new in-place native-wrap branch

Why this is the right next step:
- fix46 proved the transaction matcher was correct
- the remaining bug was downstream of that matcher, inside the later fallback path
- using the native transaction itself as the tracked-insert carrier removes that later duplication lane entirely

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-disabled-direct-edit.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npm run build`

## Fix45 stop dispatching tracked inserts from handleTextInput

Shared reports:
- browser QA on fix44 still showed `YY` for a single typed `Y`
- the decisive new finding was that even `deflt()` had the same additive failure mode as a custom `insertText(...)` dispatch
- in the live runtime, any transaction dispatched directly from `handleTextInput` landed on top of the native contenteditable insertion

Requested:
- stop dispatching from `handleTextInput` entirely for ordinary typing
- let ProseMirror's native/default text-input flow produce the single real insertion, then rely on the existing wrapper/fallback path to mark it as a tracked insert

What changed:
- `src/editor/plugins/suggestions.ts`
  - `handleTextInput` no longer dispatches tracked inserts at all
  - for TC-enabled ordinary typing it now logs and returns `false`, allowing ProseMirror's own text-input transaction to proceed
  - the active tracked-insert wrapping responsibility stays with the editor interceptor / appendTransaction fallback instead of the hook itself
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a direct regression for `buildPlainInsertionSuggestionFallbackTransaction(...)`
  - the regression proves a plain inserted character can be wrapped into exactly one suggestion-marked span without changing the text content
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to require that `handleTextInput` no longer dispatches or calls the handled-text-input helpers

Why this is the right next step:
- fix43 and fix44 established that the browser/runtime does not tolerate tracked-insert dispatch from `handleTextInput`
- the ordinary ProseMirror/native insertion path already exists and the repo already has a plain-insert fallback to mark that insertion after the fact
- moving responsibility back to the native transaction path is the cleanest way to eliminate additive `XX` / `YY` duplication at the source

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-disabled-direct-edit.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npm run build`

## Fix44 route ordinary tracked typing through ProseMirror deflt()

Shared reports:
- browser QA on fix43 still showed `XX` for a single typed `X`
- the decisive new finding was that the custom `beforeinput` blocker never fired in the live browser
- local inspection of `prosemirror-view` showed `handleTextInput` accepts a fifth `deflt()` argument and is called from the DOM-change reconciliation path after native text input has already been observed

Requested:
- stop relying on the failed `beforeinput` blocker path
- make ordinary tracked typing use ProseMirror's own default text-input transaction instead of a second synthetic `insertText(...)`

What changed:
- `src/editor/plugins/suggestions.ts`
  - removed the pending native-insert blocker cache and the dead `beforeinput.preventNativeInsertText` branch
  - `handleTextInput` now accepts `(view, from, to, text, deflt)`
  - ordinary typing dispatches `deflt().setMeta('proof-handled-text-input', ...)` when the resolved insert range matches the incoming ProseMirror range
  - only the rare adjusted-range fallback still uses a custom `state.tr.insertText(...)`
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - removed the obsolete beforeinput-blocker regression
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to require the `handleTextInput(..., deflt)` contract and the absence of the failed beforeinput blocker path

Why this is the right next step:
- the fix43 blocker path never ran in the live browser
- ProseMirror already provides the right default text-input transaction for the DOM-change lane
- the previous synthetic `state.tr.insertText(...)` path was the most plausible place ordinary typing could diverge from the browser's own text-input reconciliation

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npx tsx src/tests/track-changes-paste-regression.test.ts`
- `npm run build`

## Fix43 let handleTextInput dispatch and beforeinput only block native insertion

Shared reports:
- browser QA on fix42 showed the exact event order for a single typed character:
  1. `handleTextInput` dispatched the tracked insert
  2. the custom `beforeinput` handler ran afterward
  3. the old fix42 `beforeinput` path dispatched a second tracked insert
- that means fix42 was architecturally backwards for this browser/runtime:
  - `handleTextInput` is the first dispatch source
  - `beforeinput` is only useful as a later native-DOM blocker

Requested:
- keep `handleTextInput` as the only tracked-insert dispatcher and make `beforeinput` block only the browser's raw insertion after that dispatch

What changed:
- `src/editor/plugins/suggestions.ts`
  - removed the fix42 behavior where `beforeinput` dispatched an insert transaction
  - `handleTextInput` now records a short-lived pending native-insert block before it dispatches the tracked insert
  - `beforeinput` for `insertText` now only:
    - consumes that pending block when the text matches
    - logs `[suggestions.beforeinput.preventNativeInsertText]`
    - calls `preventDefault()` / `stopPropagation()`
    - returns `true`
  - ordinary tracked insertion still originates only from `handleTextInput`
  - removed the old `skipBeforeinputHandled` fallback logic because the order is the opposite in the live browser
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - replaced the fix42 regression with a blocker-only regression proving the pending native-insert block is consumed once and then clears
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the source guard to expect:
    - `rememberPendingBeforeinputNativeInsertBlock(...)` in `handleTextInput`
    - `[suggestions.beforeinput.preventNativeInsertText]` in `beforeinput`

Why this is the right next step:
- the browser logs ruled out duplicate `handleTextInput` callbacks
- they also ruled out `beforeinput` as the first dispatch source
- once the ordering is known, the only coherent fix is:
  - `handleTextInput` dispatches once
  - `beforeinput` blocks the browser/native insert and nothing else

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix42 route ordinary TC typing through beforeinput

Shared reports:
- browser QA on fix41: duplication still persisted
- the decisive new finding was:
  - `handleTextInput` fired exactly once per key
  - there were no `skipDuplicateCall` logs
  - the only later transactions were mark-only appendTransaction repairs
- that means the doubling was not caused by a second `handleTextInput` callback

Working hypothesis:
- the browser's raw DOM insertion is still landing for ordinary typing, while TC also dispatches its own tracked insert
- if that is true, fixing it in appendTransaction is too late; ordinary text input needs to be intercepted before the browser mutates the DOM

What changed:
- `src/editor/plugins/suggestions.ts`
  - `beforeinput` now handles ordinary `insertText` when TC is enabled:
    - resolves the tracked insertion range
    - dispatches the tracked insert transaction directly
    - `preventDefault()` / `stopPropagation()` to block the browser's raw DOM insertion
    - logs `[suggestions.beforeinput.insertText]`
  - added a short-lived `recentBeforeinputHandledTextInput` cache so `handleTextInput` can recognize and skip the same keystroke if ProseMirror still calls it afterward
  - `handleTextInput` now logs `[suggestions.handleTextInput.skipBeforeinputHandled]` when it no-ops because `beforeinput` already handled that text/range
  - reset paths clear the beforeinput cache alongside the older handled-input caches
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a regression proving `handleTextInput` skipping is one-shot after `beforeinput` has already handled the same text/range
- `src/tests/editor-suggestion-api-regression.test.ts`
  - added source guards for the new beforeinput path and handleTextInput fallback skip

Why this is the right next step:
- fix41 proved the duplicate is not a second `handleTextInput` callback
- once that is true, the only earlier control point for ordinary typing is `beforeinput`
- handling raw text insertion there gives us a place to block the browser's native insertion before any later mark repair or DOM reconciliation happens

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix41 suppress duplicate handleTextInput callbacks at the source

Shared reports:
- browser QA on fix40: duplication still persisted
- the key new diagnostic was that the second handled transaction arrived with:
  - the same `handledMeta`
  - the same original `diff.from` / `diff.to`
  - but `oldHasOriginalText = false`
- that means the duplicate callback happens before `view.state` reflects the first tracked insert, so any suppression rule that waits to observe the first insert in the old document can never fire

Requested:
- suppress the duplicate at `handleTextInput` call time instead of trying to infer it later from document state

What changed:
- `src/editor/plugins/suggestions.ts`
  - added a short-lived `recentHandledTextInputCall` cache keyed by:
    - `text`
    - `from`
    - `to`
  - `handleTextInput` now drops an immediate duplicate callback with the same text and insertion range before dispatching any transaction
  - added `[suggestions.handleTextInput.skipDuplicateCall]` logging for that source-level suppression
  - reset paths now clear both the pending echo matcher and the recent-handleTextInput call cache
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a regression proving an immediate duplicate `handleTextInput` callback with the same text/range is suppressed at the source, while a different insertion range is not

Why this is the right next step:
- fix40 established that the duplicate transaction can arrive before the first tracked insert is visible in `view.state`
- once that is true, document-based duplicate detection is too late for this lane
- the remaining reliable discriminator is the callback shape itself: same text, same range, immediate repeat

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix40 suppress duplicate handled-input echoes across original and remote lanes

Shared reports:
- browser QA on fix39: tracked typing still duplicated every character on fresh docs
- the console now showed `rememberEcho` + `echoCheck` pairs rather than `skipHandledMeta`, so the suppressor was finally inspecting transactions
- duplication still persisted, which pointed to two remaining gaps:
  - duplicate inserts can arrive at either the post-insert position or the original insertion position
  - duplicate echoes can bypass the local-only TC branch entirely, which means the suppressor must run before the remote/local split

Requested:
- catch both original-position and post-insert duplicate echoes, including Yjs/collab echoes that arrive outside the local wrapping lane

What changed:
- `src/editor/plugins/suggestions.ts`
  - pending handled-input echo state now records:
    - `originalFrom`
    - `originalTo`
    - `expectedFrom`
    - `expectedTo`
  - `rememberHandledTextInputDispatch()` logs both the original insert range and the post-insert expected echo range
  - `shouldSuppressHandledTextInputEcho()` now suppresses either:
    - a duplicate inserted at the expected post-insert echo range
    - a duplicate inserted again at the original range once the original text already exists in the document
  - `echoCheck` diagnostics now log:
    - `matchesExpectedEcho`
    - `matchesOriginalDuplicate`
    - `oldHasOriginalText`
- `src/editor/index.ts`
  - the handled-input echo suppressor now runs before the local/remote branching, so recent duplicate echoes can be dropped even if they arrive as remote/Yjs-origin content changes
  - `tc.dispatch.suppressHandledTextInputEcho` now logs whether the suppressed transaction was remote and includes `yjsOrigin`
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added a regression for a second handled-meta insert at the original position after the first tracked insert already exists
- `src/tests/editor-suggestion-api-regression.test.ts`
  - updated the interceptor source guard to reflect the earlier suppression point

Why this is the right next step:
- fix39 proved the old handled-meta early return was wrong, but suppression was still scoped too narrowly
- the remaining live duplication can only come from:
  - a duplicate insert at a different position than the original expected echo assumption
  - or a duplicate transaction that never reaches the local-only suppression branch
- this patch addresses both at the interceptor boundary

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix39 suppress handled-meta duplicate text-input echoes

Shared reports:
- browser QA on fix38: duplicated tracked typing still happens on fresh docs
- for each physical character, the console showed:
  - `[suggestions.handleTextInput]`
  - `[suggestions.handleTextInput.rememberEcho]`
  - `[suggestions.handleTextInput.echoCheck.skipHandledMeta]`
- there were zero plain-echo match logs, which means the duplicate follow-up transaction was carrying `proof-handled-text-input` meta too, so the suppressor never inspected its actual diff

Requested:
- stop treated handled-meta follow-up transactions from bypassing the duplicate-echo suppressor

What changed:
- `src/editor/plugins/suggestions.ts`
  - `shouldSuppressHandledTextInputEcho()` no longer returns early when a transaction carries `proof-handled-text-input`
  - it now inspects the transaction diff even for handled-meta transactions and suppresses it when it matches the remembered post-insert duplicate position/text
  - the echo diagnostics now include `handledMeta` in:
    - `echoCheck.noDocChange`
    - `echoCheck.noPlainInsertDiff`
    - `echoCheck`
- `src/tests/suggestions-text-input-echo-regression.test.ts`
  - added coverage for:
    - suppressing a second handled-meta insertion at the post-insert duplicate position
    - not suppressing the original handled text-input transaction itself

Why this is the right next step:
- the isolated wrapper/healer path already proved clean
- fix38 showed the duplicate lane was not a plain raw DOM echo
- the browser logs narrowed it to a follow-up transaction reusing handled-input meta, so the suppressor needed to analyze that path rather than skipping it

Verified locally:
- `npx tsx src/tests/suggestions-text-input-echo-regression.test.ts`
- `npx tsx src/tests/editor-suggestion-api-regression.test.ts`
- `npx tsx src/tests/track-changes-yjs-origin-regression.test.ts`
- `npm run build`

## Fix38 handled-text-input echo diagnostics

Shared reports:
- browser QA on fix37: character duplication still happens on fresh docs
- console showed many `handleTextInput` logs but zero `tc.dispatch.suppressHandledTextInputEcho` logs
- that means the echo suppressor is not matching the duplicate transaction shape, or the duplicate path is a second handled text-input dispatch rather than a raw DOM echo

Requested:
- log the exact remembered expectation versus the actual follow-up transaction shape so the duplicate path can be identified precisely

What changed:
- `src/editor/plugins/suggestions.ts`
  - `rememberHandledTextInputDispatch()` now logs `[suggestions.handleTextInput.rememberEcho]` with:
    - `text`
    - `from`
    - `to`
    - `expectedFrom`
    - `expectedTo`
  - `shouldSuppressHandledTextInputEcho()` now logs:
    - `[suggestions.handleTextInput.echoCheck.skipHandledMeta]` when the follow-up transaction is itself tagged as handled text input
    - `[suggestions.handleTextInput.echoCheck.expired]` when the pending echo window times out
    - `[suggestions.handleTextInput.echoCheck.noDocChange]` when a checked transaction does not change the doc
    - `[suggestions.handleTextInput.echoCheck.noPlainInsertDiff]` when the transaction is not a simple plain insertion diff
    - `[suggestions.handleTextInput.echoCheck]` with both the pending expectation and the actual detected diff when a plain insertion diff exists

Why this is the right next step:
- fix37’s predicate works in the local regression, so the remaining failure is now about the live browser transaction shape
- these logs will tell us whether the duplicate path is:
  - a second handled `handleTextInput` dispatch
  - a raw DOM echo with different positions than expected
  - a non-plain diff shape entirely

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
