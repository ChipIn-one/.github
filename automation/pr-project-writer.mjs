#!/usr/bin/env node
// Central Project #5 writer: org-only credential, no FE project token.
// FE's label is a request for verification, never write authorization.
import process from "node:process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { GitHubClient } from "./github-metadata.mjs";
import { preflightPr } from "./issue-admission-pr.mjs";
import { readAdmission, assertFreshReceipt } from "./issue-admission.mjs";
import { classifyPR, implementationIdentity, releaseReferences, assertSingleNativeIssue, verifyRelease, ensureProjectPR } from "./pr-metadata.mjs";

const REPO="ChipIn-one/chipin-frontend";
const ROOT="/repos/"+REPO;
const VALID=new Map([["implementation","pr:implementation"],["release","pr:release"]]);

function prIdentity(pr) {
  return JSON.stringify({number:pr?.number,state:pr?.state,body:pr?.body,
    head:{sha:pr?.head?.sha,ref:pr?.head?.ref,repo:pr?.head?.repo?.full_name},
    base:{sha:pr?.base?.sha,ref:pr?.base?.ref,repo:pr?.base?.repo?.full_name}});
}

export async function reconcileProjectPR({reader,writer,config,number,expectedSha,
  admit=preflightPr,reread=readAdmission,verifyNative=assertSingleNativeIssue,verifyIncluded=verifyRelease}) {
  if (!Number.isInteger(number)||number<=0 || !/^[a-f0-9]{40}$/.test(expectedSha||""))
    throw new Error("PROJECT_REQUEST: exact PR identity and SHA required");
  const pr=await reader.request(ROOT+"/pulls/"+number);
  if (pr?.number!==number||pr.state!=="open"||pr.head?.sha!==expectedSha||!pr.node_id)
    throw new Error("PROJECT_REQUEST: PR missing, closed or stale");
  const kind=classifyPR(pr);
  const label=VALID.get(kind);
  // Read all REST label pages; category conflicts hidden after page one must block.
  const labels=await reader.listAll(ROOT+"/issues/"+number+"/labels");
  if(!Array.isArray(labels)||labels.some(x=>!x?.name))
    throw new Error("PROJECT_REQUEST: unreadable PR category labels");
  const names=labels.map(x=>x.name);
  if (!names.includes(label)) throw new Error("PROJECT_REQUEST: verified category label missing");
  if (names.includes(VALID.get(kind==="implementation"?"release":"implementation")))
    throw new Error("PROJECT_REQUEST: contradictory PR category labels");

  const admitted=await admit({client:reader,config,repository:REPO,number,expectedHeadSha:expectedSha});
  if (kind==="implementation") {
    const identity=implementationIdentity(pr.body);
    await verifyNative(reader,number,identity.issueNumber,true);
  } else {
    await verifyIncluded(reader,releaseReferences(pr.body));
  }
  let latest=await reader.request(ROOT+"/pulls/"+number);
  if(prIdentity(latest)!==prIdentity(pr)) throw new Error("PROJECT_REQUEST: PR drifted during validation");

  // Re-read *each* admitted Issue/Project revision at the mutation boundary.
  // Preserve the refreshed receipts: the initial preflight receipt may age out
  // while many Issues, native links and paginated labels are being checked.
  const refreshed=[];
  for(const receipt of admitted.receipts) {
    const number=Number(receipt.issue.split("#")[1]);
    const result=await reread({
      client:reader,config,repository:REPO,number,
      selectedOwner:"syllik",expectedRevision:receipt.revision
    });
    if(result.blockers?.length) throw new Error("PROJECT_ADMISSION: "+receipt.issue+" "+result.blockers.join("; "));
    assertFreshReceipt(result.receipt,{issue:receipt.issue,revision:receipt.revision});
    refreshed.push({receipt:result.receipt,issue:receipt.issue,revision:receipt.revision});
  }
  latest=await reader.request(ROOT+"/pulls/"+number);
  if(prIdentity(latest)!==prIdentity(pr)) throw new Error("PROJECT_REQUEST: PR drifted during final admission");

  // A PR's label may change during admission. Check all pages again on the
  // Project write boundary; a late conflicting or removed category blocks.
  const finalLabels=await reader.listAll(ROOT+"/issues/"+number+"/labels");
  if(!Array.isArray(finalLabels)||finalLabels.some(x=>!x?.name))
    throw new Error("PROJECT_REQUEST: unreadable final PR category labels");
  const finalNames=finalLabels.map(x=>x.name);
  if(!finalNames.includes(label)||finalNames.includes(VALID.get(kind==="implementation"?"release":"implementation")))
    throw new Error("PROJECT_REQUEST: PR category changed before Project write");

  // Native Development/release links may drift while a multi-Issue admission
  // and paginated label read are in flight. Reverify the actual native evidence
  // immediately before authorizing a Project item (never mutate native links).
  if(kind==="implementation") {
    await verifyNative(reader,number,implementationIdentity(pr.body).issueNumber,true);
  } else {
    await verifyIncluded(reader,releaseReferences(pr.body));
  }
  latest=await reader.request(ROOT+"/pulls/"+number);
  if(prIdentity(latest)!==prIdentity(pr)) throw new Error("PROJECT_REQUEST: PR drifted before Project write");
  // Freshness is checked after ALL potentially slow external reads, not before.
  for(const entry of refreshed)
    assertFreshReceipt(entry.receipt,{issue:entry.issue,revision:entry.revision});

  // The Project-wide membership scan in ensureProjectPR can take longer than
  // 120 seconds. Re-read authoritative Issue/Project revisions *after* that
  // scan, and check native evidence, labels and PR identity before PROJECT_ADD.
  const beforeWrite=async()=>{
    const postScanReceipts=[];
    for(const entry of refreshed) {
      const issueNumber=Number(entry.issue.split("#")[1]);
      const result=await reread({
        client:reader,config,repository:REPO,number:issueNumber,
        selectedOwner:"syllik",expectedRevision:entry.revision
      });
      if(result.blockers?.length)
        throw new Error("PROJECT_ADMISSION: "+entry.issue+" "+result.blockers.join("; "));
      assertFreshReceipt(result.receipt,{issue:entry.issue,revision:entry.revision});
      postScanReceipts.push({receipt:result.receipt,issue:entry.issue,revision:entry.revision});
    }
    const labelsAfterScan=await reader.listAll(ROOT+"/issues/"+number+"/labels");
    if(!Array.isArray(labelsAfterScan)||labelsAfterScan.some(x=>!x?.name))
      throw new Error("PROJECT_REQUEST: unreadable PR categories after Project scan");
    const namesAfterScan=labelsAfterScan.map(x=>x.name);
    if(!namesAfterScan.includes(label)||namesAfterScan.includes(VALID.get(kind==="implementation"?"release":"implementation")))
      throw new Error("PROJECT_REQUEST: PR category changed during Project scan");
    if(kind==="implementation")
      await verifyNative(reader,number,implementationIdentity(pr.body).issueNumber,true);
    else
      await verifyIncluded(reader,releaseReferences(pr.body));
    const latestAfterScan=await reader.request(ROOT+"/pulls/"+number);
    if(prIdentity(latestAfterScan)!==prIdentity(pr))
      throw new Error("PROJECT_REQUEST: PR drifted during Project scan");
    for(const entry of postScanReceipts)
      assertFreshReceipt(entry.receipt,{issue:entry.issue,revision:entry.revision});
  };
  const project=await ensureProjectPR(writer,pr.node_id,{beforeWrite});
  return {contractVersion:"chipin-pr-project-reconcile/v1",number,kind,sha:expectedSha,
    itemId:project.id,created:project.created,readBack:project.readBack,admission:admitted.status};
}

export async function reconcileOpenPRs({reader,writer,config,log=console.log}) {
  // Paginate all open PRs. Never trust FE event fields or checkout FE head.
  const prs=await reader.listAll(ROOT+"/pulls?state=open");
  const receipts=[],blocked=[];
  for(const candidate of prs) {
    const names=(candidate.labels??[]).map(x=>x.name);
    if(!names.some(x=>VALID.has(x==="pr:implementation"?"implementation":x==="pr:release"?"release":""))) continue;
    try {
      receipts.push(await reconcileProjectPR({
        reader,writer,config,number:candidate.number,expectedSha:candidate.head.sha
      }));
    } catch(error) {
      blocked.push({number:candidate.number,reason:error instanceof Error?error.message:String(error)});
    }
  }
  log(JSON.stringify({contractVersion:"chipin-pr-project-batch/v1",receipts,blocked},null,2));
  if(blocked.length) process.exitCode=1;
  return {receipts,blocked};
}

async function main() {
  const readToken=process.env.CHIPIN_DEV_READ_TOKEN;
  const writeToken=process.env.CHIPIN_ISSUE_WRITE_TOKEN;
  if(!readToken||!writeToken) throw new Error("ORG_PROJECT_CREDENTIAL: dedicated org secrets required");
  const config=JSON.parse(await readFile(new URL("./metadata-migration.config.json",import.meta.url),"utf8"));
  const reader=new GitHubClient(readToken),writer=new GitHubClient(writeToken);
  if(process.env.CHIPIN_PR_NUMBER) {
    const number=Number(process.env.CHIPIN_PR_NUMBER);
    if(!Number.isInteger(number)||number<=0) throw new Error("Invalid explicit FE PR number");
    const pr=await reader.request(ROOT+"/pulls/"+number);
    const receipt=await reconcileProjectPR({reader,writer,config,number,expectedSha:pr?.head?.sha});
    console.log(JSON.stringify(receipt,null,2));
  } else {
    await reconcileOpenPRs({reader,writer,config});
  }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)
  main().catch(e=>{console.error("ORG PROJECT BLOCKED: "+e.message);process.exitCode=1;});
