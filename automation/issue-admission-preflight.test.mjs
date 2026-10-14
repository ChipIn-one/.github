import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight, parsePreflightArgs } from './issue-admission-preflight.mjs';
const issue = 'ChipIn-one/chipin-frontend#153';
const revision = 'b'.repeat(64);
const receipt = { contractVersion: 'chipin-issue-admission/v1', status: 'INTAKE_COMPLETE',
  issue, revision, checkedAt: new Date().toISOString(), blockers: [],
  project: { number: 5, itemId: 'ITEM', membershipCount: 1, status: 'Todo' } };
const configBytes = Buffer.from(JSON.stringify({ organization: 'ChipIn-one', project: { number: 5 } }));
test('missing shell token routes readAdmission through existing gh client', async () => {
  let used;
  const result = await runPreflight(['--issue', issue], {}, {
    loadConfig: async () => configBytes, makeGhClient: () => ({ existingGh: true }),
    reader: async params => { used = params; return { blockers: [], receipt }; },
  });
  assert.equal(result, receipt);
  assert.deepEqual(used.client, { existingGh: true });
  assert.equal(used.repository, 'ChipIn-one/chipin-frontend');
  assert.equal(used.number, 153);
});
test('producer mode requires trusted GitHub Actions context, no fallback', async () => {
  await assert.rejects(runPreflight(['--issue', issue, '--producer', 'actions', '--request-id', 'some-long-request-key'],
    { GITHUB_ACTIONS: 'true' }, { loadConfig: async () => configBytes }), { code: 'AUTH_UNAVAILABLE' });
});
test('KB owner explicit passed to canonical reader', async () => {
  let selectedOwner;
  await runPreflight(['--issue', 'ChipIn-one/chipin-knowledge-base#35', '--owner', 'syllik'], {}, {
    loadConfig: async () => configBytes, makeGhClient: () => ({}),
    reader: async p => { selectedOwner = p.selectedOwner; return { blockers: [], receipt }; },
  });
  assert.equal(selectedOwner, 'syllik');
});
test('exact Issue identity and stale expectedRevision parse fail closed', () => {
  assert.throws(() => parsePreflightArgs(['--issue', 'ChipIn-one/.github#119']), { code: 'INVALID_REQUEST' });
  assert.throws(() => parsePreflightArgs(['--issue', issue, '--expected-revision', 'sha-not-hash']), { code: 'INVALID_REQUEST' });
});
test('genuine invalid metadata is blocked without mutation or retry', async () => {
  let count = 0;
  await assert.rejects(runPreflight(['--issue', issue], {}, {
    loadConfig: async () => configBytes, makeGhClient: () => ({}),
    reader: async () => { count++; return { blockers: ['Required native assignee is missing'],
      receipt: { ...receipt, status: 'BLOCKED' } }; },
  }), { code: 'ADMISSION_BLOCKED' });
  assert.equal(count, 1);
});
