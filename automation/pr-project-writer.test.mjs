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
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return [];}
  };
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
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return [{name:"pr:release"}];}
  };
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
  const reader={
    async request(path){
      if(path===root+"/pulls/42"){
        reads++;return reads>=2?{...p,body:p.body+"\nmodified"}:p;
      }
      throw Error("unexpected "+path);
    },
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return [{name:"pr:release"}];}
  };
  await assert.rejects(reconcileProjectPR({
    reader,writer:{graphql:async()=>{writes++;throw Error("unexpected");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[receipt]}),
    verifyIncluded:async()=>{}
  }),/drifted/);
  assert.equal(writes,0);
});

test("Project writer rejects contradictory category beyond first 100 labels",async()=>{
  const p=mkPR();let writes=0,admissions=0;
  const labels=Array.from({length:100},(_,i)=>({name:"other-"+i}));
  labels.push({name:"pr:release"},{name:"pr:implementation"});
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return labels;}
  };
  await assert.rejects(reconcileProjectPR({
    reader,writer:{async graphql(){writes++;throw Error("unexpected Project write");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>{admissions++;throw Error("should not reach admission");}
  }),/contradictory PR category labels/);
  assert.equal(writes,0);assert.equal(admissions,0);
});

test("Project writer rejects a late label change before writing",async()=>{
  const p=mkPR();let writes=0,labelReads=0;
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){
      assert.equal(path,root+"/issues/42/labels");labelReads++;
      return labelReads===1?[{name:"pr:release"}]:[{name:"pr:release"},{name:"pr:implementation"}];
    }
  };
  await assert.rejects(reconcileProjectPR({
    reader,writer:{async graphql(){writes++;throw Error("unexpected Project write");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[receipt]}),
    reread:async()=>({receipt,blockers:[]}),
    verifyIncluded:async()=>{}
  }),/category changed before Project write/);
  assert.equal(writes,0);assert.equal(labelReads,2);
});

test("release native linkage changes after admission and blocks Project mutation",async()=>{
  const p=mkPR();let writes=0,verifyReads=0,admissionReads=0;
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return[{name:"pr:release"}];}
  };
  await assert.rejects(reconcileProjectPR({
    reader,writer:{async graphql(){writes++;throw Error("Project write must not happen");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[receipt]}),
    reread:async()=>{admissionReads++;return{receipt,blockers:[]};},
    verifyIncluded:async()=>{
      verifyReads++;
      if(verifyReads===2)throw Error("RELEASE: included PR native Task identity changed");
    },
  }),/native Task identity changed/);
  assert.equal(admissionReads,1);
  assert.equal(verifyReads,2);
  assert.equal(writes,0);
});

test("implementation native linkage changes after admission and blocks Project mutation",async()=>{
  const p={...mkPR(),body:"Task identity: "+repo+"#5",
    head:{sha:SHA,ref:"feat/issue-381-identity",repo:{full_name:repo}},
    base:{sha:"b".repeat(40),ref:"dev",repo:{full_name:repo}}};
  let writes=0,verifyReads=0;
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return[{name:"pr:implementation"}];}
  };
  await assert.rejects(reconcileProjectPR({
    reader,writer:{async graphql(){writes++;throw Error("Project write must not happen");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[receipt]}),
    reread:async()=>({receipt,blockers:[]}),
    verifyNative:async(_,number,issue,required)=>{
      verifyReads++;
      assert.equal(number,42);assert.equal(issue,5);assert.equal(required,true);
      if(verifyReads===2)throw Error("NATIVE_IDENTITY: Issue #5 link removed during admission");
    },
  }),/Issue #5 link removed/);
  assert.equal(verifyReads,2);
  assert.equal(writes,0);
});

test("Project write rejects refreshed admission expiring during paginated final labels",async()=>{
  const p=mkPR();let writes=0,labelsReads=0,verified=0;
  const currentReceipt={...receipt,checkedAt:new Date().toISOString()};
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){
      assert.equal(path,root+"/issues/42/labels");labelsReads++;
      if(labelsReads===2) currentReceipt.checkedAt=new Date(Date.now()-180_000).toISOString();
      return[{name:"pr:release"}];
    }
  };
  await assert.rejects(reconcileProjectPR({
    reader,writer:{async graphql(){writes++;throw Error("Project write must not happen");}},
    config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[receipt]}),
    reread:async()=>({receipt:currentReceipt,blockers:[]}),
    verifyIncluded:async()=>{verified++;}
  }),/STALE admission receipt/);
  assert.equal(labelsReads,2);
  assert.equal(verified,2);
  assert.equal(writes,0);
});

test("fresh reread replaces aged preflight receipt at Project boundary",async()=>{
  const p=mkPR(),oldReceipt={...receipt,checkedAt:new Date(Date.now()-180_000).toISOString()};
  const freshReceipt={...receipt,checkedAt:new Date().toISOString()};
  let writes=0,verified=0;
  const items=[];
  const reader={
    async request(path){if(path===root+"/pulls/42")return p;throw Error("unexpected "+path);},
    async listAll(path){assert.equal(path,root+"/issues/42/labels");return[{name:"pr:release"}];}
  };
  const writer={async graphql(query){
    if(query.startsWith("query"))return{organization:{projectV2:{id:"P5",items:{
      totalCount:items.length,pageInfo:{hasNextPage:false,endCursor:null},nodes:[...items]
    }}}};
    writes++;items.push({id:"ITEM_42",content:{__typename:"PullRequest",id:"PR_42"}});
    return{addProjectV2ItemById:{item:{id:"ITEM_42"}}};
  }};
  const result=await reconcileProjectPR({
    reader,writer,config:{},number:42,expectedSha:SHA,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[oldReceipt]}),
    reread:async()=>({receipt:freshReceipt,blockers:[]}),
    verifyIncluded:async()=>{verified++;}
  });
  assert.equal(writes,1);assert.equal(verified,2);
  assert.equal(result.readBack,true);
});
