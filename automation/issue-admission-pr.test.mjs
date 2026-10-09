import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightPr, taskIdentitiesForPr, selectedOwnerForPr } from './issue-admission-pr.mjs';

const FE = 'ChipIn-one/chipin-frontend';
const BE = 'ChipIn-one/chipin-backend';
function pr(repo = FE, base = 'dev', head = 'feat/issue-71-test', body = 'Task identity: ' + repo + '#71') {
  return {
    number: 10, state: 'open', body,
    head: { sha: 'a'.repeat(40), ref: head, repo: { full_name: repo } },
    base: { ref: base, repo: { full_name: repo } },
  };
}
test('implementation needs one exact same-repository identity before PR handoff', () => {
  assert.deepEqual(taskIdentitiesForPr(FE, pr()).map(x => x.canonical), [FE + '#71']);
  assert.deepEqual(taskIdentitiesForPr(BE, pr(BE, 'develop')).map(x => x.canonical), [BE + '#71']);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'dev', 'feature', 'refs #71')), /Missing/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'dev', 'feature', 'Task identity: ' + BE + '#71')), /mismatched/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'dev', 'feature', 'Task identity: ' + FE + '#71\nTask identity: ' + FE + '#72')), /ambiguous/);
  const fork = pr(); fork.head.repo.full_name = 'other/fork';
  assert.throws(() => taskIdentitiesForPr(FE, fork), /Untrusted fork/);
});
test('FE release requires one unambiguous non-closing Issue inventory', () => {
  const body = 'Included Issues: ' + FE + '#71, ' + FE + '#72';
  assert.deepEqual(taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', body)).map(x => x.issueNumber), [71, 72]);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Release ready')), /Included Issues/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Included Issues: ' + FE + '#71, ' + FE + '#71')), /duplicate/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Included Issues: ' + FE + '#71\nIncluded Issues: ' + FE + '#72')), /one exact/);
});
test('KB owner requires explicit single PR marker', () => {
  assert.equal(selectedOwnerForPr('ChipIn-one/chipin-knowledge-base', 'Task owner: @writer-user'), 'writer-user');
  assert.throws(() => selectedOwnerForPr('ChipIn-one/chipin-knowledge-base', 'Task identity: x'), /Task owner/);
  assert.throws(() => selectedOwnerForPr('ChipIn-one/chipin-knowledge-base', 'Task owner: @a\nTask owner: @b'), /Task owner/);
});
test('negative publication: queued-only and missing admission stop before handoff', async () => {
  const client = { request: async () => pr() };
  const config = {};
  await assert.rejects(() => preflightPr({ client, config, repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40),
    read: async () => ({ blockers: ['Native Priority missing'], receipt: { status: 'BLOCKED' } }),
  }), /Priority missing/);
  await assert.rejects(() => preflightPr({ client, config, repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40),
    read: async () => ({ blockers: [], receipt: { status: 'QUEUED' } }),
  }), /INTAKE_COMPLETE/);
});
test('PR head SHA and exact identities are included in a successful current readback', async () => {
  const output = await preflightPr({
    client: { request: async () => pr() }, config: {}, repository: FE, number: 10,
    expectedHeadSha: 'a'.repeat(40),
    read: async () => ({ blockers: [], receipt: {
      contractVersion: 'chipin-issue-admission/v1', status: 'INTAKE_COMPLETE',
      issue: FE + '#71', revision: 'rev', checkedAt: new Date().toISOString(), blockers: [],
    } }),
  });
  assert.equal(output.prHeadSha, 'a'.repeat(40));
  assert.equal(output.receipts.length, 1);
  assert.equal(output.status, 'INTAKE_COMPLETE');
});

test('current PR SHA is mandatory and a stale event blocks before metadata read', async () => {
  let reads = 0;
  const input = {
    client: { request: async () => pr() }, config: {}, repository: FE, number: 10,
    read: async () => { reads++; throw new Error('must not read Issue after SHA mismatch'); },
  };
  await assert.rejects(() => preflightPr({ ...input }), /expected current PR head SHA/);
  await assert.rejects(() => preflightPr({ ...input, expectedHeadSha: 'b'.repeat(40) }), /STALE.*PR head SHA/);
  assert.equal(reads, 0);
});
