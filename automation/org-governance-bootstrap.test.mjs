import assert from 'node:assert/strict';
import test from 'node:test';
import { bootstrapAllowsPath, verifyGovernanceBootstrap } from './org-governance-bootstrap.mjs';

const body = '## Problem\nAgent task admission is bypassable and needs strong governance.\n\n## Outcome\nA bounded canonical intake and read-back contract is introduced.\n\n## Acceptance\n- [ ] Live guards refuse missing Issue admission.';
const SHA = 'a'.repeat(40);
const ISSUE = { number: 53, user: { login: 'syllik' }, assignees: [{ login: 'syllik' }], title: 'Canonical issue intake governance contract', body };
const PR = { number: 57, state: 'open', user: { login: 'syllik' },
  base: { ref: 'master', repo: { full_name: 'ChipIn-one/.github' } },
  head: { ref: 'feat/53-canonical-admission', repo: { full_name: 'ChipIn-one/.github' }, sha: SHA } };
const FILES = [{ filename: 'automation/issue-intake.mjs', status: 'modified' },
  { filename: 'automation/issue-admission-pr.test.mjs', status: 'added' }];
const check = (issue = ISSUE, pr = PR, files = FILES, expectedHead = SHA) =>
  verifyGovernanceBootstrap({ issue, pr, files, expectedHead });

test('only exact human-owned org governance #53 PR #57 at current head is a bounded bootstrap', () => {
  assert.equal(check().status, 'GOVERNANCE_BOOTSTRAP_ONLY');
  assert.notEqual(check().status, 'INTAKE_COMPLETE');
  assert.equal(check().targetIssue, 'ChipIn-one/.github#53');
  assert.equal(check().headSha, SHA);
});
test('other org issue, writer, branch, actor, stale SHA are denied', () => {
  for (const [issue, pr, sha] of [
    [{ ...ISSUE, number: 54 }, PR, SHA],
    [{ ...ISSUE, assignees: [] }, PR, SHA],
    [ISSUE, { ...PR, number: 58 }, SHA],
    [ISSUE, { ...PR, head: { ...PR.head, ref: 'feat/something-else' } }, SHA],
    [ISSUE, { ...PR, user: { login: 'other' } }, SHA],
    [ISSUE, PR, 'b'.repeat(40)],
  ]) assert.equal(check(issue, pr, FILES, sha).status, 'BLOCKED');
});
test('bootstrap allowlist rejects arbitrary FE work and destructive infra changes', () => {
  assert.equal(bootstrapAllowsPath('automation/issue-admission.test.mjs'), true);
  assert.equal(bootstrapAllowsPath('automation/create-milestone.mjs'), false);
  assert.equal(bootstrapAllowsPath('src/routes/payments.ts'), false);
  assert.equal(check(ISSUE, PR, [{ filename: 'automation/create-milestone.mjs', status: 'modified' }]).status, 'BLOCKED');
  assert.equal(check(ISSUE, PR, [{ filename: 'automation/issue-intake.mjs', status: 'removed' }]).status, 'BLOCKED');
  assert.equal(check(ISSUE, PR, [{ filename: 'automation/issue-intake.mjs', status: 'renamed', previous_filename: 'unsafe.js' }]).status, 'BLOCKED');
});
