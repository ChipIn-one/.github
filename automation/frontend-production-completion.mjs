import fs from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GitHubClient } from "./github-metadata.mjs";
import {
  FRONTEND_REPOSITORY,
  INTEGRATION_BRANCH,
  PRODUCTION_BRANCH,
  evaluateIssueForCompletion,
} from "./frontend-production-completion-policy.mjs";

const OPEN_ISSUES_QUERY = [
  "query FrontendCompletionCandidates($owner: String!, $repo: String!, $after: String) {",
  "  repository(owner: $owner, name: $repo) {",
  "    issues(first: 100, after: $after, states: [OPEN], orderBy: {field: UPDATED_AT, direction: ASC}) {",
  "      totalCount",
  "      pageInfo { hasNextPage endCursor }",
  "      nodes {",
  "        number title url state updatedAt lastEditedAt",
  "        linkedBranches(first: 100) { totalCount }",
  "        timelineItems(last: 1, itemTypes: [REOPENED_EVENT]) {",
  "          nodes { __typename ... on ReopenedEvent { createdAt } }",
  "        }",
  "        closedByPullRequestsReferences(first: 100, includeClosedPrs: true) {",
  "          totalCount",
  "          nodes {",
  "            number url state mergedAt baseRefName headRefName headRefOid",
  "            repository { nameWithOwner }",
  "            headRepository { nameWithOwner }",
  "            mergeCommit { oid }",
  "          }",
  "        }",
  "      }",
  "    }",
  "  }",
  "}",
].join("\n");

function splitRepository(repository) {
  const [owner, repo, extra] = repository.split("/");
  if (!owner || !repo || extra) throw new Error("Invalid repository identity: " + repository);
  return { owner, repo };
}

function normalizePullRequest(node) {
  return {
    number: node.number,
    url: node.url ?? null,
    state: node.state ?? null,
    mergedAt: node.mergedAt ?? null,
    baseRefName: node.baseRefName ?? null,
    headRefName: node.headRefName ?? null,
    headRefOid: node.headRefOid ?? null,
    repository: node.repository?.nameWithOwner ?? null,
    headRepository: node.headRepository?.nameWithOwner ?? null,
    mergeCommitSha: node.mergeCommit?.oid ?? null,
  };
}

function normalizeIssue(node) {
  const reopenedAt = (node.timelineItems?.nodes ?? [])
    .map((event) => event?.createdAt ?? null)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;
  const development = node.closedByPullRequestsReferences ?? { totalCount: 0, nodes: [] };

  return {
    number: node.number,
    title: node.title ?? "",
    url: node.url ?? null,
    state: node.state ?? null,
    updatedAt: node.updatedAt ?? null,
    lastEditedAt: node.lastEditedAt ?? null,
    reopenedAt,
    linkedBranchCount: Number(node.linkedBranches?.totalCount ?? 0),
    linkedPullRequestTotalCount: Number(development.totalCount ?? 0),
    linkedPullRequests: (development.nodes ?? []).filter(Boolean).map(normalizePullRequest),
  };
}

export async function readOpenFrontendIssues(client, repository = FRONTEND_REPOSITORY) {
  const { owner, repo } = splitRepository(repository);
  const issues = [];
  let after = null;
  let totalCount = null;

  for (;;) {
    const data = await client.graphql(OPEN_ISSUES_QUERY, { owner, repo, after });
    const connection = data.repository?.issues;
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
      throw new Error("Frontend open-issue pagination is unreadable");
    }

    totalCount ??= connection.totalCount;
    issues.push(...connection.nodes.filter(Boolean).map(normalizeIssue));

    if (!connection.pageInfo.hasNextPage) break;
    if (!connection.pageInfo.endCursor) {
      throw new Error("Frontend open-issue pagination cursor is missing");
    }
    after = connection.pageInfo.endCursor;
  }

  if (Number.isInteger(totalCount) && issues.length !== totalCount) {
    throw new Error("Frontend open-issue pagination is incomplete: read "
      + issues.length + " of " + totalCount);
  }
  return issues;
}

export async function readProductionReleases(client, repository = FRONTEND_REPOSITORY) {
  const { owner, repo } = splitRepository(repository);
  const pulls = await client.listAll("/repos/" + owner + "/" + repo
    + "/pulls?state=closed&base=" + PRODUCTION_BRANCH + "&sort=updated&direction=desc");

  return pulls
    .filter((pull) => pull.merged_at
      && pull.base?.ref === PRODUCTION_BRANCH
      && pull.head?.ref === INTEGRATION_BRANCH
      && pull.head?.repo?.full_name === repository
      && pull.head?.sha)
    .map((pull) => ({
      number: pull.number,
      url: pull.html_url ?? null,
      mergedAt: pull.merged_at,
      headSha: pull.head.sha,
    }))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
}

export async function compareContainsCommit(client, repository, commitSha, releaseHeadSha) {
  if (!/^[0-9a-f]{40}$/iu.test(commitSha) || !/^[0-9a-f]{40}$/iu.test(releaseHeadSha)) {
    throw new Error("Commit ancestry check requires full 40-character SHAs");
  }
  if (commitSha.toLowerCase() === releaseHeadSha.toLowerCase()) return true;

  const { owner, repo } = splitRepository(repository);
  const comparison = await client.request("/repos/" + owner + "/" + repo
    + "/compare/" + commitSha + "..." + releaseHeadSha);
  return comparison.status === "ahead"
    && comparison.merge_base_commit?.sha?.toLowerCase() === commitSha.toLowerCase();
}

export async function closeIssueAsCompleted(client, issue, repository = FRONTEND_REPOSITORY) {
  const { owner, repo } = splitRepository(repository);
  const root = "/repos/" + owner + "/" + repo + "/issues/" + issue.number;
  const current = await client.request(root);

  if (current.pull_request) throw new Error("Refusing to mutate PR #" + issue.number + " as an Issue");
  if (current.state !== "open") {
    return { mutated: false, code: "already-closed", detail: "Manual closure is preserved." };
  }
  if (issue.updatedAt && current.updated_at !== issue.updatedAt) {
    return {
      mutated: false,
      code: "stale-snapshot",
      detail: "Issue changed after evaluation; leave open for the next fail-closed rerun.",
    };
  }

  const updated = await client.request(root, {
    method: "PATCH",
    body: { state: "closed", state_reason: "completed" },
  });
  if (updated.state !== "closed" || updated.state_reason !== "completed") {
    throw new Error("Issue #" + issue.number + " did not read back as closed/completed");
  }
  return { mutated: true, code: "closed-completed", detail: "Closed as completed." };
}

export async function runCompletionSweep(client, repository = FRONTEND_REPOSITORY) {
  const [issues, releases] = await Promise.all([
    readOpenFrontendIssues(client, repository),
    readProductionReleases(client, repository),
  ]);
  const ancestryCache = new Map();
  const containsCommit = async (commitSha, releaseHeadSha) => {
    const key = commitSha + ":" + releaseHeadSha;
    if (!ancestryCache.has(key)) {
      ancestryCache.set(key, compareContainsCommit(client, repository, commitSha, releaseHeadSha));
    }
    return ancestryCache.get(key);
  };

  const results = [];
  for (const issue of issues) {
    const decision = await evaluateIssueForCompletion(issue, {
      repository,
      releases,
      containsCommit,
    });
    if (decision.action !== "close-completed") {
      results.push({ issue, decision });
      continue;
    }

    const mutation = await closeIssueAsCompleted(client, issue, repository);
    results.push({
      issue,
      decision: mutation.mutated
        ? {
          action: "closed",
          code: mutation.code,
          detail: decision.detail + " " + mutation.detail,
        }
        : { action: "leave-open", code: mutation.code, detail: mutation.detail },
    });
  }
  return results;
}

export function formatSweepSummary(results) {
  const closed = results.filter((result) => result.decision.code === "closed-completed").length;
  const lines = [
    "# Frontend production completion",
    "",
    "- Evaluated open Issues: " + results.length,
    "- Closed as completed: " + closed,
    "- Left open: " + (results.length - closed),
    "",
    "| Issue | Result | Diagnostic |",
    "| --- | --- | --- |",
  ];
  for (const result of results) {
    const label = result.issue.url
      ? "[#" + result.issue.number + "](" + result.issue.url + ")"
      : "#" + result.issue.number;
    lines.push("| " + label + " | " + result.decision.code + " | "
      + result.decision.detail.replaceAll("|", "\\|").replaceAll("\n", " ") + " |");
  }
  return lines.join("\n") + "\n";
}

async function main() {
  if (process.env.CHIPIN_FRONTEND_COMPLETION_WRITE !== "1") {
    throw new Error("CHIPIN_FRONTEND_COMPLETION_WRITE=1 is required");
  }
  const token = process.env.CHIPIN_CANONICAL_WRITE_TOKEN;
  if (!token) throw new Error("CHIPIN_CANONICAL_WRITE_TOKEN is required");

  const results = await runCompletionSweep(new GitHubClient(token));
  const summary = formatSweepSummary(results);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
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
