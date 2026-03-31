import { getDocumentBySlug, listActiveDocuments } from './db.js';
import { mutateCanonicalDocument } from './canonical-document.js';
import {
  buildProofSpanReplacementMap,
  stripAllProofSpanTags,
  stripAllProofSpanTagsWithReplacements,
} from './proof-span-strip.js';
import { rehydrateProofMarksMarkdown } from './proof-mark-rehydration.js';
import { canonicalizeStoredMarks, type StoredMark } from '../src/formats/marks.js';
import { normalizeStoredMarksAgainstMarkdown } from './mark-anchor-normalization.js';

type RepairDocRow = {
  slug: string;
  markdown: string;
  marks: string;
  revision: number;
};

export type ProofMarkRepairReport = {
  slug: string;
  safeToWrite: boolean;
  wrote: boolean;
  textStable: boolean;
  markIdentityStable: boolean;
  hydrationComplete: boolean;
  changed: boolean;
  error?: string;
  code?: string;
  missingMarkIds: string[];
};

function isRecord(value: unknown): value is Record<string, StoredMark> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMarks(raw: string): Record<string, StoredMark> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? canonicalizeStoredMarks(parsed) : {};
  } catch {
    return {};
  }
}

function summarizeMarkIdentity(mark: StoredMark): Record<string, unknown> {
  return {
    kind: mark.kind ?? null,
    status: mark.status ?? null,
    resolved: mark.resolved ?? null,
    by: mark.by ?? null,
  };
}

function normalizeVisibleText(markdown: string): string {
  return markdown.trimEnd();
}

function hasStableMarkIdentity(
  beforeMarks: Record<string, StoredMark>,
  afterMarks: Record<string, StoredMark>,
): boolean {
  const beforeIds = Object.keys(beforeMarks).sort();
  const afterIds = Object.keys(afterMarks).sort();
  if (beforeIds.length !== afterIds.length) return false;
  for (let index = 0; index < beforeIds.length; index += 1) {
    if (beforeIds[index] !== afterIds[index]) return false;
  }
  for (const id of beforeIds) {
    if (JSON.stringify(summarizeMarkIdentity(beforeMarks[id])) !== JSON.stringify(summarizeMarkIdentity(afterMarks[id]))) {
      return false;
    }
  }
  return true;
}

async function repairDocumentRow(
  doc: RepairDocRow,
  options?: { write?: boolean },
): Promise<ProofMarkRepairReport> {
  const originalMarks = parseMarks(doc.marks);
  const repaired = await rehydrateProofMarksMarkdown(doc.markdown, originalMarks);
  if (!repaired.ok) {
    return {
      slug: doc.slug,
      safeToWrite: false,
      wrote: false,
      textStable: false,
      markIdentityStable: false,
      hydrationComplete: false,
      changed: false,
      error: repaired.error,
      code: repaired.code,
      missingMarkIds: repaired.missingRequiredMarkIds,
    };
  }

  const repairedMarks = normalizeStoredMarksAgainstMarkdown(
    repaired.markdown,
    canonicalizeStoredMarks(repaired.marks),
  );
  const markIdentityStable = hasStableMarkIdentity(originalMarks, repairedMarks);
  const originalBaseMarkdown = stripAllProofSpanTagsWithReplacements(
    doc.markdown,
    buildProofSpanReplacementMap(originalMarks),
  );
  const textStable = normalizeVisibleText(originalBaseMarkdown) === normalizeVisibleText(repaired.repairedStrippedMarkdown);
  const hydrationComplete = repaired.missingRequiredMarkIds.length === 0;
  const changed = doc.markdown !== repaired.markdown || JSON.stringify(originalMarks) !== JSON.stringify(repairedMarks);
  const safeToWrite = textStable && hydrationComplete && markIdentityStable;

  if (!options?.write || !safeToWrite || !changed) {
    return {
      slug: doc.slug,
      safeToWrite,
      wrote: false,
      textStable,
      markIdentityStable,
      hydrationComplete,
      changed,
      missingMarkIds: repaired.missingRequiredMarkIds,
    };
  }

  const mutation = await mutateCanonicalDocument({
    slug: doc.slug,
    nextMarkdown: repaired.markdown,
    nextMarks: repairedMarks as Record<string, unknown>,
    source: 'repair:proof-marks',
    baseRevision: doc.revision,
    strictLiveDoc: true,
    guardPathologicalGrowth: false,
  });
  if (!mutation.ok) {
    return {
      slug: doc.slug,
      safeToWrite,
      wrote: false,
      textStable,
      markIdentityStable,
      hydrationComplete,
      changed,
      error: mutation.error,
      code: mutation.code,
      missingMarkIds: repaired.missingRequiredMarkIds,
    };
  }

  return {
    slug: doc.slug,
    safeToWrite,
    wrote: true,
    textStable,
    markIdentityStable,
    hydrationComplete,
    changed,
    missingMarkIds: repaired.missingRequiredMarkIds,
  };
}

export async function repairProofMarksForSlug(
  slug: string,
  options?: { write?: boolean },
): Promise<ProofMarkRepairReport> {
  const doc = getDocumentBySlug(slug);
  if (!doc) {
    return {
      slug,
      safeToWrite: false,
      wrote: false,
      textStable: false,
      markIdentityStable: false,
      hydrationComplete: false,
      changed: false,
      error: 'Document not found',
      code: 'NOT_FOUND',
      missingMarkIds: [],
    };
  }

  return repairDocumentRow(doc, options);
}

export async function repairProofMarksForAllDocuments(
  options?: { write?: boolean },
): Promise<ProofMarkRepairReport[]> {
  const docs = listActiveDocuments();
  const reports: ProofMarkRepairReport[] = [];
  for (const doc of docs) {
    reports.push(await repairDocumentRow(doc, options));
  }
  return reports;
}
