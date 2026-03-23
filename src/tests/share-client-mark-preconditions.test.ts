import assert from 'node:assert/strict';

type FetchRecord = {
  path: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function run(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalWindow = (globalThis as { window?: unknown }).window;

  const requests: FetchRecord[] = [];
  let stateReads = 0;

  (globalThis as { window: Record<string, unknown> }).window = {
    location: new URL('https://proof-web-staging.up.railway.app/d/test-doc?token=share-token'),
    __PROOF_CONFIG__: {
      proofClientVersion: '0.31.2',
      proofClientBuild: 'test',
      proofClientProtocol: '3',
    },
  };

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) as Record<string, unknown> : null;
    requests.push({ path: url.pathname, method, headers, body });

    if (url.pathname === '/api/agent/test-doc/state') {
      stateReads += 1;
      if (stateReads === 2) {
        return jsonResponse({ updatedAt: '2026-03-06T00:00:00.000Z' });
      }
      return jsonResponse({ revision: 40 + stateReads, updatedAt: `2026-03-06T00:00:0${stateReads}.000Z` });
    }
    if (url.pathname === '/api/agent/test-doc/marks/accept' && body?.markId === 'mark-accept-recovered') {
      return jsonResponse({
        success: false,
        code: 'COLLAB_SYNC_FAILED',
        error: 'Suggestion acceptance did not converge to live collaboration state',
        markdown: 'Recovered canonical markdown',
        marks: {},
      }, 409);
    }
    if (url.pathname === '/api/agent/test-doc/marks/accept') {
      return jsonResponse({ success: true, marks: {}, markdown: 'Accepted canonical markdown' });
    }
    if (url.pathname === '/api/agent/test-doc/marks/reject') {
      return jsonResponse({ success: true, marks: {}, content: 'Rejected canonical markdown' });
    }
    if (url.pathname === '/api/agent/test-doc/marks/resolve') return jsonResponse({ success: true, marks: {} });
    if (url.pathname === '/api/agent/test-doc/marks/unresolve') return jsonResponse({ success: true, marks: {} });
    throw new Error(`Unexpected request path: ${url.pathname}`);
  };

  try {
    const { shareClient } = await import('../bridge/share-client.js');

    const accept = await shareClient.acceptSuggestion('mark-accept', 'human:editor');
    assert.equal((accept && 'error' in accept) ? false : accept?.success, true, 'acceptSuggestion should succeed');
    assert.equal(
      (accept && 'error' in accept) ? undefined : accept?.markdown,
      'Accepted canonical markdown',
      'acceptSuggestion should surface canonical markdown from the mutation response',
    );

    const recoveredAccept = await shareClient.acceptSuggestion('mark-accept-recovered', 'human:editor');
    assert.equal(
      (recoveredAccept && 'error' in recoveredAccept) ? false : recoveredAccept?.success,
      true,
      'acceptSuggestion should treat recoverable collab-sync failures with canonical payloads as success',
    );
    assert.equal(
      (recoveredAccept && 'error' in recoveredAccept) ? undefined : recoveredAccept?.markdown,
      'Recovered canonical markdown',
      'acceptSuggestion should surface canonical markdown from a recoverable collab-sync failure body',
    );

    const reject = await shareClient.rejectSuggestion('mark-reject', 'human:editor');
    assert.equal((reject && 'error' in reject) ? false : reject?.success, true, 'rejectSuggestion should succeed');
    assert.equal(
      (reject && 'error' in reject) ? undefined : reject?.markdown,
      'Rejected canonical markdown',
      'rejectSuggestion should fall back to content when markdown is returned under the legacy key',
    );

    const resolve = await shareClient.resolveComment('mark-resolve', 'human:editor');
    assert.equal((resolve && 'error' in resolve) ? false : resolve?.success, true, 'resolveComment should succeed');

    const unresolve = await shareClient.unresolveComment('mark-unresolve', 'human:editor');
    assert.equal((unresolve && 'error' in unresolve) ? false : unresolve?.success, true, 'unresolveComment should succeed');

    const acceptRequests = requests.filter((request) => request.path === '/api/agent/test-doc/marks/accept');
    const acceptRequest = acceptRequests[0];
    assert.equal(acceptRequest?.body?.baseRevision, 41, 'acceptSuggestion should include baseRevision from /state');
    assert.equal(
      acceptRequests[1]?.body?.baseUpdatedAt,
      '2026-03-06T00:00:00.000Z',
      'recoverable acceptSuggestion should still fall back to baseUpdatedAt when revision is unavailable',
    );

    const rejectRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/reject');
    assert.equal(
      rejectRequest?.body?.baseRevision,
      43,
      'rejectSuggestion should continue reading the latest base state after prior mark mutations',
    );

    const resolveRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/resolve');
    assert.equal(resolveRequest?.body?.baseRevision, 44, 'resolveComment should include baseRevision from /state');

    const unresolveRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/unresolve');
    assert.equal(unresolveRequest?.body?.baseRevision, 45, 'unresolveComment should include baseRevision from /state');

    const stateRequestCount = requests.filter((request) => request.path === '/api/agent/test-doc/state').length;
    assert.equal(stateRequestCount, 5, 'each share mark mutation should read the latest mutation base');

    console.log('share-client-mark-preconditions.test.ts passed');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
