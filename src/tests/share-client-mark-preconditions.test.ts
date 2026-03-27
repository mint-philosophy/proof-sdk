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
  let delayedAcceptAttempts = 0;
  let delayedRejectAttempts = 0;

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
      if (stateReads === 1) {
        return jsonResponse({
          mutationBase: {
            token: 'mt1:test-token-1',
            source: 'persisted_yjs',
            schemaVersion: 'mt1',
          },
          revision: 41,
          updatedAt: '2026-03-06T00:00:01.000Z',
        });
      }
      if (stateReads === 2) {
        return jsonResponse({
          mutationReady: false,
          readSource: 'yjs_fallback',
          updatedAt: null,
          revision: null,
        });
      }
      if (stateReads === 3) {
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
    if (url.pathname === '/api/agent/test-doc/marks/accept' && body?.markId === 'mark-accept-delayed') {
      delayedAcceptAttempts += 1;
      if (delayedAcceptAttempts < 3) {
        return jsonResponse({
          success: false,
          code: 'MARK_NOT_FOUND',
          error: 'Suggestion not found yet in the authoritative share state',
        }, 409);
      }
      return jsonResponse({ success: true, marks: {}, markdown: 'Delayed canonical markdown' });
    }
    if (url.pathname === '/api/agent/test-doc/marks/accept') {
      return jsonResponse({ success: true, marks: {}, markdown: 'Accepted canonical markdown' });
    }
    if (url.pathname === '/api/agent/test-doc/marks/accept-all') {
      return jsonResponse({ success: true, marks: {}, markdown: 'Accepted all canonical markdown' });
    }
    if (url.pathname === '/api/agent/test-doc/marks/reject' && body?.markId === 'mark-reject-delayed') {
      delayedRejectAttempts += 1;
      if (delayedRejectAttempts < 2) {
        return jsonResponse({
          success: false,
          code: 'LIVE_DOC_UNAVAILABLE',
          error: 'Live canonical document is unavailable on this hosted replica; retry after refreshing state',
          retryWithState: '/api/agent/test-doc/state',
        }, 409);
      }
      return jsonResponse({ success: true, marks: {}, markdown: 'Delayed rejected canonical markdown' });
    }
    if (url.pathname === '/api/documents/test-doc/open-context') {
      return jsonResponse({
        success: true,
        doc: {
          slug: 'test-doc',
          title: null,
          markdown: 'Delayed canonical markdown',
          marks: {
            'mark-accept-delayed': {
              kind: 'insert',
              status: delayedAcceptAttempts >= 3 ? 'accepted' : 'pending',
            },
            ...(delayedRejectAttempts < 2
              ? {
                  'mark-reject-delayed': {
                    kind: 'insert',
                    status: 'pending',
                  },
                }
              : {}),
          },
          updatedAt: '2026-03-06T00:00:09.000Z',
        },
        capabilities: { canRead: true, canComment: true, canEdit: true },
        links: { webUrl: '/d/test-doc', snapshotUrl: null },
      });
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

    const accept = await shareClient.acceptSuggestion('mark-accept', 'human:editor', undefined, {
      markdown: 'Snapshot single accept markdown',
      marks: {
        'mark-accept': { kind: 'insert', status: 'pending' },
      },
    });
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

    const reject = await shareClient.rejectSuggestion('mark-reject', 'human:editor', undefined, {
      markdown: 'Snapshot single reject markdown',
      marks: {
        'mark-reject': { kind: 'insert', status: 'pending' },
      },
    });
    assert.equal((reject && 'error' in reject) ? false : reject?.success, true, 'rejectSuggestion should succeed');
    assert.equal(
      (reject && 'error' in reject) ? undefined : reject?.markdown,
      'Rejected canonical markdown',
      'rejectSuggestion should fall back to content when markdown is returned under the legacy key',
    );

    const delayedReject = await shareClient.rejectSuggestion('mark-reject-delayed', 'human:editor');
    assert.equal(
      (delayedReject && 'error' in delayedReject) ? false : delayedReject?.success,
      true,
      'rejectSuggestion should refresh state and retry when the server reports LIVE_DOC_UNAVAILABLE',
    );
    assert.equal(
      (delayedReject && 'error' in delayedReject) ? undefined : delayedReject?.markdown,
      'Delayed rejected canonical markdown',
      'rejectSuggestion should return the eventual canonical markdown after LIVE_DOC_UNAVAILABLE retries',
    );

    const delayedAccept = await shareClient.acceptSuggestion('mark-accept-delayed', 'human:editor');
    assert.equal(
      (delayedAccept && 'error' in delayedAccept) ? false : delayedAccept?.success,
      true,
      'acceptSuggestion should retry transient share-state lag until the suggestion becomes available',
    );
    assert.equal(
      (delayedAccept && 'error' in delayedAccept) ? undefined : delayedAccept?.markdown,
      'Delayed canonical markdown',
      'acceptSuggestion should return the eventual canonical markdown after transient MARK_NOT_FOUND retries',
    );

    const batchAccept = await shareClient.acceptSuggestions(
      ['mark-1', 'mark-2'],
      'human:editor',
      undefined,
      {
        markdown: 'Snapshot batch markdown',
        marks: {
          'mark-1': { kind: 'insert', status: 'pending' },
          'mark-2': { kind: 'insert', status: 'pending' },
        },
      },
    );
    assert.equal((batchAccept && 'error' in batchAccept) ? false : batchAccept?.success, true, 'acceptSuggestions should succeed');
    assert.equal(
      (batchAccept && 'error' in batchAccept) ? undefined : batchAccept?.markdown,
      'Accepted all canonical markdown',
      'acceptSuggestions should surface canonical markdown from the batch mutation response',
    );

    const resolve = await shareClient.resolveComment('mark-resolve', 'human:editor');
    assert.equal((resolve && 'error' in resolve) ? false : resolve?.success, true, 'resolveComment should succeed');

    const unresolve = await shareClient.unresolveComment('mark-unresolve', 'human:editor');
    assert.equal((unresolve && 'error' in unresolve) ? false : unresolve?.success, true, 'unresolveComment should succeed');

    const acceptRequests = requests.filter((request) => request.path === '/api/agent/test-doc/marks/accept');
    const acceptRequest = acceptRequests.find((request) => request.body?.markId === 'mark-accept');
    assert.ok(
      acceptRequest?.headers.get('Idempotency-Key'),
      'acceptSuggestion should send an Idempotency-Key header when the server requires idempotent mutations',
    );
    assert.equal(
      acceptRequest?.body?.baseToken,
      'mt1:test-token-1',
      'acceptSuggestion should prefer baseToken from /state when it is available',
    );
    assert.equal(
      acceptRequest?.body?.baseRevision,
      undefined,
      'acceptSuggestion should not send baseRevision when /state already provided a baseToken',
    );
    assert.equal(
      acceptRequest?.body?.markdown,
      'Snapshot single accept markdown',
      'acceptSuggestion should send the caller-provided visible markdown snapshot for single-mark accept',
    );
    assert.deepEqual(
      acceptRequest?.body?.marks,
      {
        'mark-accept': { kind: 'insert', status: 'pending' },
      },
      'acceptSuggestion should send the caller-provided mark snapshot for single-mark accept',
    );
    assert.equal(
      acceptRequests.find((request) => request.body?.markId === 'mark-accept-recovered')?.body?.baseUpdatedAt,
      '2026-03-06T00:00:00.000Z',
      'recoverable acceptSuggestion should still fall back to baseUpdatedAt when revision is unavailable',
    );
    assert.equal(
      acceptRequests.filter((request) => request.body?.markId === 'mark-accept-delayed').length,
      3,
      'transient MARK_NOT_FOUND acceptSuggestion should retry until the authoritative share state catches up',
    );
    const delayedAcceptIdempotencyKeys = acceptRequests
      .filter((request) => request.body?.markId === 'mark-accept-delayed')
      .map((request) => request.headers.get('Idempotency-Key') ?? '');
    assert.ok(
      delayedAcceptIdempotencyKeys.every((value) => value.length > 0),
      'retrying acceptSuggestion should preserve the original Idempotency-Key across attempts',
    );
    assert.equal(
      new Set(delayedAcceptIdempotencyKeys).size,
      1,
      'retrying acceptSuggestion should reuse the same Idempotency-Key for the same user action',
    );

    const rejectRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/reject');
    const acceptAllRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/accept-all');
    assert.ok(
      rejectRequest?.headers.get('Idempotency-Key'),
      'rejectSuggestion should send an Idempotency-Key header when the server requires idempotent mutations',
    );
    assert.equal(
      rejectRequest?.body?.markdown,
      'Snapshot single reject markdown',
      'rejectSuggestion should send the caller-provided visible markdown snapshot for single-mark reject',
    );
    assert.deepEqual(
      rejectRequest?.body?.marks,
      {
        'mark-reject': { kind: 'insert', status: 'pending' },
      },
      'rejectSuggestion should send the caller-provided mark snapshot for single-mark reject',
    );
    assert.equal(
      requests.filter((request) => request.path === '/api/agent/test-doc/marks/reject' && request.body?.markId === 'mark-reject-delayed').length,
      2,
      'rejectSuggestion should retry LIVE_DOC_UNAVAILABLE after refreshing the latest state',
    );
    assert.ok(
      acceptAllRequest?.headers.get('Idempotency-Key'),
      'acceptSuggestions should send an Idempotency-Key header when the server requires idempotent mutations',
    );
    assert.deepEqual(
      acceptAllRequest?.body?.markIds,
      ['mark-1', 'mark-2'],
      'acceptSuggestions should send the requested markIds in one batch payload',
    );
    assert.equal(
      acceptAllRequest?.body?.markdown,
      'Snapshot batch markdown',
      'acceptSuggestions should send the caller-provided visible markdown snapshot for batch accept',
    );
    assert.deepEqual(
      acceptAllRequest?.body?.marks,
      {
        'mark-1': { kind: 'insert', status: 'pending' },
        'mark-2': { kind: 'insert', status: 'pending' },
      },
      'acceptSuggestions should send the caller-provided mark snapshot for batch accept',
    );
    assert.equal(
      rejectRequest?.body?.baseRevision,
      44,
      'rejectSuggestion should continue reading the latest base state after prior accept mutations',
    );
    const delayedRejectRequest = requests.find((request) =>
      request.path === '/api/agent/test-doc/marks/reject' && request.body?.markId === 'mark-reject-delayed');
    assert.equal(
      delayedRejectRequest?.body?.baseRevision,
      45,
      'LIVE_DOC_UNAVAILABLE rejectSuggestion should start from the latest pre-retry baseRevision',
    );
    assert.equal(
      acceptAllRequest?.body?.baseRevision,
      51,
      'acceptSuggestions should include the latest refreshed baseRevision after delayed accept retries',
    );
    assert.notEqual(
      acceptRequest?.headers.get('Idempotency-Key'),
      rejectRequest?.headers.get('Idempotency-Key'),
      'distinct share review actions should not share an Idempotency-Key',
    );

    const resolveRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/resolve');
    assert.equal(resolveRequest?.body?.baseRevision, 52, 'resolveComment should include the latest refreshed baseRevision after transient accept/reject retries and batch accept');

    const unresolveRequest = requests.find((request) => request.path === '/api/agent/test-doc/marks/unresolve');
    assert.equal(unresolveRequest?.body?.baseRevision, 53, 'unresolveComment should continue reading the latest baseRevision after prior retries');

    const stateRequestCount = requests.filter((request) => request.path === '/api/agent/test-doc/state').length;
    assert.equal(stateRequestCount, 13, 'share mark mutations should keep refreshing the mutation base across LIVE_DOC_UNAVAILABLE retries and batch accept');

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
