// Authenticated producer artifact consumer. No dispatch, no issue writes.
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { verifyAdmissionEvidence } from './issue-admission-evidence.mjs';
import { PreflightError } from './issue-admission-transport.mjs';

const root = '/repos/ChipIn-one/.github';
function fail(code) { throw new PreflightError(code, { principal: 'authenticated-GitHub-read-back',
  transport: 'trusted-artifact', capability: 'Actions run/artifact/branch/contents',
  remedy: 'Require current trusted workflow, authenticated exact ZIP and complete provenance.' }); }
const hex = bytes => createHash('sha256').update(bytes).digest('hex');

export function extractAdmissionEnvelope(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer) || zipBuffer.length > 2 * 1024 * 1024 || zipBuffer.length < 22) fail('INVALID_ARTIFACT_ZIP');
  // Search EOCD only in the maximum permitted ZIP comment tail.
  let end = -1;
  for (let at = zipBuffer.length - 22; at >= Math.max(0, zipBuffer.length - 65557); at--) {
    if (zipBuffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0 || zipBuffer.readUInt16LE(end + 8) !== 1 || zipBuffer.readUInt16LE(end + 10) !== 1) fail('INVALID_ARTIFACT_ZIP');
  const offset = zipBuffer.readUInt32LE(end + 16);
  if (offset + 46 > end || zipBuffer.readUInt32LE(offset) !== 0x02014b50) fail('INVALID_ARTIFACT_ZIP');
  const flags = zipBuffer.readUInt16LE(offset + 8), method = zipBuffer.readUInt16LE(offset + 10);
  const length = zipBuffer.readUInt32LE(offset + 20), unpacked = zipBuffer.readUInt32LE(offset + 24);
  const nameLength = zipBuffer.readUInt16LE(offset + 28), extra = zipBuffer.readUInt16LE(offset + 30), comment = zipBuffer.readUInt16LE(offset + 32);
  if (flags & 1 || ![0, 8].includes(method) || unpacked > 65536 || offset + 46 + nameLength + extra + comment > end ||
      zipBuffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8') !== 'admission-envelope.json') fail('INVALID_ARTIFACT_ZIP');
  const local = zipBuffer.readUInt32LE(offset + 42);
  if (local + 30 > offset || zipBuffer.readUInt32LE(local) !== 0x04034b50) fail('INVALID_ARTIFACT_ZIP');
  const start = local + 30 + zipBuffer.readUInt16LE(local + 26) + zipBuffer.readUInt16LE(local + 28);
  if (start + length > offset) fail('INVALID_ARTIFACT_ZIP');
  const bytes = zipBuffer.subarray(start, start + length);
  let unzipped;
  try { unzipped = method === 8 ? inflateRawSync(bytes, { maxOutputLength: 65537 }) : bytes; }
  catch { fail('INVALID_ARTIFACT_ZIP'); }
  if (unzipped.length !== unpacked || unzipped.length > 65536) fail('INVALID_ARTIFACT_ZIP');
  try { return JSON.parse(unzipped.toString('utf8')); }
  catch { fail('INVALID_ARTIFACT_JSON'); }
}

// API client is the already-authorized gh/connector REST GET adapter.
// Download returns ZIP bytes from the SAME GitHub artifact ID read above.
// `recordConsumed` is a durable, atomic replay registry owned by trusted consumer.
export async function consumeAdmissionArtifact({ api, downloadZip, recordConsumed, runId, artifactId,
  expectedIssue, expectedRevision, expectedRequestId, expectedProducer, expectedSourceSha,
  allowInitialBinding = false, now = Date.now() }) {
  if (!api || typeof api.request !== 'function' || typeof downloadZip !== 'function' ||
      !Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(artifactId) || artifactId < 1) fail('TRUST_CONTEXT_MISSING');
  const [run, artifact, branch] = await Promise.all([
    api.request(`${root}/actions/runs/${runId}`), api.request(`${root}/actions/artifacts/${artifactId}`),
    api.request(`${root}/branches/master`),
  ]);
  if (branch?.commit?.sha !== expectedSourceSha) fail('STALE_TRUSTED_SOURCE');
  const [reader, configFile] = await Promise.all([
    api.request(`${root}/contents/automation/issue-admission.mjs?ref=${expectedSourceSha}`),
    api.request(`${root}/contents/automation/metadata-migration.config.json?ref=${expectedSourceSha}`),
  ]);
  if (!/^[a-f0-9]{40}$/.test(reader?.sha ?? '') || configFile?.encoding !== 'base64' ||
      typeof configFile?.content !== 'string') fail('SOURCE_UNREADABLE');
  const configBytes = Buffer.from(configFile.content.replace(/\s/g, ''), 'base64');
  const zip = await downloadZip(artifactId);
  const archiveSha256 = hex(zip);
  const envelope = extractAdmissionEnvelope(zip);
  if (envelope.run?.id !== runId) fail('UNTRUSTED_EVIDENCE');
  return verifyAdmissionEvidence({ envelope, expectedIssue, expectedRevision, expectedRequestId,
    expectedProducer, expectedSourceSha, expectedReaderBlobSha: reader.sha, allowInitialBinding,
    expectedConfigSha256: hex(configBytes), run, artifact, archiveSha256, recordConsumed, now });
}
