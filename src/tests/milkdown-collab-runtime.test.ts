import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function run(): void {
  const source = readFileSync(path.resolve(process.cwd(), 'src/bridge/collab-client.ts'), 'utf8');
  const setMarksBody = source.slice(
    source.indexOf('setMarksMetadata(marks: Record<string, unknown>): void {'),
    source.indexOf('disconnect(): void {'),
  );

  assert(
    source.includes('reconnectWithSession(session: CollabSessionInfo, options?: { preserveLocalState?: boolean }): void'),
    'Expected collab runtime to expose reconnectWithSession',
  );
  assert(
    source.includes('getYDoc(): Y.Doc | null'),
    'Expected collab runtime to expose getYDoc',
  );
  assert(
    source.includes('getAwareness(): Awareness | null'),
    'Expected collab runtime to expose getAwareness',
  );
  assert(
    source.includes('setProjectionMarkdown(markdown: string): void'),
    'Expected collab runtime to expose projection markdown writes',
  );
  assert(
    source.includes('if (this.activeSession) {')
      && source.includes("this.debugLog('skip-projection-write-live-session'"),
    'Expected collab runtime to hard-stop durable projection markdown writes for live shared sessions',
  );
  assert(
    source.includes('setMarksMetadata(marks: Record<string, unknown>): void'),
    'Expected collab runtime to expose marks metadata writes',
  );
  assert(
    source.includes('if (session.syncProtocol !== \'pm-yjs-v1\')'),
    'Expected runtime to reject unsupported collab sync protocols',
  );
  assert(
    source.includes('provider.on(\'status\''),
    'Expected provider status event wiring',
  );
  assert(
    source.includes('provider.on(\'synced\''),
    'Expected provider synced event wiring',
  );
  assert(
    source.includes('provider.on(\'unsyncedChanges\''),
    'Expected provider unsyncedChanges event wiring',
  );
  assert(
    source.includes('provider.on(\'close\''),
    'Expected provider close event wiring',
  );
  assert(
    source.includes('provider.on(\'authenticationFailed\'')
      && source.includes('lastAuthenticationFailureReason')
      && !source.includes('mapAuthFailureToTerminalReason'),
    'Expected auth failures to remain refreshable signals instead of immediate terminal close handling',
  );
  assert(
    source.includes('preserveConnection: false'),
    'Expected provider to disable preserveConnection so auth failures fully tear down stale sockets',
  );
  assert(
    source.includes('private activeSession: CollabSessionInfo | null = null;')
      && source.includes('token: () => this.activeSession?.token ?? null,'),
    'Expected provider auth to read from the live session token instead of a fixed initial token',
  );
  assert(
    source.includes('requiresHardReconnect(session: CollabSessionInfo): boolean {')
      && source.includes('softRefreshSession(session: CollabSessionInfo): boolean {')
      && source.includes('this.provider.setConfiguration({')
      && source.includes('this.provider.configuration.websocketProvider.setConfiguration({')
      && source.includes('this.provider.disconnect();')
      && source.includes('void this.provider.connect();'),
    'Expected collab runtime to support soft session refresh on the existing provider/Y.Doc before falling back to hard reconnect',
  );
  assert(
    source.includes('connect(session: CollabSessionInfo, options?: { replayDurableBuffer?: boolean }): void {')
      && source.includes('if (options?.replayDurableBuffer === false) {')
      && source.includes('this.clearDurableBuffer();'),
    'Expected collab runtime to support skipping stale durable replay when a hard reconnect chooses authoritative reset',
  );
  assert(
    source.includes('const preserveLocalState = options?.preserveLocalState !== false;')
      && source.includes('private hasPendingLocalStateForReconnect(): boolean {')
      && source.includes('return this.unsyncedChanges > 0 || this.durablePendingUpdates.length > 0;')
      && source.includes('private pendingReconnectReplayUpdates: string[] = [];')
      && source.includes('private recentReconnectReplayUpdates: Array<{ encoded: string; at: number }> = [];')
      && source.includes('private static readonly RECENT_RECONNECT_REPLAY_GRACE_MS = 5_000;')
      && source.includes('const recentReconnectReplayUpdates = preserveLocalState')
      && source.includes('const canPreserveBufferedLocalState = preserveLocalState')
      && source.includes('&& this.canPersistDurableUpdates(session.role)')
      && source.includes('&& (this.hasPendingLocalStateForReconnect() || recentReconnectReplayUpdates.length > 0);')
      && source.includes('this.pendingReconnectReplayUpdates = canPreserveBufferedLocalState')
      && source.includes('if (!canPreserveBufferedLocalState) {')
      && source.includes('this.pendingMarksSnapshot = null;')
      && source.includes('this.recentReconnectReplayUpdates = [];')
      && source.includes('this.connect(session, { replayDurableBuffer: canPreserveBufferedLocalState });')
      && source.includes('Buffered local updates')
      && source.includes('safe unit of preservation across that boundary.')
      && source.includes('private rememberRecentReconnectReplayUpdate(encoded: string): void {')
      && source.includes('private getRecentReconnectReplayUpdates(): string[] {')
      && source.includes('this.rememberRecentReconnectReplayUpdate(encoded);')
      && source.includes('if (this.pendingReconnectReplayUpdates.length > 0) {')
      && source.includes('this.pendingReconnectReplayUpdates = this.replayEncodedUpdates(ydoc, this.pendingReconnectReplayUpdates);')
      && !source.includes('const localState = canPreserveLocalState && this.ydoc ? Y.encodeStateAsUpdate(this.ydoc) : null;')
      && !source.includes('const wantsDurableReplay = preserveLocalState && canPreserveLocalState && !localState;')
      && !source.includes('this.skipDurableReplayOnce = !wantsDurableReplay;')
      && !source.includes("Y.applyUpdate(this.ydoc, localState, 'local-reconnect-bootstrap');"),
    'Expected hard reconnects to preserve bounded buffered/recent local updates and never replay the full previous Y.Doc into a new live room',
  );
  assert(
    source.includes('this.activeSession.accessEpoch === session.accessEpoch;'),
    'Expected hard-reconnect decisions to include accessEpoch changes',
  );
  assert(
    source.includes('private sessionRole: ShareRole | null = null;')
      && source.includes("if (!this.sessionRole || !this.canPersistDurableUpdates(this.sessionRole)) {"),
    'Expected collab runtime to hard-stop projection and mark writes for read-only roles',
  );
  assert(
    source.includes("if (transaction.origin === 'local-marks-sync') return;"),
    'Expected marks map listener to ignore local marks transactions',
  );
  assert(
    !source.includes("if (origin === 'local-marks-sync') return false;"),
    'Expected local marks transactions to stay in the durable local Yjs replay path instead of depending on REST unload writes',
  );
  assert(
    source.includes('private pendingMarksSnapshot: Record<string, unknown> | null = null;')
      && source.includes('private applyPendingMarksSnapshot(): void {')
      && source.includes('if (!this.pendingMarksSnapshot || !this.ydoc || !this.marksMap) return;')
      && source.includes('this.pendingMarksSnapshot = { ...marks };')
      && source.includes('this.applyPendingMarksSnapshot();')
      && setMarksBody.includes('if (!this.ydoc || !this.marksMap) {\n      this.pendingMarksSnapshot = { ...marks };\n      return;\n    }')
      && setMarksBody.includes("if (!this.sessionRole || !this.canPersistDurableUpdates(this.sessionRole)) {")
      && setMarksBody.indexOf('if (!this.ydoc || !this.marksMap) {\n      this.pendingMarksSnapshot = { ...marks };\n      return;\n    }')
        < setMarksBody.indexOf("if (!this.sessionRole || !this.canPersistDurableUpdates(this.sessionRole)) {"),
    'Expected collab runtime to queue marks written before the Yjs doc exists and replay them once the live marks map is available',
  );
  assert(
    source.includes('DURABLE_UPDATE_KEY_PREFIX')
      && source.includes('proof:collab:pending-updates:')
      && source.includes('localStorage'),
    'Expected collab runtime to persist durable local updates',
  );
  assert(
    source.includes("return role === 'editor' || role === 'owner_bot';")
      && source.includes('this.durableUpdatesEnabled = this.canPersistDurableUpdates(session.role);'),
    'Expected durable buffering/replay to be limited to edit-capable roles',
  );
  assert(
    source.includes('replayDurableUpdates')
      && source.includes('durable-replay'),
    'Expected collab runtime to replay buffered updates on reconnect',
  );
  assert(
    source.includes('flushPendingLocalStateForUnload(): void {')
      && source.includes('if (this.durablePendingUpdates.length === 0) return;')
      && source.includes('this.flushDurableBuffer();'),
    'Expected collab runtime to expose a synchronous unload flush for buffered local Yjs state',
  );

  assert(
    !source.includes('onSnapshot('),
    'Did not expect legacy snapshot subscription API',
  );
  assert(
    !source.includes('setLocalSnapshot('),
    'Did not expect legacy snapshot write API',
  );
  assert(
    !source.includes('onConflict('),
    'Did not expect legacy conflict callback API',
  );
  assert(
    !source.includes('reconcileSnapshots('),
    'Did not expect reconcileSnapshots usage in collab runtime',
  );

  console.log('✓ milkdown collab runtime lifecycle + transport contract');
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
