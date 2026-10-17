// Exact trusted-human Actions artifact binding for bot-originated admission dispatch.
// This code never repairs Issue metadata, grants Executor privileges or exposes credentials.
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = 'ChipIn-one/.github', human = 'syllik', bot = 'github-actions[bot]';
const workflow = '.github/workflows/issue-admission-human-orchestrator.yml';
const apiRoot = 'https://api.github.com/repos/' + repo;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const positive = n => /^[1-9][0-9]*$/.test(String(n ?? '')) && Number.isSafeInteger(Number(n));
const issueRx = /^ChipIn-one\/(?:chipin-frontend|chipin-backend|chipin-knowledge-base)#[1-9][0-9]*$/;
const loginRx = /^[a-z0-9](?:[a-z0-9-]{0,37})$/i;
const uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const paths = new Set([workflow, workflow + '@master', workflow + '@refs/heads/master']);
const fail = () => { throw Error('UNTRUSTED_ORCHESTRATOR_REQUEST'); };

export function validateInputs({issue, owner = '', expected_revision = ''}) {
  if (typeof issue !== 'string' || !issueRx.test(issue) ||
      typeof owner !== 'string' || (owner && !loginRx.test(owner)) ||
      typeof expected_revision !== 'string' ||
      (expected_revision && !/^[0-9a-f]{64}$/.test(expected_revision)) ||
      (issue.includes('/chipin-knowledge-base#') ? !owner : !!owner)) fail();
  return {issue, owner, expected_revision};
}

function requireRuntime(env, event, actor) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== repo ||
      env.GITHUB_REF !== 'refs/heads/master' || !/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') ||
      env.GITHUB_EVENT_NAME !== event || env.GITHUB_ACTOR !== actor ||
      env.GITHUB_TRIGGERING_ACTOR !== actor || !positive(env.GITHUB_RUN_ID) ||
      !positive(env.GITHUB_RUN_ATTEMPT)) fail();
}

export function buildRequest(env, supplied, now = Date.now(), id = randomUUID()) {
  requireRuntime(env, 'workflow_dispatch', human);
  if (!uuidRx.test(id) || !Number.isFinite(now)) fail();
  return {...validateInputs(supplied), request_id:id,
    orchestrator_run_id:Number(env.GITHUB_RUN_ID),
    orchestrator_run_attempt:Number(env.GITHUB_RUN_ATTEMPT),
    orchestrator_sha:env.GITHUB_SHA, orchestrator_actor:human,
    created_at:new Date(now).toISOString()};
}

export function validateProvenance({payload, request, run, artifact, zipDigest, producerSha, now = Date.now()}) {
  if (!payload || !request || !run || !artifact || !/^[0-9a-f]{40}$/.test(producerSha ?? '')) fail();
  const common = ['issue', 'owner', 'expected_revision', 'request_id',
    'orchestrator_run_id', 'orchestrator_run_attempt'];
  if (Object.keys(payload).sort().join('|') !== [...common,'orchestrator_artifact_id'].sort().join('|') ||
      Object.keys(request).sort().join('|') !== [...common,'orchestrator_sha','orchestrator_actor','created_at'].sort().join('|') ||
      common.some(k => payload[k] !== request[k]) ||
      !positive(payload.orchestrator_artifact_id) || !uuidRx.test(request.request_id) ||
      !positive(request.orchestrator_run_id) || !positive(request.orchestrator_run_attempt)) fail();
  validateInputs(request);
  const age = now - Date.parse(request.created_at);
  if (!Number.isFinite(age) || age < 0 || age > 180000 ||
      request.orchestrator_sha !== producerSha || request.orchestrator_actor !== human ||
      run.id !== request.orchestrator_run_id || run.run_attempt !== request.orchestrator_run_attempt ||
      run.repository?.full_name !== repo || run.event !== 'workflow_dispatch' ||
      !paths.has(run.path) || run.head_branch !== 'master' || run.head_sha !== producerSha ||
      run.actor?.login !== human || run.triggering_actor?.login !== human ||
      !['in_progress','completed'].includes(run.status) ||
      (run.status === 'completed' && run.conclusion !== 'success') ||
      artifact.id !== payload.orchestrator_artifact_id ||
      artifact.workflow_run?.id !== run.id || artifact.expired !== false ||
      artifact.name !== 'chipin-admission-request-' + run.id + '-' + run.run_attempt + '-' + request.request_id ||
      artifact.digest !== 'sha256:' + zipDigest ||
      !Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 22 ||
      artifact.size_in_bytes > 32768) fail();
  return request;
}

async function github(path, token, body = null) {
  if (!token || !path.startsWith('/')) fail();
  const res = await fetch(apiRoot + path, {
    method:body ? 'POST':'GET', headers:{
      Authorization:'Bearer ' + token, Accept:'application/vnd.github+json',
      'X-GitHub-Api-Version':'2022-11-28',
      ...(body ? {'Content-Type':'application/json'} : {}) },
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000)});
  if (body) { if (res.status !== 204) fail(); return null; }
  if (!res.ok) fail();
  return res.json();
}

async function downloadZip(id, token) {
  const r = await fetch(apiRoot + '/actions/artifacts/' + id + '/zip', {
    redirect:'manual', headers:{Authorization:'Bearer ' + token,
      Accept:'application/vnd.github+json'}, signal:AbortSignal.timeout(15000)});
  const location = r.headers.get('location');
  if (r.status !== 302 || !location) fail();
  const url = new URL(location);
  if (url.protocol !== 'https:' || !(url.hostname.endsWith('.blob.core.windows.net') ||
      url.hostname.endsWith('.githubusercontent.com'))) fail();
  // Do not send the bearer token to GitHub's artifact blob storage.
  const zip = await fetch(location, {signal:AbortSignal.timeout(15000)});
  if (!zip.ok || Number(zip.headers.get('content-length') || 0) > 32768) fail();
  const bytes = Buffer.from(await zip.arrayBuffer());
  if (bytes.length < 22 || bytes.length > 32768) fail();
  return bytes;
}

async function unpackRequest(zip) {
  const dir = await mkdtemp(join(tmpdir(), 'chipin-human-proof-'));
  try {
    const file = join(dir, 'request.zip');
    await writeFile(file, zip, {mode:0o600});
    const names = execFileSync('unzip', ['-Z1',file], {
      encoding:'utf8', maxBuffer:4096, timeout:5000});
    if (names !== 'admission-request.json\n') fail();
    const body = execFileSync('unzip', ['-p',file,'admission-request.json'], {
      encoding:'utf8', maxBuffer:8192, timeout:5000});
    return JSON.parse(body);
  } finally { await rm(dir, {recursive:true, force:true}); }
}

export async function verifyHumanRequest(env, {
  loadEvent = readFile, api = github, download = downloadZip,
  unpack = unpackRequest, now = Date.now(),
} = {}) {
  requireRuntime(env, 'repository_dispatch', bot);
  if (env.CHIPIN_TRUSTED_PREFLIGHT_ACTOR !== bot || !env.ACTIONS_READ_TOKEN ||
      !env.GITHUB_EVENT_PATH) fail();
  const event = JSON.parse(await loadEvent(env.GITHUB_EVENT_PATH,'utf8'));
  if (event.action !== 'chipin-admission-preflight-v1') fail();
  const p = event.client_payload;
  if (!p || !positive(p.orchestrator_run_id) || !positive(p.orchestrator_run_attempt) ||
      !positive(p.orchestrator_artifact_id)) fail();
  const [run,artifact] = await Promise.all([
    api('/actions/runs/' + p.orchestrator_run_id,env.ACTIONS_READ_TOKEN),
    api('/actions/artifacts/' + p.orchestrator_artifact_id,env.ACTIONS_READ_TOKEN)]);
  if (artifact?.workflow_run?.id !== p.orchestrator_run_id ||
      !Number.isInteger(artifact.size_in_bytes) || artifact.size_in_bytes > 32768) fail();
  const zip = await download(p.orchestrator_artifact_id,env.ACTIONS_READ_TOKEN);
  const request = await unpack(zip);
  return validateProvenance({payload:p,request,run,artifact,zipDigest:hash(zip),
    producerSha:env.GITHUB_SHA,now});
}

async function main() {
  const env=process.env;
  switch (process.argv[2]) {
    case 'prepare': {
      const request=buildRequest(env,{issue:env.ISSUE,owner:env.OWNER ?? '',
        expected_revision:env.EXPECTED_REVISION ?? ''});
      if (!env.GITHUB_OUTPUT) fail();
      await writeFile('admission-request.json',JSON.stringify(request)+'\n',{mode:0o600});
      await appendFile(env.GITHUB_OUTPUT,'request_id='+request.request_id+'\n');
      break;
    }
    case 'dispatch': {
      requireRuntime(env,'workflow_dispatch',human);
      if (!env.GH_TOKEN || !positive(env.ARTIFACT_ID)) fail();
      const request=JSON.parse(await readFile('admission-request.json','utf8'));
      if (request.orchestrator_sha !== env.GITHUB_SHA ||
          request.orchestrator_run_id !== Number(env.GITHUB_RUN_ID) ||
          request.orchestrator_run_attempt !== Number(env.GITHUB_RUN_ATTEMPT)) fail();
      const {orchestrator_sha,orchestrator_actor,created_at,...fields}=request;
      await github('/dispatches',env.GH_TOKEN,{
        event_type:'chipin-admission-preflight-v1',
        client_payload:{...fields,orchestrator_artifact_id:Number(env.ARTIFACT_ID)}});
      process.stdout.write('Trusted human request dispatched: '+request.request_id+'\n');
      break;
    }
    case 'verify': {
      const request=await verifyHumanRequest(env);
      await writeFile('verified-admission-request.json',JSON.stringify(request)+'\n',{mode:0o600});
      break;
    }
    default: fail();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {process.stderr.write('UNTRUSTED_ORCHESTRATOR_REQUEST\n');process.exitCode=2;});
}
