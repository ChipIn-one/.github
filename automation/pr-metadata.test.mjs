import assert from "node:assert/strict";
import test from "node:test";
import {classifyPR,implementationIdentity,releaseReferences,bodyGaps,chooseOwner,chooseReviewer,uniqueProjectItem,ensureProjectPR,ensureCategory,readProject,reconcilePR,assertSingleNativeIssue,requiredShaCIGreen} from "./pr-metadata.mjs";
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
  await assert.rejects(ensureProjectPR(client,"PR_NEW",{beforeWrite:async()=>{},retryWait:async()=>{}}),/missing PR item on read-back after 7 complete reads/);
  assert.equal(writes,1);
});

test("Project membership becomes visible after a successful write without a second mutation",async()=>{
  let reads=0,writes=0,admissions=0,waits=0;
  const item={id:"ITEM_42",content:{__typename:"PullRequest",id:"PR_42"}};
  const client={async graphql(query){
    if(query.startsWith("query")){
      reads++;
      const items=reads>=4?[item]:[];
      return{organization:{projectV2:{id:"P5",items:{
        totalCount:items.length,pageInfo:{hasNextPage:false,endCursor:null},nodes:items
      }}}};
    }
    writes++;
    return{addProjectV2ItemById:{item:{id:"ITEM_42"}}};
  }};
  const result=await ensureProjectPR(client,"PR_42",{
    beforeWrite:async()=>{admissions++;assert.equal(reads,1);},
    retryWait:async(ms)=>{assert.ok(ms>0);waits++;}
  });
  assert.deepEqual(result,{id:"ITEM_42",created:true,readBack:true});
  assert.equal(reads,4);assert.equal(writes,1);
  assert.equal(admissions,1);assert.equal(waits,2);
});

test("Project read-back exhausts bounded reads without making duplicate writes",async()=>{
  let reads=0,writes=0,admissions=0,waits=0;
  const client={async graphql(query){
    if(query.startsWith("query")){
      reads++;
      return{organization:{projectV2:{id:"P5",items:{
        totalCount:0,pageInfo:{hasNextPage:false,endCursor:null},nodes:[]
      }}}};
    }
    writes++;return{addProjectV2ItemById:{item:{id:"ITEM_42"}}};
  }};
  await assert.rejects(ensureProjectPR(client,"PR_42",{
    beforeWrite:async()=>{admissions++;},
    retryWait:async()=>{waits++;}
  }),/missing PR item on read-back after 7 complete reads/);
  assert.equal(reads,8); // initial scan, then 7 full read-back attempts
  assert.equal(writes,1);assert.equal(admissions,1);assert.equal(waits,6);
});

test("Project read-back never accepts a different mutation item ID",async()=>{
  let writes=0;
  const client={async graphql(query){
    if(query.startsWith("query")){
      const nodes=writes?[{id:"DIFFERENT",content:{__typename:"PullRequest",id:"PR_42"}}]:[];
      return{organization:{projectV2:{id:"P5",items:{
        totalCount:nodes.length,pageInfo:{hasNextPage:false,endCursor:null},nodes
      }}}};
    }
    writes++;return{addProjectV2ItemById:{item:{id:"ITEM_42"}}};
  }};
  await assert.rejects(ensureProjectPR(client,"PR_42",{
    beforeWrite:async()=>{},retryWait:async()=>{}
  }),/mutation item ID differs from membership read-back/);
  assert.equal(writes,1);
});

test("new Project item requires a successful pre-write admission gate after scan",async()=>{
  let reads=0,mutations=0,checks=0;
  const client={async graphql(q){
    if(q.startsWith("query")){
      reads++;return {organization:{projectV2:{id:"P5",items:{
        totalCount:0,pageInfo:{hasNextPage:false,endCursor:null},nodes:[]
      }}}};
    }
    mutations++;return{addProjectV2ItemById:{item:{id:"NEW"}}};
  }};
  await assert.rejects(ensureProjectPR(client,"PR_42"),/pre-write validation callback required/);
  assert.equal(reads,1);assert.equal(mutations,0);
  await assert.rejects(ensureProjectPR(client,"PR_42",{
    beforeWrite:async()=>{
      checks++;assert.equal(reads,2);assert.equal(mutations,0);
      throw new Error("canonical Issue revision changed during Project scan");
    }
  }),/revision changed/);
  assert.equal(checks,1);assert.equal(mutations,0);
});

test("Project GraphQL permission failures become actionable blockers",async()=>{
  await assert.rejects(readProject({async graphql(){throw new Error("403 Forbidden");}}),/PROJECT_PERMISSION:.*org Projects v2/u);
});
test("manual category conflicts block instead of adding competing labels",async()=>{
  let writes=0;
  const client={
    async listAll(path){assert.equal(path,"/repos/"+repo+"/issues/42/labels");return[{name:"pr:release"}];},
    async request(path,opts={}){if(opts.method)writes++;throw new Error("unexpected "+path);}
  };
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
    async listAll(path){
      assert.equal(path,PATH+"/issues/20/labels");return [...labels];
    },
    async request(path,opts={}) {
      if (opts.method && path.includes("/issues/"))issueWrites++;
      if(path===PATH+"/pulls/20")return release;
      if(path===PATH+"/pulls/10")return impl;
      if(path===PATH+"/issues/20")return{number:20,assignees:[{login:"human-owner"}]};
      if(path===PATH+"/issues/20/labels" && opts.method==="POST"){
        labelAdds++;labels.push({name:"pr:release"});return labels;
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
  assert.ok(nativeReads>=2); // read-only native link verification on both retries
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

test("adapter rejects a contradictory category beyond the first 100 labels",async()=>{
  const labels=Array.from({length:100},(_,i)=>({name:"manual-"+i}));
  labels.push({name:"pr:implementation"},{name:"pr:release"});
  let mutations=0;
  const client={
    async listAll(path){
      assert.equal(path,"/repos/"+repo+"/issues/381/labels");return labels;
    },
    async request(path,opts={}){if(opts.method)mutations++;throw Error("unexpected "+path);}
  };
  await assert.rejects(ensureCategory(client,381,"implementation"),/LABEL_CONFLICT/);
  assert.equal(mutations,0);
});

test("adapter read-back rejects a conflicting label added after write",async()=>{
  const labels=[{name:"manual"}];let reads=0,adds=0;
  const client={
    async listAll(){reads++;return reads===1?[...labels]:[...labels,{name:"pr:release"}];},
    async request(path,opts={}){
      if(path.endsWith("/labels/pr%3Aimplementation"))return{name:"pr:implementation"};
      if(path.endsWith("/issues/42/labels") && opts.method==="POST"){
        adds++;labels.push({name:"pr:implementation"});return labels;
      }
      throw Error("unexpected "+path);
    }
  };
  await assert.rejects(ensureCategory(client,42,"implementation"),/LABEL_CONFLICT/);
  assert.equal(adds,1);assert.equal(reads,2);
});

// Issue #138: dependabot PRs are an explicit SKIP, never a BLOCK; everything
// else without a single Task identity keeps failing closed.
import {isDependabotPR} from "./pr-metadata.mjs";
import {taskIdentitiesForPr} from "./issue-admission-pr.mjs";
const feOnlyPolicy={repository:repo,project:5,ownerPolicy:{allowIssueOwner:true,allowAuthorFallback:false,
  implementationOwner:"syllik",releaseOwner:"syllik"},reviewerPolicy:{implementation:[],release:[]}};
function dependencyPR({login="dependabot[bot]",ref="dependabot/npm_and_yarn/dev/vitest-5.0.4",sha="c".repeat(40)}={}){
  return {number:463,node_id:"PR_463",state:"open",body:"Bumps vitest from 4 to 5.",
    user:{login,type:login.endsWith("[bot]")?"Bot":"User"},
    head:{ref,sha,repo:{full_name:repo}},base:{ref:"dev",sha:"d".repeat(40),repo:{full_name:repo}},
    requested_reviewers:[]};
}
function recordingClient(pr){
  const calls=[];
  return {calls,
    async request(path,opts={}){calls.push({path,method:opts.method??"GET"});
      if(path==="/repos/"+repo+"/pulls/"+pr.number)return pr;
      throw new Error("unexpected REST request "+path);},
    async listAll(path){calls.push({path,method:"LIST"});throw new Error("unexpected list "+path);},
    async graphql(){calls.push({path:"graphql"});throw new Error("unexpected graphql");}};
}
test("isDependabotPR matches the bot author or a dependabot/** head branch only",()=>{
  assert.equal(isDependabotPR(dependencyPR()),true);
  assert.equal(isDependabotPR(dependencyPR({login:"human",ref:"dependabot/github_actions/dev/x"})),true);
  assert.equal(isDependabotPR(dependencyPR({login:"dependabot[bot]",ref:"feat/issue-1-x"})),true);
  assert.equal(isDependabotPR(dependencyPR({login:"human",ref:"feat/issue-1-x"})),false);
  assert.equal(isDependabotPR(dependencyPR({login:"dependabot",ref:"feat/issue-1-x"})),false);
  assert.equal(isDependabotPR(dependencyPR({login:"human",ref:"dependabot-fix/x"})),false);
  assert.equal(isDependabotPR(dependencyPR({login:"human",ref:"feat/dependabot/x"})),false);
  assert.equal(isDependabotPR(null),false);
});
test("dependabot PR is SKIPPED before admission, SHA check and any write",async()=>{
  const pr=dependencyPR();
  const client=recordingClient(pr);
  let admissions=0;
  const receipt=await reconcilePR(client,feOnlyPolicy,463,"e".repeat(40),{
    admissionClient:client,admissionConfig:{},admit:async()=>{admissions++;throw new Error("must not admit");}});
  assert.equal(receipt.status,"SKIPPED");
  assert.equal(receipt.kind,"dependabot");
  assert.equal(receipt.number,463);
  assert.equal(receipt.headSha,pr.head.sha);
  assert.match(receipt.reason,/dependabot/u);
  assert.deepEqual(receipt.blockers,[]);
  assert.equal(receipt.taskIdentity,null);
  assert.equal(admissions,0);
  assert.deepEqual(client.calls,[{path:"/repos/"+repo+"/pulls/463",method:"GET"}]);
});
test("a dependabot/** head branch with a non-bot author is also SKIPPED",async()=>{
  const pr=dependencyPR({login:"human-rebaser",ref:"dependabot/npm_and_yarn/dev/x"});
  const client=recordingClient(pr);
  const receipt=await reconcilePR(client,feOnlyPolicy,463,pr.head.sha,{
    admissionClient:client,admissionConfig:{},admit:async()=>{throw new Error("must not admit");}});
  assert.equal(receipt.status,"SKIPPED");
  assert.equal(client.calls.filter(x=>x.method!=="GET").length,0);
});
test("non-dependabot PR without a Task identity is still BLOCKED by admission",async()=>{
  const pr=dependencyPR({login:"human",ref:"feat/issue-9-no-marker"});
  const client=recordingClient(pr);
  const admit=async({client:c,repository,number})=>{
    taskIdentitiesForPr(repository,await c.request("/repos/"+repository+"/pulls/"+number));
    return {status:"INTAKE_COMPLETE",receipts:[]};
  };
  await assert.rejects(reconcilePR(client,feOnlyPolicy,463,pr.head.sha,{
    admissionClient:client,admissionConfig:{},admit}),/Missing or mismatched single Task identity in implementation PR/u);
  assert.equal(client.calls.filter(x=>x.method!=="GET").length,0);
  // The reconciler's own identity gate keeps blocking even if admission were stubbed open.
  await assert.rejects(reconcilePR(client,feOnlyPolicy,463,pr.head.sha,{
    admissionClient:client,admissionConfig:{},admit:async()=>({status:"INTAKE_COMPLETE",receipts:[]})}),/IDENTITY/u);
});

// .github#214: canonical master trusts frontend-ci, required via a repository
// ruleset. Response shapes are modelled on live REST reads (2026-10-22):
// the branch/rules shapes of a ruleset-only branch come from ChipIn-one/.github
// master (ruleset 24047968, the only org ruleset with a required_status_checks
// rule): GET /branches/{b} exposes no ruleset checks, GET /rules/branches/{b}
// carries them. The non-CI rule entries (deletion, non_fast_forward) and the
// ruleset_id copy chipin-frontend main (ruleset 24097006); classicBranch copies
// chipin-frontend dev/main classic protection.
const CI_SHA="a".repeat(40), CI_BASE="b".repeat(40);
const rulesetRule=(checks)=>({type:"required_status_checks",parameters:{strict_required_status_checks_policy:true,
  do_not_enforce_on_create:false,required_status_checks:checks},ruleset_source_type:"Repository",
  ruleset_source:repo,ruleset_id:24097006});
const rulesetOnlyBranch=(name)=>({name,protected:true,protection:{enabled:false,
  required_status_checks:{checks:[],contexts:[],enforcement_level:"off"}}});
const classicBranch=(name,context)=>({name,protected:true,protection:{enabled:true,
  required_status_checks:{checks:[{app_id:15368,context}],contexts:[context],enforcement_level:"everyone"}}});
const otherRules=[{type:"deletion",ruleset_source_type:"Repository",ruleset_source:repo,ruleset_id:24097006},
  {type:"non_fast_forward",ruleset_source_type:"Repository",ruleset_source:repo,ruleset_id:24097006}];
function masterClient({name="master",branch=rulesetOnlyBranch(name),rules=[...otherRules,rulesetRule([{context:"frontend-ci",integration_id:15368}])],
                       conclusion="success",path=".github/workflows/frontend-ci.yml"}={}){
  const seen=[];
  return {seen,async request(url){
    seen.push(url);
    if (url.endsWith("/rules/branches/"+name+"?per_page=100")) return rules;
    if (url.endsWith("/branches/"+name)) return branch;
    if (url.endsWith("/commits/"+CI_SHA+"/check-runs?per_page=100&filter=latest"))
      return {total_count:1,check_runs:[{id:200,name:"frontend-ci",head_sha:CI_SHA,status:"completed",conclusion,
        app:{id:15368,slug:"github-actions"},details_url:"https://github.com/"+repo+"/actions/runs/300/job/200"}]};
    if (url.endsWith("/actions/runs/300"))
      return {id:300,path,repository:{full_name:repo},head_sha:CI_SHA,head_branch:"feat/x",status:"completed",
        conclusion:"success",event:"pull_request",pull_requests:[{number:7,head:{ref:"feat/x",sha:CI_SHA},base:{ref:"master",sha:CI_BASE}}]};
    throw new Error("unexpected GET "+url);
  }};
}
const masterPR={number:7,base:{ref:"master",sha:CI_BASE},head:{sha:CI_SHA,ref:"feat/x"}};

test("#214 master: ruleset-required frontend-ci on the current head authorizes review",async()=>{
  const client=masterClient();
  const result=await requiredShaCIGreen(client,masterPR);
  assert.equal(result.ok,true);
  assert.deepEqual(result.required,["frontend-ci"]);
  assert.ok(client.seen.some(u=>u.endsWith("/rules/branches/master?per_page=100")));
});

test("#214 master: failing frontend-ci or a non-frontend-ci workflow blocks",async()=>{
  assert.equal((await requiredShaCIGreen(masterClient({conclusion:"failure"}),masterPR)).ok,false);
  assert.equal((await requiredShaCIGreen(masterClient({path:".github/workflows/main-ci.yml"}),masterPR)).ok,false);
});

test("#214 master: classic-protection shape is still read (same strictness)",async()=>{
  const result=await requiredShaCIGreen(masterClient({branch:classicBranch("master","frontend-ci"),rules:otherRules}),masterPR);
  assert.equal(result.ok,true);
  await assert.rejects(requiredShaCIGreen(masterClient({branch:classicBranch("master","main-ci"),rules:otherRules}),masterPR),
    /unapproved required check/u);
});

test("#214 master: ruleset policy unreadable, empty or ambiguous fails closed",async()=>{
  const fc={context:"frontend-ci",integration_id:15368};
  for (const [opts,re] of [
    [{rules:otherRules},/policy unreadable/u],                                    // no required check at all
    [{rules:[]},/policy unreadable/u],
    [{rules:null},/ruleset policy unreadable/u],
    [{rules:{message:"Not Found"}},/ruleset policy unreadable/u],
    [{rules:Array.from({length:100},()=>otherRules[0])},/ruleset policy unreadable or incomplete/u],
    [{rules:[{parameters:{}}]},/ruleset policy unreadable/u],                     // untyped rule
    [{rules:[rulesetRule([])]},/ruleset required checks unreadable/u],
    [{rules:[rulesetRule(null)]},/ruleset required checks unreadable/u],
    [{rules:[rulesetRule([{integration_id:15368}])]},/ruleset required checks unreadable/u],
    [{branch:classicBranch("master","frontend-ci"),rules:[rulesetRule([{context:"frontend-ci",integration_id:999}])]},/ambiguous/u], // same context, other producer
    [{rules:[rulesetRule([fc]),rulesetRule([{context:"frontend-ci",integration_id:999}])]},/ambiguous/u],
    [{rules:[...otherRules,{type:"workflows",parameters:{workflows:[]}},rulesetRule([fc])]},/rule 'workflows' gates merge but is not verified/u],
    [{rules:[{type:"code_scanning",parameters:{code_scanning_tools:[]}},rulesetRule([fc])]},/rule 'code_scanning' gates merge but is not verified/u],
    [{rules:[rulesetRule([{context:"frontend-ci"}])]},/unapproved required check or producer/u], // any source
    [{rules:[rulesetRule([{context:"frontend-ci",integration_id:999}])]},/unapproved/u],
    [{rules:[rulesetRule([fc,{context:"e2e",integration_id:15368}])]},/unapproved/u],
    [{rules:[rulesetRule([{context:"main-ci",integration_id:15368}])]},/unapproved/u],
    [{branch:{...rulesetOnlyBranch("main")}},/policy unreadable/u],               // GET /branches/master redirected to renamed main
    [{branch:{...rulesetOnlyBranch("master"),protected:false}},/policy unreadable/u],
    [{branch:{name:"master",protected:true}},/policy unreadable/u],
  ]) await assert.rejects(requiredShaCIGreen(masterClient(opts),masterPR),re,JSON.stringify(opts).slice(0,120));
});

test("#214 identical required check from classic protection and rulesets counts once",async()=>{
  const fc={context:"frontend-ci",integration_id:15368};
  for (const opts of [
    {branch:classicBranch("master","frontend-ci"),rules:[rulesetRule([fc])]},
    {rules:[rulesetRule([fc,fc])]},
    {rules:[rulesetRule([fc]),rulesetRule([fc])]},
  ]) {
    const result=await requiredShaCIGreen(masterClient(opts),masterPR);
    assert.equal(result.ok,true);
    assert.deepEqual(result.required,["frontend-ci"]);
  }
});

test("#214 dev: an extra ruleset-required check beyond classic frontend-ci is rejected",async()=>{
  const devPR={...masterPR,base:{ref:"dev",sha:CI_BASE}};
  await assert.rejects(requiredShaCIGreen(masterClient({name:"dev",branch:classicBranch("dev","frontend-ci"),
    rules:[rulesetRule([{context:"other-check",integration_id:15368}])]}),devPR),/unapproved required check or producer for dev/u);
});

test("#214 unknown or prototype-named target branches are rejected",async()=>{
  for (const ref of ["release","__proto__","constructor","toString"])
    await assert.rejects(requiredShaCIGreen(masterClient(),{...masterPR,base:{ref,sha:CI_BASE}}),/unsupported target branch/u);
});
