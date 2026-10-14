import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runPreflight, parsePreflightArgs } from './issue-admission-preflight.mjs';
import { GitHubClient } from './github-metadata.mjs';
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
test('trusted workflow forwards the KB owner from dispatch payload to canonical preflight', async () => {
  const workflow = await readFile(new URL('../.github/workflows/issue-admission-preflight.yml', import.meta.url), 'utf8');
  assert.match(workflow, /OWNER: \$\{\{ github\.event\.client_payload\.owner \}\}/);
  assert.match(workflow, /args\+=\(--owner "\$OWNER"\)/);
  assert.match(workflow, /github\.triggering_actor == vars\.CHIPIN_TRUSTED_PREFLIGHT_ACTOR/);
});
test('KB requires a validated selected owner; explicit FE/BE owner policy remains canonical', () => {
  assert.throws(() => parsePreflightArgs(['--issue', 'ChipIn-one/chipin-knowledge-base#35']), {code:'INVALID_REQUEST'});
  for (const owner of ['bad name', 'bad/owner', '--bad', 'a'.repeat(39)]) {
    assert.throws(() => parsePreflightArgs(['--issue', 'ChipIn-one/chipin-knowledge-base#35', '--owner', owner]), {code:'INVALID_REQUEST'});
  }
  assert.equal(parsePreflightArgs(['--issue', 'ChipIn-one/chipin-knowledge-base#35', '--owner', 'syllik']).owner, 'syllik');
});
test('producer requires a trusted rerun actor independently of the original actor', async () => {
  const env = {GITHUB_ACTIONS:'true', GITHUB_EVENT_NAME:'repository_dispatch', GITHUB_REPOSITORY:'ChipIn-one/.github',
    GITHUB_REF:'refs/heads/master', GITHUB_SHA:'a'.repeat(40), GITHUB_TOKEN:'approved',
    GITHUB_RUN_ID:'1234', GITHUB_RUN_ATTEMPT:'2', GITHUB_ACTOR:'syllik',
    GITHUB_TRIGGERING_ACTOR:'untrusted', CHIPIN_TRUSTED_PREFLIGHT_ACTOR:'syllik'};
  await assert.rejects(runPreflight(['--issue', issue, '--producer', 'actions', '--request-id', 'some-long-request-key'], env,
    {loadConfig: async () => configBytes, makeTokenClient: () => ({})}), {code:'UNTRUSTED_PRODUCER_RUNTIME'});
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
test('real token-backed GitHubClient transient failure drives bounded canonical retry', async () => {
  let attempts = 0;
  const value = await runPreflight(['--issue', issue], {GITHUB_TOKEN:'approved'}, {
    loadConfig:async()=>configBytes,
    retryOptions:{pause:async()=>{}},
    makeTokenClient:token=>new GitHubClient(token, async () => {
      attempts++;
      if (attempts === 1) return {ok:false,status:503,text:async()=>'SENSITIVE_RESPONSE_BODY'};
      return {ok:true,status:200,json:async()=>({})};
    }),
    reader:async ({client}) => {
      try { await client.request('/repos/ChipIn-one/chipin-frontend/issues/153'); }
      catch (e) {
        assert.equal(e.code, 'TRANSPORT_ERROR');
        return {blockers:[`Native Issue unreadable: ${e.message}`,
          'Unreadable or mismatched native Issue identity.'],receipt:{...receipt,status:'BLOCKED'}};
      }
      return {blockers:[],receipt};
    },
  });
  assert.equal(value,receipt);
  assert.equal(attempts,2);
});
test('transport failure accompanied by derived metadata blockers retries and recovers', async () => {
  let count = 0;
  const value = await runPreflight(['--issue', issue], {}, {
    loadConfig: async () => configBytes, makeGhClient: () => ({}),
    retryOptions: {pause: async () => {}},
    reader: async () => {
      count++;
      return count === 1 ? {blockers: ['Project #5 unreadable: TRANSPORT_ERROR',
        'Project #5 membership count 0, expected one.', 'Project #5 Status missing or unsupported.'],
        receipt:{...receipt,status:'BLOCKED'}} : {blockers:[],receipt};
    },
  });
  assert.equal(count, 2);
  assert.equal(value, receipt);
});
test('permanent read failure alongside transient one is not retried', async () => {
  let count = 0;
  await assert.rejects(runPreflight(['--issue', issue], {}, {
    loadConfig: async () => configBytes, makeGhClient: () => ({}),
    retryOptions: {pause: async () => {}},
    reader: async () => {count++; return {blockers: ['Native Issue unreadable: PERMISSION_DENIED',
      'Project #5 unreadable: TRANSPORT_ERROR', 'Unreadable or mismatched native Issue identity.'],
      receipt:{...receipt,status:'BLOCKED'}};},
  }), {code:'ADMISSION_BLOCKED'});
  assert.equal(count, 1);
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
