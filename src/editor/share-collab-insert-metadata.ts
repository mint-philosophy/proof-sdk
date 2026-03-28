import type { StoredMark } from '../formats/marks';

export function preservePendingRemoteInsertMetadata(
  sourceMarks: Record<string, StoredMark>,
  syncedMetadata: Record<string, StoredMark>,
  insertIds: string[],
): Record<string, StoredMark> {
  let nextMetadata = syncedMetadata;

  for (const id of insertIds) {
    const sourceMark = sourceMarks[id];
    if (!sourceMark || sourceMark.kind !== 'insert') continue;
    const syncedMark = nextMetadata[id];
    if (syncedMark?.kind === 'insert') continue;

    if (nextMetadata === syncedMetadata) {
      nextMetadata = { ...syncedMetadata };
    }
    nextMetadata[id] = { ...sourceMark };
  }

  return nextMetadata;
}

export function mergeResyncedPendingInsertServerMarks(
  currentServerMarks: Record<string, StoredMark>,
  sourceMarks: Record<string, StoredMark>,
  resyncedMetadata: Record<string, StoredMark>,
  insertIds: string[],
): Record<string, StoredMark> {
  const nextServerMarks = { ...currentServerMarks };

  for (const id of insertIds) {
    const sourceMark = sourceMarks[id];
    const resyncedMark = resyncedMetadata[id];

    if (resyncedMark?.kind === 'insert') {
      nextServerMarks[id] = {
        ...nextServerMarks[id],
        ...(sourceMark?.kind === 'insert' ? sourceMark : {}),
        ...resyncedMark,
      };
      continue;
    }

    if (sourceMark?.kind === 'insert') {
      nextServerMarks[id] = {
        ...nextServerMarks[id],
        ...sourceMark,
      };
    }
  }

  return nextServerMarks;
}
