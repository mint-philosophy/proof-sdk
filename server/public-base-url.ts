import type { Request } from 'express';

export function trustProxyHeaders(): boolean {
  const value = (process.env.PROOF_TRUST_PROXY_HEADERS || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function normalizeOrigin(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function getPublicBaseUrl(req: Request): string {
  if (trustProxyHeaders()) {
    const forwardedProtoHeader = req.header('x-forwarded-proto');
    const forwardedHostHeader = req.header('x-forwarded-host');
    const forwardedProto = typeof forwardedProtoHeader === 'string'
      ? forwardedProtoHeader.split(',')[0]?.trim()
      : '';
    const forwardedHost = typeof forwardedHostHeader === 'string'
      ? forwardedHostHeader.split(',')[0]?.trim()
      : '';
    if (forwardedProto && forwardedHost) {
      const forwardedOrigin = normalizeOrigin(`${forwardedProto}://${forwardedHost}`);
      if (forwardedOrigin) return forwardedOrigin;
    }
  }

  const configuredBase = (process.env.PROOF_PUBLIC_BASE_URL || '').trim();
  if (configuredBase) {
    const normalizedConfiguredBase = normalizeOrigin(configuredBase.replace(/\/+$/, ''));
    if (normalizedConfiguredBase) return normalizedConfiguredBase;
  }

  const host = req.get('host') || '';
  if (!host) return '';
  return normalizeOrigin(`${req.protocol || 'http'}://${host}`) ?? '';
}
