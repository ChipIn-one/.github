import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightPr, taskIdentitiesForPr, selectedOwnerForPr } from './issue-admission-pr.mjs';
import { loadRegistry } from './registry.mjs';

const FE = 'ChipIn-one/chipin-frontend';
const BE = 'ChipIn-one/chipin-backend';
// The frontend dev/main record from before the canonical-master cutover (.github#216): the rollback target of
// chipin-frontend#497, the only record with a promotion branch, so the release-inventory path is tested on it.
const legacyFrontendRegistry = () => {
  const registry = loadRegistry();
  return { ...registry, repositories: registry.repositories.map(profile => (profile.repository === FE
    ? { ...profile, branches: { default: 'main', integration: 'dev', promotion: 'main' } } : profile)) };
};
function pr(repo = FE, base = 'master', head = 'feat/issue-71-test', body = 'Task identity: ' + repo + '#71') {
  return {
    number: 10, state: 'open', body,
    head: { sha: 'a'.repeat(40), ref: head, repo: { full_name: repo } },
    base: { ref: base, repo: { full_name: repo } },
  };
}
test('implementation needs one exact same-repository identity before PR handoff', () => {
  assert.deepEqual(taskIdentitiesForPr(FE, pr()).map(x => x.canonical), [FE + '#71']);
  assert.deepEqual(taskIdentitiesForPr(BE, pr(BE, 'develop')).map(x => x.canonical), [BE + '#71']);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feature', 'refs #71')), /Missing/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feature', 'Task identity: ' + BE + '#71')), /mismatched/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feature', 'Task identity: ' + FE + '#71\nTask identity: ' + FE + '#72')), /ambiguous/);
  const fork = pr(); fork.head.repo.full_name = 'other/fork';
  assert.throws(() => taskIdentitiesForPr(FE, fork), /Untrusted fork/);
});
test('.github implementation PRs are admitted against master; repositories outside admission scope are rejected', () => {
  const META = 'ChipIn-one/.github';
  // .github is inside admission scope, and since #179 (completion for .github needs the Development link)
  // its implementation-PR identity marker is accepted like FE/BE/KB.
  assert.deepEqual(taskIdentitiesForPr(META, pr(META, 'master', 'feat/issue-183', 'Task identity: ' + META + '#183')).map(x => x.issueNumber), [183]);
  assert.equal(selectedOwnerForPr(META, 'Task identity: ' + META + '#183'), null);
  assert.throws(() => taskIdentitiesForPr('ChipIn-one/chipin-notifications', pr('ChipIn-one/chipin-notifications', 'main')), /Unsupported PR admission repository/);
  assert.throws(() => taskIdentitiesForPr('ChipIn-one/slack-rofls', pr('ChipIn-one/slack-rofls', 'main')), /Unsupported PR admission repository/);
  // only a repository with a promotion branch has a release inventory path
  assert.throws(() => taskIdentitiesForPr(BE, pr(BE, 'main', 'develop', 'Included Issues: ' + BE + '#1')), /Unsupported PR branch transition/);
});
test('FE on canonical master (.github#216): feature -> master is the only route; dev and main are rejected', () => {
  assert.equal(loadRegistry().repositories.find(p => p.repository === FE).branches.promotion, null);
  assert.deepEqual(taskIdentitiesForPr(FE, pr(FE, 'master', 'feat/issue-71-test')).map(x => x.canonical), [FE + '#71']);
  for (const [base, head] of [['dev', 'feat/issue-71-test'], ['main', 'feat/issue-71-test'], ['main', 'dev'], ['master', 'master']]) {
    assert.throws(() => taskIdentitiesForPr(FE, pr(FE, base, head)),
      /Unsupported PR branch transition .*no admission bypass \(registry: implementation -> master\)/, base + ' <- ' + head);
  }
  // a release inventory needs a promotion branch: on master it is just an unsupported route, never a bypass
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Included Issues: ' + FE + '#71')), /Unsupported PR branch transition/);
});
test('FE release requires one unambiguous non-closing Issue inventory (dev/main rollback record)', () => {
  const registry = legacyFrontendRegistry();
  const body = 'Included Issues: ' + FE + '#71, ' + FE + '#72';
  assert.deepEqual(taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', body), registry).map(x => x.issueNumber), [71, 72]);
  assert.deepEqual(taskIdentitiesForPr(FE, pr(FE, 'dev', 'feat/issue-71-test'), registry).map(x => x.canonical), [FE + '#71']);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feat/issue-71-test'), registry),
    /registry: implementation -> dev, release dev -> main/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Release ready'), registry), /Included Issues/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Included Issues: ' + FE + '#71, ' + FE + '#71'), registry), /duplicate/);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'main', 'dev', 'Included Issues: ' + FE + '#71\nIncluded Issues: ' + FE + '#72'), registry), /one exact/);
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

test('PR body edits without a head commit cannot swap an admitted Issue', async () => {
  let calls = 0;
  const client = { request: async () => {
    calls++;
    return pr(FE, 'master', 'feat/issue-71-test',
      'Task identity: ' + FE + '#' + (calls === 1 ? 71 : 72));
  } };
  await assert.rejects(() => preflightPr({ client, config: {}, repository: FE, number: 10,
    expectedHeadSha: 'a'.repeat(40), read: async () => ({ blockers: [], receipt: {
      contractVersion: 'chipin-issue-admission/v1', status: 'INTAKE_COMPLETE',
      issue: FE + '#71', revision: 'rev', checkedAt: new Date().toISOString(), blockers: [],
    } }),
  }), /STALE: PR identity/);
  assert.equal(calls, 2);
});

test('final release boundary rechecks every admission receipt age', async () => {
  const owner = Date.now;
  const start = owner();
  let calls = 0;
  try {
    Date.now = () => calls > 1 ? start + 121_000 : start;
    const a = FE + '#71';
    const body = 'Included Issues: ' + a;
    const client = { request: async () => { calls++; return pr(FE, 'main', 'dev', body); } };
    // First receipt passes at start; final PR re-read advances time and must expire it.
    await assert.rejects(() => preflightPr({ client, config: {}, repository: FE, number: 10, registry: legacyFrontendRegistry(),
      expectedHeadSha: 'a'.repeat(40), read: async () => ({ blockers: [], receipt: {
        contractVersion: 'chipin-issue-admission/v1', status: 'INTAKE_COMPLETE',
        issue: a, revision: 'rev', checkedAt: new Date(start).toISOString(), blockers: [],
      } }),
    }), /STALE admission receipt/);
  } finally { Date.now = owner; }
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
