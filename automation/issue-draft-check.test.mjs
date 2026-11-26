import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDraft, main, parseDraftArgs } from './issue-draft-check.mjs';

const config = JSON.parse(await readFile(new URL('./metadata-migration.config.json', import.meta.url), 'utf8'));
const FE = 'ChipIn-one/chipin-frontend';
const TITLE = 'Settle-up shows the payment details of the receiver';
const VALID = [
  '## Problem', '', 'The settle-up screen hides the receiver IBAN, so payers ask in chat.', '',
  '## Outcome', '', 'The payer sees the receiver payment details on the settle-up screen.', '',
  '## Acceptance', '', '- [ ] Settle-up shows the IBAN of the receiver when one is saved.', '- [ ] No details: the section is hidden.', '',
  '## Dependencies', '', 'Parent: ChipIn-one/chipin-frontend#855', '',
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

test('a malformed ## Dependencies declaration is a blocker', () => {
  const body = VALID.replace('Parent: ChipIn-one/chipin-frontend#855', 'Relates to: #855');
  assert.ok(draft({ body }).blockers.some(b => b.startsWith('Dependencies: ')), draft({ body }).blockers.join('; '));
});

const SCRIPT = fileURLToPath(new URL('./issue-draft-check.mjs', import.meta.url));
// Real child process, empty environment (no GITHUB_TOKEN, no gh), fetch replaced by a thrower,
// started from another working directory, so the default config path must resolve by module URL.
function cli(args, cwd) {
  return new Promise(done => execFile(process.execPath, ['--import', 'data:text/javascript,globalThis.fetch=()=>{throw new Error("network")}', SCRIPT, ...args],
    { cwd, env: {} }, (error, stdout, stderr) => done({ code: error ? error.code : 0, stdout, stderr })));
}

test('CLI offline: exit 0 / 2 / 1, blockers on stderr, unreadable body is a blocker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'draft-check-'));
  await writeFile(join(dir, 'ok.md'), VALID);
  await writeFile(join(dir, 'bad.md'), '## Problem\n\nShort.\n');
  const base = ['--repository', FE, '--title', TITLE, '--type', 'Task', '--priority', 'P2', '--body-file'];

  const ok = await cli([...base, 'ok.md'], dir);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status, 'DRAFT_OK');
  assert.equal(ok.stderr, '');

  const bad = await cli([...base, 'bad.md'], dir);
  assert.equal(bad.code, 2);
  const result = JSON.parse(bad.stdout);
  assert.equal(result.contractVersion, 'chipin-issue-draft-check/v1');
  assert.equal(bad.stderr.trim().split('\n').length, result.blockers.length);
  assert.ok(bad.stderr.trim().split('\n').every(line => line.startsWith('DRAFT BLOCKER: ')));

  const missing = await cli([...base, 'nope.md'], dir);
  assert.equal(missing.code, 2);
  assert.match(JSON.parse(missing.stdout).blockers[0], /^Issue body read failed/);

  const usage = await cli(['--repository', FE], dir);
  assert.equal(usage.code, 1);
  assert.equal(usage.stdout, '');
  assert.match(usage.stderr, /Usage/);
});
