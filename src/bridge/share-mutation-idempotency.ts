let shareMutationNonce = 0;

function sanitizeKeyPart(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized.slice(0, 64) : 'unknown';
}

function createNonce(): string {
  shareMutationNonce += 1;
  const timestamp = Date.now().toString(36);
  const counter = shareMutationNonce.toString(36);
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return `${timestamp}-${counter}-${random}`;
}

export function createShareMutationIdempotencyKey(args: {
  path: 'accept' | 'reject';
  slug: string;
  markId: string;
  by: string;
}): string {
  return [
    'proof',
    'share',
    'mark',
    sanitizeKeyPart(args.path),
    sanitizeKeyPart(args.slug),
    sanitizeKeyPart(args.markId),
    sanitizeKeyPart(args.by),
    createNonce(),
  ].join(':');
}
