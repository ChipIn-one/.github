import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkDraft, main, parseDraftArgs } from './issue-draft-check.mjs';

const config = JSON.parse(await readFile(new URL('./metadata-migration.config.json', import.meta.url), 'utf8'));
const FE = 'ChipIn-one/chipin-frontend';
const TITLE = 'Settle-up shows the payment details of the receiver';
const VALID = [
  '## Problem', '', 'The settle-up screen hides the receiver IBAN, so payers ask in chat.', '',
  '## Outcome', '', 'The payer sees the receiver payment details on the settle-up screen.', '',
  '## Acceptance', '', '- [ ] Settle-up shows the IBAN of the receiver when one is saved.', '- [ ] No details: the section is hidden.', '',
  '## Dependencies', '', 'Part of: ChipIn-one/chipin-frontend#855', '',
].join('\n');
const draft = (overrides = {}) => checkDraft({ config, repository: FE, title: TITLE, body: VALID, issueType: 'Task', priority: 'P2', ...overrides });
const without = section => VALID.replace(new RegExp('## ' + section + '\\n\\n[^#]*'), '');

test('a valid Task draft is DRAFT_OK and points to the preflight', () => {
  const result = draft();
  assert.equal(result.status, 'DRAFT_OK');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.classification, { issueType: 'Task', priority: 'P2', severity: null });
  assert.match(result.next, /issue-admission-preflight\.mjs --issue ChipIn-one\/chipin-frontend#<n>/);
});

for (const section of ['Problem', 'Outcome', 'Acceptance']) {
  test('missing ## ' + section + ' is a blocker', () => {
    const result = draft({ body: without(section) });
    assert.equal(result.status, 'DRAFT_BLOCKED');
    assert.ok(result.blockers.includes('Issue body needs substantive ## ' + section.toLowerCase() + '.'), result.blockers.join('; '));
  });
}

test('a placeholder section is a blocker', () => {
  const body = VALID.replace('The payer sees the receiver payment details on the settle-up screen.', 'TBD');
  assert.ok(draft({ body }).blockers.includes('Issue body needs substantive ## outcome.'));
});

test('Acceptance without list items is a blocker', () => {
  const body = VALID.replace('- [ ] Settle-up shows the IBAN of the receiver when one is saved.\n- [ ] No details: the section is hidden.',
    'Settle-up shows the IBAN of the receiver when one is saved, otherwise nothing.');
  assert.ok(draft({ body }).blockers.includes('Acceptance must contain verifiable checklist/list items.'));
});

test('a bug-report body (Actual/Expected) reports every missing section at once', () => {
  const body = '## Actual\n\nThe total is wrong after an edit of a shared expense.\n\n## Expected\n\nThe total equals the sum of the shares.\n';
  const result = draft({ body });
  for (const key of ['problem', 'outcome', 'acceptance']) assert.ok(result.blockers.includes('Issue body needs substantive ## ' + key + '.'));
});

test('a Bug without Severity is rejected; with Severity it passes', () => {
  assert.ok(draft({ issueType: 'Bug' }).blockers.includes('Severity is required for Bug issues.'));
  assert.ok(draft({ issueType: 'Bug', severity: 'none' }).blockers.includes('Severity is required for Bug issues.'));
  assert.equal(draft({ issueType: 'Bug', severity: 'Major' }).status, 'DRAFT_OK');
});

test('unsupported Type, Priority and Severity are blockers', () => {
  const result = draft({ issueType: 'Epic', priority: 'High', severity: 'Blocker' });
  assert.ok(result.blockers.includes('Unsupported Issue Type: Epic.'));
  assert.ok(result.blockers.includes('Unsupported Priority: High.'));
  assert.ok(result.blockers.includes('Unsupported Severity: Blocker.'));
});

test('owner policy comes from the registry: BE conflict and KB without --owner are blockers', () => {
  assert.ok(draft({ repository: 'ChipIn-one/chipin-backend', owner: 'syllik' }).blockers.some(b => /requires olegbal/.test(b)));
  assert.equal(draft({ repository: 'ChipIn-one/chipin-backend' }).status, 'DRAFT_OK');
  assert.ok(draft({ repository: 'ChipIn-one/chipin-knowledge-base' }).blockers.some(b => /explicitly selected --owner/.test(b)));
  assert.equal(draft({ repository: 'ChipIn-one/chipin-knowledge-base', owner: 'syllik' }).status, 'DRAFT_OK');
});

test('a repository outside intake scope is a blocker', () => {
  assert.ok(draft({ repository: 'ChipIn-one/chipin-notifications' }).blockers.some(b => /outside ChipIn intake scope/.test(b)));
  assert.ok(draft({ repository: 'ChipIn-one/Chipin-Frontend' }).blockers.some(b => /outside ChipIn intake scope/.test(b)));
});

test('argument parsing requires the core flags and rejects unknown or repeated ones', () => {
  assert.throws(() => parseDraftArgs(['--repository', FE, '--title', TITLE]), /Usage/);
  assert.throws(() => parseDraftArgs(['--repository', FE, '--title', TITLE, '--body-file', 'b.md', '--type', 'Task', '--priority', 'P2', '--token', 'x']), /Usage/);
  assert.throws(() => parseDraftArgs(['--repository', FE, '--repository', FE]), /Usage/);
  assert.throws(() => parseDraftArgs(['--repository', '--title']), /Usage/);
});

test('CLI makes no GitHub call, prints each blocker and exits 2 on a blocked draft', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network is not allowed in the draft check'); };
  const files = { '/draft/ok.md': VALID, '/draft/bad.md': '## Problem\n\nShort.\n' };
  const readFile = async path => path.endsWith('.json') ? JSON.stringify(config) : files[path];
  const out = []; const err = [];
  const io = { readFile, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) } };
  const previous = process.exitCode;
  try {
    const ok = await main(['--repository', FE, '--title', TITLE, '--body-file', '/draft/ok.md', '--type', 'Task', '--priority', 'P2'], io);
    assert.equal(ok.status, 'DRAFT_OK');
    assert.equal(err.length, 0);
    assert.notEqual(process.exitCode, 2);
    const bad = await main(['--repository', FE, '--title', TITLE, '--body-file', '/draft/bad.md', '--type', 'Bug', '--priority', 'P1'], io);
    assert.equal(bad.status, 'DRAFT_BLOCKED');
    assert.equal(process.exitCode, 2);
    assert.equal(err.length, bad.blockers.length);
    assert.ok(err.every(line => line.startsWith('DRAFT BLOCKER: ')));
    assert.equal(JSON.parse(out.at(-1)).contractVersion, 'chipin-issue-draft-check/v1');
  } finally {
    globalThis.fetch = realFetch;
    process.exitCode = previous;
  }
});
