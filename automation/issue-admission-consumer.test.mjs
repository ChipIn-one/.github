import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createAdmissionEnvelope } from './issue-admission-evidence.mjs';
import { consumeAdmissionArtifact, extractAdmissionEnvelope } from './issue-admission-consumer.mjs';
const sha256 = b => createHash('sha256').update(b).digest('hex');
function singleFileZip(text) {
  const name = Buffer.from('admission-envelope.json'), data = Buffer.from(text);
  const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50); l.writeUInt32LE(data.length,18);
  l.writeUInt32LE(data.length,22); l.writeUInt16LE(name.length,26);
  const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt32LE(data.length,20);
  c.writeUInt32LE(data.length,24); c.writeUInt16LE(name.length,28);
  const d = Buffer.alloc(22); d.writeUInt32LE(0x06054b50); d.writeUInt16LE(1,8); d.writeUInt16LE(1,10);
  d.writeUInt32LE(c.length+name.length,12); d.writeUInt32LE(l.length+name.length+data.length,16);
  return Buffer.concat([l,name,data,c,name,d]);
}
const issue = 'ChipIn-one/chipin-frontend#153', revision = 'a'.repeat(64), source = 'b'.repeat(40);
const reader = 'c'.repeat(40), configContent = Buffer.from('{}'), req = 'trusted-unique-request-1234';
function setup() {
  const receipt = { contractVersion: 'chipin-issue-admission/v1', status: 'INTAKE_COMPLETE', issue, revision,
    checkedAt: new Date().toISOString(), blockers: [],
    project: { number: 5, itemId: 'P_1', membershipCount: 1, status: 'Todo' } };
  const envelope = createAdmissionEnvelope({ receipt, requestId: req, producer: 'syllik', sourceSha: source,
    readerBlobSha: reader, configSha256: sha256(configContent), runId: 123, runAttempt: 1 });
  const zip = singleFileZip(JSON.stringify(envelope));
  const run = { id:123, run_attempt:1, repository:{full_name:'ChipIn-one/.github'},
    path:'.github/workflows/issue-admission-preflight.yml@master', event:'repository_dispatch',
    head_branch:'master', head_sha:source, status:'completed', conclusion:'success', actor:{login:'syllik'},
    triggering_actor:{login:'syllik'} };
  const artifact = { id:456, workflow_run:{id:123}, name:`chipin-admission-123-1-${req}`,
    expired:false, digest:`sha256:${sha256(zip)}` };
  let calls=[];
  return { zip, params: { api: { request: async path => { calls.push(path);
    if (path.endsWith('/actions/runs/123')) return run;
    if (path.endsWith('/actions/artifacts/456')) return artifact;
    if (path.endsWith('/branches/master')) return { commit: {sha: source} };
    if (path.includes('/contents/automation/issue-admission.mjs')) return { sha: reader };
    if (path.includes('/contents/automation/metadata-migration.config.json')) return { encoding:'base64', content:configContent.toString('base64') };
    throw Error('unexpected request'); } }, downloadZip: async id => { assert.equal(id,456); return zip; },
    recordConsumed: async () => true, runId:123, artifactId:456, expectedIssue:issue,
    expectedRevision:revision, expectedRequestId:req, expectedProducer:'syllik', expectedSourceSha:source },
    calls };
}
test('consumer authoritatively reads run/artifact/master/reader/config, verifies ZIP and receipt', async () => {
  const fixture=setup();
  assert.equal(extractAdmissionEnvelope(fixture.zip).revision, revision);
  const value = await consumeAdmissionArtifact(fixture.params);
  assert.equal(value.artifactId,456);
  assert.equal(fixture.calls.length,5);
  assert.ok(fixture.calls.every(p=>p.startsWith('/repos/ChipIn-one/.github/')));
});
test('consumer rejects untrusted rerun initiator despite trusted original actor', async () => {
  const fixture=setup();
  const original=fixture.params.api.request;
  fixture.params.api.request = async path => {
    const response=await original(path);
    if (path.endsWith('/actions/runs/123')) return {...response, triggering_actor:{login:'untrusted-executor'}};
    return response;
  };
  await assert.rejects(consumeAdmissionArtifact(fixture.params), {code:'UNTRUSTED_RUN'});
});
test('consumer fails closed on master drift or altered downloaded artifact', async () => {
  const fixture=setup(); fixture.params.expectedSourceSha='f'.repeat(40);
  await assert.rejects(consumeAdmissionArtifact(fixture.params), { code:'STALE_TRUSTED_SOURCE' });
  const tampered=setup(); tampered.params.downloadZip=async()=>Buffer.from('bad zip');
  await assert.rejects(consumeAdmissionArtifact(tampered.params), { code:'INVALID_ARTIFACT_ZIP' });
});
