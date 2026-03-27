import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAllProofSpanTags, stripProofSpanTags } from '../../server/proof-span-strip.ts';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function normalizeVisibleMarkdown(markdown: string): string {
  return stripAllProofSpanTags(markdown).replaceAll('\\|', '|').trim();
}

function getSuggestionMarkId(result: { body: { marks?: Record<string, { kind?: string }> } }, kind: string): string {
  const marks = result.body.marks ?? {};
  const match = Object.entries(marks).find(([, mark]) => mark?.kind === kind);
  return match?.[0] ?? '';
}

async function run(): Promise<void> {
  const dbName = `proof-suggestion-anchor-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);

  const prevDatabasePath = process.env.DATABASE_PATH;
  const prevProofEnv = process.env.PROOF_ENV;
  const prevNodeEnv = process.env.NODE_ENV;
  const prevDbEnvInit = process.env.PROOF_DB_ENV_INIT;

  process.env.DATABASE_PATH = dbPath;
  process.env.PROOF_ENV = 'development';
  process.env.NODE_ENV = 'development';
  delete process.env.PROOF_DB_ENV_INIT;

  const db = await import('../../server/db.ts');
  const { executeDocumentOperation, executeDocumentOperationAsync } = await import('../../server/document-engine.ts');

  try {
    const slug = `anchor-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(slug, '# Title\n\nHello world', {}, 'Suggestion anchor test');

    const missingReplace = executeDocumentOperation(slug, 'POST', '/marks/suggest-replace', {
      quote: 'This quote is not in the document',
      content: 'replacement',
      by: 'ai:test',
    });
    assert(missingReplace.status === 409, `Expected 409 for missing replace quote, got ${missingReplace.status}`);
    assert(missingReplace.body.code === 'ANCHOR_NOT_FOUND', `Expected ANCHOR_NOT_FOUND, got ${String(missingReplace.body.code)}`);

    const missingInsert = executeDocumentOperation(slug, 'POST', '/marks/suggest-insert', {
      quote: 'Also missing',
      content: ' insert',
      by: 'ai:test',
    });
    assert(missingInsert.status === 409, `Expected 409 for missing insert quote, got ${missingInsert.status}`);
    assert(missingInsert.body.code === 'ANCHOR_NOT_FOUND', `Expected ANCHOR_NOT_FOUND, got ${String(missingInsert.body.code)}`);

    const missingDelete = executeDocumentOperation(slug, 'POST', '/marks/suggest-delete', {
      quote: 'Still missing',
      by: 'ai:test',
    });
    assert(missingDelete.status === 409, `Expected 409 for missing delete quote, got ${missingDelete.status}`);
    assert(missingDelete.body.code === 'ANCHOR_NOT_FOUND', `Expected ANCHOR_NOT_FOUND, got ${String(missingDelete.body.code)}`);

    const missingComment = executeDocumentOperation(slug, 'POST', '/marks/comment', {
      quote: 'Missing comment anchor',
      text: 'Need revision',
      by: 'ai:test',
    });
    assert(missingComment.status === 409, `Expected 409 for missing comment quote, got ${missingComment.status}`);
    assert(missingComment.body.code === 'ANCHOR_NOT_FOUND', `Expected ANCHOR_NOT_FOUND, got ${String(missingComment.body.code)}`);

    const missingSelectorComment = executeDocumentOperation(slug, 'POST', '/marks/comment', {
      selector: { quote: 'Missing selector anchor' },
      text: 'Need revision',
      by: 'ai:test',
    });
    assert(missingSelectorComment.status === 409, `Expected 409 for missing selector comment quote, got ${missingSelectorComment.status}`);
    assert(missingSelectorComment.body.code === 'ANCHOR_NOT_FOUND', `Expected ANCHOR_NOT_FOUND, got ${String(missingSelectorComment.body.code)}`);

    const validComment = executeDocumentOperation(slug, 'POST', '/marks/comment', {
      quote: 'Hello world',
      text: 'Looks good',
      by: 'ai:test',
    });
    assert(validComment.status === 200, `Expected 200 for valid comment anchor, got ${validComment.status}`);
    assert(validComment.body.success === true, 'Expected success=true for valid comment anchor');

    const validReplace = executeDocumentOperation(slug, 'POST', '/marks/suggest-replace', {
      quote: 'Hello',
      content: 'Hi',
      by: 'ai:test',
    });
    assert(validReplace.status === 200, `Expected 200 for valid suggestion anchor, got ${validReplace.status}`);
    assert(validReplace.body.success === true, 'Expected success=true for valid suggestion anchor');

    const markdownSlug = `anchor-md-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(markdownSlug, '- List item two with **bold text**', {}, 'Markdown anchor test');

    const markdownComment = executeDocumentOperation(markdownSlug, 'POST', '/marks/comment', {
      quote: 'List item two with bold text',
      text: 'Anchors on plain text',
      by: 'ai:test',
    });
    assert(markdownComment.status === 200, `Expected 200 for markdown comment anchor, got ${markdownComment.status}`);
    assert(markdownComment.body.success === true, 'Expected success=true for markdown comment anchor');

    const explicitTargetComment = executeDocumentOperation(markdownSlug, 'POST', '/marks/comment', {
      target: { anchor: 'List item two with bold text', mode: 'normalized' },
      text: 'Anchors on explicit visible text target',
      by: 'ai:test',
    });
    assert(explicitTargetComment.status === 200, `Expected 200 for explicit visible-text target anchor, got ${explicitTargetComment.status}`);
    const explicitTargetDoc = db.getDocumentBySlug(markdownSlug);
    assert(explicitTargetDoc, 'Expected markdown doc to exist after explicit target comment');
    const explicitTargetCommentMark = Object.values(JSON.parse(explicitTargetDoc.marks ?? '{}') as Record<string, { kind?: string; text?: string; target?: { anchor?: string } }>).find(
      (mark) => mark?.kind === 'comment' && mark?.text === 'Anchors on explicit visible text target',
    );
    assert(
      explicitTargetCommentMark?.target?.anchor === 'List item two with bold text',
      `Expected explicit target to persist visible-text anchor, got ${JSON.stringify(explicitTargetCommentMark?.target)}`,
    );

    const crossParagraphSlug = `anchor-cross-paragraph-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(crossParagraphSlug, 'Context marker foo\n\nbar\n\nfoo bar', {}, 'Cross paragraph target test');
    const crossParagraphSuggestion = executeDocumentOperation(crossParagraphSlug, 'POST', '/marks/suggest-replace', {
      target: { anchor: 'foo bar', mode: 'normalized', occurrence: 0 },
      content: 'Changed',
      by: 'ai:test',
    });
    assert(crossParagraphSuggestion.status === 200, `Expected 200 for cross-paragraph target anchor, got ${crossParagraphSuggestion.status}`);
    const crossParagraphMarkId = getSuggestionMarkId(crossParagraphSuggestion as { body: { marks?: Record<string, { kind?: string }> } }, 'replace');
    assert(crossParagraphMarkId, 'Expected cross-paragraph suggestion mark id');
    const crossParagraphMark = crossParagraphSuggestion.body.marks?.[crossParagraphMarkId];
    assert(
      crossParagraphMark?.target?.anchor === 'foo\nbar',
      `Expected cross-paragraph target to persist canonical newline separators, got ${JSON.stringify(crossParagraphMark?.target)}`,
    );

    const htmlSlug = `anchor-html-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(htmlSlug, '<p>foo</p><p>bar</p>', {}, 'HTML anchor test');

    const htmlComment = executeDocumentOperation(htmlSlug, 'POST', '/marks/comment', {
      quote: 'foo bar',
      text: 'Anchors across HTML blocks',
      by: 'ai:test',
    });
    assert(htmlComment.status === 200, `Expected 200 for HTML comment anchor, got ${htmlComment.status}`);
    assert(htmlComment.body.success === true, 'Expected success=true for HTML comment anchor');

    const taskSlug = `anchor-task-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(taskSlug, '- [ ] Task one\n- [x] Task two', {}, 'Task list anchor test');

    const taskComment = executeDocumentOperation(taskSlug, 'POST', '/marks/comment', {
      quote: 'Task one',
      text: 'Anchors without checkbox tokens',
      by: 'ai:test',
    });
    assert(taskComment.status === 200, `Expected 200 for task list comment anchor, got ${taskComment.status}`);
    assert(taskComment.body.success === true, 'Expected success=true for task list comment anchor');

    const emphasisSlug = `anchor-emphasis-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(emphasisSlug, '***bold italic***', {}, 'Nested emphasis anchor test');

    const emphasisComment = executeDocumentOperation(emphasisSlug, 'POST', '/marks/comment', {
      quote: 'bold italic',
      text: 'Anchors on nested emphasis',
      by: 'ai:test',
    });
    assert(emphasisComment.status === 200, `Expected 200 for emphasis comment anchor, got ${emphasisComment.status}`);
    assert(emphasisComment.body.success === true, 'Expected success=true for emphasis comment anchor');

    const authoredSlug = `anchor-authored-${Math.random().toString(36).slice(2, 10)}`;
    const authoredMarkdown = '| 2<span data-proof="authored" data-by="human:willie">.</span> | Token tracking per plus1 |';
    db.createDocument(authoredSlug, authoredMarkdown, {}, 'Authored span anchor test');

    const authoredSuggest = executeDocumentOperation(authoredSlug, 'POST', '/marks/suggest-replace', {
      quote: '| 2. | Token tracking per plus1 |',
      content: '| 2. | Token tracking per Plus One |',
      by: 'ai:test',
    });
    assert(authoredSuggest.status === 200, `Expected 200 for authored span suggestion anchor, got ${authoredSuggest.status}`);
    const authoredMarkId = getSuggestionMarkId(authoredSuggest as { body: { marks?: Record<string, { kind?: string }> } }, 'replace');
    assert(authoredMarkId, 'Expected authored span suggestion mark id');
    const authoredMark = (authoredSuggest.body.marks as Record<string, { startRel?: string; endRel?: string }>)[authoredMarkId];
    assert(typeof authoredMark?.startRel === 'string', 'Expected suggestion.add to persist startRel for authored span anchors');
    assert(typeof authoredMark?.endRel === 'string', 'Expected suggestion.add to persist endRel for authored span anchors');

    const authoredAcceptedSlug = `anchor-authored-accepted-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(authoredAcceptedSlug, authoredMarkdown, {}, 'Authored span accepted suggestion test');

    const authoredAccepted = await executeDocumentOperationAsync(authoredAcceptedSlug, 'POST', '/marks/suggest-replace', {
      quote: '| 2. | Token tracking per plus1 |',
      content: '| 2. | Token tracking per Plus One |',
      by: 'ai:test',
      status: 'accepted',
    });
    assert(authoredAccepted.status === 200, `Expected status=accepted suggestion.add to succeed, got ${authoredAccepted.status}`);
    assert(authoredAccepted.body.acceptedImmediately === true, 'Expected acceptedImmediately=true for suggestion.add status=accepted');
    assert(
      stripProofSpanTags(String(authoredAccepted.body.markdown ?? '')) === '| 2. | Token tracking per Plus One |\n',
      `Expected accepted suggestion markdown to apply the replacement immediately, got ${JSON.stringify(authoredAccepted.body.markdown)}`,
    );

    const rejectCycleSlug = `reject-cycle-${Math.random().toString(36).slice(2, 10)}`;
    const rejectCycleMarkdown = '| 2<span data-proof="authored" data-by="human:willie">.</span> | Token tracking per plus1 | Med |';
    db.createDocument(rejectCycleSlug, rejectCycleMarkdown, {}, 'Reject cycle regression');

    const firstRejectSuggestion = executeDocumentOperation(rejectCycleSlug, 'POST', '/marks/suggest-replace', {
      quote: '| 2. | Token tracking per plus1 | Med |',
      content: '| 2. | Token tracking per Plus One | Med |',
      by: 'ai:test',
    });
    assert(firstRejectSuggestion.status === 200, `Expected first reject-cycle suggestion to succeed, got ${firstRejectSuggestion.status}`);
    const firstRejectId = getSuggestionMarkId(firstRejectSuggestion as { body: { marks?: Record<string, { kind?: string }> } }, 'replace');
    assert(firstRejectId, 'Expected first reject-cycle suggestion mark id');
    const firstRejectResult = executeDocumentOperation(rejectCycleSlug, 'POST', '/marks/reject', { markId: firstRejectId, by: 'human:test' });
    assert(firstRejectResult.status === 200, `Expected first reject-cycle rejection to succeed, got ${firstRejectResult.status}`);
    const firstRejectedMarkdown = db.getDocumentBySlug(rejectCycleSlug)?.markdown ?? '';
    assert(
      normalizeVisibleMarkdown(firstRejectedMarkdown) === normalizeVisibleMarkdown(rejectCycleMarkdown),
      'Expected first reject cycle to preserve visible markdown content',
    );
    assert(!firstRejectedMarkdown.includes('data-proof="suggestion"'), 'Expected first reject cycle to remove the suggestion wrapper');

    const secondRejectSuggestion = executeDocumentOperation(rejectCycleSlug, 'POST', '/marks/suggest-replace', {
      quote: '| 2. | Token tracking per plus1 | Med |',
      content: '| 2. | Token tracking per Plus1 tracking | Med |',
      by: 'ai:test',
    });
    assert(secondRejectSuggestion.status === 200, `Expected second reject-cycle suggestion to succeed, got ${secondRejectSuggestion.status}`);
    const secondRejectId = getSuggestionMarkId(secondRejectSuggestion as { body: { marks?: Record<string, { kind?: string }> } }, 'replace');
    assert(secondRejectId, 'Expected second reject-cycle suggestion mark id');
    const secondRejectResult = executeDocumentOperation(rejectCycleSlug, 'POST', '/marks/reject', { markId: secondRejectId, by: 'human:test' });
    assert(secondRejectResult.status === 200, `Expected second reject-cycle rejection to succeed, got ${secondRejectResult.status}`);
    const secondRejectedMarkdown = db.getDocumentBySlug(rejectCycleSlug)?.markdown ?? '';
    assert(
      normalizeVisibleMarkdown(secondRejectedMarkdown) === normalizeVisibleMarkdown(rejectCycleMarkdown),
      'Expected repeated reject cycles to preserve visible markdown content',
    );
    assert(!secondRejectedMarkdown.includes('data-proof="suggestion"'), 'Expected repeated reject cycles to remove the suggestion wrapper');

    // --- Table-driven acceptance tests ---
    // Each case: create doc, suggest, accept, verify final markdown
    type AcceptCase = {
      name: string;
      markdown: string;
      kind: 'delete' | 'replace' | 'insert';
      quote: string;
      content?: string;
      expected: string;
    };

    const acceptCases: AcceptCase[] = [
      { name: 'delete bold formatting',          markdown: 'Some **bold** text',                       kind: 'delete',  quote: 'bold',         expected: 'Some  text' },
      { name: 'replace italic formatting',        markdown: 'Some *italic* words',                     kind: 'replace', quote: 'italic',       content: 'plain',   expected: 'Some *plain* words' },
      { name: 'insert after bold formatting',     markdown: 'Some **text** here',                      kind: 'insert',  quote: 'text',         content: ' added',  expected: 'Some **text** added here' },
      { name: 'exact match replace (plain text)', markdown: 'Hello world',                             kind: 'replace', quote: 'Hello',        content: 'Hi',      expected: 'Hi world' },
      { name: 'delete nested formatting',         markdown: 'Some **_bold italic_** text',             kind: 'delete',  quote: 'bold italic',  expected: 'Some  text' },
      { name: 'delete HTML tag formatting',       markdown: 'Some <strong>bold</strong> text',         kind: 'delete',  quote: 'bold',         expected: 'Some  text' },
      { name: 'replace with whitespace normalization', markdown: 'Hello\n\nworld',                     kind: 'replace', quote: 'Hello world',  content: 'Hi there', expected: 'Hi there' },
      { name: 'delete link text',                 markdown: 'Click [here](https://example.com) now',   kind: 'delete',  quote: 'here',         expected: 'Click  now' },
      { name: 'delete image alt text',            markdown: 'See ![photo](https://img.com/a.jpg) below', kind: 'delete', quote: 'photo',       expected: 'See  below' },
    ];

    function suggestAndAccept(c: AcceptCase): void {
      const slug = `accept-${c.kind}-${Math.random().toString(36).slice(2, 10)}`;
      db.createDocument(slug, c.markdown, {}, c.name);

      const suggestRoute = c.kind === 'delete' ? '/marks/suggest-delete'
        : c.kind === 'replace' ? '/marks/suggest-replace'
        : '/marks/suggest-insert';

      const suggestBody: Record<string, string> = { quote: c.quote, by: 'ai:test' };
      if (c.content !== undefined) suggestBody.content = c.content;

      const suggestResult = executeDocumentOperation(slug, 'POST', suggestRoute, suggestBody);
      assert(suggestResult.status === 200, `[${c.name}] suggest failed: ${suggestResult.status}`);

      const markId = getSuggestionMarkId(suggestResult as { body: { marks?: Record<string, { kind?: string }> } }, c.kind);
      assert(markId, `[${c.name}] no markId found`);

      const acceptResult = executeDocumentOperation(slug, 'POST', '/marks/accept', { markId, by: 'ai:test' });
      assert(acceptResult.status === 200, `[${c.name}] accept failed: ${acceptResult.status}`);
      assert(
        String(acceptResult.body.markdown ?? '').trimEnd() === c.expected.trimEnd(),
        `[${c.name}] expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(acceptResult.body.markdown)}`,
      );
    }

    for (const c of acceptCases) {
      suggestAndAccept(c);
    }

    type ExplicitTargetAcceptCase = {
      name: string;
      markdown: string;
      kind: 'delete' | 'replace' | 'insert';
      target: { anchor: string; mode: 'exact' | 'normalized' | 'contextual'; contextBefore?: string; contextAfter?: string };
      content?: string;
      expectedTargetAnchor: string;
      expected: string;
    };

    const explicitTargetAcceptCases: ExplicitTargetAcceptCase[] = [
      {
        name: 'explicit target delete preserves formatting semantics',
        markdown: 'Some **bold** text',
        kind: 'delete',
        target: { anchor: '**bold**', mode: 'normalized' },
        expectedTargetAnchor: 'bold',
        expected: 'Some  text',
      },
      {
        name: 'explicit target replace preserves wrapper formatting',
        markdown: 'Some *italic* words',
        kind: 'replace',
        target: { anchor: '*italic*', mode: 'normalized' },
        content: 'plain',
        expectedTargetAnchor: 'italic',
        expected: 'Some *plain* words',
      },
      {
        name: 'explicit target insert lands after formatted span',
        markdown: 'Some **text** here',
        kind: 'insert',
        target: { anchor: '**text**', mode: 'normalized' },
        content: ' added',
        expectedTargetAnchor: 'text',
        expected: 'Some **text** added here',
      },
    ];

    function suggestAndAcceptExplicitTarget(c: ExplicitTargetAcceptCase): void {
      const slug = `accept-target-${c.kind}-${Math.random().toString(36).slice(2, 10)}`;
      db.createDocument(slug, c.markdown, {}, c.name);

      const suggestRoute = c.kind === 'delete' ? '/marks/suggest-delete'
        : c.kind === 'replace' ? '/marks/suggest-replace'
        : '/marks/suggest-insert';

      const suggestBody: Record<string, unknown> = { target: c.target, by: 'ai:test' };
      if (c.content !== undefined) suggestBody.content = c.content;

      const suggestResult = executeDocumentOperation(slug, 'POST', suggestRoute, suggestBody);
      assert(suggestResult.status === 200, `[${c.name}] suggest failed: ${suggestResult.status}`);

      const markId = getSuggestionMarkId(suggestResult as { body: { marks?: Record<string, { kind?: string }> } }, c.kind);
      assert(markId, `[${c.name}] no markId found`);
      const storedMark = suggestResult.body.marks?.[markId];
      assert(
        storedMark?.target?.anchor === c.expectedTargetAnchor,
        `[${c.name}] expected stored target anchor ${JSON.stringify(c.expectedTargetAnchor)}, got ${JSON.stringify(storedMark?.target)}`,
      );

      const acceptResult = executeDocumentOperation(slug, 'POST', '/marks/accept', { markId, by: 'ai:test' });
      assert(acceptResult.status === 200, `[${c.name}] accept failed: ${acceptResult.status}`);
      assert(
        String(acceptResult.body.markdown ?? '').trimEnd() === c.expected.trimEnd(),
        `[${c.name}] expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(acceptResult.body.markdown)}`,
      );
    }

    for (const c of explicitTargetAcceptCases) {
      suggestAndAcceptExplicitTarget(c);
    }

    const duplicateSlug = `anchor-dupe-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(duplicateSlug, '# Title\\n\\nRepeat\\n\\nRepeat', {}, 'Duplicate anchor test');

    const ambiguousSuggestion = executeDocumentOperation(duplicateSlug, 'POST', '/marks/suggest-replace', {
      target: { anchor: 'Repeat' },
      content: 'Changed',
      by: 'ai:test',
    });
    assert(ambiguousSuggestion.status === 409, `Expected 409 for ambiguous suggestion anchor, got ${ambiguousSuggestion.status}`);
    assert(ambiguousSuggestion.body.code === 'ANCHOR_AMBIGUOUS', `Expected ANCHOR_AMBIGUOUS, got ${String(ambiguousSuggestion.body.code)}`);

    const disambiguatedSuggestion = executeDocumentOperation(duplicateSlug, 'POST', '/marks/suggest-replace', {
      target: { anchor: 'Repeat', occurrence: 1 },
      content: 'Changed',
      by: 'ai:test',
    });
    assert(disambiguatedSuggestion.status === 200, `Expected 200 for disambiguated suggestion anchor, got ${disambiguatedSuggestion.status}`);
    assert(disambiguatedSuggestion.body.success === true, 'Expected success=true for disambiguated suggestion anchor');
    const disambiguatedMarkId = Object.keys(disambiguatedSuggestion.body.marks ?? {})[0];
    const disambiguatedMark = disambiguatedSuggestion.body.marks?.[disambiguatedMarkId];
    assert(typeof disambiguatedMark?.target?.contextBefore === 'string' || typeof disambiguatedMark?.target?.contextAfter === 'string', 'Expected stabilized target context to be persisted');
    assert(disambiguatedMark?.target?.occurrence === undefined, 'Expected stabilized target to omit occurrence-based identity');

    const driftSlug = `anchor-drift-${Math.random().toString(36).slice(2, 10)}`;
    db.createDocument(driftSlug, '# Title\n\nRepeat\n\nContext target\nRepeat', {}, 'Target drift test');
    const targetSuggestion = executeDocumentOperation(driftSlug, 'POST', '/marks/suggest-replace', {
      target: { anchor: 'Repeat', occurrence: 1 },
      content: 'Changed',
      by: 'ai:test',
    });
    assert(targetSuggestion.status === 200, `Expected 200 for target drift setup, got ${targetSuggestion.status}`);
    const targetMarkId = Object.keys(targetSuggestion.body.marks ?? {})[0];
    const driftDocBefore = db.getDocumentBySlug(driftSlug);
    assert(driftDocBefore, 'Expected drift doc to exist');
    const driftMarks = JSON.parse(driftDocBefore.marks ?? '{}') as Record<string, unknown>;
    const driftUpdatedMarkdown = '# Title\n\nRepeat\n\nRepeat\n\nContext target\nRepeat';
    const driftUpdated = db.updateDocumentAtomic(
      driftSlug,
      driftDocBefore.updated_at,
      driftUpdatedMarkdown,
      driftMarks,
    );
    assert(driftUpdated === true, 'Expected drift document setup update to succeed');
    const targetAccept = executeDocumentOperation(driftSlug, 'POST', '/marks/accept', { markId: targetMarkId, by: 'ai:test' });
    assert(targetAccept.status === 200, `Expected target drift accept to succeed, got ${targetAccept.status}`);
    assert(
      targetAccept.body.markdown === '# Title\n\nRepeat\n\nRepeat\n\nContext target\nChanged',
      `Expected accept to mutate the original targeted duplicate, got ${JSON.stringify(targetAccept.body.markdown)}`,
    );

    console.log('✓ suggestion/comment anchor validation guardrails');
  } finally {
    if (prevDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = prevDatabasePath;

    if (prevProofEnv === undefined) delete process.env.PROOF_ENV;
    else process.env.PROOF_ENV = prevProofEnv;

    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;

    if (prevDbEnvInit === undefined) delete process.env.PROOF_DB_ENV_INIT;
    else process.env.PROOF_DB_ENV_INIT = prevDbEnvInit;

    for (const suffix of ['', '-wal', '-shm']) {
      try {
        unlinkSync(`${dbPath}${suffix}`);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
