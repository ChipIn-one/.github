import assert from "node:assert/strict";
import test from "node:test";
import {classifyPR,implementationIdentity,releaseReferences,bodyGaps,chooseOwner,chooseReviewer,uniqueProjectItem,ensureProjectPR} from "./pr-metadata.mjs";
const repo="ChipIn-one/chipin-frontend";
const pr=(base,head)=>({base:{ref:base,repo:{full_name:repo}},head:{ref:head,repo:{full_name:repo}}});
test("routes implementation and release exactly",()=>{
  assert.equal(classifyPR(pr("dev","feat/issue-381-pr-metadata")),"implementation");
  assert.equal(classifyPR(pr("main","dev")),"release");
  assert.throws(()=>classifyPR(pr("main","feature")) ,/ROUTE/);
  assert.throws(()=>classifyPR({...pr("dev","feat/task"),head:{ref:"x",repo:{full_name:"fork/repo"}}}),/SCOPE/);
});
test("identity must be single and explicit; never inferred",()=>{
  assert.equal(implementationIdentity("Task identity: ChipIn-one/chipin-frontend#381").issueNumber,381);
  assert.throws(()=>implementationIdentity("Relates to #381"),/IDENTITY/);
  assert.throws(()=>implementationIdentity("Task identity: ChipIn-one/chipin-backend#381"),/IDENTITY/);
  assert.throws(()=>implementationIdentity("Task identity: ChipIn-one/chipin-frontend#381\nTask identity: ChipIn-one/chipin-frontend#382"),/ambiguous/);
});
test("release contract requires verifiable unique PRs and Issues",()=>{
  const body="Included implementation PRs: "+repo+"#1, "+repo+"#2\nIncluded Issues: "+repo+"#5, "+repo+"#6";
  assert.deepEqual(releaseReferences(body),{prs:[1,2],issues:[5,6]});
  assert.throws(()=>releaseReferences("Included Issues: "+repo+"#5"),/RELEASE/);
  assert.throws(()=>releaseReferences(body+"\nIncluded Issues: "+repo+"#7"),/RELEASE/);
  assert.throws(()=>releaseReferences(body.replace(repo+"#2",repo+"#1")) ,/RELEASE/);
  assert.throws(()=>releaseReferences(body+"\nTask identity: "+repo+"#5"),/RELEASE/);
});
test("body headings only check, never overwrite human text",()=>{
  assert.deepEqual(bodyGaps("## Summary\nok\n## Tests\nok\n## Version impact\nnone\n## Dependencies\nnone"),[]);
  assert.equal(bodyGaps("manual prose").length,4);
});
test("owner policy preserves manual and blocks ambiguity",()=>{
  assert.equal(chooseOwner({manual:["human"],issue:["approved"]}),null);
  assert.equal(chooseOwner({issue:["approved"],approved:"other"}),"approved");
  assert.throws(()=>chooseOwner({issue:["a","b"]}),/OWNER_POLICY/);
  assert.throws(()=>chooseOwner({author:"author"}),/OWNER_POLICY/);
  assert.equal(chooseOwner({author:"author",allowAuthor:true}),"author");
});
test("reviewer policy differs from assignment and forbids self-review",()=>{
  assert.equal(chooseReviewer({manual:["human"],approved:[],author:"owner"}),null);
  assert.throws(()=>chooseReviewer({approved:[],author:"owner"}),/REVIEWER_POLICY/);
  assert.throws(()=>chooseReviewer({approved:["owner"],author:"owner"}),/REVIEWER_POLICY/);
  assert.throws(()=>chooseReviewer({approved:["a","b"],author:"owner"}),/REVIEWER_POLICY/);
  assert.equal(chooseReviewer({approved:["reviewer"],author:"owner"}),"reviewer");
});
test("Project duplicates fail; existing membership read-back is idempotent",async()=>{
  const content={__typename:"PullRequest",id:"PR_10"};
  assert.throws(()=>uniqueProjectItem([{id:"1",content},{id:"2",content}],"PR_10"),/duplicate/);
  let writes=0;
  const node={id:"1",content};
  const client={async graphql(q){
    if(q.startsWith("query"))return{organization:{projectV2:{id:"P5",items:{totalCount:1,pageInfo:{hasNextPage:false,endCursor:null},nodes:[node]}}}};
    writes++;throw new Error("write not expected");
  }};
  assert.equal((await ensureProjectPR(client,"PR_10")).created,false);
  assert.equal((await ensureProjectPR(client,"PR_10")).readBack,true);
  assert.equal(writes,0);
});
test("Project write requires actual read-back, not mutation claim",async()=>{
  let writes=0;
  const client={async graphql(q){
    if(q.startsWith("query"))return{organization:{projectV2:{id:"P5",items:{totalCount:0,pageInfo:{hasNextPage:false,endCursor:null},nodes:[]}}}};
    writes++;return{addProjectV2ItemById:{item:{id:"new"}}};
  }};
  await assert.rejects(ensureProjectPR(client,"PR_NEW"),/missing PR item/);
  assert.equal(writes,1);
});
