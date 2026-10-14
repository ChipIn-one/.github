import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdmissionEnvelope, verifyAdmissionEvidence } from './issue-admission-evidence.mjs';
const issue = 'ChipIn-one/chipin-frontend#153';
const revision = 'a'.repeat(64), sha = 'b'.repeat(40), reader = 'c'.repeat(40), config = 'd'.repeat(64);
const requestId = 'fixed-unique-request-1234';
const receipt = () => ({ contractVersion: 'chipin-issue-admission/v1', issue, revision,
  status: 'INTAKE_COMPLETE', blockers: [], checkedAt: new Date().toISOString(),
  project: { number: 5, membershipCount: 1, itemId: 'PVTI_1', status: 'Todo' } });
function setup() {
  const envelope = createAdmissionEnvelope({ receipt: receipt(), requestId, producer: 'trusted-bot[bot]', sourceSha: sha,
    readerBlobSha: reader, configSha256: config, runId: 12, runAttempt: 1 });
  return { envelope, expectedIssue: issue, expectedRevision: revision, expectedRequestId: requestId,
    expectedProducer: 'trusted-bot[bot]', expectedSourceSha: sha, expectedReaderBlobSha: reader,
    expectedConfigSha256: config, run: { id: 12, run_attempt: 1,
      repository: { full_name: 'ChipIn-one/.github' }, path: '.github/workflows/issue-admission-preflight.yml',
      event: 'repository_dispatch', head_branch: 'master', head_sha: sha,
      status: 'completed', conclusion: 'success', actor: { login: 'trusted-bot[bot]' } },
    artifact: { id: 789, workflow_run: { id: 12 }, name: `chipin-admission-12-1-${requestId}`,
      expired: false, digest: `sha256:${'e'.repeat(64)}` },
    archiveSha256: 'e'.repeat(64), recordConsumed: async () => true };
}
test('trusted Actions run and downloaded artifact digest admit canonical v1 revision', async () => {
  const result = await verifyAdmissionEvidence(setup());
  assert.equal(result.revision, revision);
  assert.equal(result.artifactId, 789);
});
test('wrong issue, digest tampering, invalid revision, wrong producer, and request mismatch block', async () => {
  for (const modify of [
    v => { v.expectedIssue = 'ChipIn-one/chipin-backend#178'; },
    v => { v.envelope.receipt.fields = { Priority: 'P0' }; },
    v => { delete v.envelope.receipt.revision; },
    v => { v.run.actor.login = 'attacker'; },
    v => { v.expectedRequestId = 'unmatched-req-123456'; },
  ]) {
    const v = setup(); modify(v); await assert.rejects(verifyAdmissionEvidence(v));
  }
});
test('run/ref/attempt and artifact mismatch block even with valid-looking payload', async () => {
  for (const modify of [
    v => { v.run.run_attempt = 2; },
    v => { v.run.head_sha = 'f'.repeat(40); },
    v => { v.run.conclusion = 'failure'; },
    v => { v.artifact.id = 0; },
    v => { v.archiveSha256 = '0'.repeat(64); },
    v => { v.expectedSourceSha = 'f'.repeat(40); },
  ]) { const v = setup(); modify(v); await assert.rejects(verifyAdmissionEvidence(v)); }
});
test('replay, future timestamp, expired timestamp and BLOCKED status reject', async () => {
  const replay = setup(); replay.recordConsumed = async () => false;
  await assert.rejects(verifyAdmissionEvidence(replay), { code: 'REPLAY' });
  for (const modify of [
    v => { v.envelope.receipt.checkedAt = new Date(Date.now() + 1000).toISOString(); },
    v => { v.envelope.receipt.checkedAt = new Date(Date.now() - 121000).toISOString(); },
    v => { v.envelope.receipt.status = 'BLOCKED'; },
  ]) { const v = setup(); modify(v); await assert.rejects(verifyAdmissionEvidence(v)); }
});
test('consumer requires durable replay registry', async () => {
  const v = setup(); delete v.recordConsumed;
  await assert.rejects(verifyAdmissionEvidence(v), { code: 'TRUST_CONTEXT_MISSING' });
});
test('first trusted issue-based preflight may bind its authenticated full revision only explicitly', async () => {
  const v = setup(); delete v.expectedRevision;
  await assert.rejects(verifyAdmissionEvidence(v), { code: 'TRUST_CONTEXT_MISSING' });
  v.allowInitialBinding = true;
  const result = await verifyAdmissionEvidence(v);
  assert.equal(result.revision, revision);
});
