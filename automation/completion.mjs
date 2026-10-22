// Completion engine driven by the registry strategy (docs/workflow/completion.md, task .github#179).
//
// One entry point for every repository whose registry record says `capabilities.completion: automatic`;
// the record's top-level `completion` picks the strategy:
//   production-merge   — the frontend rule, delegated unchanged to frontend-production-completion.mjs
//                        (merge to the integration branch is not completion; a merged release PR
//                        integration -> promotion whose head contains the merge commit is);
//   integration-merge  — `.github` and the knowledge base: an Issue closes once every Development-linked
//                        PR is merged into the integration branch and that merge commit is still reachable
//                        from the branch head.
// Both strategies share the fail-closed gates: native Development link as identity, complete pagination,
// same-repository PRs only, no linked branches, no open blockers, no incomplete sub-issues, no scope change
// after the last merge (timeline + body-revision history, .github#178), stale-snapshot check before the
// only mutation (`state=closed`, `state_reason=completed`), never reopen, never set Project Status except
// the existing repair of an open Issue that still shows derived `Done`.
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

/**
 * integration-merge sweep over every open Issue of `profile.repository`.
 * Mirrors runCompletionSweep of the frontend module: relationships are read before the decision and again
 * right before the close; the close is abandoned when the Issue changed since the snapshot.
 */
export async function runIntegrationCompletionSweep(client, profile, {
  reconcileProjectStatus = true,
  projectConfig,
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
      decision = await evaluateIssueForIntegrationCompletion({ ...issue, ...relationships }, {
        repository,
        integrationBranch,
        integrationHeadSha,
        containsCommit,
        readScopeHistory: (candidate) => readScopeHistory(client, repository, candidate),
      });
    } catch (error) {
      // one unreadable compare (a merge commit gone after a force-push) must not abort the sweep
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        issue,
        decision: leaveOpen("integration-evidence-unreadable",
          "Implementation evidence could not be read for this Issue; skipped until the next run: " + detail),
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
      results.push({ issue, decision: { action: "closed", code: mutation.code, detail: decision.detail + " " + mutation.detail } });
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
 * Run the strategy of one registry repository. Returns the receipt; throws CompletionBlocked when the
 * registry says the repository is not automatic or the strategy is not implemented.
 */
export async function runCompletion(client, {
  repository,
  registry = loadRegistry(),
  reconcileProjectStatus = true,
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

  let results;
  if (strategy === "production-merge") {
    // The frontend module is bound to dev/main; refuse any other layout instead of guessing.
    if (profile.branches.integration !== FRONTEND_INTEGRATION_BRANCH || profile.branches.promotion !== FRONTEND_PRODUCTION_BRANCH) {
      throw blocked("STRATEGY_BRANCH_MISMATCH", "production-merge is implemented for integration \""
        + FRONTEND_INTEGRATION_BRANCH + "\" and promotion \"" + FRONTEND_PRODUCTION_BRANCH + "\"; " + profile.repository
        + " declares " + profile.branches.integration + " / " + (profile.branches.promotion ?? "none") + ".");
    }
    results = await runProductionMergeSweep(client, profile.repository, { reconcileProjectStatus });
  } else {
    const [organization] = profile.repository.split("/");
    results = await runIntegrationCompletionSweep(client, profile, {
      reconcileProjectStatus,
      projectConfig: { organization, project: { number: registry.project.number, statusField: "Status" } },
    });
  }

  return {
    contract: COMPLETION_CONTRACT,
    repository: profile.repository,
    strategy,
    branch: strategy === "production-merge" ? profile.branches.promotion : profile.branches.integration,
    projectNumber: registry.project.number,
    projectReconciliation: reconcileProjectStatus,
    results,
  };
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

  const receipt = await runCompletion(new GitHubClient(token), { repository, reconcileProjectStatus });
  const summary = formatCompletionSummary(receipt);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  if (args.get("--output")) fs.writeFileSync(args.get("--output"), JSON.stringify(receipt, null, 2) + "\n", "utf8");
}

const isMainModule = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMainModule) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
