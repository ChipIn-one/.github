// Trust-boundary verification. Caller must supply authoritative GitHub API read-back
// and the SHA-256 of the *downloaded artifact archive*, not a claimed digest.
import { createHash } from 'node:crypto';
import { ADMISSION_CONTRACT, ADMISSION_MAX_AGE_MS, parseAdmissionIssue } from './issue-admission.mjs';
import { PreflightError } from './issue-admission-transport.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const REQUEST = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/;
const ROOT = 'ChipIn-one/.github';
const WORKFLOW = '.github/workflows/issue-admission-preflight.yml';

export function digest(obj) { return createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function block(code, remedy) {
  throw new PreflightError(code, { principal: 'GitHub Actions authenticated run', transport: 'trusted-artifact',
    capability: 'signed-origin-equivalent authoritative evidence read-back', remedy });
}
export function assertCanonicalReceipt(receipt, { issue, revision, now = Date.now() }) {
  if (!parseAdmissionIssue(issue) || receipt?.contractVersion !== ADMISSION_CONTRACT || receipt?.issue !== issue ||
    receipt?.status !== 'INTAKE_COMPLETE' || !Array.isArray(receipt?.blockers) || receipt.blockers.length || !SHA256.test(receipt?.revision ?? '') ||
    !SHA256.test(revision ?? '') || receipt.revision !== revision) block('INVALID_RECEIPT', 'Obtain full canonical admission for exact issue/revision.');
  if (typeof receipt.checkedAt !== 'string' || !/Z$/.test(receipt.checkedAt)) block('INVALID_RECEIPT', 'Use canonical UTC checkedAt.');
  const checked = Date.parse(receipt.checkedAt);
  if (!Number.isFinite(checked) || checked > now || now - checked >= ADMISSION_MAX_AGE_MS) {
    block('STALE_RECEIPT', 'Request a new canonical read from the trusted producer; never retimestamp.');
  }
  if (receipt.project?.number !== 5 || receipt.project?.membershipCount !== 1 ||
    !receipt.project?.itemId || !['Todo', 'Backlog', 'In Progress'].includes(receipt.project?.status)) {
    block('INVALID_RECEIPT', 'Canonical Project #5 membership/Status is required.');
  }
  return true;
}

export function createAdmissionEnvelope({ receipt, requestId, producer, sourceSha, readerBlobSha, configSha256,
  runId, runAttempt, checkedAt = receipt?.checkedAt }) {
  if (!REQUEST.test(requestId) || !SHA40.test(sourceSha) || !SHA40.test(readerBlobSha) ||
    !SHA256.test(configSha256) || !Number.isSafeInteger(runId) || runId < 1 ||
    !Number.isSafeInteger(runAttempt) || runAttempt < 1 || !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(producer ?? '')) {
    block('INVALID_ENVELOPE', 'Trusted producer must supply immutable source/config and run identity.');
  }
  assertCanonicalReceipt(receipt, { issue: receipt.issue, revision: receipt.revision });
  if (checkedAt !== receipt.checkedAt) block('INVALID_ENVELOPE', 'Never adjust original read-back timestamp.');
  return { contractVersion: 'chipin-issue-admission-transport/v1', issue: receipt.issue,
    revision: receipt.revision, requestId, producer, trustedSource: { repository: ROOT, workflow: WORKFLOW,
      ref: 'refs/heads/master', sha: sourceSha, readerBlobSha, configSha256 },
    run: { id: runId, attempt: runAttempt },
    payloadDigest: digest(receipt), receipt };
}

// `run`, `artifact` and source hashes MUST come from GitHub API GET endpoints,
// fetched by the consumer's existing authorized connector/gh read route.
// `archiveSha256` MUST be computed from the artifact zip bytes received from GitHub.
// `recordConsumed` MUST atomically persist requestId+runAttempt in trusted storage.
export async function verifyAdmissionEvidence({ envelope, expectedIssue, expectedRevision, expectedRequestId,
  expectedProducer, expectedSourceSha, expectedReaderBlobSha, expectedConfigSha256,
  run, artifact, archiveSha256, recordConsumed, allowInitialBinding = false, now = Date.now() }) {
  // First admission can bind the authenticated producer's full revision. Every
  // subsequent controlled boundary MUST supply the previously pinned revision.
  const pinnedRevision = expectedRevision ?? (allowInitialBinding ? envelope?.revision : null);
  if (!REQUEST.test(expectedRequestId ?? '') || !SHA256.test(pinnedRevision ?? '') ||
    !SHA40.test(expectedSourceSha ?? '') || !SHA40.test(expectedReaderBlobSha ?? '') ||
    !SHA256.test(expectedConfigSha256 ?? '') || typeof expectedProducer !== 'string' || !expectedProducer ||
    typeof recordConsumed !== 'function') block('TRUST_CONTEXT_MISSING', 'Trusted consumer needs prebound request, source, principal and durable replay registry.');
  if (envelope?.contractVersion !== 'chipin-issue-admission-transport/v1' || envelope?.issue !== expectedIssue ||
    envelope?.revision !== pinnedRevision || envelope?.requestId !== expectedRequestId ||
    envelope?.producer !== expectedProducer || envelope?.payloadDigest !== digest(envelope.receipt)) {
    block('UNTRUSTED_EVIDENCE', 'Payload identity, revision, producer or digest does not match request.');
  }
  assertCanonicalReceipt(envelope.receipt, { issue: expectedIssue, revision: pinnedRevision, now });
  const s = envelope.trustedSource;
  if (s?.repository !== ROOT || s?.workflow !== WORKFLOW || s?.ref !== 'refs/heads/master' ||
    s?.sha !== expectedSourceSha || s?.readerBlobSha !== expectedReaderBlobSha ||
    s?.configSha256 !== expectedConfigSha256) block('UNTRUSTED_SOURCE', 'Read current trusted master and reader/config hashes authoritatively.');
  const runId = envelope.run?.id, attempt = envelope.run?.attempt;
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1 ||
    run?.id !== runId || run?.run_attempt !== attempt || run?.repository?.full_name !== ROOT ||
    ![WORKFLOW, `${WORKFLOW}@master`].includes(run?.path) || run?.event !== 'repository_dispatch' ||
    run?.head_branch !== 'master' || run?.head_sha !== expectedSourceSha ||
    run?.status !== 'completed' || run?.conclusion !== 'success' ||
    run?.actor?.login !== expectedProducer || run?.triggering_actor?.login !== expectedProducer) {
    block('UNTRUSTED_RUN', 'GitHub API must confirm successful expected workflow, initiating and triggering actors, ref, SHA, run and attempt.');
  }
  const expectedName = `chipin-admission-${runId}-${attempt}-${expectedRequestId}`;
  if (!Number.isSafeInteger(artifact?.id) || artifact.id < 1 || artifact?.workflow_run?.id !== runId ||
    artifact?.name !== expectedName || artifact?.expired !== false ||
    !/^sha256:[a-f0-9]{64}$/.test(artifact?.digest ?? '') ||
    artifact.digest !== `sha256:${archiveSha256}`) {
    block('UNTRUSTED_ARTIFACT', 'Fetch artifact metadata/ZIP from GitHub and verify exact identity and ZIP SHA-256.');
  }
  // This operation MUST be durable and atomic; duplicate keys are rejected.
  const consumed = await recordConsumed(`${ROOT}/${runId}/${attempt}/${expectedRequestId}`);
  if (consumed !== true) block('REPLAY', 'Use a fresh trusted request and a new canonical read-back.');
  return { receipt: envelope.receipt, revision: envelope.revision, sourceSha: expectedSourceSha,
    requestId: expectedRequestId, runId, attempt, artifactId: artifact.id };
}
