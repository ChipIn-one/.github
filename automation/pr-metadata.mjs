import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GitHubClient } from "./github-metadata.mjs";
import { reconcileDevelopmentLink, readTaskIdentityMarker } from "./development-link.mjs";

const REPO = "ChipIn-one/chipin-frontend";
const ROOT = "/repos/" + REPO;
const PROJECT = 5;
const CATEGORIES = { implementation: "pr:implementation", release: "pr:release" };
const PROJECT_QUERY = 'query PRMembership($after:String){ organization(login:"ChipIn-one"){ projectV2(number:5){id items(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id content{__typename ... on PullRequest{id number repository{nameWithOwner}}}}}}}}';
const PROJECT_ADD = 'mutation AddPR($project:ID!,$pr:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$pr}){item{id}}}';
const FULL_REF = /^ChipIn-one\/chipin-frontend#([1-9]\d*)$/u;

export function classifyPR(pr) {
  if (pr.base?.repo?.full_name !== REPO || pr.head?.repo?.full_name !== REPO) throw new Error("SCOPE: same-repo frontend PR only");
  if (pr.base.ref === "dev" && !["main", "dev"].includes(pr.head.ref)) return "implementation";
  if (pr.base.ref === "main" && pr.head.ref === "dev") return "release";
  throw new Error("ROUTE: only implementation→dev and dev→main");
}
export function implementationIdentity(body) {
  const identity = readTaskIdentityMarker(body);
  if (!identity || identity.repository !== REPO) throw new Error("IDENTITY: exactly one canonical frontend Task identity line required");
  return identity;
}
export function releaseReferences(body) {
  if (readTaskIdentityMarker(body)) throw new Error("RELEASE: release is not a single Task identity");
  const lines = String(body ?? "").split(/\r?\n/u);
  function field(name) {
    const hit = lines.filter(line => line.startsWith(name + ":"));
    if (hit.length !== 1) throw new Error("RELEASE: exactly one " + name + ": line required");
    const refs = hit[0].slice(name.length + 1).split(",").map(x=>x.trim());
    if (!refs.length || refs.some(x=>!FULL_REF.test(x)) || new Set(refs).size !== refs.length)
      throw new Error("RELEASE: invalid, ambiguous or duplicate " + name + " references");
    return refs.map(x=>Number(FULL_REF.exec(x)[1]));
  }
  return { prs:field("Included implementation PRs"), issues:field("Included Issues") };
}
export function bodyGaps(body) {
  return ["Summary","Tests","Version impact","Dependencies"].filter(
    key=>!new RegExp("^## "+key+"\\s*$","miu").test(String(body??""))
  ).map(key=>"BODY: missing ## "+key+" (preserve human edits; add manually)");
}
export function chooseOwner({manual=[],issue=[],approved=null,author=null,allowAuthor=false}) {
  if (manual.length) return null;
  if (issue.length>1) throw new Error("OWNER_POLICY: multiple Issue assignees, manual decision required");
  const owner = issue[0] ?? approved ?? (allowAuthor ? author : null);
  if (!owner) throw new Error("OWNER_POLICY: no Issue owner or approved repository/release owner; assign Issue or configure explicit owner");
  return owner;
}
export function chooseReviewer({manual=[],approved=[],author}) {
  if (manual.length) return null;
  if (approved.length!==1) throw new Error("REVIEWER_POLICY: configure exactly one approved reviewer; no inference");
  if (approved[0]===author || !approved[0]) throw new Error("REVIEWER_POLICY: no self-review");
  return approved[0];
}
export function uniqueProjectItem(items, id) {
  const selected=items.filter(x=>x?.content?.__typename==="PullRequest" && x.content.id===id);
  if (selected.length>1) throw new Error("PROJECT: duplicate PR membership, manual reconciliation required");
  return selected[0]??null;
}
export async function readProject(client) {
  const items=[];const seen=new Set(); let cursor=null, projectId=null, count=null;
  do {
    const result=await client.graphql(PROJECT_QUERY,{after:cursor});
    const p=result?.organization?.projectV2;
    if (!p?.id || !p.items?.pageInfo || !Array.isArray(p.items.nodes) || !Number.isInteger(p.items.totalCount))
      throw new Error("PROJECT_PERMISSION: Project #5 unreadable; needs organization Projects read/write grant");
    if (projectId && projectId!==p.id) throw new Error("PROJECT: project changed mid-read");
    if (count!==null && count!==p.items.totalCount) throw new Error("PROJECT: membership changed mid-read");
    projectId=p.id;count=p.items.totalCount;
    for (const item of p.items.nodes) {
      if (!item?.id || seen.has(item.id)) throw new Error("PROJECT: duplicate or missing item ID");
      seen.add(item.id);items.push(item);
    }
    if (p.items.pageInfo.hasNextPage && (!p.items.pageInfo.endCursor || cursor===p.items.pageInfo.endCursor))
      throw new Error("PROJECT: broken pagination");
    cursor=p.items.pageInfo.hasNextPage?p.items.pageInfo.endCursor:null;
  }while(cursor);
  if (items.length!==count) throw new Error("PROJECT: incomplete pagination");
  return {id:projectId,items};
}
export async function ensureProjectPR(client,prId) {
  const before=await readProject(client);
  const existing=uniqueProjectItem(before.items,prId);
  if (!existing) {
    const added=await client.graphql(PROJECT_ADD,{project:before.id,pr:prId});
    if (!added?.addProjectV2ItemById?.item?.id) throw new Error("PROJECT: membership write not confirmed");
  }
  const after=await readProject(client);
  const found=uniqueProjectItem(after.items,prId);
  if (!found) throw new Error("PROJECT: missing PR item on read-back");
  return {id:found.id,created:!existing,readBack:true};
}
async function verifyRelease(client,refs) {
  const issues=[];
  for (const num of refs.prs) {
    const impl=await client.request(ROOT+"/pulls/"+num);
    if (!impl?.merged_at || impl.base?.ref!=="dev") throw new Error("RELEASE: PR #"+num+" not merged into dev");
    issues.push(implementationIdentity(impl.body).issueNumber);
  }
  if ([...new Set(issues)].sort((a,b)=>a-b).join(",")!==[...refs.issues].sort((a,b)=>a-b).join(","))
    throw new Error("RELEASE: listed Issue set does not match included PR identities");
}
async function ensureCategory(client,prNumber,kind) {
  const label=CATEGORIES[kind];
  if (!await client.request(ROOT+"/labels/"+encodeURIComponent(label),{allow404:true})) {
    await client.request(ROOT+"/labels",{method:"POST",body:{name:label,color:kind==="release"?"0366d6":"0e8a16",description:"ChipIn PR category"}});
  }
  const current=await client.request(ROOT+"/issues/"+prNumber+"/labels");
  if (!Array.isArray(current)) throw new Error("LABEL: unreadable existing labels");
  if (!current.some(x=>x.name===label)) await client.request(ROOT+"/issues/"+prNumber+"/labels",{method:"POST",body:{labels:[label]}});
  const final=await client.request(ROOT+"/issues/"+prNumber+"/labels");
  if (!Array.isArray(final)||!final.some(x=>x.name===label)) throw new Error("LABEL: failed read-back");
}
async function assignable(client,login) {
  if (!/^[a-z\d][a-z\d-]{0,38}$/iu.test(login)) throw new Error("OWNER_POLICY: invalid login");
  await client.request(ROOT+"/assignees/"+login);
}
async function eligibleReviewer(client,login) {
  if (!/^[a-z\d][a-z\d-]{0,38}$/iu.test(login)) throw new Error("REVIEWER_POLICY: invalid login");
  const p=await client.request(ROOT+"/collaborators/"+login+"/permission");
  if (!["write","maintain","admin"].includes(p?.permission)) throw new Error("REVIEWER_POLICY: reviewer lacks write-or-higher collaborator eligibility");
}
async function shaCIGreen(client,sha) {
  const checks=await client.request(ROOT+"/commits/"+sha+"/check-runs?per_page=100");
  if (!Array.isArray(checks?.check_runs)) throw new Error("REVIEW_CI: SHA check-runs unreadable");
  return checks.check_runs.some(x=>x.head_sha===sha&&x.name==="frontend-ci"&&x.status==="completed"&&x.conclusion==="success");
}
export async function reconcilePR(client,policy,number,expectedSha) {
  if (policy?.repository!==REPO || policy.project!==PROJECT || policy.ownerPolicy?.allowIssueOwner!==true
      || !Array.isArray(policy.reviewerPolicy?.implementation) || !Array.isArray(policy.reviewerPolicy?.release))
    throw new Error("CONFIG: explicit FE Project #5, owner and reviewer policy required");
  const n=Number(number);
  if (!Number.isSafeInteger(n)||n<=0) throw new Error("PR: invalid PR number");
  const url=ROOT+"/pulls/"+n;
  const pr=await client.request(url);
  if (pr?.number!==n || pr.state!=="open" || !pr.node_id || !pr.head?.sha) throw new Error("PR: unreadable or not open");
  if (!expectedSha || pr.head.sha!==expectedSha) throw new Error("SHA: event head no longer matches PR");
  const kind=classifyPR(pr);
  const blockers=bodyGaps(pr.body);
  let issue=null,taskIdentity=null;
  if (kind==="implementation") {
    const identity=implementationIdentity(pr.body);
    const native=await reconcileDevelopmentLink(client,{repository:REPO,pullRequestNumber:n});
    if (!native.readBackConfirmed || native.issueNumber!==identity.issueNumber) throw new Error("NATIVE_LINK: missing exact userLinkedOnly read-back");
    issue=await client.request(ROOT+"/issues/"+identity.issueNumber);
    if (issue?.number!==identity.issueNumber || issue.pull_request) throw new Error("IDENTITY: target is not an Issue");
    taskIdentity=identity.canonical;
  } else {
    await verifyRelease(client,releaseReferences(pr.body));
  }
  const fresh=await client.request(url);
  if (fresh.head?.sha!==pr.head.sha || fresh.body!==pr.body || fresh.state!=="open") throw new Error("PR_DRIFT: metadata changed mid-run");
  await ensureCategory(client,n,kind);
  const project=await ensureProjectPR(client,pr.node_id);
  const prIssue=await client.request(ROOT+"/issues/"+n);
  const currentOwners=(prIssue.assignees??[]).map(x=>x.login);
  const issueOwners=issue?(issue.assignees??[]).map(x=>x.login):[];
  try {
    const selected=chooseOwner({manual:currentOwners,issue:issueOwners,
      approved:kind==="release"?policy.ownerPolicy.releaseOwner:policy.ownerPolicy.implementationOwner,
      author:pr.user?.login,allowAuthor:policy.ownerPolicy.allowAuthorFallback===true});
    if (selected) {
      await assignable(client,selected);
      await client.request(ROOT+"/issues/"+n+"/assignees",{method:"POST",body:{assignees:[selected]}});
      if (!(await client.request(ROOT+"/issues/"+n)).assignees?.some(x=>x.login===selected)) throw new Error("OWNER_READ_BACK: missing");
    }
  } catch (e) {blockers.push(e.message);}
  const reviewers=(await client.request(url)).requested_reviewers??[];
  try {
    const selected=chooseReviewer({manual:reviewers.map(x=>x.login),
      approved:policy.reviewerPolicy[kind],author:pr.user?.login});
    if (selected) {
      if (!await shaCIGreen(client,pr.head.sha)) {
        blockers.push("REVIEW_CI: no successful frontend-ci on current head "+pr.head.sha+"; request deferred");
      } else {
        await eligibleReviewer(client,selected);
        await client.request(ROOT+"/pulls/"+n+"/requested_reviewers",{method:"POST",body:{reviewers:[selected]}});
        if (!(await client.request(url)).requested_reviewers?.some(x=>x.login===selected)) throw new Error("REVIEW_READ_BACK: missing");
      }
    }
  } catch(e) {blockers.push(e.message);}
  const last=await client.request(url);
  if (last.head?.sha!==pr.head.sha) throw new Error("SHA: PR changed before receipt");
  if (!uniqueProjectItem((await readProject(client)).items,pr.node_id)) throw new Error("PROJECT: membership disappeared");
  if (issue) {
    const afterIssue=await client.request(ROOT+"/issues/"+issue.number);
    if (afterIssue.state!==issue.state || afterIssue.state_reason!==issue.state_reason)
      throw new Error("ISSUE_STATE: changed during reconciliation; task completion is exclusively Issue-owned");
  }
  return {number:n,kind,headSha:pr.head.sha,taskIdentity,project,blockers,issueStateUnchanged:true};
}
async function main(){
  const {readFile}=await import("node:fs/promises");
  const policy=JSON.parse(await readFile(new URL("./pr-metadata.config.json",import.meta.url),"utf8"));
  const client=new GitHubClient(process.env.CHIPIN_PR_METADATA_TOKEN || process.env.GITHUB_TOKEN);
  const receipt=await reconcilePR(client,policy,process.env.CHIPIN_PR_NUMBER,process.env.CHIPIN_PR_SHA);
  console.log(JSON.stringify(receipt,null,2));
  if (receipt.blockers.length) process.exitCode=1;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(e=>{console.error("PR METADATA BLOCKED: "+e.message);process.exitCode=1;});
