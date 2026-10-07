export const FRONTEND_REPOSITORY = "ChipIn-one/chipin-frontend";
export const INTEGRATION_BRANCH = "dev";
export const PRODUCTION_BRANCH = "main";

function leaveOpen(code, detail) {
  return { action: "leave-open", code, detail };
}

function closeCompleted(detail) {
  return { action: "close-completed", code: "production-complete", detail };
}

function latestTimestamp(...values) {
  const valid = values
    .filter(Boolean)
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((entry) => Number.isFinite(entry.time))
    .sort((a, b) => b.time - a.time);
  return valid[0]?.value ?? null;
}

function isAfter(left, right) {
  if (!left || !right) return false;
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime;
}

async function findProductionRelease(pullRequest, releases, containsCommit) {
  for (const release of releases) {
    if (Date.parse(release.mergedAt) < Date.parse(pullRequest.mergedAt)) continue;
    if (await containsCommit(pullRequest.mergeCommitSha, release.headSha)) return release;
  }
  return null;
}

export async function evaluateIssueForCompletion(issue, {
  repository = FRONTEND_REPOSITORY,
  releases = [],
  containsCommit,
} = {}) {
  if (issue.state !== "OPEN") {
    return leaveOpen("already-closed", "Issue is already closed; automation never reopens it.");
  }

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
  const scopeFreshnessFloor = latestTimestamp(issue.lastEditedAt, issue.reopenedAt);
  let hasFreshImplementationEvidence = scopeFreshnessFloor === null;
  const productionReceipts = [];

  for (const pullRequest of issue.linkedPullRequests) {
    const identity = (pullRequest.repository ?? "unknown") + "#" + pullRequest.number;
    if (identities.has(identity)) {
      return leaveOpen("ambiguous-development", "Duplicate Development PR identity: " + identity + ".");
    }
    identities.add(identity);

    if (pullRequest.repository !== repository) {
      return leaveOpen(
        "ambiguous-development",
        "Linked PR " + identity + " is outside the frontend repository; v1 will not guess cross-repository completion.",
      );
    }

    if (!pullRequest.mergedAt || !pullRequest.mergeCommitSha) {
      return leaveOpen(
        "implementation-not-merged",
        "Linked frontend PR #" + pullRequest.number + " is not merged with readable merge evidence.",
      );
    }

    if (isAfter(pullRequest.mergedAt, scopeFreshnessFloor)) {
      hasFreshImplementationEvidence = true;
    }

    if (pullRequest.baseRefName === PRODUCTION_BRANCH) {
      if (pullRequest.headRefName !== INTEGRATION_BRANCH || pullRequest.headRepository !== repository) {
        return leaveOpen(
          "ambiguous-production",
          "Linked PR #" + pullRequest.number
            + " targets main but is not the canonical same-repository dev -> main release path.",
        );
      }
      productionReceipts.push("PR #" + pullRequest.number + " merged directly through dev -> main.");
      continue;
    }

    if (pullRequest.baseRefName !== INTEGRATION_BRANCH) {
      return leaveOpen(
        "ambiguous-development",
        "Linked PR #" + pullRequest.number + " targets unsupported base "
          + (pullRequest.baseRefName ?? "unknown") + "; expected dev or canonical dev -> main.",
      );
    }

    if (typeof containsCommit !== "function") {
      throw new Error("containsCommit callback is required for dev implementation evidence");
    }

    const release = await findProductionRelease(pullRequest, releases, containsCommit);
    if (!release) {
      return leaveOpen(
        "awaiting-production",
        "Linked PR #" + pullRequest.number
          + " is merged to dev but no merged dev -> main release snapshot contains its merge commit.",
      );
    }

    productionReceipts.push("PR #" + pullRequest.number + " reached main via release PR #" + release.number + ".");
  }

  if (!hasFreshImplementationEvidence) {
    return leaveOpen(
      "scope-changed-after-implementation",
      "The Issue was edited or reopened after all currently linked implementation PRs merged. Link and merge fresh required implementation evidence before automatic completion.",
    );
  }

  return closeCompleted(productionReceipts.join(" "));
}
