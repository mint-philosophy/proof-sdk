export function shouldKeepalivePersistShareContent(options: {
  keepalive: boolean;
  persistContent?: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  hasLocalContentEditSinceHydration: boolean;
  collabConnectionStatus: 'connecting' | 'connected' | 'disconnected';
  collabIsSynced: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
  markdown: string;
}): boolean {
  if (!options.keepalive) return false;
  if (options.persistContent !== true) return false;
  if (!options.collabEnabled || !options.collabCanEdit) return false;
  if (!options.hasCompletedInitialCollabHydration) return false;
  if (!options.hasLocalContentEditSinceHydration) return false;
  // If live Yjs still has local changes in flight, reconnect should recover from
  // the authoritative binary state instead of forcing a stale REST markdown write.
  if (options.collabUnsyncedChanges > 0 || options.collabPendingLocalUpdates > 0) {
    return false;
  }
  const liveSessionHealthy = options.collabConnectionStatus === 'connected'
    && options.collabIsSynced
    && options.collabUnsyncedChanges === 0
    && options.collabPendingLocalUpdates === 0;
  if (liveSessionHealthy) return false;
  return options.markdown.trim().length > 0;
}

export function shouldUseLocalKeepaliveBaseToken(options: {
  keepalive: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  collabIsSynced: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
}): boolean {
  if (!options.keepalive) return false;
  if (!options.collabEnabled || !options.collabCanEdit) return false;
  if (!options.hasCompletedInitialCollabHydration) return false;
  if (!options.collabIsSynced) return false;
  if (options.collabUnsyncedChanges > 0) return false;
  if (options.collabPendingLocalUpdates > 0) return false;
  return true;
}

export function shouldAllowShareLocalEditsDuringTransientCollabRecovery(options: {
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  hydratedForEditing: boolean;
  collabConnectionStatus: 'connecting' | 'connected' | 'disconnected';
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
}): boolean {
  if (!options.collabEnabled || !options.collabCanEdit) return false;
  if (!options.hasCompletedInitialCollabHydration) return false;
  if (!options.hydratedForEditing) return false;
  if (options.collabConnectionStatus !== 'connecting' && options.collabConnectionStatus !== 'disconnected') {
    return false;
  }
  return options.collabUnsyncedChanges > 0 || options.collabPendingLocalUpdates > 0;
}

export function buildShareReviewBatchMutationMarkIds(options: {
  localPendingIds: string[];
  authoritativePendingIds: string[];
}): string[] {
  const requestedIds: string[] = [];
  const seen = new Set<string>();

  for (const markId of options.localPendingIds) {
    if (typeof markId !== 'string' || markId.trim().length === 0) continue;
    if (seen.has(markId)) continue;
    seen.add(markId);
    requestedIds.push(markId);
  }

  for (const markId of options.authoritativePendingIds) {
    if (typeof markId !== 'string' || markId.trim().length === 0) continue;
    if (seen.has(markId)) continue;
    seen.add(markId);
    requestedIds.push(markId);
  }

  return requestedIds;
}

export function shouldSkipShareDocumentRefreshDuringReviewCooldown(options: {
  cooldownUntilMs: number;
  nowMs?: number;
  hasActiveRemotePeer: boolean;
}): boolean {
  if (options.hasActiveRemotePeer) return false;
  const nowMs = options.nowMs ?? Date.now();
  return nowMs < options.cooldownUntilMs;
}

export function shouldKeepalivePersistShareMarks(options: {
  keepalive: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
  hasCompletedInitialCollabHydration: boolean;
  hasLocalContentEditSinceHydration: boolean;
  collabUnsyncedChanges: number;
  collabPendingLocalUpdates: number;
}): boolean {
  if (!options.keepalive) return true;
  if (!options.collabEnabled || !options.collabCanEdit) return true;
  return false;
}

export function shouldPreserveLocalContentEditMarkerOnRemoteChange(options: {
  isShareMode: boolean;
  collabEnabled: boolean;
  collabCanEdit: boolean;
}): boolean {
  return options.isShareMode && options.collabEnabled && options.collabCanEdit;
}
