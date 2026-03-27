import { Router, type Request, type Response } from 'express';
import {
  addAppsignalDistributionValue,
  incrementAppsignalCounter,
} from './observability.js';

type LabelValue = string | number | boolean;
type Labels = Record<string, LabelValue | undefined>;

const DEFAULT_MUTATION_LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000];
const DEFAULT_RECONNECT_BUCKETS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000];
const DEFAULT_PROJECTION_LAG_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000];
const DEFAULT_ROUTE_LATENCY_BUCKETS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000];
const DEFAULT_LIBRARY_SYNC_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];
type ProjectionMetricSource = 'persist' | 'repair' | 'startup' | 'share' | 'unknown';

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/"/g, '\\"');
}

function normalizeMetricName(name: string): string {
  return name
    .trim()
    .replace(/[^a-zA-Z0-9_:]/g, '_')
    .replace(/_{2,}/g, '_');
}

function labelsKey(labels: Labels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  return entries.map(([key, value]) => `${key}=${value}`).join('|');
}

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const rendered = entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(',');
  return `{${rendered}}`;
}

class CounterMetric {
  readonly name: string;
  readonly help: string;
  private readonly values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string) {
    this.name = normalizeMetricName(name);
    this.help = help;
  }

  inc(labels: Labels = {}, value: number = 1): void {
    const key = labelsKey(labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.values.set(key, {
      labels: { ...labels },
      value,
    });
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name} 0`);
      return lines;
    }
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines;
  }
}

class HistogramMetric {
  readonly name: string;
  readonly help: string;
  private readonly buckets: number[];
  private readonly values = new Map<string, {
    labels: Labels;
    count: number;
    sum: number;
    bucketCounts: number[];
  }>();

  constructor(name: string, help: string, buckets: number[]) {
    this.name = normalizeMetricName(name);
    this.help = help;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels = {}, value: number): void {
    const key = labelsKey(labels);
    const existing = this.values.get(key) ?? {
      labels: { ...labels },
      count: 0,
      sum: 0,
      bucketCounts: new Array(this.buckets.length).fill(0) as number[],
    };
    existing.count += 1;
    existing.sum += value;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]) {
        existing.bucketCounts[i] += 1;
      }
    }
    this.values.set(key, existing);
  }

  render(): string[] {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    if (this.values.size === 0) {
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines;
    }
    for (const item of this.values.values()) {
      const baseLabels = item.labels;
      for (let i = 0; i < this.buckets.length; i += 1) {
        const labels = { ...baseLabels, le: this.buckets[i] };
        lines.push(`${this.name}_bucket${formatLabels(labels)} ${item.bucketCounts[i]}`);
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...baseLabels, le: '+Inf' })} ${item.count}`);
      lines.push(`${this.name}_sum${formatLabels(baseLabels)} ${item.sum}`);
      lines.push(`${this.name}_count${formatLabels(baseLabels)} ${item.count}`);
    }
    return lines;
  }
}

class MetricsRegistry {
  private readonly counters = new Map<string, CounterMetric>();
  private readonly histograms = new Map<string, HistogramMetric>();

  counter(name: string, help: string): CounterMetric {
    const metricName = normalizeMetricName(name);
    const existing = this.counters.get(metricName);
    if (existing) return existing;
    const created = new CounterMetric(metricName, help);
    this.counters.set(metricName, created);
    return created;
  }

  histogram(name: string, help: string, buckets: number[]): HistogramMetric {
    const metricName = normalizeMetricName(name);
    const existing = this.histograms.get(metricName);
    if (existing) return existing;
    const created = new HistogramMetric(metricName, help, buckets);
    this.histograms.set(metricName, created);
    return created;
  }

  render(): string {
    const lines: string[] = [];
    for (const metric of this.counters.values()) {
      lines.push(...metric.render());
    }
    for (const metric of this.histograms.values()) {
      lines.push(...metric.render());
    }
    return `${lines.join('\n')}\n`;
  }
}

const registry = new MetricsRegistry();

const shareLinkOpenCounter = registry.counter(
  'share_link_open_total',
  'Count of shared link opens by result and state',
);
const agentMutationCounter = registry.counter(
  'agent_mutation_total',
  'Count of agent mutations by route and result',
);
const agentMutationLatency = registry.histogram(
  'agent_mutation_latency_ms',
  'Latency of agent mutation requests in milliseconds',
  DEFAULT_MUTATION_LATENCY_BUCKETS_MS,
);
const collabReconnectHistogram = registry.histogram(
  'collab_reconnect_ms',
  'Client-observed collaboration reconnect latency in milliseconds',
  DEFAULT_RECONNECT_BUCKETS_MS,
);
const markAnchorResolutionCounter = registry.counter(
  'mark_anchor_resolution_total',
  'Mark anchor resolution outcomes from collaborative updates',
);
const projectionLagHistogram = registry.histogram(
  'projection_lag_ms',
  'Lag for materializing canonical Y.Doc updates to markdown projection',
  DEFAULT_PROJECTION_LAG_BUCKETS_MS,
);
const projectionWipeCounter = registry.counter(
  'projection_wipe_warning_total',
  'Count of projection wipe warnings by reason',
);
const projectionGuardBlockCounter = registry.counter(
  'projection_guard_block_total',
  'Count of projection writes blocked by guardrails',
);
const projectionDriftCounter = registry.counter(
  'projection_drift_total',
  'Count of projection drift detections by reason',
);
const projectionRepairCounter = registry.counter(
  'projection_repair_total',
  'Projection repair outcomes by reason',
);
const projectionReadFallbackCounter = registry.counter(
  'projection_read_fallback_total',
  'Count of canonical reads served from Yjs fallback instead of the projection row',
);
const projectionMarkedStaleCounter = registry.counter(
  'projection_marked_stale_total',
  'Count of times a projection row is explicitly marked stale',
);
const collabLogSuppressedCounter = registry.counter(
  'collab_log_suppressed_total',
  'Count of repeated collab pathology logs suppressed by cooldown',
);
const collabAdmissionGuardCounter = registry.counter(
  'collab_admission_guard_total',
  'Count of global collab admission guard trips and blocks by event, reason, and surface',
);
const collabPathologyQuarantineCounter = registry.counter(
  'collab_pathology_quarantine_total',
  'Count of pathological collab slugs fast-quarantined by reason and surface',
);
const collabPersistedYjsUpdateBytesHistogram = registry.histogram(
  'collab_persisted_yjs_update_bytes',
  'Size of persisted Yjs update blobs in bytes by source and outcome',
  [512, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576, 4_194_304, 8_388_608, 16_777_216, 67_108_864, 268_435_456],
);
const collabPersistedYjsWriteCounter = registry.counter(
  'collab_persisted_yjs_write_total',
  'Persisted Yjs write outcomes by source and reason',
);
const collabStaleOnStoreDropCounter = registry.counter(
  'collab_stale_onstore_drop_total',
  'Dropped stale onStoreDocument writes by source and reason',
);
const collabLegacyReseedCounter = registry.counter(
  'collab_legacy_reseed_total',
  'Legacy canonical-to-Yjs reseed attempts by result and source',
);
const collabLegacyReverseFlowBlockedCounter = registry.counter(
  'collab_legacy_reverse_flow_block_total',
  'Blocked legacy reverse-flow collab apply attempts by source and live state',
);
const collabCanonicalSyncRefusalCounter = registry.counter(
  'collab_canonical_sync_refusal_total',
  'Canonical-to-collab sync refusals by reason, source, and live state',
);
const collabCanonicalSyncFailureCounter = registry.counter(
  'collab_canonical_sync_failure_total',
  'Canonical-to-collab sync exceptions by phase, source, and live state',
);
const collabCanonicalSyncRecoveryFailureCounter = registry.counter(
  'collab_canonical_sync_recovery_failure_total',
  'Canonical sync recovery failures by stage, surface, reason, containment, and live state',
);
const collabFragmentCacheMismatchCounter = registry.counter(
  'collab_fragment_cache_mismatch_total',
  'Fragment-derived markdown mismatches against Y.Text cache by source',
);
const collabSuspiciousDocBlockedCounter = registry.counter(
  'collab_suspicious_doc_block_total',
  'Suspicious-doc auto-heal attempts blocked by path and quarantine reason',
);
const projectionCharsHistogram = registry.histogram(
  'projection_chars',
  'Projected markdown size in characters',
  [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_500_000, 5_000_000],
);
const snapshotPublishCounter = registry.counter(
  'snapshot_publish_total',
  'Snapshot publish outcomes by storage backend',
);
const mirrorFileCreationCounter = registry.counter(
  'mirror_file_creation_total',
  'Remote mirror file creation outcomes by result',
);
const libraryClaimFlowCounter = registry.counter(
  'library_claim_flow_total',
  'Library claim flow events by event and surface',
);
const authChallengeCompletionCounter = registry.counter(
  'auth_challenge_completion_total',
  'Authentication challenge completion outcomes',
);
const deepLinkUnhandledCounter = registry.counter(
  'deep_link_unhandled_total',
  'Count of deep link open attempts not handled by native app',
);
const offlineEditMergeCounter = registry.counter(
  'offline_edit_merge_total',
  'Offline edit merge outcomes after reconnect',
);
const mutationIdempotencyDualReadCounter = registry.counter(
  'mutation_idempotency_dual_read_total',
  'Dual-read idempotency outcomes during migration',
);
const mutationIdempotencyLifecycleCounter = registry.counter(
  'mutation_idempotency_lifecycle_total',
  'Mutation idempotency lifecycle outcomes by route',
);
const mutationBackfillCounter = registry.counter(
  'mutation_backfill_total',
  'Backfill row outcomes by target table',
);
const rewriteLiveClientBlockCounter = registry.counter(
  'rewrite_live_client_block_total',
  'Rewrite attempts blocked due to active authenticated live clients',
);
const rewriteForceIgnoredCounter = registry.counter(
  'rewrite_force_ignored_total',
  'Rewrite force flag ignored due to hosted environment safety policy',
);
const rewriteBarrierFailureCounter = registry.counter(
  'rewrite_barrier_failure_total',
  'Rewrite barrier preparation failures by route and reason',
);
const rewriteBarrierLatencyHistogram = registry.histogram(
  'rewrite_barrier_latency_ms',
  'Rewrite barrier preparation latency in milliseconds',
  DEFAULT_MUTATION_LATENCY_BUCKETS_MS,
);
const editAnchorAmbiguousCounter = registry.counter(
  'edit_anchor_ambiguous_total',
  'Count of edit anchor resolutions rejected due to ambiguity',
);
const editAnchorNotFoundCounter = registry.counter(
  'edit_anchor_not_found_total',
  'Count of edit anchor resolutions that failed because no match was found',
);
const editStructuralCleanupAppliedCounter = registry.counter(
  'edit_structural_cleanup_applied_total',
  'Count of structural cleanup passes that changed markdown after edit mutations',
);
const editAuthoredSpanRemapCounter = registry.counter(
  'edit_authored_span_remap_total',
  'Count of edit anchor resolutions that required authored-span logical remapping',
);
const libraryRouteLatencyHistogram = registry.histogram(
  'library_route_latency_ms',
  'Latency of library-facing routes in milliseconds',
  DEFAULT_ROUTE_LATENCY_BUCKETS_MS,
);
const librarySyncLatencyHistogram = registry.histogram(
  'library_sync_latency_ms',
  'Latency of library sync stages in milliseconds',
  DEFAULT_LIBRARY_SYNC_BUCKETS_MS,
);
const collabRouteLatencyHistogram = registry.histogram(
  'collab_route_latency_ms',
  'Latency of collab route handlers in milliseconds',
  DEFAULT_ROUTE_LATENCY_BUCKETS_MS,
);
const collabSessionBuildLatencyHistogram = registry.histogram(
  'collab_session_build_latency_ms',
  'Latency of buildCollabSession in milliseconds',
  DEFAULT_LIBRARY_SYNC_BUCKETS_MS,
);

let shareLinkOpenTotal = 0;
let shareLinkOpenSuccess = 0;
let agentMutationTotal = 0;
let agentMutationSuccess = 0;
let markAnchorTotal = 0;
let markAnchorFailures = 0;
const collabReconnectSamplesMs: number[] = [];

function readDurationMs(body: unknown): number | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as { durationMs?: unknown }).durationMs;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return raw;
}

function readResult(body: unknown): 'success' | 'failure' | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const raw = (body as { result?: unknown }).result;
  return raw === 'success' || raw === 'failure' ? raw : null;
}

export function recordShareLinkOpen(
  result: 'success' | 'failure',
  state: string,
): void {
  shareLinkOpenCounter.inc({
    result,
    state: state || 'UNKNOWN',
  });
  incrementAppsignalCounter('proof.share_link_open_total', 1, {
    result,
    state: state || 'unknown',
  });
  shareLinkOpenTotal += 1;
  if (result === 'success') shareLinkOpenSuccess += 1;
}

export function recordAgentMutation(
  route: string,
  success: boolean,
  latencyMs: number,
): void {
  agentMutationCounter.inc({
    route: route || 'unknown',
    result: success ? 'success' : 'failure',
  });
  agentMutationLatency.observe({ route: route || 'unknown' }, latencyMs);
  incrementAppsignalCounter('proof.agent_mutation_total', 1, {
    route: route || 'unknown',
    result: success ? 'success' : 'failure',
  });
  addAppsignalDistributionValue('proof.agent_mutation_latency_ms', latencyMs, {
    route: route || 'unknown',
  });
  agentMutationTotal += 1;
  if (success) agentMutationSuccess += 1;
}

export function recordProjectionLag(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  projectionLagHistogram.observe({}, durationMs);
  addAppsignalDistributionValue('proof.projection_lag_ms', durationMs);
}

export function recordProjectionWipe(reason: 'empty' | 'shrink'): void {
  projectionWipeCounter.inc({ reason });
  incrementAppsignalCounter('proof.projection_wipe_total', 1, { reason });
}

export function recordProjectionGuardBlock(
  reason: string,
  source: ProjectionMetricSource = 'unknown',
): void {
  projectionGuardBlockCounter.inc({
    reason: reason || 'unknown',
    source,
  });
  incrementAppsignalCounter('proof.projection_guard_block_total', 1, {
    reason: reason || 'unknown',
    source,
  });
}

export function recordProjectionDrift(
  reason: string,
  source: ProjectionMetricSource = 'unknown',
): void {
  projectionDriftCounter.inc({
    reason: reason || 'unknown',
    source,
  });
  incrementAppsignalCounter('proof.projection_drift_total', 1, {
    reason: reason || 'unknown',
    source,
  });
}

export function recordProjectionRepair(
  result: 'success' | 'failure' | 'queued' | 'skipped',
  reason: string,
): void {
  projectionRepairCounter.inc({
    result,
    reason: reason || 'unknown',
  });
  incrementAppsignalCounter('proof.projection_repair_total', 1, {
    result,
    reason: reason || 'unknown',
  });
}

export function recordProjectionReadFallback(
  source: 'state' | 'snapshot' | 'share' | 'unknown',
  reason: string,
): void {
  projectionReadFallbackCounter.inc({
    source,
    reason: reason || 'unknown',
  });
  incrementAppsignalCounter('proof.projection_read_fallback_total', 1, {
    source,
    reason: reason || 'unknown',
  });
}

export function recordProjectionMarkedStale(
  reason: string,
  source: ProjectionMetricSource = 'unknown',
): void {
  projectionMarkedStaleCounter.inc({
    reason: reason || 'unknown',
    source,
  });
  incrementAppsignalCounter('proof.projection_marked_stale_total', 1, {
    reason: reason || 'unknown',
    source,
  });
}

export function recordCollabLogSuppressed(
  kind: 'stale_onstore_drift' | 'stale_onstore_drop' | 'ws_oversize' | 'repair_guard' | 'large_doc' | 'projection_drift_loop' | 'integrity_warning' | 'stale_epoch_bypass',
  reason: string,
): void {
  collabLogSuppressedCounter.inc({
    kind,
    reason: reason || 'unknown',
  });
  incrementAppsignalCounter('proof.collab_log_suppressed_total', 1, {
    kind,
    reason: reason || 'unknown',
  });
}

export function recordStaleOnStoreDrop(reason: string, source: string): void {
  collabStaleOnStoreDropCounter.inc({
    reason: reason || 'unknown',
    source: source || 'unknown',
  });
  incrementAppsignalCounter('proof.collab_stale_onstore_drop_total', 1, {
    reason: reason || 'unknown',
    source: source || 'unknown',
  });
}

export function recordCollabAdmissionGuard(
  event: 'trip' | 'block',
  reason: string,
  surface: string,
): void {
  collabAdmissionGuardCounter.inc({
    event,
    reason: reason || 'unknown',
    surface: surface || 'unknown',
  });
  incrementAppsignalCounter('proof.collab_admission_guard_total', 1, {
    event,
    reason: reason || 'unknown',
    surface: surface || 'unknown',
  });
}

export function recordCollabPathologyQuarantine(reason: string, surface: string): void {
  collabPathologyQuarantineCounter.inc({
    reason: reason || 'unknown',
    surface: surface || 'unknown',
  });
  incrementAppsignalCounter('proof.collab_pathology_quarantine_total', 1, {
    reason: reason || 'unknown',
    surface: surface || 'unknown',
  });
}

export function recordPersistedYjsUpdateBytes(
  bytes: number,
  source: string,
  outcome: 'accepted' | 'rejected' | 'quarantined',
  reason?: string,
): void {
  if (!Number.isFinite(bytes) || bytes < 0) return;
  const safeSource = source || 'unknown';
  const safeReason = reason || undefined;
  collabPersistedYjsUpdateBytesHistogram.observe({
    source: safeSource,
    outcome,
    reason: safeReason,
  }, bytes);
  collabPersistedYjsWriteCounter.inc({
    source: safeSource,
    outcome,
    reason: safeReason,
  });
  addAppsignalDistributionValue('proof.collab_persisted_yjs_update_bytes', bytes, {
    source: safeSource,
    outcome,
    reason: safeReason,
  });
  incrementAppsignalCounter('proof.collab_persisted_yjs_write_total', 1, {
    source: safeSource,
    outcome,
    reason: safeReason,
  });
}

export function recordLegacyReseedAttempt(
  result: 'seeded' | 'blocked' | 'quarantined',
  source: string,
): void {
  collabLegacyReseedCounter.inc({
    result,
    source: source || 'unknown',
  });
  incrementAppsignalCounter('proof.collab_legacy_reseed_total', 1, {
    result,
    source: source || 'unknown',
  });
}

export function recordLegacyReverseFlowBlocked(source: string, liveState: 'live_doc' | 'loaded_doc'): void {
  collabLegacyReverseFlowBlockedCounter.inc({
    source: source || 'unknown',
    live_state: liveState,
  });
  incrementAppsignalCounter('proof.collab_legacy_reverse_flow_blocked_total', 1, {
    source: source || 'unknown',
    live_state: liveState,
  });
}

export function recordCanonicalSyncRefusal(
  reason: string,
  source: string,
  liveState: 'live_doc' | 'loaded_doc' | 'persisted_doc',
): void {
  collabCanonicalSyncRefusalCounter.inc({
    reason: reason || 'unknown',
    source: source || 'unknown',
    live_state: liveState,
  });
  incrementAppsignalCounter('proof.collab_canonical_sync_refusal_total', 1, {
    reason: reason || 'unknown',
    source: source || 'unknown',
    live_state: liveState,
  });
}

export function recordCanonicalSyncFailure(
  phase: 'apply' | 'persist' | 'invalidate',
  source: string,
  liveState: 'live_doc' | 'loaded_doc' | 'persisted_doc',
): void {
  collabCanonicalSyncFailureCounter.inc({
    phase,
    source: source || 'unknown',
    live_state: liveState,
  });
  incrementAppsignalCounter('proof.collab_canonical_sync_failure_total', 1, {
    phase,
    source: source || 'unknown',
    live_state: liveState,
  });
}

export function recordCanonicalSyncRecoveryFailure(
  stage: string,
  surface: string,
  reason: string,
  containment: string,
  liveState: 'live_doc' | 'loaded_doc' | 'persisted_doc',
): void {
  collabCanonicalSyncRecoveryFailureCounter.inc({
    stage: stage || 'unknown',
    surface: surface || 'unknown',
    reason: reason || 'unknown',
    containment: containment || 'unknown',
    live_state: liveState,
  });
  incrementAppsignalCounter('proof.collab_canonical_sync_recovery_failure_total', 1, {
    stage: stage || 'unknown',
    surface: surface || 'unknown',
    reason: reason || 'unknown',
    containment: containment || 'unknown',
    live_state: liveState,
  });
}

export function recordFragmentCacheMismatch(source: string): void {
  collabFragmentCacheMismatchCounter.inc({
    source: source || 'unknown',
  });
}

export function recordSuspiciousDocBlocked(
  path: 'legacy_reseed' | 'pending_delta_clear',
  reason: string,
): void {
  collabSuspiciousDocBlockedCounter.inc({
    path,
    reason: reason || 'unknown',
  });
}

export function recordProjectionChars(chars: number, source: ProjectionMetricSource = 'unknown'): void {
  if (!Number.isFinite(chars) || chars < 0) return;
  projectionCharsHistogram.observe({ source }, chars);
  addAppsignalDistributionValue('proof.projection_chars', chars, { source });
}

export function recordSnapshotPublish(result: 'success' | 'failure', storage: string): void {
  snapshotPublishCounter.inc({
    result,
    storage: storage || 'unknown',
  });
  incrementAppsignalCounter('proof.snapshot_publish_total', 1, {
    result,
    storage: storage || 'unknown',
  });
}

export function recordMirrorFileCreation(result: 'success' | 'failure', source: string): void {
  mirrorFileCreationCounter.inc({
    result,
    source: source || 'unknown',
  });
  incrementAppsignalCounter('proof.mirror_file_creation_total', 1, {
    result,
    source: source || 'unknown',
  });
}

export function recordLibraryClaimFlow(
  event: 'impression' | 'start' | 'complete' | 'claim' | 'failure',
  source: string,
  surface?: string,
  reason?: string,
  count: number = 1,
): void {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
  libraryClaimFlowCounter.inc({
    event,
    source: source || 'unknown',
    surface: surface || 'unknown',
    reason: reason || undefined,
  }, safeCount);
  incrementAppsignalCounter('proof.library_claim_flow_total', safeCount, {
    event,
    source: source || 'unknown',
    surface: surface || 'unknown',
    reason: reason || undefined,
  });
}

export function recordAuthChallengeCompletion(result: 'success' | 'failure', provider: string): void {
  authChallengeCompletionCounter.inc({
    result,
    provider: provider || 'unknown',
  });
  incrementAppsignalCounter('proof.auth_challenge_completion_total', 1, {
    result,
    provider: provider || 'unknown',
  });
}

export function recordDeepLinkUnhandled(source: string): void {
  deepLinkUnhandledCounter.inc({
    source: source || 'unknown',
  });
  incrementAppsignalCounter('proof.deep_link_unhandled_total', 1, {
    source: source || 'unknown',
  });
}

export function recordOfflineEditMerge(result: 'success' | 'failure', source: string): void {
  offlineEditMergeCounter.inc({
    result,
    source: source || 'unknown',
  });
  incrementAppsignalCounter('proof.offline_edit_merge_total', 1, {
    result,
    source: source || 'unknown',
  });
}

export function recordMutationIdempotencyDualRead(
  outcome: 'new_hit' | 'legacy_fallback' | 'parity_match' | 'parity_mismatch' | 'new_only',
  route: string,
): void {
  mutationIdempotencyDualReadCounter.inc({
    outcome,
    route: route || 'unknown',
  });
  incrementAppsignalCounter('proof.mutation_idempotency_dual_read_total', 1, {
    outcome,
    route: route || 'unknown',
  });
}

export function recordMutationIdempotencyLifecycle(
  outcome:
    | 'reservation_created'
    | 'replay_completed'
    | 'request_mismatch'
    | 'concurrent_wait_hit'
    | 'concurrent_wait_timeout'
    | 'reservation_completed'
    | 'reservation_released'
    | 'expired_pending_committed'
    | 'expired_pending_stolen',
  route: string,
): void {
  mutationIdempotencyLifecycleCounter.inc({
    outcome,
    route: route || 'unknown',
  });
  incrementAppsignalCounter('proof.mutation_idempotency_lifecycle_total', 1, {
    outcome,
    route: route || 'unknown',
  });
}

export function recordMutationBackfill(
  target: 'mutation_idempotency' | 'mutation_outbox' | 'mark_tombstones',
  result: 'inserted' | 'skipped' | 'error',
  count: number = 1,
): void {
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
  mutationBackfillCounter.inc({
    target,
    result,
  }, safeCount);
  incrementAppsignalCounter('proof.mutation_backfill_total', safeCount, {
    target,
    result,
  });
}

export function recordRewriteLiveClientBlock(
  route: string,
  runtimeEnvironment: string,
  forceRequested: boolean,
  forceIgnored: boolean,
): void {
  rewriteLiveClientBlockCounter.inc({
    route: route || 'unknown',
    env: runtimeEnvironment || 'unknown',
    force_requested: forceRequested ? 'true' : 'false',
    force_ignored: forceIgnored ? 'true' : 'false',
  });
  incrementAppsignalCounter('proof.rewrite_live_client_block_total', 1, {
    route: route || 'unknown',
    env: runtimeEnvironment || 'unknown',
    force_requested: forceRequested ? 'true' : 'false',
    force_ignored: forceIgnored ? 'true' : 'false',
  });
}

export function recordRewriteForceIgnored(
  route: string,
  runtimeEnvironment: string,
): void {
  rewriteForceIgnoredCounter.inc({
    route: route || 'unknown',
    env: runtimeEnvironment || 'unknown',
  });
  incrementAppsignalCounter('proof.rewrite_force_ignored_total', 1, {
    route: route || 'unknown',
    env: runtimeEnvironment || 'unknown',
  });
}

export function recordRewriteBarrierFailure(route: string, reason: string): void {
  rewriteBarrierFailureCounter.inc({
    route: route || 'unknown',
    reason: reason || 'unknown',
  });
  incrementAppsignalCounter('proof.rewrite_barrier_failure_total', 1, {
    route: route || 'unknown',
    reason: reason || 'unknown',
  });
}

export function recordRewriteBarrierLatency(route: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  rewriteBarrierLatencyHistogram.observe({
    route: route || 'unknown',
  }, durationMs);
  addAppsignalDistributionValue('proof.rewrite_barrier_latency_ms', durationMs, {
    route: route || 'unknown',
  });
}

export function recordEditAnchorAmbiguous(route: string, mode: string): void {
  editAnchorAmbiguousCounter.inc({
    route: route || 'unknown',
    mode: mode || 'unknown',
  });
  incrementAppsignalCounter('proof.edit_anchor_ambiguous_total', 1, {
    route: route || 'unknown',
    mode: mode || 'unknown',
  });
}

export function recordEditAnchorNotFound(route: string, mode: string): void {
  editAnchorNotFoundCounter.inc({
    route: route || 'unknown',
    mode: mode || 'unknown',
  });
  incrementAppsignalCounter('proof.edit_anchor_not_found_total', 1, {
    route: route || 'unknown',
    mode: mode || 'unknown',
  });
}

export function recordEditStructuralCleanupApplied(route: string): void {
  editStructuralCleanupAppliedCounter.inc({
    route: route || 'unknown',
  });
  incrementAppsignalCounter('proof.edit_structural_cleanup_applied_total', 1, {
    route: route || 'unknown',
  });
}

export function recordEditAuthoredSpanRemap(route: string, mode: string): void {
  editAuthoredSpanRemapCounter.inc({
    route: route || 'unknown',
    mode: mode || 'unknown',
  });
  incrementAppsignalCounter('proof.edit_authored_span_remap_total', 1, {
    route: route || 'unknown',
    mode: mode || 'unknown',
  });
}

export function recordLibraryRouteLatency(route: string, result: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  libraryRouteLatencyHistogram.observe({
    route: route || 'unknown',
    result: result || 'unknown',
  }, durationMs);
  addAppsignalDistributionValue('proof.library_route_latency_ms', durationMs, {
    route: route || 'unknown',
    result: result || 'unknown',
  });
}

export function recordLibrarySyncLatency(stage: string, result: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  librarySyncLatencyHistogram.observe({
    stage: stage || 'unknown',
    result: result || 'unknown',
  }, durationMs);
  addAppsignalDistributionValue('proof.library_sync_latency_ms', durationMs, {
    stage: stage || 'unknown',
    result: result || 'unknown',
  });
}

export function recordCollabRouteLatency(route: string, result: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  collabRouteLatencyHistogram.observe({
    route: route || 'unknown',
    result: result || 'unknown',
  }, durationMs);
  addAppsignalDistributionValue('proof.collab_route_latency_ms', durationMs, {
    route: route || 'unknown',
    result: result || 'unknown',
  });
}

export function recordCollabSessionBuildLatency(result: string, role: string, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  collabSessionBuildLatencyHistogram.observe({
    result: result || 'unknown',
    role: role || 'unknown',
  }, durationMs);
  addAppsignalDistributionValue('proof.collab_session_build_latency_ms', durationMs, {
    result: result || 'unknown',
    role: role || 'unknown',
  });
}

export function recordMarkAnchorResolution(result: 'success' | 'failure', source: string): void {
  markAnchorResolutionCounter.inc({
    result,
    source: source || 'unknown',
  });
  incrementAppsignalCounter('proof.mark_anchor_resolution_total', 1, {
    result,
    source: source || 'unknown',
  });
  markAnchorTotal += 1;
  if (result === 'failure') markAnchorFailures += 1;
}

export function recordCollabReconnect(durationMs: number, source: string): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return;
  collabReconnectHistogram.observe({ source: source || 'unknown' }, durationMs);
  addAppsignalDistributionValue('proof.collab_reconnect_ms', durationMs, {
    source: source || 'unknown',
  });
  collabReconnectSamplesMs.push(durationMs);
  if (collabReconnectSamplesMs.length > 2048) {
    collabReconnectSamplesMs.splice(0, collabReconnectSamplesMs.length - 2048);
  }
}

export const metricsApiRoutes = Router();

metricsApiRoutes.post('/collab-reconnect', (req: Request, res: Response) => {
  const durationMs = readDurationMs(req.body);
  if (durationMs === null) {
    res.status(400).json({ success: false, error: 'durationMs must be a non-negative number' });
    return;
  }
  const source = typeof req.body?.source === 'string' && req.body.source.trim()
    ? req.body.source.trim()
    : 'web';
  recordCollabReconnect(durationMs, source);
  res.json({ success: true });
});

metricsApiRoutes.post('/mark-anchor', (req: Request, res: Response) => {
  const result = readResult(req.body);
  if (!result) {
    res.status(400).json({ success: false, error: 'result must be success or failure' });
    return;
  }
  const source = typeof req.body?.source === 'string' && req.body.source.trim()
    ? req.body.source.trim()
    : 'web';
  recordMarkAnchorResolution(result, source);
  res.json({ success: true });
});

metricsApiRoutes.post('/mirror-file-creation', (req: Request, res: Response) => {
  const result = readResult(req.body);
  if (!result) {
    res.status(400).json({ success: false, error: 'result must be success or failure' });
    return;
  }
  const source = typeof req.body?.source === 'string' && req.body.source.trim()
    ? req.body.source.trim()
    : 'native';
  recordMirrorFileCreation(result, source);
  res.json({ success: true });
});

metricsApiRoutes.post('/library-claim', (req: Request, res: Response) => {
  const event = typeof req.body?.event === 'string' ? req.body.event.trim() : '';
  const allowedEvents = new Set(['impression', 'start', 'complete', 'claim', 'failure']);
  if (!allowedEvents.has(event)) {
    res.status(400).json({ success: false, error: 'event must be impression, start, complete, claim, or failure' });
    return;
  }
  const source = typeof req.body?.source === 'string' && req.body.source.trim()
    ? req.body.source.trim()
    : 'web';
  const surface = typeof req.body?.surface === 'string' && req.body.surface.trim()
    ? req.body.surface.trim()
    : 'doc';
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
    ? req.body.reason.trim()
    : undefined;
  const rawCount = req.body?.count;
  const count = typeof rawCount === 'number' && Number.isFinite(rawCount) && rawCount > 0
    ? rawCount
    : 1;
  recordLibraryClaimFlow(event as 'impression' | 'start' | 'complete' | 'claim' | 'failure', source, surface, reason, count);
  res.json({ success: true });
});

metricsApiRoutes.post('/auth-challenge', (req: Request, res: Response) => {
  const result = readResult(req.body);
  if (!result) {
    res.status(400).json({ success: false, error: 'result must be success or failure' });
    return;
  }
  const provider = typeof req.body?.provider === 'string' && req.body.provider.trim()
    ? req.body.provider.trim()
    : 'every';
  recordAuthChallengeCompletion(result, provider);
  res.json({ success: true });
});

metricsApiRoutes.post('/deep-link-unhandled', (req: Request, res: Response) => {
  const source = typeof req.body?.source === 'string' && req.body.source.trim()
    ? req.body.source.trim()
    : 'web';
  recordDeepLinkUnhandled(source);
  res.json({ success: true });
});

metricsApiRoutes.post('/offline-edit-merge', (req: Request, res: Response) => {
  const result = readResult(req.body);
  if (!result) {
    res.status(400).json({ success: false, error: 'result must be success or failure' });
    return;
  }
  const source = typeof req.body?.source === 'string' && req.body.source.trim()
    ? req.body.source.trim()
    : 'web';
  recordOfflineEditMerge(result, source);
  res.json({ success: true });
});

export function renderMetricsText(): string {
  const p95 = (() => {
    if (collabReconnectSamplesMs.length === 0) return 0;
    const sorted = [...collabReconnectSamplesMs].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
    return sorted[idx];
  })();
  const shareSuccessRate = shareLinkOpenTotal > 0 ? shareLinkOpenSuccess / shareLinkOpenTotal : 1;
  const agentSuccessRate = agentMutationTotal > 0 ? agentMutationSuccess / agentMutationTotal : 1;
  const anchorFailureRate = markAnchorTotal > 0 ? markAnchorFailures / markAnchorTotal : 0;
  const computed = [
    '# HELP share_link_open_success_rate Successful share link opens divided by total opens.',
    '# TYPE share_link_open_success_rate gauge',
    `share_link_open_success_rate ${shareSuccessRate}`,
    '# HELP agent_mutation_success_rate Successful agent mutations divided by total mutations.',
    '# TYPE agent_mutation_success_rate gauge',
    `agent_mutation_success_rate ${agentSuccessRate}`,
    '# HELP collab_reconnect_p95_ms 95th percentile client-observed reconnect latency in milliseconds.',
    '# TYPE collab_reconnect_p95_ms gauge',
    `collab_reconnect_p95_ms ${p95}`,
    '# HELP mark_anchor_resolution_failure_rate Failed mark anchor resolutions divided by total resolutions.',
    '# TYPE mark_anchor_resolution_failure_rate gauge',
    `mark_anchor_resolution_failure_rate ${anchorFailureRate}`,
  ].join('\n');
  return `${registry.render()}${computed}\n`;
}
