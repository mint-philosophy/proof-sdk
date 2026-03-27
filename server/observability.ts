import type { Request, Response } from 'express';
import { getBuildInfo } from './build-info.js';

type MetricTagValue = string | number | boolean;
type MetricTags = Record<string, MetricTagValue | null | undefined>;
type SpanTags = Record<string, MetricTagValue | null | undefined>;

export type AppsignalCorrelation = {
  namespace: string;
  requestId: string | null;
  revision: string | null;
  tags: string[];
};

type BuildCorrelationInput = {
  namespace?: string | null;
  requestId?: string | null;
  tags?: SpanTags | null;
};

type ActiveBugReportInput = {
  issueNumber: number;
  issueUrl: string;
  subsystem?: string | null;
  requestId?: string | null;
};

function normalizeTags(tags: SpanTags | null | undefined): string[] {
  if (!tags) return [];
  return Object.entries(tags)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim().length > 0)
    .slice(0, 16)
    .map(([key, value]) => `${key}=${String(value).trim()}`);
}

export function buildAppsignalCorrelation(input: BuildCorrelationInput = {}): AppsignalCorrelation {
  return {
    namespace: (input.namespace ?? 'proof-sdk').trim() || 'proof-sdk',
    requestId: input.requestId ?? null,
    revision: getBuildInfo().sha || null,
    tags: normalizeTags(input.tags),
  };
}

export function incrementAppsignalCounter(_name: string, _value: number = 1, _tags: MetricTags = {}): void {}

export function addAppsignalDistributionValue(_name: string, _value: number, _tags: MetricTags = {}): void {}

export function observeExpressError(_req: Request, _res: Response, _error: unknown): void {}

export function tagActiveBugReportIssue(_input: ActiveBugReportInput): void {}
