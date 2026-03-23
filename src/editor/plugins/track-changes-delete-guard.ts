export type TrackChangesDeleteIntent = {
  key: 'Backspace' | 'Delete';
  modifiers?: {
    altKey?: boolean;
    metaKey?: boolean;
    ctrlKey?: boolean;
  };
};

type TrackChangesKeyboardLike = {
  key: string;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
};

export function shouldSuppressTrackChangesDeleteIntent(
  intent: TrackChangesDeleteIntent | null,
): boolean {
  if (!intent || intent.key !== 'Backspace') return false;

  if (intent.modifiers?.metaKey && !intent.modifiers?.altKey && !intent.modifiers?.ctrlKey) {
    return true;
  }

  if (!intent.modifiers?.metaKey && (intent.modifiers?.altKey || intent.modifiers?.ctrlKey)) {
    return true;
  }

  return false;
}

export function shouldSuppressTrackChangesKeydown(
  event: TrackChangesKeyboardLike,
): boolean {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false;
  return shouldSuppressTrackChangesDeleteIntent({
    key: event.key,
    modifiers: {
      altKey: event.altKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
    },
  });
}
