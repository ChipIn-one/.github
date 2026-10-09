import test from "node:test";
import assert from "node:assert/strict";
import { reconcileProjectPR } from "./pr-project-writer.mjs";

const repo="ChipIn-one/chipin-frontend", root="/repos/"+repo, SHA="a".repeat(40);
const mkPR=()=>({number:42,node_id:"PR_42",state:"open",
  head:{sha:SHA,ref:"dev",repo:{full_name:repo}},
  base:{sha:"b".repeat(40),ref:"main",repo:{full_name:repo}},
  body:"Included implementation PRs: "+repo+"#37\nIncluded Issues: "+repo+"#5",
});
const receipt={
  contractVersion:"chipin-issue-admission/v1",status:"INTAKE_COMPLETE",
  issue:repo+"#5",revision:"f".repeat(64),checkedAt:new Date().toISOString(),blockers:[]
};
test("org writer rejects unlabelled PR before Project GraphQL mutation",async()=>{
  let writes=0;const p=mkPR();
  const reader={async request(path){
    if(path===root+"/pulls/42")return p;
    if(path===root+"/issues/42/labels")return [];
    throw Error("unexpected "+path);
  }};
  await assert.rejects(reconcileProjectPR({
    reader,writer:{graphql:async()=>{writes++;throw Error("unexpected");}},
    config:{},number:42,expectedSha:SHA,
  }),/category label missing/);
  assert.equal(writes,0);
});

test("org writer requires current SHA and never writes on stale PR",async()=>{
  let writes=0;const p=mkPR();
  const reader={async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path)}};
  await assert.rejects(reconcileProjectPR({
    reader,writer:{graphql:async()=>{writes++;throw Error("unexpected");}},
    config:{},number:42,expectedSha:"c".repeat(40),
  }),/stale/);
  assert.equal(writes,0);
});

test("org writer adds exactly one Project item after fresh Issue/native checks; retry idempotent",async()=>{
  const p=mkPR(),events=[];const items=[];
  const reader={async request(path){
    if(path===root+"/pulls/42")return p;
    if(path===root+"/issues/42/labels")return [{name:"pr:release"}];
    throw Error("unexpected "+path);
  }};
  const writer={async graphql(q){
    if(q.startsWith("query"))return {organization:{projectV2:{
      id:"P5",items:{totalCount:items.length,
        pageInfo:{hasNextPage:false,endCursor:null},nodes:[...items]}
    }}};
    events.push("write");
    items.push({id:"ITEM_42",content:{__typename:"PullRequest",id:"PR_42"}});
    return {addProjectV2ItemById:{item:{id:"ITEM_42"}}};
  }};
  const dependencies={
    admit:async()=>{events.push("admission");return{status:"INTAKE_COMPLETE",receipts:[receipt]}},
    reread:async()=>{events.push("revision");return{receipt,blockers:[]}},
    verifyIncluded:async(_,refs)=>{events.push("native");assert.deepEqual(refs,{prs:[37],issues:[5]})},
  };
  const first=await reconcileProjectPR({reader,writer,config:{},number:42,expectedSha:SHA,...dependencies});
  const second=await reconcileProjectPR({reader,writer,config:{},number:42,expectedSha:SHA,...dependencies});
  assert.equal(first.created,true);
  assert.equal(second.created,false);
  assert.equal(first.itemId,"ITEM_42");
  assert.equal(first.readBack,true);
  assert.equal(events.filter(x=>x==="write").length,1);
  assert.ok(events.indexOf("admission")<events.indexOf("write"));
  assert.ok(events.indexOf("revision")<events.indexOf("write"));
  assert.ok(events.indexOf("native")<events.indexOf("write"));
});

test("org writer detects PR body drift after admission and performs no Project mutation",async()=>{
  const p=mkPR();let reads=0,writes=0;
  const reader={async request(path){
    if(path===root+"/pulls/42"){
      reads++;return reads>=2?{...p,body:p.body+"\nmodified"}:p;
    }
    if(path===root+"/issues/42/labels")return[{name:"pr:release"}];
    throw Error("unexpected "+path);
  }};
  await assert.rejects(reconcileProjectPR({
    reader,writer:{graphql:async()=>{writes++;throw Error("unexpected");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[receipt]}),
    verifyIncluded:async()=>{}
  }),/drifted/);
  assert.equal(writes,0);
});
