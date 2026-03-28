import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { ReplaceStep, ReplaceAroundStep } from '@milkdown/kit/prose/transform';
import type { EditorView } from '@milkdown/kit/prose/view';
import { ySyncPluginKey } from 'y-prosemirror';

type ShareContentFilterState = {
  enabled: boolean;
};

const shareContentFilterKey = new PluginKey<ShareContentFilterState>('share-content-filter');
export const SHARE_CONTENT_FILTER_ALLOW_META = 'proof.share.allowContentMutation';

/**
 * When enabled, blocks text-editing transactions while allowing mark changes.
 * This lets web viewers select text and add comments/flags/suggestions
 * without being able to edit the prose content itself.
 *
 * Allowed: AddMarkStep, RemoveMarkStep (comments, flags, etc.)
 * Blocked: ReplaceStep, ReplaceAroundStep (typing, paste, delete)
 */
export function enableShareContentFilter(view: EditorView): void {
  const tr = view.state.tr.setMeta(shareContentFilterKey, { enabled: true });
  view.dispatch(tr);
}

export function disableShareContentFilter(view: EditorView): void {
  const tr = view.state.tr.setMeta(shareContentFilterKey, { enabled: false });
  view.dispatch(tr);
}

export const shareContentFilterPlugin = $prose(() => {
  return new Plugin<ShareContentFilterState>({
    key: shareContentFilterKey,
    state: {
      init: () => ({ enabled: false }),
      apply(tr, value) {
        const meta = tr.getMeta(shareContentFilterKey) as ShareContentFilterState | undefined;
        if (meta && typeof meta.enabled === 'boolean') {
          return { enabled: meta.enabled };
        }
        return value;
      }
    },
	    filterTransaction(tr, state) {
	      const pluginState = shareContentFilterKey.getState(state);
	      if (!pluginState?.enabled) return true;
	      const debugTypedInsert = tr.getMeta('proof-native-typed-input') === true || tr.getMeta('suggestions-wrapped');
	      // Allow explicitly trusted bridge mutations (transaction-scoped only).
	      if (tr.getMeta(SHARE_CONTENT_FILTER_ALLOW_META) === true) {
	        if (debugTypedInsert) {
	          console.log('[share-content-filter.filterTransaction.allowTrusted]', {
	            stepTypes: tr.steps.map((step) => step.constructor.name),
	          });
	        }
	        return true;
	      }
	      // Always allow collaborative remote transactions from Yjs.
	      //
	      // In some production bundles, y-prosemirror sync transactions are tagged under
	      // `tr.meta['y-sync$']`, but `tr.getMeta(ySyncPluginKey)` can be `undefined`
	      // (likely due to dependency duplication / differing PluginKey instances).
	      //
	      // Treat any y-sync metadata as trusted collaboration traffic so we never block
	      // initial hydration, which would leave the doc blank.
	      const rawMeta = (tr as unknown as { meta?: Record<string, unknown> }).meta;
	      if (rawMeta) {
	        for (const key of Object.keys(rawMeta)) {
	          if (key.startsWith('y-sync')) {
	            if (debugTypedInsert) {
	              console.log('[share-content-filter.filterTransaction.allowYSyncRaw]', {
	                stepTypes: tr.steps.map((step) => step.constructor.name),
	              });
	            }
	            return true;
	          }
	        }
	      }
	      const ySyncMeta = tr.getMeta(ySyncPluginKey);
	      if (ySyncMeta !== undefined) {
	        if (debugTypedInsert) {
	          console.log('[share-content-filter.filterTransaction.allowYSyncMeta]', {
	            stepTypes: tr.steps.map((step) => step.constructor.name),
	          });
	        }
	        return true;
	      }
	      // Allow transactions with no steps (selection changes, etc.)
	      if (tr.steps.length === 0) return true;
	      // Block transactions that contain any text-modifying steps
	      for (const step of tr.steps) {
        if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
          if (debugTypedInsert) {
            console.log('[share-content-filter.filterTransaction.block]', {
              stepTypes: tr.steps.map((innerStep) => innerStep.constructor.name),
            });
          }
          return false;
        }
      }
      // Allow mark-only transactions (AddMarkStep, RemoveMarkStep)
      if (debugTypedInsert) {
        console.log('[share-content-filter.filterTransaction.allowMarkOnly]', {
          stepTypes: tr.steps.map((step) => step.constructor.name),
        });
      }
      return true;
    },
  });
});
