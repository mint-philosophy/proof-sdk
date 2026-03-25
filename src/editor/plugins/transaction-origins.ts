import { ySyncPluginKey } from 'y-prosemirror';

type RawMeta = Record<string, unknown>;

export type YjsTransactionOriginInfo = {
  isYjsOrigin: boolean;
  source: 'plugin-meta-change-origin' | 'raw-meta-change-origin' | 'raw-meta-key' | null;
  rawMetaKeys: string[];
};

function getRawMeta(transaction: unknown): RawMeta | null {
  const rawMeta = (transaction as { meta?: unknown } | null | undefined)?.meta;
  if (!rawMeta || typeof rawMeta !== 'object' || Array.isArray(rawMeta)) return null;
  return rawMeta as RawMeta;
}

export function getYjsTransactionOriginInfo(transaction: unknown): YjsTransactionOriginInfo {
  const pluginMeta = (transaction as { getMeta?: (key: unknown) => unknown } | null | undefined)?.getMeta?.(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  if (pluginMeta?.isChangeOrigin === true) {
    return {
      isYjsOrigin: true,
      source: 'plugin-meta-change-origin',
      rawMetaKeys: [],
    };
  }

  const rawMeta = getRawMeta(transaction);
  if (!rawMeta) {
    return {
      isYjsOrigin: false,
      source: null,
      rawMetaKeys: [],
    };
  }

  const rawMetaKeys = Object.keys(rawMeta).filter((key) => key.startsWith('y-sync'));
  if (rawMetaKeys.length === 0) {
    return {
      isYjsOrigin: false,
      source: null,
      rawMetaKeys: [],
    };
  }

  for (const key of rawMetaKeys) {
    const value = rawMeta[key];
    if (value && typeof value === 'object' && (value as { isChangeOrigin?: boolean }).isChangeOrigin === true) {
      return {
        isYjsOrigin: true,
        source: 'raw-meta-change-origin',
        rawMetaKeys,
      };
    }
  }

  return {
    isYjsOrigin: true,
    source: 'raw-meta-key',
    rawMetaKeys,
  };
}

export function isExplicitYjsChangeOriginTransaction(transaction: unknown): boolean {
  const pluginMeta = (transaction as { getMeta?: (key: unknown) => unknown } | null | undefined)?.getMeta?.(ySyncPluginKey) as
    | { isChangeOrigin?: boolean }
    | undefined;
  if (pluginMeta?.isChangeOrigin === true) {
    return true;
  }

  const rawMeta = getRawMeta(transaction);
  if (!rawMeta) return false;
  const rawMetaKeys = Object.keys(rawMeta).filter((key) => key.startsWith('y-sync'));
  for (const key of rawMetaKeys) {
    const value = rawMeta[key];
    if (value && typeof value === 'object' && (value as { isChangeOrigin?: boolean }).isChangeOrigin === true) {
      return true;
    }
  }
  return false;
}

export function isYjsChangeOriginTransaction(transaction: unknown): boolean {
  return getYjsTransactionOriginInfo(transaction).isYjsOrigin;
}
