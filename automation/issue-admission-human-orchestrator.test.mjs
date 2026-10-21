import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {buildRequest, validateInputs, validateProvenance, verifyHumanRequest,
  assertFirstProducerRun, assertFreshOriginalRequest} from './issue-admission-human-orchestrator.mjs';

const sha='a'.repeat(40), digest='b'.repeat(64), now=Date.parse('2026-10-17T10:00:00Z');
const id='12345678-1234-4234-8234-123456789abc';
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'ChipIn-one/.github',
  GITHUB_EVENT_NAME:'workflow_dispatch',GITHUB_REF:'refs/heads/master',
  GITHUB_SHA:sha,GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'1',
  GITHUB_ACTOR:'syllik',GITHUB_TRIGGERING_ACTOR:'syllik'};
const issue='ChipIn-one/chipin-backend#178';

function fixture() {
  const request=buildRequest(env,{issue},now,id);
  const {orchestrator_sha,orchestrator_actor,created_at,...fields}=request;
  return {payload:{...fields,orchestrator_artifact_id:456},request,
    run:{id:123,run_attempt:1,repository:{full_name:'ChipIn-one/.github'},
      event:'workflow_dispatch',path:'.github/workflows/issue-admission-human-orchestrator.yml@master',
      head_branch:'master',head_sha:sha,actor:{login:'syllik'},triggering_actor:{login:'syllik'},
      status:'in_progress',conclusion:null},
    artifact:{id:456,workflow_run:{id:123},expired:false,
      name:'chipin-admission-request-123-1-'+id,digest:'sha256:'+digest,size_in_bytes:450},
    zipDigest:digest,producerSha:sha,now:now+15000};
}
test('manual request requires exact owner, Issue, SHA and trusted human',()=>{
  assert.equal(buildRequest(env,{issue},now,id).orchestrator_actor,'syllik');
  assert.equal(validateInputs({issue:'ChipIn-one/chipin-knowledge-base#35',owner:'syllik'}).owner,'syllik');
  assert.equal(validateInputs({issue:'ChipIn-one/.github#119'}).issue,'ChipIn-one/.github#119');
  for(const data of [{issue:'ChipIn-one/chipin-notifications#1'}, {issue:'ChipIn-one/slack-rofls#1'},
    {issue:'ChipIn-one/.github#119',owner:'somebody'}, {issue:'ChipIn-one/chipin-knowledge-base#35'},
    {issue,owner:'somebody'}, {issue,expected_revision:'short'}]) {
    assert.throws(()=>validateInputs(data),/UNTRUSTED_ORCHESTRATOR_REQUEST/);
  }
  assert.throws(()=>buildRequest({...env,GITHUB_ACTOR:'untrusted'}, {issue},now,id));
  assert.throws(()=>buildRequest({...env,GITHUB_REF:'refs/heads/feature'}, {issue},now,id));
});
test('authenticated run, artifact and request body admit only matching producer master',()=>{
  const v=fixture();
  assert.equal(validateProvenance(v).request_id,id);
  v.run.status='completed';v.run.conclusion='success';
  assert.equal(validateProvenance(v).issue,issue);
});
test('all spoofed or stale human artifact provenance is rejected',()=>{
  const changes=[
    v=>{v.run.actor.login='attacker';},
    v=>{v.run.triggering_actor.login='attacker';},
    v=>{v.run.path='.github/workflows/untrusted.yml@master';},
    v=>{v.run.head_sha='f'.repeat(40);},
    v=>{v.run.run_attempt=2;},
    v=>{v.run.event='push';},
    v=>{v.run.status='completed';v.run.conclusion='failure';},
    v=>{v.artifact.name='another';},
    v=>{v.artifact.digest='sha256:'+'f'.repeat(64);},
    v=>{v.artifact.workflow_run.id=12;},
    v=>{v.artifact.id=900;},
    v=>{v.payload.issue='ChipIn-one/chipin-frontend#153';},
    v=>{v.payload.request_id='00000000-0000-4000-8000-000000000000';},
    v=>{v.request.owner='unauthorized';},
    v=>{v.request.created_at='2026-01-01T00:00:00Z';},
    v=>{v.request.orchestrator_sha='f'.repeat(40);},
    v=>{v.payload.malicious='extra';},
    v=>{v.artifact.size_in_bytes=32769;},
  ];
  for(const change of changes){const v=fixture();change(v);assert.throws(()=>validateProvenance(v),/UNTRUSTED_ORCHESTRATOR_REQUEST/);}
});
test('original human request expires at 120 seconds, including after canonical read',()=>{
  const v=fixture();
  assert.equal(assertFreshOriginalRequest(v.request, now + 119999).issue, issue);
  assert.throws(()=>assertFreshOriginalRequest(v.request, now + 120000),/UNTRUSTED_ORCHESTRATOR_REQUEST/);
  assert.throws(()=>validateProvenance({...v,now:now + 120000}),/UNTRUSTED_ORCHESTRATOR_REQUEST/);
});

test('duplicate producer dispatch cannot reuse the original human request',async()=>{
  const v=fixture(), first={id:123,run_attempt:1,event:'repository_dispatch',
    repository:{full_name:'ChipIn-one/.github'},head_sha:sha,
    display_title:'chipin-admission-'+id};
  const second={...first,id:222};
  const botEnv={...env,GITHUB_EVENT_NAME:'repository_dispatch',
    GITHUB_ACTOR:'github-actions[bot]',GITHUB_TRIGGERING_ACTOR:'github-actions[bot]'};
  const api=async()=>({total_count:2,workflow_runs:[first,second]});
  await assert.rejects(assertFirstProducerRun(botEnv,v.request,api,v.now));
  await assert.rejects(assertFirstProducerRun({...botEnv,GITHUB_RUN_ID:'222'},v.request,api,v.now));
  await assert.rejects(assertFirstProducerRun({...botEnv,GITHUB_RUN_ATTEMPT:'2'},v.request,api,v.now));
  await assert.rejects(assertFirstProducerRun(botEnv,v.request,
    async()=>({total_count:101,workflow_runs:[]}),v.now));
});

test('bot verification accepts authenticated original request and rejects tampering',async()=>{
  const v=fixture();
  const botEnv={...env,GITHUB_EVENT_NAME:'repository_dispatch',GITHUB_ACTOR:'github-actions[bot]',
    GITHUB_TRIGGERING_ACTOR:'github-actions[bot]',CHIPIN_TRUSTED_PREFLIGHT_ACTOR:'github-actions[bot]',
    ACTIONS_READ_TOKEN:'test-read',GITHUB_EVENT_PATH:'/fake/path'};
  const checks=[];
  const zip=Buffer.from('zip');
  v.artifact.digest='sha256:'+createHash('sha256').update(zip).digest('hex');
  const read={
    loadEvent:async()=>JSON.stringify({action:'chipin-admission-preflight-v1',client_payload:v.payload}),
    api:async path=>{
      checks.push(path);
      if(path.includes('/workflows/issue-admission-preflight.yml/runs'))
        return {total_count:1,workflow_runs:[{id:123,run_attempt:1,head_sha:sha,
          repository:{full_name:'ChipIn-one/.github'},event:'repository_dispatch',
          display_title:'chipin-admission-'+id}]};
      return path.includes('/runs/')?v.run:v.artifact;
    },
    download:async()=>zip,unpack:async()=>v.request,now:v.now};
  assert.equal((await verifyHumanRequest(botEnv,read)).request_id,id);
  assert.equal(checks.length,3);
  assert.ok(checks[2].includes('event=repository_dispatch'));
  v.artifact.digest='sha256:'+'f'.repeat(64);
  await assert.rejects(verifyHumanRequest(botEnv,read));
  await assert.rejects(verifyHumanRequest({...botEnv,CHIPIN_TRUSTED_PREFLIGHT_ACTOR:'untrusted'},read));
});
test('workflow limits mutation to human job and gates shared actor by artifact proof',async()=>{
  const human=await readFile(new URL('../.github/workflows/issue-admission-human-orchestrator.yml',import.meta.url),'utf8');
  const producer=await readFile(new URL('../.github/workflows/issue-admission-preflight.yml',import.meta.url),'utf8');
  assert.match(human,/workflow_dispatch:/);
  assert.doesNotMatch(human,/pull_request:/);
  assert.match(human,/github.actor == 'syllik' && github.triggering_actor == 'syllik'/);
  assert.match(human,/contents: write/);
  assert.match(human,/persist-credentials: false/);
  assert.match(producer,/actions: read/);
  assert.match(producer,/run-name: chipin-admission-/);
  assert.match(producer,/concurrency:/);
  assert.match(producer,/cancel-in-progress: false/);
  assert.match(producer,/issue-admission-human-orchestrator\.mjs fresh/);
  assert.match(producer,/github.actor == 'github-actions\[bot\]'/);
  assert.match(producer,/issue-admission-human-orchestrator\.mjs verify/);
  assert.doesNotMatch(producer,/contents: write/);
});
