import assert from "node:assert/strict";
import test from "node:test";
import {classifyPR,implementationIdentity,releaseReferences,bodyGaps,chooseOwner,chooseReviewer,ensureCategory,reconcilePR,assertSingleNativeIssue,requiredShaCIGreen} from "./pr-metadata.mjs";
const repo="ChipIn-one/chipin-frontend";
const pr=(base,head)=>({base:{ref:base,repo:{full_name:repo}},head:{ref:head,repo:{full_name:repo}}});
// the frontend dev/main layout before the canonical-master cutover (.github#216): rollback target of chipin-frontend#497
const LEGACY_BRANCHES=Object.freeze({default:"main",integration:"dev",promotion:"main"});
test("routes from the registry: frontend on canonical master has implementation → master only",()=>{
  assert.equal(classifyPR(pr("master","feat/issue-381-pr-metadata")),"implementation");
  for (const [base,head] of [["dev","feat/x"],["main","feat/x"],["main","dev"],["master","master"]])
    assert.throws(()=>classifyPR(pr(base,head)),/^Error: ROUTE: only implementation→master$/u,base+" <- "+head);
  assert.throws(()=>classifyPR({...pr("master","feat/task"),head:{ref:"x",repo:{full_name:"fork/repo"}}}),/SCOPE/);
});
test("routes implementation and release exactly on the dev/main rollback layout",()=>{
  assert.equal(classifyPR(pr("dev","feat/issue-381-pr-metadata"),LEGACY_BRANCHES),"implementation");
  assert.equal(classifyPR(pr("main","dev"),LEGACY_BRANCHES),"release");
  assert.throws(()=>classifyPR(pr("main","feature"),LEGACY_BRANCHES),/ROUTE: only implementation→dev and dev→main/u);
  assert.throws(()=>classifyPR(pr("master","feature"),LEGACY_BRANCHES),/ROUTE/);
  assert.throws(()=>classifyPR({...pr("dev","feat/task"),head:{ref:"x",repo:{full_name:"fork/repo"}}},LEGACY_BRANCHES),/SCOPE/);
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
test("PR metadata never adds pull requests to Project #5 (.github#157)",async()=>{
  const mod=await import("./pr-metadata.mjs");
  for (const name of ["ensureProjectPR","readProject","uniqueProjectItem"]) assert.equal(mod[name],undefined,name);
  const {readFile}=await import("node:fs/promises");
  const source=await readFile(new URL("./pr-metadata.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(source,/addProjectV2ItemById|projectV2\(/u);
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
test("release retries preserve manual values, never add a Project item and never change Issues",async()=>{
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
  await assert.rejects(reconcilePR(client,policy,20,SHA,{admissionClient:client,admissionConfig:{},
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[]})}),/ROUTE: only implementation→master/u,
    "no release route on canonical master");
  const options={admissionClient:client,admissionConfig:{},branches:LEGACY_BRANCHES,
    admit:async()=>({status:"INTAKE_COMPLETE",receipts:[]})};
  const one=await reconcilePR(client,policy,20,SHA,options);
  const two=await reconcilePR(client,policy,20,SHA,options);
  assert.equal(one.kind,"release");assert.equal(one.project.status,"issues-only");
  assert.equal(two.project.status,"issues-only");
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
    head:{ref,sha,repo:{full_name:repo}},base:{ref:"master",sha:"d".repeat(40),repo:{full_name:repo}},
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

// .github#268: UI-affecting frontend PRs must carry QA steps for the release QA Issue (chipin-frontend#635).
import {isUiAffectingPath,hasQaSteps,qaSteps,qaGap,prQaBlocker} from "./pr-metadata.mjs";
const shippedConfig=JSON.parse(await (await import("node:fs/promises")).readFile(new URL("./pr-metadata.config.json",import.meta.url),"utf8"));
const qa=shippedConfig.qaPolicy;
test("the shipped QA policy mirrors chipin-frontend scripts/release-qa/ui-paths.mjs",()=>{
  assert.deepEqual(qa,{prefixes:["src/","public/"],files:["index.html","app.html","vercel.json","vite.config.ts",
    "pwa-assets.config.ts","scripts/prerender-before-workbox.mjs","scripts/prerender-public.mjs",
    "scripts/private-spa-navigation.ts"],excludePrefixes:["src/test/"],testFilePrefixes:["src/"]});
});
test("UI-affecting paths follow the frontend release QA list",()=>{
  for (const path of ["src/App.tsx","src/i18n/locales/en/common.json","public/robots.txt","index.html","vercel.json",
    "scripts/private-spa-navigation.ts","public/x.test.js"]) assert.equal(isUiAffectingPath(path,qa),true,path);
  for (const path of ["src/App.test.tsx","src/test/setup.ts","docs/help.md",".github/workflows/frontend-ci.yml",
    "package.json","scripts/release-qa/core.mjs","srcx/a.ts","",null]) assert.equal(isUiAffectingPath(path,qa),false,String(path));
});
test("QA steps are a QA: line or a real item of a ## QA section, never a placeholder",()=>{
  assert.equal(hasQaSteps("## Summary\nx\n- [ ] QA: Open settings => Settings appear"),true);
  assert.equal(hasQaSteps("## QA (owner)\r\n- [ ] Create an expense: the balance changes\r\n"),true);
  assert.equal(hasQaSteps("## QA\n1. Open the landing"),true);
  assert.equal(hasQaSteps("## QA\n- None of the rows overflow at 320px"),true);
  for (const body of ["","## Summary\n- [ ] Open settings","## QA (owner)\n- [ ]\n- [ ] QA:\n- None\n- n/a (CI only)\n- None, docs only\n- - -",
    "## QA\n```\n- [ ] in a fence\n```","## QA\n<!--\n- [ ] example\n-->","## QA\n## Tests\n- [ ] npm test",
    "### QA\n- [ ] sub-heading is not the section","```\n- [ ] QA: in a fence => x\n```",null])
    assert.equal(hasQaSteps(body),false,JSON.stringify(body));
});
// Step counts chipin-frontend scripts/release-qa/core.mjs prQaSteps returns for the same bodies; a body
// passes this check exactly when the release QA Issue would list a step from it.
const QA_PARITY = [
  ["- [ ] QA: None", 0], ["- [ ] QA: n/a", 0], ["## QA\n- [ ] QA: None — docs", 0], ["- [x] QA: <>", 0],
  ["## QA\n- None\n  - Open settings", 0], ["## QA\n- <>", 0], ["## QA\n- [ ] => shows", 0],
  ["## QA\n- [ ]\n  Open settings => ok", 1], ["## QA\n1. ---", 1], ["## QA\n- a\n  - b\n- c", 2],
  ["## QA\n- a\n    ```\n    - fake\n    ```\n- c\n- - -", 2], ["## QA\n- a\n  ```npm run x``` then check\n- b", 2],
  ["## QA\n````\n```\n- x\n```\n````\n- after", 1], ["## QA\n<!--\n- hidden\n-->\n- real", 1],
  ["## Summary\n- [ ] QA: Open => ok\n## QA (owner)\n- [x] QA: Reload => no flash\n* plain\n### Sub\n- nested section item", 4],
  ["## QA\n- None of the rows overflow", 1], ["## QA\n- None, docs only\n- No QA needed: CI\n- None => x", 0],
];
test("QA step parsing agrees with the frontend release QA parser",()=>{
  for (const [body,count] of QA_PARITY) {
    assert.equal(qaSteps(body).length,count,JSON.stringify(body));
    assert.equal(hasQaSteps(body),count>0,JSON.stringify(body));
  }
});
test("only a UI-affecting PR without QA steps gets a QA blocker",()=>{
  assert.equal(qaGap(["docs/help.md",".github/workflows/x.yml","src/App.test.tsx"],"",qa),null);
  assert.equal(qaGap(["src/App.tsx"],"## QA (owner)\n- [ ] Open the app: it loads",qa),null);
  const gap=qaGap(["src/a.ts","src/b.ts","public/c.svg","index.html","docs/d.md"],"## Summary\nx",qa);
  assert.match(gap,/^QA: PR changes UI-affecting paths \(src\/a\.ts, src\/b\.ts, public\/c\.svg, \+1 more\) but its body has no QA steps; add a ## QA section with checklist steps a tester can follow/u);
  assert.doesNotMatch(gap,/owner/u);
});
test("the QA blocker reads every changed file, including the old name of a renamed file, and fails closed",async()=>{
  const client=files=>({calls:[],async listAll(path){this.calls.push(path);return files;}});
  const renamed=client([{filename:"legacy/App.tsx",previous_filename:"src/App.tsx"}]);
  assert.match(await prQaBlocker(renamed,"/repos/"+repo+"/pulls/7","",qa),/src\/App\.tsx/u);
  assert.deepEqual(renamed.calls,["/repos/"+repo+"/pulls/7/files"]);
  assert.equal(await prQaBlocker(client([{filename:"docs/a.md"}]),"/p","",qa),null);
  await assert.rejects(prQaBlocker(client([]),"/p","",qa),/QA: PR changed files are unreadable/u);
  await assert.rejects(prQaBlocker(client(null),"/p","",qa),/unreadable/u);
  await assert.rejects(prQaBlocker(client(Array.from({length:3000},()=>({filename:"docs/a.md"}))),"/p","",qa),/unreadable/u);
  assert.match(await prQaBlocker(client([{filename:"src/a.ts",previous_filename:null},{filename:"docs/b.md"}]),"/p","",qa),/src\/a\.ts/u);
});
test("an invalid QA policy fails closed before any read",async()=>{
  const policy={repository:repo,project:5,ownerPolicy:{allowIssueOwner:true,allowAuthorFallback:false},
    reviewerPolicy:{implementation:[],release:[]},qaPolicy:{prefixes:["src/"]}};
  let reads=0;
  await assert.rejects(reconcilePR({async request(){reads++;}},policy,1,"a".repeat(40)),/CONFIG: qaPolicy/u);
  assert.equal(reads,0);
});
test("reconcilePR runs the QA blocker only for implementation PRs",async()=>{
  const {readFile}=await import("node:fs/promises");
  const source=await readFile(new URL("./pr-metadata.mjs",import.meta.url),"utf8");
  const impl=source.slice(source.indexOf('if (kind==="implementation")'),source.indexOf("await verifyRelease("));
  assert.match(impl,/prQaBlocker\(client,url,pr\.body,policy\.qaPolicy\)/u);
});

// .github#278: bounded retry of the whole reconciliation and superseded-head runs.
import {runReconcile,isRetryableError,supersededHead,reportOutcome,MAX_ATTEMPTS} from "./pr-metadata.mjs";
const RUN_SHA="a".repeat(40), NEW_SHA="f".repeat(40);
const goodBody="Included implementation PRs: "+repo+"#10\nIncluded Issues: "+repo+"#5\n"
  +"## Summary\nrelease\n## Tests\nCI\n## Version impact\nnone\n## Dependencies\nnone";
// A release PR on the dev/main layout: the smallest full reconcilePR path with real writes.
function releaseRun({body=goodBody,failRequest=null}={}){
  const P="/repos/"+repo;
  const pr={number:20,node_id:"PR_20",state:"open",body,user:{login:"pr-author"},
    head:{ref:"dev",sha:RUN_SHA,repo:{full_name:repo}},base:{ref:"main",repo:{full_name:repo}},requested_reviewers:[]};
  const impl={number:10,merged_at:"2026-10-08T12:00:00Z",base:{ref:"dev"},body:"Task identity: "+repo+"#5"};
  const labels=[];const writes=[];
  const client={pr,writes,
    async graphql(){return {repository:{nameWithOwner:repo,pullRequest:{number:10,closingIssuesReferences:{totalCount:1,
      pageInfo:{hasNextPage:false,endCursor:null},nodes:[{id:"ISSUE_5",number:5,repository:{nameWithOwner:repo}}]}}}};},
    async listAll(){return [...labels];},
    async request(path,opts={}){
      const fail=failRequest?.(path,opts);if(fail)throw fail;
      if(opts.method)writes.push(opts.method+" "+path);
      if(path===P+"/pulls/20")return pr;
      if(path===P+"/pulls/10")return impl;
      if(path===P+"/issues/20")return{number:20,assignees:[{login:"human-owner"}]};
      if(path===P+"/labels/pr%3Arelease")return{name:"pr:release"};
      if(path===P+"/issues/20/labels"&&opts.method==="POST"){if(!labels.length)labels.push({name:"pr:release"});return labels;}
      throw new Error("unexpected REST request "+path);
    }};
  return client;
}
const relPolicy={repository:repo,project:5,ownerPolicy:{allowIssueOwner:true,allowAuthorFallback:false,
  implementationOwner:null,releaseOwner:null},reviewerPolicy:{implementation:[],release:[]}};
function runOpts(client,admit,extra={}){
  const sleeps=[],logs=[];
  return {sleeps,logs,opts:{admissionClient:client,admissionConfig:{},branches:LEGACY_BRANCHES,admit,
    sleep:async ms=>{sleeps.push(ms);},random:()=>0,log:line=>logs.push(line),...extra}};
}
const admitOk=async()=>({status:"INTAKE_COMPLETE",receipts:[]});

test("#278 retry classifier: races and transient transport only",()=>{
  const yes=["STALE: Issue admission changed before Development mutation: STALE: Issue/metadata/ownership/Project revision changed.",
    "STALE: PR identity/body/owner or branch changed during admission.","STALE admission receipt.",
    "PR_DRIFT: metadata changed mid-run",
    repo+"#5 BLOCKED: Second canonical read-back failed: fetch failed",
    repo+"#5 BLOCKED: STALE: canonical state changed during admission read-back: Missing Priority",
    repo+"#5 BLOCKED: STALE: admission read-back outside freshness window.",
    repo+"#5 BLOCKED: Project #5 unreadable: GET /orgs/x -> 502: bad gateway; Issue is not in Project #5",
    "fetch failed","GET /repos/x -> 503: unavailable","GraphQL -> 504: timeout","POST /repos/x -> 429: slow down",
    "GET /repos/x -> 403: {\"message\":\"You have exceeded a secondary rate limit\"}",
    "read ECONNRESET","getaddrinfo EAI_AGAIN api.github.com","connect ETIMEDOUT","UND_ERR_SOCKET other side closed",
    "Native Development link mutation failed for x: fetch failed. Check Issues write permission"];
  for (const message of yes) assert.equal(isRetryableError(new Error(message)),true,message);
  const abort=new Error("This operation was aborted");abort.name="AbortError";
  assert.equal(isRetryableError(abort),true);
  assert.equal(isRetryableError(Object.assign(new TypeError("x"),{cause:{code:"UND_ERR_CONNECT_TIMEOUT"}})),true);
  const no=["IDENTITY: exactly one canonical frontend Task identity line required",
    "CONFIG: explicit FE Project #5, owner and reviewer policy required","NATIVE_LINK: missing exact userLinkedOnly read-back",
    "ISSUE_STATE: changed during reconciliation","ADMISSION: read-only org credential and canonical config required",
    "SHA: event head no longer matches PR","PR: unreadable or not open","NATIVE_IDENTITY: PR linked-Issue read is unavailable",
    repo+"#5 BLOCKED: Missing Priority; STALE: admission read-back outside freshness window.",
    repo+"#5 BLOCKED: Native Issue unreadable: GET /repos/x/issues/5 -> 403: Resource not accessible",
    "GET /repos/x -> 404: Not Found","POST /repos/x -> 422: Validation Failed","GET /repos/x -> 403: Forbidden",
    "GET /rate_limit -> 403: API rate limit exceeded","LABEL: failed read-back"];
  for (const message of no) assert.equal(isRetryableError(new Error(message)),false,message);
});
test("#278 a STALE race is retried and the next attempt succeeds",async()=>{
  const client=releaseRun();let calls=0;
  const {sleeps,logs,opts}=runOpts(client,async()=>{
    if(++calls===1)throw new Error(repo+"#5 BLOCKED: STALE: canonical state changed during admission read-back: x");
    return admitOk();});
  const result=await runReconcile(client,relPolicy,20,RUN_SHA,opts);
  assert.equal(result.outcome,"ok");assert.equal(result.attempts,2);
  assert.deepEqual(result.receipt.blockers,[]);
  assert.deepEqual(sleeps,[2000]);
  assert.equal(logs.length,1);assert.match(logs[0],/^::warning title=PR metadata retry::attempt 1 of 3 failed/u);
  assert.equal(reportOutcome(result,{log:()=>{},error:()=>{}}),0);
});
test("#278 a transient fetch failure is retried and the next attempt succeeds",async()=>{
  let failed=false;
  const client=releaseRun({failRequest:(path,opts)=>{
    if(!failed&&opts.method==="POST"&&path.endsWith("/issues/20/labels")){failed=true;return new TypeError("fetch failed");}
    return null;}});
  const {sleeps,opts}=runOpts(client,admitOk);
  const result=await runReconcile(client,relPolicy,20,RUN_SHA,opts);
  assert.equal(result.outcome,"ok");assert.equal(result.attempts,2);assert.deepEqual(sleeps,[2000]);
  assert.deepEqual(client.writes,["POST /repos/"+repo+"/issues/20/labels"]); // idempotent: one successful add
});
test("#278 retries stop after exactly MAX_ATTEMPTS and still fail with the attempt count",async()=>{
  const client=releaseRun();let calls=0;
  const {sleeps,logs,opts}=runOpts(client,async()=>{calls++;throw new Error("STALE: PR identity/body/owner or branch changed during admission.");});
  const result=await runReconcile(client,relPolicy,20,RUN_SHA,opts);
  assert.equal(MAX_ATTEMPTS,3);
  assert.equal(result.outcome,"blocked");assert.equal(result.attempts,3);assert.equal(calls,3);
  assert.deepEqual(sleeps,[2000,5000]);assert.equal(logs.length,2);
  const errors=[];
  assert.equal(reportOutcome(result,{log:()=>{},error:x=>errors.push(x)}),1);
  assert.match(errors[0],/^PR METADATA BLOCKED: STALE: PR identity.* \(after 3 attempts; retries exhausted\)$/u);
});
test("#278 a receipt with blockers is never retried",async()=>{
  const client=releaseRun({body:goodBody.replace("## Tests\nCI\n","")});
  const {sleeps,opts}=runOpts(client,admitOk);
  const result=await runReconcile(client,relPolicy,20,RUN_SHA,opts);
  assert.equal(result.outcome,"blocked");assert.equal(result.attempts,1);assert.deepEqual(sleeps,[]);
  assert.match(result.receipt.blockers.join("\n"),/BODY: missing ## Tests/u);
  const errors=[];
  assert.equal(reportOutcome(result,{log:()=>{},error:x=>errors.push(x)}),1);
  assert.match(errors[0],/^PR METADATA BLOCKED: receipt blockers \(after 1 attempt; not retryable\)/u);
});
test("#278 a non-retryable IDENTITY error fails on the first attempt",async()=>{
  const pr=dependencyPR({login:"human",ref:"feat/issue-9-no-marker",sha:RUN_SHA});
  const client=recordingClient(pr);
  const {sleeps,opts}=runOpts(client,admitOk,{branches:undefined});
  const result=await runReconcile(client,feOnlyPolicy,463,RUN_SHA,opts);
  assert.equal(result.outcome,"blocked");assert.equal(result.attempts,1);assert.deepEqual(sleeps,[]);
  assert.match(result.error.message,/^IDENTITY:/u);
  const errors=[];reportOutcome(result,{log:()=>{},error:x=>errors.push(x)});
  assert.match(errors[0],/^PR METADATA BLOCKED: IDENTITY: .* \(after 1 attempt; not retryable\)$/u);
});
test("#278 a newer PR head at the early SHA gate ends the run as superseded (exit 0)",async()=>{
  const client=recordingClient(dependencyPR({login:"human",ref:"feat/x",sha:NEW_SHA}));
  const {sleeps,opts}=runOpts(client,async()=>{throw new Error("must not admit");},{branches:undefined});
  const result=await runReconcile(client,feOnlyPolicy,463,RUN_SHA,opts);
  assert.equal(result.outcome,"superseded");assert.equal(result.attempts,1);assert.deepEqual(sleeps,[]);
  assert.equal(result.eventSha,RUN_SHA);assert.equal(result.currentSha,NEW_SHA);
  assert.equal(client.calls.filter(x=>x.method!=="GET").length,0);
  const logs=[];
  assert.equal(reportOutcome(result,{log:x=>logs.push(x),error:()=>assert.fail("no error line")}),0);
  assert.equal(logs.length,1);
  assert.match(logs[0],new RegExp("^::notice title=PR metadata superseded::PR METADATA SUPERSEDED: PR #463 event head "+RUN_SHA+" .*current head is "+NEW_SHA+"\\. The PR metadata run for the current head decides","u"));
});
test("#278 a head change during the run (STALE) is detected as superseded, not retried",async()=>{
  const pr=dependencyPR({login:"human",ref:"feat/x",sha:RUN_SHA});
  const client=recordingClient(pr);
  const {sleeps,opts}=runOpts(client,async()=>{pr.head={...pr.head,sha:NEW_SHA};
    throw new Error("STALE: PR head SHA changed since the invoking workflow event.");},{branches:undefined});
  const result=await runReconcile(client,feOnlyPolicy,463,RUN_SHA,opts);
  assert.equal(result.outcome,"superseded");assert.equal(result.attempts,1);assert.deepEqual(sleeps,[]);
  assert.equal(result.currentSha,NEW_SHA);
});
test("#278 an invalid event SHA, a closed PR or an unreadable PR still fails",async()=>{
  for (const expected of ["","not-a-sha","A".repeat(40),undefined]) {
    const client=recordingClient(dependencyPR({login:"human",ref:"feat/x",sha:NEW_SHA}));
    const {opts}=runOpts(client,admitOk,{branches:undefined});
    const result=await runReconcile(client,feOnlyPolicy,463,expected,opts);
    assert.equal(result.outcome,"blocked",String(expected));assert.equal(result.attempts,1);
    assert.match(result.error.message,/^SHA:/u);
  }
  const closed=recordingClient({...dependencyPR({login:"human",ref:"feat/x",sha:NEW_SHA}),state:"closed"});
  const {opts}=runOpts(closed,admitOk,{branches:undefined});
  const result=await runReconcile(closed,feOnlyPolicy,463,RUN_SHA,opts);
  assert.equal(result.outcome,"blocked");assert.match(result.error.message,/^PR: unreadable or not open/u);
  assert.equal(await supersededHead({async request(){throw new TypeError("fetch failed");}},463,RUN_SHA),null);
  assert.equal(await supersededHead(recordingClient(dependencyPR({login:"human",ref:"feat/x",sha:"zz"})),463,RUN_SHA),null);
});

// .github#278 review R1.
import {githubFetch,escapeCommand,RETRY_AFTER_CAP_MS} from "./pr-metadata.mjs";
import {ADMISSION_CONTRACT} from "./issue-admission.mjs";
test("#278 output lines cannot inject workflow commands",()=>{
  const lines=[];const out={log:x=>lines.push(...String(x).split("\n")),error:x=>lines.push(...String(x).split("\n"))};
  const evil="QA: PR changes UI-affecting paths (src/a\n::error::x.tsx%0A) but its body has no QA steps";
  reportOutcome({outcome:"blocked",number:20,attempts:1,receipt:{number:20,blockers:[evil,"BODY: x\r\n::warning::y"]}},out);
  reportOutcome({outcome:"blocked",number:20,attempts:3,retryable:true,error:new Error("STALE: a\n::error::x")},out);
  reportOutcome({outcome:"superseded",number:20,attempts:1,eventSha:RUN_SHA,currentSha:NEW_SHA,error:new Error("SHA: x\n::error::x")},out);
  reportOutcome({outcome:"ok",number:463,attempts:1,receipt:{number:463,status:"SKIPPED",blockers:[],
    reason:"dependabot PR (author dependabot[bot], head dependabot/x%0A::error::y\n::error::z)"}},out);
  const commands=lines.filter(line=>line.startsWith("::"));
  assert.ok(commands.length===2,JSON.stringify(commands));
  assert.match(commands[0],/^::notice title=PR metadata superseded::/u);
  assert.match(commands[1],/^::notice title=PR metadata skipped::/u);
  assert.ok(lines.some(line=>line.includes("src/a%0A::error::x.tsx%250A")),"newline and % are escaped");
  assert.equal(escapeCommand("a%b\r\nc"),"a%25b%0D%0Ac");
});
test("#278 workflow_dispatch with a wrong SHA still fails instead of ending as superseded",async()=>{
  const client=recordingClient(dependencyPR({login:"human",ref:"feat/x",sha:NEW_SHA}));
  const {opts}=runOpts(client,admitOk,{branches:undefined,eventName:"workflow_dispatch"});
  const result=await runReconcile(client,feOnlyPolicy,463,RUN_SHA,opts);
  assert.equal(result.outcome,"blocked");assert.equal(result.attempts,1);
  assert.match(result.error.message,/^SHA: event head no longer matches PR/u);
  const pr2=recordingClient(dependencyPR({login:"human",ref:"feat/x",sha:NEW_SHA}));
  const other=await runReconcile(pr2,feOnlyPolicy,463,RUN_SHA,runOpts(pr2,admitOk,{branches:undefined,eventName:"pull_request"}).opts);
  assert.equal(other.outcome,"superseded");
});
test("#278 HTTP 500, GraphQL 'Something went wrong' and GraphQL rate limits are transient",()=>{
  for (const message of ["GET /repos/x -> 500: oops","GraphQL -> 500: oops",
    "Something went wrong while executing your query. Please include `ABC` when reporting this issue.",
    "Native Development relationship state is unreadable: API rate limit already exceeded for user ID 1.",
    "RATE_LIMITED: API rate limit exceeded"])
    assert.equal(isRetryableError(new Error(message)),true,message);
  assert.equal(isRetryableError(new Error("GET /repos/x -> 403: {\"message\":\"API rate limit exceeded for x\"}")),false);
});
test("#278 Retry-After is honoured for rate limits, capped, otherwise the normal backoff",async()=>{
  for (const [message,hint,expected] of [
    ["GET /repos/x -> 429: slow",12000,12000],
    ["GET /repos/x -> 403: You have exceeded a secondary rate limit",90000,RETRY_AFTER_CAP_MS],
    ["GET /repos/x -> 429: slow",null,2000],
    ["GET /repos/x -> 429: slow",500,2000],
    ["fetch failed",12000,2000]]) {
    let calls=0,hints=[null,hint];
    const sleeps=[];
    await runReconcile({async request(){return null;}},relPolicy,20,RUN_SHA,{sleep:async ms=>{sleeps.push(ms);},random:()=>0,log:()=>{},
      retryAfter:()=>hints.shift()??null,
      reconcile:async()=>{if(++calls===1)throw new Error(message);return {number:20,blockers:[]};}});
    assert.deepEqual(sleeps,[expected],message+" "+hint);
  }
});
test("#278 githubFetch adds a request timeout only when no signal is given and reports Retry-After",async()=>{
  const seen=[],hints=[];
  const fake=async(url,init)=>{seen.push(init);return {status:url.endsWith("/limited")?429:200,headers:new Headers({"retry-after":"7"})};};
  const wrapped=githubFetch({fetchImpl:fake,timeoutMs:1000,onRetryAfter:ms=>hints.push(ms)});
  await wrapped("https://api.github.com/x",{method:"GET"});
  assert.ok(seen[0].signal instanceof AbortSignal);assert.equal(seen[0].method,"GET");
  const own=new AbortController().signal;
  await wrapped("https://api.github.com/y",{signal:own});
  assert.equal(seen[1].signal,own);
  assert.deepEqual(hints,[]);
  await wrapped("https://api.github.com/limited");
  assert.deepEqual(hints,[7000]);
  // deterministic timeout: a fake signal that is already aborted with the TimeoutError AbortSignal.timeout uses
  const timedOut=()=>{const c=new AbortController();c.abort(new DOMException("The operation was aborted due to timeout","TimeoutError"));return c.signal;};
  const slow=githubFetch({fetchImpl:(url,init)=>Promise.reject(init.signal.reason),timeoutMs:30000,timeoutSignal:ms=>{assert.equal(ms,30000);return timedOut();}});
  await assert.rejects(slow("https://api.github.com/z"),error=>error.name==="TimeoutError" && isRetryableError(error));
});

// The implementation path with the real reconcileDevelopmentLink under retry.
const REVISION="1".repeat(64);
const implBody="Task identity: "+repo+"#5\n## Summary\nx\n## Tests\nx\n## Version impact\nnone\n## Dependencies\nnone";
function implementationRun({failFirstMutation=false}={}){
  const P="/repos/"+repo;
  const pr={number:30,node_id:"PR_30",state:"open",body:implBody,user:{login:"syllik"},
    head:{ref:"feat/issue-5-x",sha:RUN_SHA,repo:{full_name:repo}},base:{ref:"master",sha:"d".repeat(40),repo:{full_name:repo}},
    requested_reviewers:[],requested_teams:[]};
  const state={linked:false,mutations:0};const labels=[];
  const prNode={id:"PR_30",number:30,url:"https://github.com/"+repo+"/pull/30",repository:{nameWithOwner:repo},body:implBody};
  const client={state,
    async graphql(query){
      if (query.includes("mutation AddNativeDevelopmentLink")) {
        state.mutations++;state.linked=true;
        if (failFirstMutation && state.mutations===1) throw new Error("GraphQL -> 502: Bad Gateway");
        return {addCloseIssueReferences:{issue:{id:"ISSUE_5",number:5,url:"u",repository:{nameWithOwner:repo}}}};
      }
      const links=state.linked?[prNode]:[];
      if (query.includes("query PRNativeIdentity")) return {repository:{nameWithOwner:repo,pullRequest:{number:30,
        closingIssuesReferences:{totalCount:links.length,pageInfo:{hasNextPage:false,endCursor:null},
          nodes:state.linked?[{id:"ISSUE_5",number:5,repository:{nameWithOwner:repo}}]:[]}}}};
      if (query.includes("query DevelopmentLinkPullRequest")) return {repository:{nameWithOwner:repo,pullRequest:prNode}};
      if (query.includes("query DevelopmentLinkTarget")) return {repository:{nameWithOwner:repo,
        taskIssue:{id:"ISSUE_5",number:5,url:"u",repository:{nameWithOwner:repo},
          closedByPullRequestsReferences:{totalCount:links.length,pageInfo:{hasNextPage:false,endCursor:null},nodes:links}},
        implementationPr:prNode}};
      throw new Error("unexpected graphql "+query.slice(0,60));
    },
    async listAll(){return [...labels];},
    async request(path,opts={}){
      if(path===P+"/pulls/30")return pr;
      if(path===P+"/issues/5")return {number:5,state:"open",state_reason:null,assignees:[{login:"syllik"}]};
      if(path===P+"/issues/30")return {number:30,assignees:[{login:"syllik"}]};
      if(path===P+"/labels/pr%3Aimplementation")return {name:"pr:implementation"};
      if(path===P+"/issues/30/labels"&&opts.method==="POST"){if(!labels.length)labels.push({name:"pr:implementation"});return labels;}
      throw new Error("unexpected REST request "+path);
    }};
  return client;
}
const liveReceipt=()=>({contractVersion:ADMISSION_CONTRACT,status:"INTAKE_COMPLETE",issue:repo+"#5",revision:REVISION,
  checkedAt:new Date().toISOString(),blockers:[]});
const admitImpl=async()=>({status:"INTAKE_COMPLETE",receipts:[liveReceipt()]});
test("#278 implementation: a 502 after the link mutation applied retries into the already-linked path",async()=>{
  const client=implementationRun({failFirstMutation:true});
  const {sleeps,opts}=runOpts(client,admitImpl,{branches:undefined,readAdmission:async()=>({blockers:[],receipt:liveReceipt()})});
  const result=await runReconcile(client,feOnlyPolicy,30,RUN_SHA,opts);
  assert.equal(result.outcome,"ok",result.error?.message);
  assert.equal(result.attempts,2);assert.deepEqual(sleeps,[2000]);
  assert.equal(client.state.mutations,1,"exactly one addCloseIssueReferences across attempts");
  assert.equal(result.receipt.taskIdentity,repo+"#5");
});
test("#278 implementation: a dev-link STALE with a real admission blocker is retried once, then fails",async()=>{
  const client=implementationRun();let admits=0;
  const {sleeps,opts}=runOpts(client,async()=>{
    if(++admits===1)return admitImpl();
    throw new Error(repo+"#5 BLOCKED: Issue Priority is missing");
  },{branches:undefined,readAdmission:async()=>({blockers:["Issue Priority is missing"],receipt:liveReceipt()})});
  const result=await runReconcile(client,feOnlyPolicy,30,RUN_SHA,opts);
  assert.equal(result.outcome,"blocked");assert.equal(result.attempts,2);assert.equal(result.retryable,false);
  assert.deepEqual(sleeps,[2000]);
  assert.equal(client.state.mutations,0);
  assert.match(result.error.message,/BLOCKED: Issue Priority is missing$/u);
});
test("#278 reportOutcome prints the SKIPPED receipt and exits 0",async()=>{
  const client=recordingClient(dependencyPR());
  const result=await runReconcile(client,feOnlyPolicy,463,RUN_SHA,runOpts(client,admitOk,{branches:undefined}).opts);
  assert.equal(result.outcome,"ok");
  const logs=[];
  assert.equal(reportOutcome(result,{log:x=>logs.push(x),error:()=>assert.fail("no error")}),0);
  assert.equal(JSON.parse(logs[0]).status,"SKIPPED");
  assert.match(logs[1],/^PR METADATA SKIPPED: PR #463 is a dependabot PR/u);
  assert.match(logs[2],/^::notice title=PR metadata skipped::PR METADATA SKIPPED: /u);
});

test("#278 a Retry-After hint from an earlier attempt is not reused",async()=>{
  // per attempt retryAfter() is read twice: at the start (discarded) and after the failure
  const hints=[null,20000,15000,null];const sleeps=[];let calls=0;
  const result=await runReconcile({async request(){return null;}},relPolicy,20,RUN_SHA,{sleep:async ms=>{sleeps.push(ms);},
    random:()=>0,log:()=>{},retryAfter:()=>hints.shift()??null,
    reconcile:async()=>{calls++;throw new Error("GET /repos/x -> 429: slow down");}});
  assert.deepEqual(sleeps,[20000,5000]);
  assert.equal(calls,3);assert.equal(result.outcome,"blocked");assert.equal(result.attempts,3);
});
test("#278 no new attempt starts past the retry budget",async()=>{
  let clock=0;const sleeps=[];let calls=0;
  const result=await runReconcile({async request(){return null;}},relPolicy,20,RUN_SHA,{sleep:async ms=>{sleeps.push(ms);clock+=ms;},
    random:()=>0,log:()=>{},now:()=>clock,budgetMs:6*60_000,
    reconcile:async()=>{calls++;clock+=6*60_000-1000;throw new Error("fetch failed");}}); // 5:59 elapsed + 2 s wait > 6 min
  assert.equal(calls,1);assert.deepEqual(sleeps,[]);
  assert.equal(result.outcome,"blocked");assert.equal(result.budgetExhausted,true);
  const errors=[];reportOutcome(result,{log:()=>{},error:x=>errors.push(x)});
  assert.match(errors[0],/^PR METADATA BLOCKED: fetch failed \(after 1 attempt; retry budget exhausted\)$/u);
  clock=0;calls=0;
  const within=await runReconcile({async request(){return null;}},relPolicy,20,RUN_SHA,{sleep:async ms=>{clock+=ms;},
    random:()=>0,log:()=>{},now:()=>clock,
    reconcile:async()=>{if(++calls===1){clock+=60_000;throw new Error("fetch failed");}return {number:20,blockers:[]};}});
  assert.equal(within.outcome,"ok");assert.equal(within.attempts,2);
});
