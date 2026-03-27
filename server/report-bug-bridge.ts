import { Router, type Request, type Response } from 'express';
import {
  appendGitHubBugReportFollowUp,
  buildBugReportEvidence,
  buildBugReportFollowUpEvidence,
  buildFixerBriefFromEvidence,
  createGitHubIssueForBugReport,
  getReportBugToolSpec,
  validateReportBugToolCreate,
  validateReportBugToolFollowUp,
} from './bug-reporting.js';
import { traceServerIncident, toErrorTraceData } from './incident-tracing.js';
import { buildAppsignalCorrelation, tagActiveBugReportIssue } from './observability.js';
import { getPublicBaseUrl } from './public-base-url.js';
import { readRequestId } from './request-context.js';

export const reportBugBridgeRouter = Router({ mergeParams: true });

function getSlug(req: Request): string | null {
  const raw = req.params.slug;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  return null;
}

function getIssueUrl(issueNumber: number): string {
  const owner = process.env.PROOF_GITHUB_ISSUES_OWNER?.trim() || 'EveryInc';
  const repo = process.env.PROOF_GITHUB_ISSUES_REPO?.trim() || 'proof';
  return `https://github.com/${owner}/${repo}/issues/${issueNumber}`;
}

function getReportBugRouteTemplate(req: Request): string {
  return getSlug(req) ? '/d/:slug/bridge/report_bug' : '/api/bridge/report_bug';
}

function readIssueNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!/^[1-9]\d*$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function __readIssueNumberForTests(value: unknown): number | null {
  return readIssueNumber(value);
}

reportBugBridgeRouter.get('/report_bug', (req: Request, res: Response) => {
  res.json(getReportBugToolSpec({
    slugFromPath: getSlug(req),
    baseUrl: getPublicBaseUrl(req),
  }));
});

reportBugBridgeRouter.post('/report_bug', async (req: Request, res: Response) => {
  const requestId = readRequestId(req);
  const slugFromPath = getSlug(req);
  const issueNumber = readIssueNumber((req.body as Record<string, unknown> | null | undefined)?.issueNumber);
  const routeTemplate = getReportBugRouteTemplate(req);
  const buildResponseAppsignal = (input: {
    subsystem?: string | null;
    issueNumber?: number | null;
    issueUrl?: string | null;
  } = {}) => buildAppsignalCorrelation({
    namespace: 'agent_bug_reports',
    routeTemplate,
    subsystem: input.subsystem ?? null,
    issueNumber: input.issueNumber ?? null,
    issueUrl: input.issueUrl ?? null,
  });

  if ((req.body as Record<string, unknown> | null | undefined)?.issueNumber !== undefined && issueNumber === null) {
    res.json({
      status: 'needs_more_info',
      issueNumber: null,
      issueUrl: null,
      evidenceSummary: null,
      fixerBrief: null,
      missingFields: ['issueNumber'],
      suggestedQuestions: ['Which GitHub issue number should this follow-up be appended to?'],
      nextBestEvidence: [],
      requestId,
      appsignal: buildResponseAppsignal(),
    });
    return;
  }

  if (issueNumber !== null) {
    const validation = validateReportBugToolFollowUp(req.body, slugFromPath);
    if (!validation.ok) {
      res.json({
        status: 'needs_more_info',
        issueNumber,
        issueUrl: getIssueUrl(issueNumber),
        evidenceSummary: null,
        fixerBrief: null,
        missingFields: validation.missingFields,
        suggestedQuestions: validation.suggestedQuestions,
        nextBestEvidence: validation.nextBestEvidence,
        requestId,
        appsignal: buildResponseAppsignal({
          issueNumber,
          issueUrl: getIssueUrl(issueNumber),
        }),
      });
      return;
    }

    const evidence = buildBugReportFollowUpEvidence(validation.followUp);
    traceServerIncident({
      requestId,
      slug: validation.followUp.slug,
      subsystem: 'agent_bug_reports',
      level: 'info',
      eventType: 'bridge_follow_up_received',
      message: 'Received report_bug follow-up submission',
      data: {
        issueNumber,
        reportRequestId: validation.followUp.requestId,
        inferredSubsystem: evidence.inferredSubsystem,
        routeTemplate: evidence.routeTemplate,
        evidenceSummary: evidence.summary,
      },
    });

    try {
      await appendGitHubBugReportFollowUp(issueNumber, evidence);
      const issueUrl = getIssueUrl(issueNumber);
      tagActiveBugReportIssue({
        issueNumber,
        issueUrl,
        subsystem: evidence.inferredSubsystem,
        requestId,
      });
      const fixerBrief = buildFixerBriefFromEvidence(
        validation.followUp.context ?? 'Bug follow-up',
        evidence,
        issueNumber,
        issueUrl,
      );
      res.json({
        status: 'follow_up_added',
        issueNumber,
        issueUrl,
        likelySubsystem: evidence.inferredSubsystem,
        primaryRequest: evidence.primaryRequest,
        routeHint: evidence.routeHint,
        routeTemplate: evidence.routeTemplate,
        primaryError: evidence.primaryError,
        suspectedFiles: evidence.suspectedFiles,
        evidenceSummary: evidence.summary,
        fixerBrief,
        missingFields: [],
        suggestedQuestions: [],
        nextBestEvidence: [],
        requestId,
        appsignal: buildResponseAppsignal({
          subsystem: evidence.inferredSubsystem,
          issueNumber,
          issueUrl,
        }),
      });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message.includes('PROOF_GITHUB_ISSUES_TOKEN') ? 503 : 502;
      traceServerIncident({
        requestId,
        slug: validation.followUp.slug,
        subsystem: 'agent_bug_reports',
        level: 'error',
        eventType: 'bridge_follow_up_failed',
        message: 'Failed to append report_bug follow-up to GitHub issue',
        data: {
          issueNumber,
          routeTemplate: evidence.routeTemplate,
          evidenceSummary: evidence.summary,
          ...toErrorTraceData(error),
        },
      });
      res.status(status).json({
        error: message,
        code: 'REPORT_BUG_FOLLOW_UP_FAILED',
        issueNumber,
        issueUrl: getIssueUrl(issueNumber),
        evidenceCapturedLocally: true,
        requestId,
      });
      return;
    }
  }

  const validation = validateReportBugToolCreate(req.body, slugFromPath);
  if (!validation.ok) {
    res.json({
      status: 'needs_more_info',
      issueNumber: null,
      issueUrl: null,
      evidenceSummary: null,
      fixerBrief: null,
      missingFields: validation.missingFields,
      suggestedQuestions: validation.suggestedQuestions,
      nextBestEvidence: validation.nextBestEvidence,
      requestId,
      appsignal: buildResponseAppsignal(),
    });
    return;
  }

  const evidence = buildBugReportEvidence(validation.report);
  traceServerIncident({
    requestId,
    slug: validation.report.slug,
    subsystem: 'agent_bug_reports',
    level: 'info',
    eventType: 'bridge_report_received',
    message: 'Received report_bug bridge submission',
    data: {
      reportType: validation.report.reportType,
      severity: validation.report.severity,
      summary: validation.report.summary,
      reportRequestId: validation.report.requestId,
      routeTemplate: evidence.routeTemplate,
      inferredSubsystem: evidence.inferredSubsystem,
      evidenceSummary: evidence.summary,
    },
  });

  try {
    const issue = await createGitHubIssueForBugReport(evidence);
    tagActiveBugReportIssue({
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
      subsystem: evidence.inferredSubsystem,
      requestId,
    });
    const fixerBrief = buildFixerBriefFromEvidence(
      validation.report.summary,
      evidence,
      issue.issueNumber,
      issue.issueUrl,
    );
    traceServerIncident({
      requestId,
      slug: validation.report.slug,
      subsystem: 'agent_bug_reports',
      level: 'info',
      eventType: 'bridge_issue_created',
      message: 'Created GitHub issue from report_bug bridge submission',
      data: {
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
        routeTemplate: evidence.routeTemplate,
        inferredSubsystem: evidence.inferredSubsystem,
      },
    });
    res.json({
      status: 'created',
      issueNumber: issue.issueNumber,
      issueUrl: issue.issueUrl,
      likelySubsystem: evidence.inferredSubsystem,
      primaryRequest: evidence.primaryRequest,
      routeHint: evidence.routeHint,
      routeTemplate: evidence.routeTemplate,
      primaryError: evidence.primaryError,
      suspectedFiles: evidence.suspectedFiles,
      evidenceSummary: evidence.summary,
      fixerBrief,
      missingFields: [],
      suggestedQuestions: [],
      nextBestEvidence: [],
      requestId,
      appsignal: buildResponseAppsignal({
        subsystem: evidence.inferredSubsystem,
        issueNumber: issue.issueNumber,
        issueUrl: issue.issueUrl,
      }),
    });
  } catch (error) {
    const issueError = error as Error & {
      issueNumber?: number;
      issueUrl?: string;
      issueApiUrl?: string;
    };
    const message = issueError instanceof Error ? issueError.message : String(issueError);
    const status = message.includes('PROOF_GITHUB_ISSUES_TOKEN') ? 503 : 502;
    traceServerIncident({
      requestId,
      slug: validation.report.slug,
      subsystem: 'agent_bug_reports',
      level: 'error',
      eventType: 'bridge_issue_failed',
      message: 'Failed to create GitHub issue from report_bug bridge submission',
      data: {
        issueNumber: issueError.issueNumber ?? null,
        issueUrl: issueError.issueUrl ?? null,
        routeTemplate: evidence.routeTemplate,
        inferredSubsystem: evidence.inferredSubsystem,
        evidenceSummary: evidence.summary,
        ...toErrorTraceData(error),
      },
    });
    res.status(status).json({
      error: message,
      code: 'REPORT_BUG_CREATE_FAILED',
      issueNumber: issueError.issueNumber ?? null,
      issueUrl: issueError.issueUrl ?? null,
      issueApiUrl: issueError.issueApiUrl ?? null,
      evidenceCapturedLocally: true,
      requestId,
    });
  }
});
