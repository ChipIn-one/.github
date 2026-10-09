import assert from "node:assert/strict";
import test from "node:test";
import {classifyPR,implementationIdentity,releaseReferences,bodyGaps,chooseOwner,chooseReviewer,uniqueProjectItem,ensureProjectPR,ensureCategory,readProject,reconcilePR,assertSingleNativeIssue} from "./pr-metadata.mjs";
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
  assert.equal(chooseOwner({issue:["syllik","other-human"],approved:"syllik"}),"syllik");
  assert.throws(()=>chooseOwner({issue:["other1","other2"],approved:"syllik"}),/OWNER_POLICY/);
  assert.throws(()=>chooseOwner({author:"author"}),/OWNER_POLICY/);
  assert.equal(chooseOwner({author:"author",allowAuthor:true}),"author");
});
test("reviewer policy differs from assignment and forbids self-review",()=>{
  assert.equal(chooseReviewer({manual:["human"],approved:[],author:"owner"}),null);
  assert.equal(chooseReviewer({manual:["approved-review-team"],approved:[],author:"owner"}),null);
  assert.equal(chooseReviewer({approved:[],author:"owner"}),null);
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

test("Project GraphQL permission failures become actionable blockers",async()=>{
  await assert.rejects(readProject({async graphql(){throw new Error("403 Forbidden");}}),/PROJECT_PERMISSION:.*org Projects v2/u);
});
test("manual category conflicts block instead of adding competing labels",async()=>{
  let writes=0;
  const client={async request(path,opts={}) {
    if(opts.method)writes++;
    if(path.includes("/issues/42/labels"))return[{name:"pr:release"}];
    throw new Error("unexpected "+path);
  }};
  await assert.rejects(ensureCategory(client,42,"implementation"),/LABEL_CONFLICT/u);
  assert.equal(writes,0);
});
test("release retries preserve manual values, avoid duplicate Project item and never change Issues",async()=>{
  const SHA="a".repeat(40), PATH="/repos/ChipIn-one/chipin-frontend";
  const body="Included implementation PRs: "+repo+"#10\nIncluded Issues: "+repo+"#5\n"
    +"## Summary\nrelease\n## Tests\nCI pending\n## Version impact\nnone\n## Dependencies\nnone";
  const release={number:20,node_id:"PR_20",state:"open",body,user:{login:"pr-author"},
    head:{ref:"dev",sha:SHA,repo:{full_name:repo}},base:{ref:"main",repo:{full_name:repo}},
    requested_reviewers:[]};
  const impl={number:10,merged_at:"2026-10-08T12:00:00Z",base:{ref:"dev"},
    body:"Task identity: "+repo+"#5"};
  const labels=[{name:"manual-label"}],items=[];
  let projectAdds=0,labelAdds=0,issueWrites=0,nativeReads=0;
  const client={
    async graphql(query) {
      if (query.includes("query PRNativeIdentity")) {
        nativeReads++;
        return {repository:{nameWithOwner:repo,pullRequest:{number:10,
          closingIssuesReferences:{totalCount:1,pageInfo:{hasNextPage:false,endCursor:null},
            nodes:[{id:"ISSUE_5",number:5,repository:{nameWithOwner:repo}}]}}}};
      }
      if (query.includes("query DevelopmentLinkPullRequest")) {
        nativeReads++;
        return {repository:{nameWithOwner:repo,pullRequest:{
          id:"PR_10",number:10,body:impl.body,repository:{nameWithOwner:repo}}}};
      }
      if (query.includes("query DevelopmentLinkTarget")) {
        nativeReads++;
        return {repository:{nameWithOwner:repo,taskIssue:{
          id:"ISSUE_5",number:5,url:"https://github.com/"+repo+"/issues/5",
          repository:{nameWithOwner:repo},closedByPullRequestsReferences:{
            totalCount:1,pageInfo:{hasNextPage:false,endCursor:null},nodes:[{
              id:"PR_10",number:10,url:"https://github.com/"+repo+"/pull/10",
              repository:{nameWithOwner:repo}}]}},
          implementationPr:{id:"PR_10",number:10,body:impl.body,repository:{nameWithOwner:repo}}}};
      }
      if(query.startsWith("query"))return {organization:{projectV2:{id:"PROJECT_5",
        items:{totalCount:items.length,pageInfo:{hasNextPage:false,endCursor:null},nodes:items}}}};
      projectAdds++;items.push({id:"ITEM_20",content:{__typename:"PullRequest",id:"PR_20"}});
      return{addProjectV2ItemById:{item:{id:"ITEM_20"}}};
    },
    async request(path,opts={}) {
      if (opts.method && path.includes("/issues/"))issueWrites++;
      if(path===PATH+"/pulls/20")return release;
      if(path===PATH+"/pulls/10")return impl;
      if(path===PATH+"/issues/20")return{number:20,assignees:[{login:"human-owner"}]};
      if(path===PATH+"/issues/20/labels") {
        if(opts.method==="POST"){labelAdds++;labels.push({name:"pr:release"});}
        return labels;
      }
      if(path===PATH+"/labels/pr%3Arelease")return{name:"pr:release"};
      throw new Error("unexpected REST request "+path);
    }
  };
  const policy={repository:repo,project:5,ownerPolicy:{allowIssueOwner:true,allowAuthorFallback:false,
    implementationOwner:null,releaseOwner:null},reviewerPolicy:{implementation:[],release:[]}};
  await assert.rejects(reconcilePR(client,policy,20,"b".repeat(40)),/SHA/u);
  const options={admissionClient:client,admissionConfig:{},
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[]})};
  const one=await reconcilePR(client,policy,20,SHA,options);
  const two=await reconcilePR(client,policy,20,SHA,options);
  assert.equal(one.kind,"release");assert.equal(one.project.status,"pending-org-writer");
  assert.equal(two.project.status,"pending-org-writer");
  assert.equal(projectAdds,0);assert.equal(labelAdds,1);assert.equal(issueWrites,1); // no FE Project write
  assert.ok(nativeReads>=4); // native userLinkedOnly read-back on both retries
  assert.ok(!two.blockers.some(x=>x.includes("REVIEWER_POLICY")));
  assert.equal(items.length,0);
  assert.deepEqual(labels.map(x=>x.name),["manual-label","pr:release"]);
});

test("native single-Issue contract detects stale identity and missing read-back",async()=>{
  let size=2;
  const client={async graphql(){
    const nodes=Array.from({length:size},(_,i)=>({id:"ISSUE_"+(i+5),number:i+5,
      repository:{nameWithOwner:repo}}));
    return {repository:{nameWithOwner:repo,pullRequest:{number:10,closingIssuesReferences:{
      totalCount:nodes.length,pageInfo:{hasNextPage:false,endCursor:null},nodes}}}};
  }};
  await assert.rejects(assertSingleNativeIssue(client,10,5),/NATIVE_IDENTITY: PR has a conflicting/u);
  size=0;
  assert.equal(await assertSingleNativeIssue(client,10,5),false);
  await assert.rejects(assertSingleNativeIssue(client,10,5,true),/expected one native/u);
  size=1;
  assert.equal(await assertSingleNativeIssue(client,10,5,true),true);
});

// Keep the audited failure reproduction in the default org test suite.
import "../evidence/pr54-ci-gate-reproduction.test.mjs";

test("single-maintainer reviewer policy does not invent a second person",()=>{
  assert.equal(chooseReviewer({approved:[],author:"syllik"}),null);
  assert.throws(()=>chooseReviewer({approved:["syllik"],author:"syllik"}),/self-review/);
});
