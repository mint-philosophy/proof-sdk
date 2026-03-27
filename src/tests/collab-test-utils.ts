import './install-node-websocket.ts';
import { HocuspocusProvider } from '@hocuspocus/provider';

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (actual !== expected) {
    throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function assertDeepEqual<T>(actual: T, expected: T, message?: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message ?? `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  label: string,
  intervalMs: number = 20,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await fn()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

export async function retryableAssertion(
  assertion: () => void | Promise<void>,
  timeoutMs: number,
  label: string,
  intervalMs: number = 25,
): Promise<void> {
  const started = Date.now();
  let lastError: unknown = new Error(`Assertion never passed: ${label}`);

  while (Date.now() - started < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await sleep(intervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for assertion: ${label}\n${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

export function normalizeWsUrl(raw: string): string {
  const cleaned = raw.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(cleaned);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return cleaned.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

export function safeDisconnect(provider: HocuspocusProvider | null | undefined): void {
  if (!provider) return;
  try {
    provider.disconnect();
  } catch {
    // ignore
  }
  try {
    provider.destroy();
  } catch {
    // ignore
  }
  try {
    (provider as any)?.configuration?.websocketProvider?.destroy?.();
  } catch {
    // ignore
  }
}
