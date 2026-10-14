import test from 'node:test';
import assert from 'node:assert/strict';
import { GhReadClient, TokenReadClient, selectDirectTransport, safeAdmissionDiagnostics } from './issue-admission-transport.mjs';
import { GitHubClient } from './github-metadata.mjs';
const stub = (record, value = '{}') => async (_program, args) => { record.push(args); return { stdout: value }; };

test('token-backed HTTP 503/429 and network errors normalize as transient without leaking bodies', async () => {
  for (const status of [429, 500, 503]) {
    const raw = new GitHubClient('approved', async () => ({ok:false, status, text:async () => 'SENSITIVE_RESPONSE_BODY'}));
    const client = new TokenReadClient(raw);
    await assert.rejects(client.request('/repos/ChipIn-one/chipin-frontend/issues/153'), e => {
      assert.equal(e.code, 'TRANSPORT_ERROR');
      assert.ok(!JSON.stringify(e).includes('SENSITIVE_RESPONSE_BODY'));
      return true;
    });
    await assert.rejects(client.graphql('query MetadataProject($org: String!) { organization(login: $org) { id } }', {org:'ChipIn-one'}),
      {code:'TRANSPORT_ERROR'});
  }
  const raw = new GitHubClient('approved', async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(new TokenReadClient(raw).request('/repos/ChipIn-one/chipin-frontend/issues/153'), {code:'TRANSPORT_ERROR'});
});
test('token-backed auth failure and schema failure remain permanent; writes forbidden', async () => {
  for (const [status, code] of [[401,'PERMISSION_DENIED'],[403,'PERMISSION_DENIED'],[422,'SCHEMA_UNREADABLE']]) {
    const raw = new GitHubClient('approved', async () => ({ok:false,status,text:async()=>'SECRET'}));
    await assert.rejects(new TokenReadClient(raw).request('/repos/ChipIn-one/chipin-frontend/issues/153'), e => {
      assert.equal(e.code, code); assert.ok(!JSON.stringify(e).includes('SECRET')); return true;
    });
  }
  const never = new TokenReadClient({request:()=>{throw Error('should not invoke')} });
  await assert.rejects(never.request('/repos/x/y/issues/1', {method:'PATCH'}), {code:'READ_ONLY_VIOLATION'});
  await assert.rejects(never.graphql('mutation Foo { editIssue(input:{}) { id } }'), {code:'READ_ONLY_VIOLATION'});
});
test('missing GITHUB_TOKEN resolves pre-existing authenticated gh without credential extraction', async () => {
  const calls = [];
  const selected = selectDirectTransport({ token: '', makeGhClient: () => new GhReadClient({ run: stub(calls) }) });
  assert.equal(selected.transport, 'gh');
  assert.deepEqual(await selected.client.request('/repos/ChipIn-one/chipin-frontend/issues/153'), {});
  assert.equal(calls[0][0], 'api');
  assert.ok(!JSON.stringify(calls).includes('auth token'));
});
test('explicit approved credential wins deterministically', () => {
  let received;
  const selected = selectDirectTransport({ token: 'injected', makeTokenClient: token => { received = token; return {}; },
    makeGhClient: () => { throw Error('gh must not be touched'); } });
  assert.equal(selected.transport, 'token');
  assert.equal(received, 'injected');
  assert.ok(selected.client instanceof TokenReadClient);
  assert.equal(Object.hasOwn(selected.client, 'token'), false);
});
test('gh rejects privileged method and GraphQL mutation', async () => {
  const client = new GhReadClient({ run: () => { throw Error('must not run'); } });
  await assert.rejects(client.request('/repos/x/y/issues/1', { method: 'PATCH' }), { code: 'READ_ONLY_VIOLATION' });
  await assert.rejects(client.graphql('mutation M { editIssue(input:{}) { clientMutationId } }'), { code: 'READ_ONLY_VIOLATION' });
});
test('gh GraphQL reads are typed, null cursor omitted, and outputs parsed', async () => {
  const calls = [];
  const client = new GhReadClient({ run: stub(calls, '{"data":{"organization":{"projectV2":null}}}') });
  const result = await client.graphql('query MetadataProject($org: String!, $number: Int!, $itemsAfter: String) { organization(login: $org) { id } }',
    { org: 'ChipIn-one', number: 5, itemsAfter: null });
  assert.ok(result.organization);
  assert.ok(calls[0].includes('number=5'));
  assert.ok(!calls[0].some(arg => arg.startsWith('itemsAfter=')));
});
test('401/403 and raw response bodies remain redacted', async () => {
  const client = new GhReadClient({ run: async () => { const e = Error('x'); e.stderr = 'HTTP 403: SECRET RESPONSE BODY'; throw e; } });
  await assert.rejects(client.request('/orgs/ChipIn-one/issue-fields'), e => {
    assert.equal(e.code, 'PERMISSION_DENIED');
    assert.ok(!JSON.stringify(e).includes('SECRET'));
    return true;
  });
});
test('safe diagnostics never contain unsafe underlying REST or GraphQL bodies', () => {
  const d = safeAdmissionDiagnostics(['Project #5 unreadable: 403 API BODY SECRET'], 'gh-session', 'gh');
  assert.equal(d[0].code, 'PERMISSION_DENIED');
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});
test('pagination of native Issue relationships is complete', async () => {
  const calls = [];
  const client = new GhReadClient({ run: stub(calls, '[]') });
  assert.deepEqual(await client.listAll('/repos/ChipIn-one/chipin-frontend/issues/153/sub_issues'), []);
  assert.equal(calls.length, 1);
});

test('retry exhaustion is finite and genuine auth/policy failures never retry', async () => {
  const { retryTransient, PreflightError } = await import('./issue-admission-transport.mjs');
  let count = 0;
  await assert.rejects(retryTransient(() => { count++; throw new PreflightError('TRANSPORT_ERROR'); },
    { maxAttempts: 3, pause: async () => {}, now: () => 1 }), { code: 'RETRY_EXHAUSTED' });
  assert.equal(count, 3);
  count = 0;
  await assert.rejects(retryTransient(() => { count++; throw new PreflightError('PERMISSION_DENIED'); },
    { pause: async () => {} }), { code: 'PERMISSION_DENIED' });
  assert.equal(count, 1);
});
