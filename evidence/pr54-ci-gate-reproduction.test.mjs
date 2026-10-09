// Audit reproduction of #54's former false-green reviewer gate.
// Before fix: frontend-ci=success on the head was sufficient even for dev -> main,
// despite the target branch requiring main-ci. This file remains a regression.
import assert from "node:assert/strict";
import test from "node:test";
import { requiredShaCIGreen } from "../automation/pr-metadata.mjs";

const REPO = "ChipIn-one/chipin-frontend";
const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const APP = {id:15368, slug:"github-actions"};
const pr = (branch="main") => ({
  number: 388, base: {ref:branch,sha:BASE}, head:{sha:SHA,ref:"dev"},
});
const check = (name, conclusion="success", overrides={}) => ({
  id:name==="main-ci"?201:200, name, head_sha:SHA, status:"completed",
  conclusion, app:APP,
  details_url:"https://github.com/ChipIn-one/chipin-frontend/actions/runs/" +
    (name==="main-ci"?301:300) + "/job/" + (name==="main-ci"?201:200),
  ...overrides,
});
function clientFor({target="main", main="success", frontend="success", branchPolicy=null,
                    alteredCheck=null, alteredRun=null}={}) {
  const checks=[check("frontend-ci",frontend),check("main-ci",main)];
  if (alteredCheck) checks[1] = alteredCheck(checks[1]);
  const required=target==="main"?"main-ci":"frontend-ci";
  const base={
    name:target,protected:true,protection:{required_status_checks:
      branchPolicy??{contexts:[required],checks:[{context:required,app_id:15368}]}},
  };
  const runs={
    300:{id:300,name:"Frontend CI",path:".github/workflows/frontend-ci.yml"},
    301:{id:301,name:"Main CI",path:".github/workflows/main-ci.yml"},
  };
  return {async request(path) {
    if (path.endsWith("/branches/"+target)) return base;
    if (path.endsWith("/commits/"+SHA+"/check-runs?per_page=100&filter=latest"))
      return {total_count:checks.length,check_runs:checks};
    const m=path.match(/\/actions\/runs\/(\d+)$/u);
    if (m) {
      const run=runs[Number(m[1])];
      if (!run) throw new Error("unexpected workflow run");
      const raw={...run,repository:{full_name:REPO},head_sha:SHA,head_branch:"dev",
        status:"completed",conclusion:"success",event:"pull_request",
        pull_requests:[{number:388,head:{ref:"dev",sha:SHA},
                        base:{ref:target,sha:BASE}}]};
      return alteredRun ? alteredRun(raw) : raw;
    }
    throw new Error("unexpected GET " + path);
  }};
}

test("AUDIT REPRO: release frontend-ci=success and required main-ci=failure MUST block",async()=>{
  const result=await requiredShaCIGreen(clientFor({main:"failure"}),pr());
  assert.equal(result.ok,false);
  assert.deepEqual(result.required,["main-ci"]);
  assert.match(result.blockers.join(" "),/main-ci/u);
});

test("AUDIT REPRO: release frontend-ci=success and required main-ci=pending MUST block",async()=>{
  const result=await requiredShaCIGreen(clientFor({
    alteredCheck: old=>({...old,status:"in_progress",conclusion:null}),
  }),pr());
  assert.equal(result.ok,false);
});

test("both required main-ci and current trusted workflow green can pass",async()=>{
  const result=await requiredShaCIGreen(clientFor(),pr());
  assert.equal(result.ok,true);
});

test("implementation targets dev: requires frontend-ci, not unrelated main-ci",async()=>{
  const result=await requiredShaCIGreen(clientFor({target:"dev",main:"failure"}),pr("dev"));
  assert.equal(result.ok,true);
});

test("required check from unapproved app cannot authorize reviewer",async()=>{
  await assert.rejects(requiredShaCIGreen(clientFor({
    branchPolicy:{contexts:["main-ci"],checks:[{context:"main-ci",app_id:999}]},
  }),pr()),/unapproved required check/u);
});

test("successful check with spoofed producer cannot authorize reviewer",async()=>{
  const result=await requiredShaCIGreen(clientFor({
    alteredCheck: old=>({...old,app:{id:15368,slug:"third-party"}}),
  }),pr());
  assert.equal(result.ok,false);
  assert.match(result.blockers.join(" "),/untrusted/u);
});

test("successful check linked to untrusted or wrong PR workflow cannot authorize reviewer",async()=>{
  for (const transform of [
    raw=>({...raw,path:".github/workflows/untrusted.yml"}),
    raw=>({...raw,head_sha:"c".repeat(40)}),
    raw=>({...raw,pull_requests:[{number:999,head:{sha:SHA,ref:"dev"},base:{ref:"main",sha:BASE}}]}),
    raw=>({...raw,pull_requests:[{number:388,head:{sha:SHA,ref:"dev"},base:{ref:"main",sha:"d".repeat(40)}}]}),
  ]) {
    const result=await requiredShaCIGreen(clientFor({alteredRun:transform}),pr());
    assert.equal(result.ok,false);
  }
});

test("required check stale head and duplicate results fail closed",async()=>{
  const wrong=await requiredShaCIGreen(clientFor({alteredCheck:x=>({...x,head_sha:"c".repeat(40)})}),pr());
  assert.equal(wrong.ok,false);
  const client=clientFor();const original=client.request;
  client.request=async p=>{
    const v=await original(p);
    if (p.includes("/check-runs?"))return {...v,total_count:3,check_runs:[...v.check_runs,v.check_runs[1]]};
    return v;
  };
  const duplicate=await requiredShaCIGreen(client,pr());
  assert.equal(duplicate.ok,false);
});

test("unreadable or unexpectedly expanded target-branch required checks fail closed",async()=>{
  for (const policy of [
    {contexts:["main-ci","other"],checks:[{context:"main-ci",app_id:15368},{context:"other",app_id:15368}]},
    {contexts:["main-ci"],checks:[{context:"main-ci",app_id:null}]},
    {contexts:["frontend-ci"],checks:[{context:"main-ci",app_id:15368}]},
  ]) await assert.rejects(requiredShaCIGreen(clientFor({branchPolicy:policy}),pr()),/REVIEW_CI/u);
});
