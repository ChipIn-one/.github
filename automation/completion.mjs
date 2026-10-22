// Completion engine driven by the registry strategy (docs/workflow/completion.md, task .github#179).
//
// One entry point for every repository whose registry record says `capabilities.completion: automatic`;
// the record's top-level `completion` picks the strategy:
//   production-merge   — the frontend rule, delegated unchanged to frontend-production-completion.mjs
//                        (merge to the integration branch is not completion; a merged release PR
//                        integration -> promotion whose head contains the merge commit is);
//   integration-merge  — `.github` and the knowledge base: an Issue closes once every Development-linked
//                        PR is merged into the integration branch and that merge commit is still reachable
//                        from the branch head;
//   deployment-receipt — every integration-merge gate, plus (.github#212) every linked PR's merge commit is
//                        contained in a valid production receipt: a GitHub Deployment of the registry
//                        `productionEvidence` environment and creator whose newest status is `success` and whose
//                        SHA is on the integration branch. Merged but not yet received -> `awaiting-production`.
// All strategies share the fail-closed gates: native Development link as identity, complete pagination,
// same-repository PRs only, no linked branches, no open blockers, no incomplete sub-issues, no scope change
// after the last merge (timeline + body-revision history, .github#178), stale-snapshot check before the
// only mutation (`state=closed`, `state_reason=completed`), never reopen, never set Project Status except
// the existing repair of an open Issue that still shows derived `Done`, and, for production-merge and
// deployment-receipt with `awaitingRelease` on (.github#180, #212), `Todo`/`In Progress` -> `Awaiting release`
// for Issues whose decision is `awaiting-production` and that pass the strategy's re-check
// (evaluateAwaitingReleaseCandidate / deploymentReceiptAwaitingVerifier; setAwaitingReleaseStatus). Status is
// never an input of the close decision.
import fs from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GitHubClient, readProjectSnapshot } from "./github-metadata.mjs";
import { AUTOMATIC_COMPLETION_STRATEGIES, loadRegistry, requireRepositoryProfile } from "./registry.mjs";
import {
  closeIssueAsCompleted,
  compareContainsCommit,
  readOpenFrontendIssues as readOpenIssues,
  readRequiredRelationships,
  readScopeHistory,
  reconcileOpenDoneProjectStatus,
  runCompletionSweep as runProductionMergeSweep,
} from "./frontend-production-completion.mjs";
import {
  INTEGRATION_BRANCH as FRONTEND_INTEGRATION_BRANCH,
  PRODUCTION_BRANCH as FRONTEND_PRODUCTION_BRANCH,
  evaluateRequiredRelationships,
  resolveScopeFreshnessFloor,
} from "./frontend-production-completion-policy.mjs";

export const COMPLETION_CONTRACT = "chipin-completion/v1";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export const AWAITING_RELEASE_STATUS = "Awaiting release";
// Only these Statuses move to Awaiting release; Done (derived mirror), Backlog and anything else stay as they are.
const AWAITING_RELEASE_SOURCES = Object.freeze(["Todo", "In Progress"]);

// Same shape as PROJECT_ITEM_STATUS_QUERY / SET_PROJECT_STATUS of frontend-production-completion.mjs, which
// does not export them (that module stays unchanged).
const PROJECT_ITEM_STATUS_QUERY = [
  "query CompletionProjectItemStatus($itemId: ID!) {",
  "  node(id: $itemId) {",
  "    __typename",
  "    ... on ProjectV2Item {",
  "      id",
  "      fieldValueByName(name: \"Status\") {",
  "        __typename",
  "        ... on ProjectV2ItemFieldSingleSelectValue { name }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

const SET_PROJECT_STATUS = [
  "mutation SetCompletionAwaitingRelease($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {",
  "  updateProjectV2ItemFieldValue(input: {",
  "    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,",
  "    value: { singleSelectOptionId: $optionId }",
  "  }) { projectV2Item { id } }",
  "}",
].join("\n");

export class CompletionBlocked extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CompletionBlocked";
    this.code = code;
  }
}

function blocked(code, message) {
  return new CompletionBlocked(code, message);
}

function leaveOpen(code, detail) {
  return { action: "leave-open", code, detail };
}

function latestTimestamp(values) {
  const valid = values
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(b) - Date.parse(a));
  return valid[0] ?? null;
}

function isAfter(left, right) {
  if (!left || !right) return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

function splitRepository(repository) {
  const [owner, repo, extra] = String(repository ?? "").split("/");
  if (!owner || !repo || extra) throw blocked("INVALID_REPOSITORY", "Invalid repository identity: " + repository);
  return { owner, repo };
}

/**
 * integration-merge: decide one open Issue.
 *
 * `issue` is the normalized candidate (readOpenIssues + readRequiredRelationships). Every Development-linked
 * PR must be a same-repository PR merged into `integrationBranch` whose merge commit is contained in
 * `integrationHeadSha` (containsCommit); then the scope-freshness rule of .github#178 applies unchanged.
 */
export async function evaluateIssueForIntegrationCompletion(issue, {
  repository,
  integrationBranch,
  integrationHeadSha,
  containsCommit,
  readScopeHistory: readHistory,
} = {}) {
  if (typeof repository !== "string" || typeof integrationBranch !== "string" || !integrationBranch) {
    throw new Error("repository and integrationBranch are required");
  }
  if (!SHA_PATTERN.test(String(integrationHeadSha ?? ""))) {
    throw new Error("integrationHeadSha must be a full 40-character SHA");
  }
  if (typeof containsCommit !== "function") throw new Error("containsCommit callback is required");

  if (issue.state !== "OPEN") {
    return leaveOpen("already-closed", "Issue is already closed; automation never reopens it.");
  }

  const relationshipBlocker = evaluateRequiredRelationships(issue);
  if (relationshipBlocker) return relationshipBlocker;

  if (issue.linkedBranchCount > 0) {
    return leaveOpen(
      "development-branch-pending",
      "Development still contains " + issue.linkedBranchCount
        + " linked branch(es). Convert the required work to PR evidence before automatic completion.",
    );
  }

  if (issue.linkedPullRequestTotalCount === 0) {
    return leaveOpen(
      "missing-development",
      "No native Development-linked PR is present. Link the implementation PR in the Issue Development section; plain references are not completion evidence.",
    );
  }

  if (issue.linkedPullRequests.length !== issue.linkedPullRequestTotalCount) {
    return leaveOpen(
      "ambiguous-development",
      "Native Development linkage is incomplete: read " + issue.linkedPullRequests.length
        + " of " + issue.linkedPullRequestTotalCount + " linked PR(s).",
    );
  }

  const identities = new Set();
  const mergedAtValues = [];
  const receipts = [];

  for (const pullRequest of issue.linkedPullRequests) {
    const identity = (pullRequest.repository ?? "unknown") + "#" + pullRequest.number;
    if (identities.has(identity)) {
      return leaveOpen("ambiguous-development", "Duplicate Development PR identity: " + identity + ".");
    }
    identities.add(identity);

    if (pullRequest.repository !== repository) {
      return leaveOpen(
        "ambiguous-development",
        "Linked PR " + identity + " is outside " + repository + "; v1 will not guess cross-repository completion.",
      );
    }
    if (pullRequest.headRepository !== repository) {
      return leaveOpen(
        "ambiguous-development",
        "Linked PR #" + pullRequest.number + " comes from " + (pullRequest.headRepository ?? "an unknown repository")
          + ", not from " + repository + "; fork pull requests are not completion evidence.",
      );
    }

    if (!pullRequest.mergedAt || !pullRequest.mergeCommitSha) {
      return leaveOpen(
        "implementation-not-merged",
        "Linked PR #" + pullRequest.number + " is not merged with readable merge evidence.",
      );
    }

    if (pullRequest.baseRefName !== integrationBranch) {
      return leaveOpen(
        "ambiguous-development",
        "Linked PR #" + pullRequest.number + " targets unsupported base "
          + (pullRequest.baseRefName ?? "unknown") + "; expected the integration branch " + integrationBranch + ".",
      );
    }

    if (!SHA_PATTERN.test(String(pullRequest.mergeCommitSha))) {
      return leaveOpen(
        "implementation-not-merged",
        "Linked PR #" + pullRequest.number + " has an unreadable merge commit.",
      );
    }

    if (!(await containsCommit(pullRequest.mergeCommitSha, integrationHeadSha))) {
      return leaveOpen(
        "integration-history-diverged",
        "Linked PR #" + pullRequest.number + " merge commit " + pullRequest.mergeCommitSha.slice(0, 7)
          + " is not contained in the current " + integrationBranch + " head " + integrationHeadSha.slice(0, 7)
          + "; the branch history changed after the merge, a human decides.",
      );
    }

    mergedAtValues.push(pullRequest.mergedAt);
    receipts.push("PR #" + pullRequest.number + " merged into " + integrationBranch
      + " (" + pullRequest.mergeCommitSha.slice(0, 7) + ").");
  }

  if (issue.scopeHistory === undefined && typeof readHistory === "function") {
    const history = await readHistory(issue);
    issue = { ...issue, scopeHistory: history && typeof history === "object" ? history : null };
  }
  const freshness = resolveScopeFreshnessFloor(issue, mergedAtValues);
  if (freshness.blocker) return freshness.blocker;

  // The #178 refinement ignores a reopen that undoes an early manual close made after the merge, because
  // on the frontend the release (and the automatic close) comes later. With integration-merge the merge
  // itself is terminal evidence and the integration branch is the default branch, so GitHub's native
  // auto-close (or the engine) closes right after the merge; a human reopen after that means "not done":
  // every reopen after the last merge counts, and the Issue stays open until a fresh linked PR merges.
  const lastMergedAt = latestTimestamp(mergedAtValues);
  const lateReopens = (issue.scopeHistory?.reopenedAt ?? [])
    .filter((reopenedAt) => isAfter(reopenedAt, lastMergedAt))
    .map((reopenedAt) => ({ at: reopenedAt, kind: "reopened" }));
  const reasons = [...(freshness.reasons ?? []), ...lateReopens]
    .filter((reason) => lastMergedAt === null || isAfter(reason.at, lastMergedAt));
  const hasFreshImplementationEvidence = reasons.length === 0
    && (freshness.floor === null || mergedAtValues.some((mergedAt) => isAfter(mergedAt, freshness.floor)));
  if (!hasFreshImplementationEvidence) {
    const described = [...new Map(reasons.map((reason) => [reason.kind + reason.at, reason])).values()]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((reason) => reason.kind + " at " + reason.at);
    return leaveOpen(
      "scope-changed-after-implementation",
      "The Issue was edited or reopened after all currently linked implementation PRs merged"
        + (described.length > 0 ? " (" + described.join(", ") + ")" : "")
        + ". Link and merge fresh required implementation evidence before automatic completion.",
    );
  }

  return { action: "close-completed", code: "integration-complete", detail: receipts.join(" ") };
}

/**
 * Fail closed when the token cannot see every sub-issue: the REST list only returns Issues the token may
 * read (private cross-repository sub-issues disappear), while `sub_issues_summary.total` counts them all.
 */
export async function readSubIssueTotal(client, repository, number) {
  const { owner, repo } = splitRepository(repository);
  const current = await client.request("/repos/" + owner + "/" + repo + "/issues/" + number);
  const total = current?.sub_issues_summary?.total;
  if (!Number.isInteger(total) || total < 0) {
    throw blocked("UNREADABLE_SUB_ISSUE_SUMMARY", "Issue #" + number + " has no readable sub_issues_summary.total");
  }
  return total;
}

export async function readBranchHead(client, repository, branch) {
  const { owner, repo } = splitRepository(repository);
  const commit = await client.request("/repos/" + owner + "/" + repo + "/commits/" + encodeURIComponent(branch));
  if (!SHA_PATTERN.test(String(commit?.sha ?? ""))) {
    throw blocked("UNREADABLE_BRANCH_HEAD", "Head of " + repository + "@" + branch + " is unreadable");
  }
  return commit.sha;
}

export function projectStatusCoordinates(project, desiredStatus, statusField = "Status") {
  const fields = (project?.fields ?? []).filter((field) => field?.name === statusField);
  if (fields.length !== 1) {
    throw blocked("PROJECT_STATUS_FIELD", "Project Status field is missing or ambiguous (" + fields.length + " matches)");
  }
  const field = fields[0];
  if (field.isIssueField === true) throw blocked("PROJECT_STATUS_FIELD", "Project Status must remain project-local");
  const options = (field.options ?? []).filter((option) => option?.name === desiredStatus);
  if (options.length !== 1) {
    throw blocked("PROJECT_STATUS_OPTION", desiredStatus + " Status option is missing or ambiguous ("
      + options.length + " matches)");
  }
  if (!project?.id || !field?.id || !options[0]?.id) {
    throw blocked("PROJECT_STATUS_FIELD", "Project Status mutation coordinates are unreadable");
  }
  return { projectId: project.id, fieldId: field.id, optionId: options[0].id };
}

export async function readProjectItemStatus(client, itemId) {
  const data = await client.graphql(PROJECT_ITEM_STATUS_QUERY, { itemId });
  const item = data?.node;
  if (item?.id !== itemId) throw blocked("PROJECT_ITEM_UNREADABLE", "Project item status read did not return the expected item");
  return item.fieldValueByName?.name ?? null;
}

/**
 * Awaiting release writer (.github#180) for one open Issue whose production-merge or deployment-receipt decision
 * is `awaiting-production`: every linked PR merged into the integration branch, not all of them released yet.
 * Moves Project #5 Status `Todo` / `In Progress` -> `Awaiting release` and reads it back. `Awaiting release`
 * is a no-op; `Done`, `Backlog`, any other value or no Status is left untouched. The Issue is re-read right
 * before the write and the write is abandoned when it is no longer open or changed since the snapshot.
 * Never closes or reopens anything. Membership checks mirror reconcileOpenDoneProjectStatus.
 */
export async function setAwaitingReleaseStatus(client, issue, project, repository, { statusField = "Status" } = {}) {
  const memberships = (project?.items ?? []).filter((item) => (
    item?.repository === repository && item?.number === issue.number
  ));
  if (memberships.length === 0) {
    return { mutated: false, code: "project-membership-missing", detail: "Issue is not present in Project #5." };
  }
  if (memberships.length !== 1) {
    return {
      mutated: false,
      code: "project-membership-ambiguous",
      detail: "Project #5 has " + memberships.length + " items for this Issue; manual reconciliation is required.",
    };
  }
  const itemId = memberships[0].id;
  if (!itemId) {
    return { mutated: false, code: "project-item-unreadable", detail: "Project #5 item id is unreadable." };
  }

  const currentStatus = await readProjectItemStatus(client, itemId);
  if (currentStatus === AWAITING_RELEASE_STATUS) {
    return { mutated: false, code: "awaiting-release-current", detail: "Project Status is already " + AWAITING_RELEASE_STATUS + "." };
  }
  if (!AWAITING_RELEASE_SOURCES.includes(currentStatus)) {
    return {
      mutated: false,
      code: "awaiting-release-skipped:" + (currentStatus ?? "none"),
      detail: "Project Status " + (currentStatus === null ? "is empty" : currentStatus)
        + "; only Todo or In Progress move to " + AWAITING_RELEASE_STATUS + ".",
    };
  }

  const { owner, repo } = splitRepository(repository);
  const current = await client.request("/repos/" + owner + "/" + repo + "/issues/" + issue.number);
  if (current?.pull_request) throw blocked("NOT_AN_ISSUE", "Refusing to set Project Status of PR #" + issue.number + " as an Issue");
  if (current?.state !== "open") {
    return { mutated: false, code: "issue-no-longer-open", detail: "Issue is no longer open; Project Status left unchanged." };
  }
  if (!issue.updatedAt || current.updated_at !== issue.updatedAt) {
    return {
      mutated: false,
      code: "stale-snapshot",
      detail: "Issue changed after evaluation; Project Status left unchanged until the next run.",
    };
  }

  const coordinates = projectStatusCoordinates(project, AWAITING_RELEASE_STATUS, statusField);
  const data = await client.graphql(SET_PROJECT_STATUS, {
    projectId: coordinates.projectId,
    itemId,
    fieldId: coordinates.fieldId,
    optionId: coordinates.optionId,
  });
  if (data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) {
    throw blocked("PROJECT_STATUS_WRITE", "Project Status mutation did not return the expected item id");
  }
  const readBack = await readProjectItemStatus(client, itemId);
  if (readBack !== AWAITING_RELEASE_STATUS) {
    throw blocked("PROJECT_STATUS_WRITE", "Project Status of Issue #" + issue.number + " did not read back as "
      + AWAITING_RELEASE_STATUS + " (read " + (readBack ?? "none") + ")");
  }
  return {
    mutated: true,
    code: "awaiting-release-set",
    detail: "Project Status " + currentStatus + " -> " + AWAITING_RELEASE_STATUS + ".",
  };
}

function notEligible(code, detail) {
  return { eligible: false, code, detail };
}

/**
 * Re-verify one `awaiting-production` candidate before the Awaiting release write (.github#180).
 *
 * The frontend evaluator returns `awaiting-production` as soon as the first dev-merged PR without a release
 * is reached, so the remaining linked PRs (in GitHub order, unsorted) and the scope-freshness gate are not
 * proven by that code alone. This helper checks EVERY linked PR and the #178 scope-freshness rule itself.
 * The required-relationships gate (sub-issues, blockers) is not re-read here: the frontend sweep applies
 * evaluateRequiredRelationships before it can reach `awaiting-production`.
 */
export async function evaluateAwaitingReleaseCandidate(issue, { repository, readScopeHistory: readHistory } = {}) {
  if (typeof repository !== "string" || !repository) throw new Error("repository is required");
  if (issue?.state !== "OPEN") return notEligible("already-closed", "Issue is not open.");

  const total = issue.linkedPullRequestTotalCount;
  const pullRequests = Array.isArray(issue.linkedPullRequests) ? issue.linkedPullRequests : [];
  if (!Number.isInteger(total) || total <= 0) {
    return notEligible("missing-development", "No native Development-linked PR is present.");
  }
  if (pullRequests.length !== total) {
    return notEligible("ambiguous-development", "Native Development linkage is incomplete: read "
      + pullRequests.length + " of " + total + " linked PR(s).");
  }

  const identities = new Set();
  const mergedAtValues = [];
  for (const pullRequest of pullRequests) {
    const identity = (pullRequest?.repository ?? "unknown") + "#" + pullRequest?.number;
    if (identities.has(identity)) {
      return notEligible("ambiguous-development", "Duplicate Development PR identity: " + identity + ".");
    }
    identities.add(identity);
    if (pullRequest.repository !== repository) {
      return notEligible("ambiguous-development", "Linked PR " + identity + " is outside " + repository + ".");
    }
    if (pullRequest.headRepository !== repository) {
      return notEligible("ambiguous-development", "Linked PR #" + pullRequest.number + " comes from "
        + (pullRequest.headRepository ?? "an unknown repository") + "; fork pull requests are not evidence.");
    }
    if (!pullRequest.mergedAt || !Number.isFinite(Date.parse(pullRequest.mergedAt))
      || !SHA_PATTERN.test(String(pullRequest.mergeCommitSha ?? ""))) {
      return notEligible("implementation-not-merged",
        "Linked PR #" + pullRequest.number + " is not merged with readable merge evidence.");
    }
    if (pullRequest.baseRefName === FRONTEND_PRODUCTION_BRANCH) {
      // the canonical same-repository dev -> main release PR (headRepository checked above); such an Issue
      // would normally be production-complete, but it is valid evidence and does not block the Status
      if (pullRequest.headRefName !== FRONTEND_INTEGRATION_BRANCH) {
        return notEligible("ambiguous-production", "Linked PR #" + pullRequest.number
          + " targets " + FRONTEND_PRODUCTION_BRANCH + " but is not the canonical "
          + FRONTEND_INTEGRATION_BRANCH + " -> " + FRONTEND_PRODUCTION_BRANCH + " release PR.");
      }
    } else if (pullRequest.baseRefName !== FRONTEND_INTEGRATION_BRANCH) {
      return notEligible("ambiguous-development", "Linked PR #" + pullRequest.number + " targets unsupported base "
        + (pullRequest.baseRefName ?? "unknown") + ".");
    }
    mergedAtValues.push(pullRequest.mergedAt);
  }

  if (issue.linkedBranchCount !== 0) {
    return notEligible("development-branch-pending",
      "Development still contains " + (issue.linkedBranchCount ?? "an unknown number of") + " linked branch(es).");
  }

  let candidate = issue;
  if (candidate.scopeHistory === undefined && typeof readHistory === "function") {
    let history;
    try {
      history = await readHistory(candidate);
    } catch (error) {
      history = { readable: false, detail: error instanceof Error ? error.message : String(error) };
    }
    candidate = { ...candidate, scopeHistory: history && typeof history === "object" ? history : null };
  }
  const freshness = resolveScopeFreshnessFloor(candidate, mergedAtValues);
  if (freshness.blocker) return notEligible(freshness.blocker.code, freshness.blocker.detail);
  if (freshness.floor !== null && !mergedAtValues.some((mergedAt) => isAfter(mergedAt, freshness.floor))) {
    return notEligible("scope-changed-after-implementation",
      "The Issue was edited or reopened after all linked PRs merged (" + freshness.floor + ").");
  }
  return { eligible: true };
}

/**
 * Apply setAwaitingReleaseStatus to every `awaiting-production` result of a production-merge sweep that
 * passes evaluateAwaitingReleaseCandidate. The Project snapshot is read once, only when at least one
 * candidate is eligible, and the Status coordinates are resolved before any write (a missing field or
 * option stops the run). A failure of one Issue's write is recorded (`awaiting-release-failed`) and the run
 * continues. Returns the results with the outcome appended to `decision.detail` and the receipt block
 * `{ enabled, updated, skipped, failed }`. `verifyCandidate` defaults to the production-merge re-check
 * (evaluateAwaitingReleaseCandidate); deployment-receipt passes deploymentReceiptAwaitingVerifier(integrationBranch).
 */
export async function reconcileAwaitingRelease(client, results, {
  repository,
  projectConfig,
  readScopeHistory: readHistory = (issue) => readScopeHistory(client, repository, issue),
  verifyCandidate = evaluateAwaitingReleaseCandidate,
}) {
  if (!projectConfig) throw new Error("projectConfig is required for the Awaiting release writer");
  const summary = { enabled: true, updated: [], skipped: 0, failed: [] };
  if (!results.some((result) => result.decision?.code === "awaiting-production")) {
    return { results, awaitingRelease: summary };
  }

  const verdicts = new Map();
  for (const result of results) {
    if (result.decision?.code !== "awaiting-production") continue;
    verdicts.set(result, await verifyCandidate(result.issue, { repository, readScopeHistory: readHistory }));
  }

  let project = null;
  const statusField = projectConfig.project.statusField;
  if ([...verdicts.values()].some((verdict) => verdict.eligible)) {
    project = await readProjectSnapshot(client, projectConfig);
    projectStatusCoordinates(project, AWAITING_RELEASE_STATUS, statusField);
  }

  const appendDetail = (result, text) => ({
    ...result,
    decision: { ...result.decision, detail: result.decision.detail + " Awaiting release: " + text },
  });
  const updatedResults = [];
  for (const result of results) {
    const verdict = verdicts.get(result);
    if (!verdict) {
      updatedResults.push(result);
      continue;
    }
    if (!verdict.eligible) {
      summary.skipped += 1;
      updatedResults.push(appendDetail(result, "awaiting-release-skipped:" + verdict.code + ". " + verdict.detail));
      continue;
    }
    let outcome;
    try {
      outcome = await setAwaitingReleaseStatus(client, result.issue, project, repository, { statusField });
    } catch (error) {
      summary.failed.push(result.issue.number);
      updatedResults.push(appendDetail(result, "awaiting-release-failed: "
        + (error instanceof Error ? error.message : String(error))));
      continue;
    }
    if (outcome.mutated) summary.updated.push(result.issue.number);
    else summary.skipped += 1;
    updatedResults.push(appendDetail(result, outcome.code + ". " + outcome.detail));
  }
  return { results: updatedResults, awaitingRelease: summary };
}

/**
 * Shared sweep over every open Issue of `profile.repository` (integration-merge and deployment-receipt).
 * Mirrors runCompletionSweep of the frontend module: relationships are read before the decision and again
 * right before the close; the close is abandoned when the Issue changed since the snapshot. `evaluate`
 * decides one candidate with `{ integrationHeadSha, containsCommit }`; an exception it throws leaves only that
 * Issue open with `unreadableCode`.
 */
async function runOpenIssueSweep(client, profile, {
  reconcileProjectStatus = true,
  projectConfig,
  evaluate,
  unreadableCode,
  unreadableDetail,
} = {}) {
  const repository = profile.repository;
  const integrationBranch = profile.branches.integration;
  if (reconcileProjectStatus && !projectConfig) {
    throw new Error("projectConfig is required when Project reconciliation is enabled");
  }

  const [issues, integrationHeadSha, project] = await Promise.all([
    readOpenIssues(client, repository),
    readBranchHead(client, repository, integrationBranch),
    reconcileProjectStatus ? readProjectSnapshot(client, projectConfig) : Promise.resolve(null),
  ]);

  const reconcileProject = async (issue) => {
    if (!reconcileProjectStatus) {
      return {
        mutated: false,
        code: "project-reconciliation-disabled",
        detail: "Project reconciliation is disabled for repository-local execution.",
      };
    }
    return reconcileOpenDoneProjectStatus(client, issue, project, repository);
  };

  const ancestryCache = new Map();
  const containsCommit = async (commitSha, headSha) => {
    const key = commitSha + ":" + headSha;
    if (!ancestryCache.has(key)) ancestryCache.set(key, compareContainsCommit(client, repository, commitSha, headSha));
    return ancestryCache.get(key);
  };

  const results = [];
  for (const issue of issues) {
    let relationships;
    try {
      relationships = await readRequiredRelationships(client, repository, issue.number);
      const total = await readSubIssueTotal(client, repository, issue.number);
      if (relationships.subIssues.length !== total) {
        throw new Error("only " + relationships.subIssues.length + " of " + total
          + " sub-issue(s) are visible to this token (private or cross-repository sub-issues are hidden)");
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        issue,
        decision: leaveOpen("required-relationships-unreadable",
          "Required sub-issue/blocking relationships are unreadable: " + detail),
      });
      continue;
    }

    let decision;
    try {
      decision = await evaluate({ ...issue, ...relationships }, { integrationHeadSha, containsCommit });
    } catch (error) {
      // one unreadable compare (a merge commit gone after a force-push) must not abort the sweep
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        issue,
        decision: leaveOpen(unreadableCode, unreadableDetail + detail),
      });
      continue;
    }
    if (decision.action !== "close-completed") {
      const projectReconciliation = await reconcileProject(issue);
      results.push({
        issue,
        decision: projectReconciliation.mutated
          ? { ...decision, detail: decision.detail + " " + projectReconciliation.detail }
          : decision,
      });
      continue;
    }

    let finalRelationships;
    try {
      finalRelationships = await readRequiredRelationships(client, repository, issue.number);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        issue,
        decision: leaveOpen("required-relationships-unreadable",
          "Required relationships became unreadable before close: " + detail),
      });
      continue;
    }
    const finalRelationshipBlocker = evaluateRequiredRelationships({ ...issue, ...finalRelationships });
    if (finalRelationshipBlocker) {
      results.push({ issue, decision: finalRelationshipBlocker });
      continue;
    }

    const mutation = await closeIssueAsCompleted(client, issue, repository);
    if (mutation.mutated) {
      results.push({
        issue,
        decision: {
          action: "closed",
          code: mutation.code,
          detail: decision.detail + " " + mutation.detail,
          ...(decision.evidence ? { evidence: decision.evidence } : {}),
        },
      });
      continue;
    }
    if (mutation.code === "already-closed") {
      results.push({ issue, decision: leaveOpen(mutation.code, mutation.detail) });
      continue;
    }
    const projectReconciliation = await reconcileProject(issue);
    results.push({
      issue,
      decision: leaveOpen(mutation.code,
        mutation.detail + (projectReconciliation.mutated ? " " + projectReconciliation.detail : "")),
    });
  }
  return results;
}

/**
 * integration-merge sweep over every open Issue of `profile.repository` (runOpenIssueSweep with the
 * integration-merge evaluator).
 */
export async function runIntegrationCompletionSweep(client, profile, {
  reconcileProjectStatus = true,
  projectConfig,
} = {}) {
  const repository = profile.repository;
  const integrationBranch = profile.branches.integration;
  return runOpenIssueSweep(client, profile, {
    reconcileProjectStatus,
    projectConfig,
    unreadableCode: "integration-evidence-unreadable",
    unreadableDetail: "Implementation evidence could not be read for this Issue; skipped until the next run: ",
    evaluate: (candidate, { integrationHeadSha, containsCommit }) => evaluateIssueForIntegrationCompletion(candidate, {
      repository,
      integrationBranch,
      integrationHeadSha,
      containsCommit,
      readScopeHistory: (scopeCandidate) => readScopeHistory(client, repository, scopeCandidate),
    }),
  });
}

// ---------------------------------------------------------------------------
// deployment-receipt (.github#212)
// ---------------------------------------------------------------------------

// Bounded read of the newest production Deployments: at most RECEIPT_PAGE_SIZE * RECEIPT_MAX_PAGES records.
// Older receipts beyond the window are not evidence (fewer receipts can only keep an Issue open).
export const RECEIPT_PAGE_SIZE = 50;
export const RECEIPT_MAX_PAGES = 2;
// One page of statuses per Deployment; a full page may hide newer statuses, so such a receipt is invalid.
export const RECEIPT_STATUS_PAGE_SIZE = 100;

// GitHubClient errors read "<METHOD> <path> -> <status>: <body>"
const isNotFound = (error) => /-> 404\b/u.test(error instanceof Error ? error.message : String(error));
const newestFirst = (left, right) => (Date.parse(right.created_at ?? "") || 0) - (Date.parse(left.created_at ?? "") || 0)
  || (Number(right.id) || 0) - (Number(left.id) || 0);

/**
 * Read the newest Deployments of `environment` (newest first, bounded pagination). Any read error or a page that
 * is not a list stops the run (PRODUCTION_EVIDENCE_UNREADABLE) before anything is evaluated or written.
 * Returns `{ deployments, read, truncated }`; `truncated` means the window was full, so older records may exist.
 */
export async function readProductionDeployments(client, repository, {
  environment,
  pageSize = RECEIPT_PAGE_SIZE,
  maxPages = RECEIPT_MAX_PAGES,
} = {}) {
  if (typeof environment !== "string" || !environment) throw new Error("environment is required");
  const { owner, repo } = splitRepository(repository);
  const deployments = [];
  let truncated = true;
  for (let page = 1; page <= maxPages; page += 1) {
    let batch;
    try {
      batch = await client.request("/repos/" + owner + "/" + repo + "/deployments?environment="
        + encodeURIComponent(environment) + "&per_page=" + pageSize + "&page=" + page);
    } catch (error) {
      throw blocked("PRODUCTION_EVIDENCE_UNREADABLE", "Deployments of " + repository + " are unreadable: "
        + (error instanceof Error ? error.message : String(error)));
    }
    if (!Array.isArray(batch)) {
      throw blocked("PRODUCTION_EVIDENCE_UNREADABLE", "Deployments page " + page + " of " + repository + " is not a list");
    }
    deployments.push(...batch);
    if (batch.length < pageSize) {
      truncated = false;
      break;
    }
  }
  return { deployments: [...deployments].sort(newestFirst), read: deployments.length, truncated };
}

/**
 * Validate one Deployment as a production receipt. Valid: `environment` and `creator.login` equal the registry
 * `productionEvidence`, a full SHA, the newest status is `success` written by the same creator (and, when the
 * status names an environment, the same one), and the SHA is an ancestor of or equal to the integration head
 * (compare `sha...head` is `ahead`, or the SHAs are equal; containsCommit). A full page of statuses
 * (`statusPageSize`) is `statuses-truncated`: the newest status cannot be proven. A 404 (deployment or commit gone)
 * makes the receipt invalid; any other read error is thrown, so the Issue under evaluation fails closed.
 */
export async function validateProductionReceipt(deployment, {
  environment,
  creator,
  integrationHeadSha,
  readStatuses,
  containsCommit,
  statusPageSize = RECEIPT_STATUS_PAGE_SIZE,
}) {
  const record = {
    deploymentId: deployment?.id ?? null,
    sha: deployment?.sha ?? null,
    environment: deployment?.environment ?? null,
    creator: deployment?.creator?.login ?? null,
    createdAt: deployment?.created_at ?? null,
    statusId: null,
    statusState: null,
    statusCreatedAt: null,
  };
  const invalid = (reason) => ({ valid: false, reason, receipt: record });
  if (!Number.isInteger(record.deploymentId)) return invalid("deployment-id-unreadable");
  if (record.environment !== environment) return invalid("environment-mismatch");
  if (record.creator !== creator) return invalid("creator-mismatch");
  if (!SHA_PATTERN.test(String(record.sha ?? ""))) return invalid("sha-unreadable");

  let statuses;
  try {
    statuses = await readStatuses(record.deploymentId);
  } catch (error) {
    if (isNotFound(error)) return invalid("deployment-not-found");
    throw error;
  }
  if (!Array.isArray(statuses)) throw new Error("Statuses of deployment " + record.deploymentId + " are not a list");
  // a full page means the newest status may be beyond what was read: never assume it, fail closed
  if (statuses.length >= statusPageSize) return invalid("statuses-truncated");
  const [newest] = [...statuses].sort(newestFirst);
  if (!newest) return invalid("no-status");
  record.statusId = newest.id ?? null;
  record.statusState = newest.state ?? null;
  record.statusCreatedAt = newest.created_at ?? null;
  if (newest.state !== "success") return invalid("newest-status-" + (newest.state ?? "unknown"));
  if (newest.creator?.login !== creator) return invalid("status-creator-mismatch");
  if (newest.environment != null && newest.environment !== environment) return invalid("status-environment-mismatch");

  let onBranch;
  try {
    onBranch = await containsCommit(record.sha, integrationHeadSha);
  } catch (error) {
    if (isNotFound(error)) return invalid("sha-not-found");
    throw error;
  }
  if (!onBranch) return invalid("not-on-integration-branch");
  return { valid: true, reason: null, receipt: record };
}

/**
 * Lazily validates the Deployments (newest first, each at most once per run) and answers which valid receipt
 * contains a merge commit (compare `merge...receiptSha` is `ahead`, or the SHAs are equal). `checked()` lists
 * every Deployment validated so far with its verdict, for the run receipt.
 */
export function createReceiptResolver({ deployments, environment, creator, integrationHeadSha, readStatuses, containsCommit }) {
  if (!Array.isArray(deployments)) throw new Error("deployments are required");
  if (typeof readStatuses !== "function" || typeof containsCommit !== "function") {
    throw new Error("readStatuses and containsCommit callbacks are required");
  }
  const verdicts = new Map();
  const verdictOf = (deployment) => {
    if (!verdicts.has(deployment)) {
      verdicts.set(deployment, validateProductionReceipt(deployment, {
        environment, creator, integrationHeadSha, readStatuses, containsCommit,
      }));
    }
    return verdicts.get(deployment);
  };
  return {
    async findReceipt(mergeCommitSha) {
      for (const deployment of deployments) {
        const verdict = await verdictOf(deployment);
        if (!verdict.valid) continue;
        if (await containsCommit(mergeCommitSha, verdict.receipt.sha)) return verdict.receipt;
      }
      return null;
    },
    async checked() {
      const rows = [];
      for (const [, pending] of verdicts) {
        try {
          const verdict = await pending;
          rows.push({ ...verdict.receipt, valid: verdict.valid, reason: verdict.reason });
        } catch (error) {
          rows.push({ valid: false, reason: "unreadable: " + (error instanceof Error ? error.message : String(error)) });
        }
      }
      return rows;
    },
  };
}

const describeReceipt = (receipt) => "deployment " + receipt.deploymentId + " (" + receipt.environment + ", "
  + receipt.creator + ", sha " + receipt.sha.slice(0, 7) + ", status " + receipt.statusId + " success at "
  + receipt.statusCreatedAt + ")";

/**
 * deployment-receipt: decide one open Issue.
 *
 * Every gate of integration-merge runs first, unchanged (evaluateIssueForIntegrationCompletion: Development
 * link identity, complete linkage, same-repository PRs, no linked branches, blockers and sub-issues, merged
 * into the integration branch and still on its head, scope freshness). Then every linked PR's merge commit must
 * be contained in some valid production receipt (findReceipt). All contained -> `close-completed`
 * (`production-receipt-complete`); otherwise `awaiting-production`. Both carry `evidence.pullRequests`.
 */
export async function evaluateIssueForDeploymentReceiptCompletion(issue, {
  repository,
  integrationBranch,
  integrationHeadSha,
  containsCommit,
  readScopeHistory: readHistory,
  findReceipt,
} = {}) {
  if (typeof findReceipt !== "function") throw new Error("findReceipt callback is required");
  const integration = await evaluateIssueForIntegrationCompletion(issue, {
    repository, integrationBranch, integrationHeadSha, containsCommit, readScopeHistory: readHistory,
  });
  if (integration.action !== "close-completed") return integration;

  const pullRequests = [];
  for (const pullRequest of issue.linkedPullRequests) {
    const receipt = await findReceipt(pullRequest.mergeCommitSha);
    pullRequests.push({ number: pullRequest.number, mergeCommitSha: pullRequest.mergeCommitSha, receipt: receipt ?? null });
  }
  const evidence = { pullRequests };
  const pending = pullRequests.filter((entry) => entry.receipt === null);
  if (pending.length === 0) {
    return {
      action: "close-completed",
      code: "production-receipt-complete",
      detail: pullRequests.map((entry) => "PR #" + entry.number + " (" + entry.mergeCommitSha.slice(0, 7)
        + ") is in production receipt " + describeReceipt(entry.receipt) + ".").join(" "),
      evidence,
    };
  }
  return {
    ...leaveOpen(
      "awaiting-production",
      "Merged into " + integrationBranch + " but not yet in a valid production receipt: "
        + pending.map((entry) => "PR #" + entry.number + " (" + entry.mergeCommitSha.slice(0, 7) + ")").join(", ") + ".",
    ),
    evidence,
  };
}

/**
 * Awaiting release re-check for a deployment-receipt `awaiting-production` result. The evaluator already ran
 * every gate over every linked PR (unlike the frontend evaluator, it never stops at the first PR), so this only
 * re-asserts the structure the writer relies on: open, complete same-repository linkage, every PR merged into
 * the integration branch with a readable merge commit, no linked branches.
 */
export function deploymentReceiptAwaitingVerifier(integrationBranch) {
  return async (issue, { repository } = {}) => {
    if (issue?.state !== "OPEN") return notEligible("already-closed", "Issue is not open.");
    const pullRequests = Array.isArray(issue.linkedPullRequests) ? issue.linkedPullRequests : [];
    if (!Number.isInteger(issue.linkedPullRequestTotalCount) || issue.linkedPullRequestTotalCount <= 0
      || pullRequests.length !== issue.linkedPullRequestTotalCount) {
      return notEligible("ambiguous-development", "Native Development linkage is missing or incomplete.");
    }
    if (issue.linkedBranchCount !== 0) {
      return notEligible("development-branch-pending", "Development still contains linked branch(es).");
    }
    for (const pullRequest of pullRequests) {
      if (pullRequest.repository !== repository || pullRequest.headRepository !== repository) {
        return notEligible("ambiguous-development", "Linked PR #" + pullRequest.number + " is not a same-repository PR.");
      }
      if (!pullRequest.mergedAt || !SHA_PATTERN.test(String(pullRequest.mergeCommitSha ?? ""))) {
        return notEligible("implementation-not-merged", "Linked PR #" + pullRequest.number + " is not merged with readable merge evidence.");
      }
      if (pullRequest.baseRefName !== integrationBranch) {
        return notEligible("ambiguous-development", "Linked PR #" + pullRequest.number + " targets "
          + (pullRequest.baseRefName ?? "unknown") + ", not " + integrationBranch + ".");
      }
    }
    return { eligible: true };
  };
}

/**
 * deployment-receipt sweep over every open Issue of `profile.repository`. The newest production Deployments
 * are read once (bounded; an unreadable list stops the run before any write); receipts are validated lazily and
 * cached; compare results are cached across Issues. A read error while evaluating one Issue leaves only that
 * Issue open (`production-evidence-unreadable`, never Awaiting release). Returns `{ results, productionEvidence }`.
 */
export async function runDeploymentReceiptCompletionSweep(client, profile, {
  reconcileProjectStatus = true,
  projectConfig,
  pageSize = RECEIPT_PAGE_SIZE,
  maxPages = RECEIPT_MAX_PAGES,
} = {}) {
  const repository = profile.repository;
  const integrationBranch = profile.branches.integration;
  const { environment, creator } = profile.productionEvidence ?? {};
  if (typeof environment !== "string" || !environment || typeof creator !== "string" || !creator) {
    throw blocked("PRODUCTION_EVIDENCE_UNDECLARED", profile.repository
      + " has completion deployment-receipt without productionEvidence { environment, creator } in workflow-registry.yaml.");
  }
  if (reconcileProjectStatus && !projectConfig) {
    throw new Error("projectConfig is required when Project reconciliation is enabled");
  }
  const { owner, repo } = splitRepository(repository);
  const deploymentWindow = await readProductionDeployments(client, repository, { environment, pageSize, maxPages });
  const candidates = deploymentWindow.deployments.filter((deployment) => (
    deployment?.environment === environment && deployment?.creator?.login === creator
  ));
  const readStatuses = (deploymentId) => client.request("/repos/" + owner + "/" + repo + "/deployments/"
    + deploymentId + "/statuses?per_page=" + RECEIPT_STATUS_PAGE_SIZE);

  let resolver = null;
  const results = await runOpenIssueSweep(client, profile, {
    reconcileProjectStatus,
    projectConfig,
    unreadableCode: "production-evidence-unreadable",
    unreadableDetail: "Implementation or production evidence could not be read for this Issue; skipped until the next run: ",
    evaluate: (candidate, { integrationHeadSha, containsCommit }) => {
      resolver ??= createReceiptResolver({
        deployments: candidates, environment, creator, integrationHeadSha, readStatuses, containsCommit,
      });
      return evaluateIssueForDeploymentReceiptCompletion(candidate, {
        repository,
        integrationBranch,
        integrationHeadSha,
        containsCommit,
        readScopeHistory: (scopeCandidate) => readScopeHistory(client, repository, scopeCandidate),
        findReceipt: resolver.findReceipt,
      });
    },
  });
  return {
    results,
    productionEvidence: {
      environment,
      creator,
      deploymentsRead: deploymentWindow.read,
      matchingDeployments: candidates.length,
      truncated: deploymentWindow.truncated,
      checked: resolver ? await resolver.checked() : [],
    },
  };
}

/**
 * Run the strategy of one registry repository. Returns the receipt; throws CompletionBlocked when the
 * registry says the repository is not automatic or the strategy is not implemented.
 */
export async function runCompletion(client, {
  repository,
  registry = loadRegistry(),
  reconcileProjectStatus = true,
  awaitingRelease = false,
} = {}) {
  const profile = requireRepositoryProfile(repository, registry);
  if (profile.capabilities.completion !== "automatic") {
    throw blocked("COMPLETION_NOT_AUTOMATIC", profile.repository + " has capabilities.completion \""
      + profile.capabilities.completion + "\" in workflow-registry.yaml; the completion engine must not run for it.");
  }
  const strategy = profile.completion;
  if (!AUTOMATIC_COMPLETION_STRATEGIES.includes(strategy)) {
    throw blocked("STRATEGY_NOT_IMPLEMENTED", "Completion strategy \"" + strategy + "\" of " + profile.repository
      + " is not implemented (implemented: " + AUTOMATIC_COMPLETION_STRATEGIES.join(", ") + ").");
  }

  const [organization] = profile.repository.split("/");
  const projectConfig = { organization, project: { number: registry.project.number, statusField: "Status" } };
  // Awaiting release is written only for production-merge and deployment-receipt (a later release step exists)
  // and only with Project reconciliation on; for integration-merge the merge is terminal and the writer never runs.
  if (awaitingRelease === true && !reconcileProjectStatus) {
    throw blocked("AWAITING_RELEASE_NEEDS_PROJECT", "awaitingRelease requires Project reconciliation (an org token that reads and writes Project #"
      + registry.project.number + "); a repository-local run cannot write Awaiting release.");
  }
  const awaitingReleaseEnabled = awaitingRelease === true
    && (strategy === "production-merge" || strategy === "deployment-receipt");
  let awaitingReleaseReceipt = { enabled: false, updated: [], skipped: 0, failed: [] };

  let results;
  let productionEvidence = null;
  if (strategy === "production-merge") {
    // The frontend module is bound to dev/main; refuse any other layout instead of guessing.
    if (profile.branches.integration !== FRONTEND_INTEGRATION_BRANCH || profile.branches.promotion !== FRONTEND_PRODUCTION_BRANCH) {
      throw blocked("STRATEGY_BRANCH_MISMATCH", "production-merge is implemented for integration \""
        + FRONTEND_INTEGRATION_BRANCH + "\" and promotion \"" + FRONTEND_PRODUCTION_BRANCH + "\"; " + profile.repository
        + " declares " + profile.branches.integration + " / " + (profile.branches.promotion ?? "none") + ".");
    }
    results = await runProductionMergeSweep(client, profile.repository, { reconcileProjectStatus });
    if (awaitingReleaseEnabled) {
      const reconciled = await reconcileAwaitingRelease(client, results, { repository: profile.repository, projectConfig });
      results = reconciled.results;
      awaitingReleaseReceipt = reconciled.awaitingRelease;
    }
  } else if (strategy === "deployment-receipt") {
    const sweep = await runDeploymentReceiptCompletionSweep(client, profile, { reconcileProjectStatus, projectConfig });
    results = sweep.results;
    productionEvidence = sweep.productionEvidence;
    if (awaitingReleaseEnabled) {
      const reconciled = await reconcileAwaitingRelease(client, results, {
        repository: profile.repository,
        projectConfig,
        verifyCandidate: deploymentReceiptAwaitingVerifier(profile.branches.integration),
      });
      results = reconciled.results;
      awaitingReleaseReceipt = reconciled.awaitingRelease;
    }
  } else {
    results = await runIntegrationCompletionSweep(client, profile, { reconcileProjectStatus, projectConfig });
  }

  return {
    contract: COMPLETION_CONTRACT,
    repository: profile.repository,
    strategy,
    branch: strategy === "production-merge" ? profile.branches.promotion : profile.branches.integration,
    projectNumber: registry.project.number,
    projectReconciliation: reconcileProjectStatus,
    awaitingRelease: awaitingReleaseReceipt,
    // deployment-receipt only: which Deployments were read and validated (audit trail of the run)
    ...(productionEvidence ? { productionEvidence } : {}),
    results,
  };
}

function formatProductionEvidence(evidence) {
  const valid = (evidence.checked ?? []).filter((row) => row.valid);
  return "- Production evidence: " + evidence.environment + " by " + evidence.creator + "; "
    + evidence.deploymentsRead + " deployment(s) read" + (evidence.truncated ? " (window full, older ones ignored)" : "")
    + ", " + (evidence.checked ?? []).length + " checked, valid receipts: "
    + (valid.length > 0
      ? valid.map((row) => row.deploymentId + " (" + String(row.sha).slice(0, 7) + ", status " + row.statusId + ")").join(", ")
      : "none");
}

export function formatCompletionSummary(receipt) {
  const results = receipt.results ?? [];
  const closed = results.filter((result) => result.decision.code === "closed-completed").length;
  const lines = [
    "# Completion " + receipt.repository + " (" + receipt.strategy + ")",
    "",
    "- Evaluated open Issues: " + results.length,
    "- Closed as completed: " + closed,
    "- Left open: " + (results.length - closed),
    "- Project #" + receipt.projectNumber + " reconciliation: " + (receipt.projectReconciliation ? "on" : "off"),
    "- Awaiting release: " + (receipt.awaitingRelease?.enabled
      ? "on (set " + receipt.awaitingRelease.updated.length + ", unchanged " + receipt.awaitingRelease.skipped
        + ", failed " + (receipt.awaitingRelease.failed ?? []).length + ")"
      : "off"),
    ...(receipt.productionEvidence ? [formatProductionEvidence(receipt.productionEvidence)] : []),
    "",
    "| Issue | Result | Diagnostic |",
    "| --- | --- | --- |",
  ];
  for (const result of results) {
    const label = result.issue.url
      ? "[#" + result.issue.number + "](" + result.issue.url + ")"
      : "#" + result.issue.number;
    lines.push("| " + label + " | " + result.decision.code + " | "
      + String(result.decision.detail ?? "").replaceAll("|", "\\|").replaceAll("\n", " ") + " |");
  }
  return lines.join("\n") + "\n";
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error("Unexpected argument: " + value);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) throw new Error("Missing value for " + value);
    args.set(value, next);
    index += 1;
  }
  return args;
}

async function main() {
  if (process.env.CHIPIN_COMPLETION_WRITE !== "1") {
    throw new Error("CHIPIN_COMPLETION_WRITE=1 is required");
  }
  const token = process.env.CHIPIN_CANONICAL_WRITE_TOKEN;
  if (!token) throw new Error("CHIPIN_CANONICAL_WRITE_TOKEN is required");

  const args = parseArgs(process.argv.slice(2));
  const repository = args.get("--repository") ?? process.env.GITHUB_REPOSITORY ?? null;
  if (!repository) throw new Error("--repository owner/name (or GITHUB_REPOSITORY) is required");
  const reconcileProjectStatus = process.env.CHIPIN_COMPLETION_PROJECT_RECONCILE !== "0";
  const awaitingRelease = process.env.CHIPIN_COMPLETION_AWAITING_RELEASE === "1";

  const receipt = await runCompletion(new GitHubClient(token), { repository, reconcileProjectStatus, awaitingRelease });
  const summary = formatCompletionSummary(receipt);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  if (args.get("--output")) fs.writeFileSync(args.get("--output"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
  const failed = receipt.awaitingRelease?.failed ?? [];
  if (failed.length > 0) {
    process.stderr.write("Awaiting release write failed for Issue(s) " + failed.map((number) => "#" + number).join(", ") + "\n");
    process.exitCode = 1;
  }
}

const isMainModule = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
