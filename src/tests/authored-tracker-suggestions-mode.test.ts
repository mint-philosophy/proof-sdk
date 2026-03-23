import { Schema } from '@milkdown/kit/prose/model';
import { EditorState, Plugin } from '@milkdown/kit/prose/state';

import { shouldTrackHumanAuthorship } from '../editor/plugins/authored-tracker.js';
import { suggestionsPluginKey } from '../editor/plugins/suggestions.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function createState(suggestionsEnabled: boolean): EditorState {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
    marks: {},
  });

  const suggestionsStatePlugin = new Plugin({
    key: suggestionsPluginKey,
    state: {
      init: () => ({ enabled: suggestionsEnabled }),
      apply: (tr, value) => {
        const meta = tr.getMeta(suggestionsPluginKey);
        if (meta && typeof meta.enabled === 'boolean') {
          return { enabled: meta.enabled };
        }
        return value;
      },
    },
  });

  return EditorState.create({
    schema,
    doc: schema.node('doc', null, [schema.node('paragraph', null, [schema.text('alpha')])]),
    plugins: [suggestionsStatePlugin],
  });
}

function run(): void {
  assert(shouldTrackHumanAuthorship(createState(false)) === true, 'Expected authored tracking when suggestions are off');
  assert(shouldTrackHumanAuthorship(createState(true)) === false, 'Expected authored tracking to be disabled when suggestions are on');
  console.log('✓ authored tracker skips human spans while track changes is enabled');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
