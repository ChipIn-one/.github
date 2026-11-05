import assert from 'node:assert/strict';
import test from 'node:test';
import { preflightPr, taskIdentitiesForPr, selectedOwnerForPr, isCrossRepositoryTaskRepository } from './issue-admission-pr.mjs';
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
  // a BE marker in an FE PR is a cross-repository identity since .github#247 (tested below), no longer a mismatch
  assert.deepEqual(taskIdentitiesForPr(FE, pr(FE, 'master', 'feature', 'Task identity: ' + BE + '#71')).map(x => x.canonical), [BE + '#71']);
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

// Cross-repository Task identity (.github#247).
const KB = 'ChipIn-one/chipin-knowledge-base';
const META = 'ChipIn-one/.github';
const receiptFor = issue => ({ blockers: [], receipt: {
  contractVersion: 'chipin-issue-admission/v1', status: 'INTAKE_COMPLETE',
  issue, revision: 'rev', checkedAt: new Date().toISOString(), blockers: [],
} });

test('same-repository identity keeps its decisions and messages byte-identical', () => {
  assert.deepEqual(taskIdentitiesForPr(FE, pr()), [{ canonical: FE + '#71', repository: FE, issueNumber: 71 }]);
  assert.deepEqual(taskIdentitiesForPr(BE, pr(BE, 'develop')), [{ canonical: BE + '#71', repository: BE, issueNumber: 71 }]);
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feature', 'refs #71')),
    { message: 'Missing or mismatched single Task identity in implementation PR.' });
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feature', 'Task identity: ' + FE + '#0')),
    { message: 'Task identity must be exactly ChipIn-one/<supported-repository>#<issue-number>.' });
  assert.throws(() => selectedOwnerForPr(KB, 'Task identity: ' + KB + '#5'), { message: 'KB PR requires one explicit Task owner: @login line.' });
  assert.equal(selectedOwnerForPr(FE, 'Task identity: ' + FE + '#71'), null);
});

test('an allow-listed cross-repository identity is accepted and read from its own repository', async () => {
  for (const [repo, base, target] of [[FE, 'master', META], [BE, 'develop', FE], [META, 'master', BE], [KB, 'master', META]]) {
    const body = 'Task identity: ' + target + '#9' + (repo === KB ? '\nTask owner: @writer-user' : '');
    assert.deepEqual(taskIdentitiesForPr(repo, pr(repo, base, 'feat/x', body)), [{ canonical: target + '#9', repository: target, issueNumber: 9 }]);
  }
  const reads = [];
  const output = await preflightPr({
    client: { request: async () => pr(FE, 'master', 'feat/x', 'Task identity: ' + META + '#247') }, config: {},
    repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40),
    read: async input => { reads.push(input); return receiptFor(META + '#247'); },
  });
  assert.deepEqual(reads.map(r => [r.repository, r.number, r.selectedOwner]), [[META, 247, null]]);
  assert.equal(output.receipts[0].issue, META + '#247');
});

test('owner policy of a cross-repository identity is the Issue repository rule', async () => {
  // KB Issue (registry owner null) from an FE PR needs the explicit Task owner line; an FE Issue from a KB PR does not.
  const reads = [];
  const read = async input => { reads.push(input); return receiptFor(input.repository + '#' + input.number); };
  await preflightPr({ client: { request: async () => pr(FE, 'master', 'feat/x', 'Task identity: ' + KB + '#5\nTask owner: @writer-user') },
    config: {}, repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40), read });
  await preflightPr({ client: { request: async () => pr(KB, 'master', 'feat/x', 'Task identity: ' + FE + '#5') },
    config: {}, repository: KB, number: 10, expectedHeadSha: 'a'.repeat(40), read });
  assert.deepEqual(reads.map(r => [r.repository, r.selectedOwner]), [[KB, 'writer-user'], [FE, null]]);
  await assert.rejects(() => preflightPr({ client: { request: async () => pr(FE, 'master', 'feat/x', 'Task identity: ' + KB + '#5') },
    config: {}, repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40), read }), /Task owner/);
  assert.equal(reads.length, 2);
});

test('a non-allow-listed, other-owner or malformed cross-repository identity is rejected before any Issue read', async () => {
  const offRegistry = (() => {
    const registry = loadRegistry();
    return { ...registry, repositories: registry.repositories.map(profile => (profile.repository === BE
      ? { ...profile, capabilities: { ...profile.capabilities, admission: 'off' } } : profile)) };
  })();
  assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feat/x', 'Task identity: ' + BE + '#7'), offRegistry),
    /Cross-repository Task identity ChipIn-one\/chipin-backend#7 is not allowed/);
  for (const marker of ['ChipIn-one/chipin-notifications#7', 'ChipIn-one/slack-rofls#7', 'other-org/chipin-frontend#7',
    'chipin-one/chipin-backend#7', 'ChipIn-one/chipin-backend', 'ChipIn-one/chipin-backend#07', 'ChipIn-one/../chipin-backend#7',
    'https://github.com/ChipIn-one/chipin-backend/issues/7']) {
    assert.throws(() => taskIdentitiesForPr(FE, pr(FE, 'master', 'feat/x', 'Task identity: ' + marker)), /Task identity/, marker);
  }
  assert.equal(isCrossRepositoryTaskRepository(BE), true);
  assert.equal(isCrossRepositoryTaskRepository(META), true);
  for (const repo of ['ChipIn-one/chipin-notifications', 'ChipIn-one/slack-rofls', 'other-org/chipin-backend', 'chipin-one/chipin-backend', '', null]) {
    assert.equal(isCrossRepositoryTaskRepository(repo), false, String(repo));
  }
  let reads = 0;
  await assert.rejects(() => preflightPr({ client: { request: async () => pr(FE, 'master', 'feat/x', 'Task identity: other-org/x#7') },
    config: {}, repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40), read: async () => { reads++; return receiptFor('x'); } }), /Task identity/);
  assert.equal(reads, 0);
});

test('an unreadable or blocked cross-repository Issue fails closed', async () => {
  const client = { request: async () => pr(FE, 'master', 'feat/x', 'Task identity: ' + BE + '#7') };
  const input = { client, config: {}, repository: FE, number: 10, expectedHeadSha: 'a'.repeat(40) };
  await assert.rejects(() => preflightPr({ ...input, read: async () => { throw new Error('GET /repos/' + BE + '/issues/7 -> 404'); } }), /404/);
  await assert.rejects(() => preflightPr({ ...input,
    read: async () => ({ blockers: ['Unreadable or mismatched native Issue identity.'], receipt: { status: 'BLOCKED' } }) }),
  /ChipIn-one\/chipin-backend#7 BLOCKED: Unreadable or mismatched native Issue identity/);
  // a receipt for another Issue than the marker never admits the PR
  await assert.rejects(() => preflightPr({ ...input, read: async () => receiptFor(FE + '#7') }), /Admission identity\/revision mismatch/);
});
