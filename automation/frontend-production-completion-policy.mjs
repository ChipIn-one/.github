export const FRONTEND_REPOSITORY = "ChipIn-one/chipin-frontend";
export const INTEGRATION_BRANCH = "dev";
export const PRODUCTION_BRANCH = "main";

function leaveOpen(code, detail) {
  return { action: "leave-open", code, detail };
}

function closeCompleted(detail) {
  return { action: "close-completed", code: "production-complete", detail };
}

export function evaluateRequiredRelationships(issue) {
  if (issue.requiredRelationshipsReadable !== true) {
    return leaveOpen(
      "required-relationships-unreadable",
      "Required sub-issue/blocking relationships are unreadable; leave the Issue open and rerun after GitHub relationship reads recover.",
    );
  }

  const incompleteSubIssues = (issue.subIssues ?? []).filter((item) => (
    item.state !== "closed" || item.stateReason !== "completed"
  ));
  if (incompleteSubIssues.length > 0) {
    return leaveOpen(
      "required-sub-issue-incomplete",
      "Required sub-issue(s) are not closed/completed: "
        + incompleteSubIssues.map((item) => (
          (item.repository ?? "unknown") + "#" + item.number
          + " (" + (item.state ?? "unknown") + "/" + (item.stateReason ?? "unknown") + ")"
        )).join(", ")
        + ".",
    );
  }

  const openBlockers = (issue.blockedBy ?? []).filter((item) => item.state === "open");
  if (openBlockers.length > 0) {
    return leaveOpen(
      "blocked-by-open-issue",
      "Issue is still blocked by open Issue(s): "
        + openBlockers.map((item) => (item.repository ?? "unknown") + "#" + item.number).join(", ")
        + ".",
    );
  }

  return null;
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

function validTimestamps(values) {
  return (values ?? [])
    .filter((value) => typeof value === "string" && Number.isFinite(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

const CHECKBOX_PATTERN = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[[ xX]\]/gmu;

export function normalizeCheckboxes(text) {
  return String(text ?? "").replace(/\r\n/gu, "\n").replace(CHECKBOX_PATTERN, "$1[ ]");
}

function hasInvalidTimestamp(values) {
  return (values ?? []).some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value)));
}

function scopeHistoryUnreadable(detail) {
  return {
    floor: null,
    blocker: leaveOpen(
      "scope-history-unreadable",
      "Issue timeline or edit history is unreadable; leave the Issue open and rerun: " + detail,
    ),
  };
}

/**
 * Resolve the moment after which fresh implementation evidence is required.
 *
 * Without `scopeHistory` the legacy rule applies: any body edit (`lastEditedAt`) or reopen (`reopenedAt`)
 * after the last merge is a scope change. With `scopeHistory` (timeline closes/reopens/renames and the
 * body edit history) the rule is refined:
 * - a reopen is ignored when the close it reverts happened after every PR merged before that reopen
 *   (an early manual close after the implementation merged, undone to let automation finish);
 * - a body edit counts only when the text changed beyond `- [ ]` / `- [x]` toggles;
 * - a title rename always counts.
 * Unreadable history fails closed.
 */
export function resolveScopeFreshnessFloor(issue, mergedAtValues = []) {
  const history = issue.scopeHistory;
  if (history === undefined) {
    return { floor: latestTimestamp(issue.lastEditedAt, issue.reopenedAt), blocker: null, reasons: [] };
  }
  if (!history || typeof history !== "object" || history.readable !== true) {
    return scopeHistoryUnreadable(history?.detail ?? "no readable scope history was provided.");
  }
  if (hasInvalidTimestamp(history.closedAt) || hasInvalidTimestamp(history.reopenedAt) || hasInvalidTimestamp(history.renamedAt)) {
    return scopeHistoryUnreadable("a timeline event has no readable timestamp.");
  }
  if (hasInvalidTimestamp(mergedAtValues)) {
    return scopeHistoryUnreadable("a linked pull request has no readable mergedAt.");
  }

  const merges = validTimestamps(mergedAtValues);
  const closes = validTimestamps(history.closedAt);
  const reasons = [];

  for (const reopenedAt of validTimestamps(history.reopenedAt)) {
    const precedingClose = closes.filter((closedAt) => !isAfter(closedAt, reopenedAt)).at(-1) ?? null;
    const mergedBetween = precedingClose !== null && merges.some((mergedAt) => (
      isAfter(mergedAt, precedingClose) && !isAfter(mergedAt, reopenedAt)
    ));
    if (precedingClose !== null && !mergedBetween) continue;
    reasons.push({ at: reopenedAt, kind: "reopened" });
  }

  for (const renamedAt of validTimestamps(history.renamedAt)) {
    reasons.push({ at: renamedAt, kind: "title changed" });
  }

  const revisions = Array.isArray(history.bodyRevisions) ? history.bodyRevisions : [];
  if (issue.lastEditedAt) {
    if (revisions.length < 2) {
      return scopeHistoryUnreadable("the Issue was edited (" + issue.lastEditedAt
        + ") but fewer than two body revisions are available.");
    }
    for (const revision of revisions) {
      if (typeof revision?.body !== "string" || !Number.isFinite(Date.parse(revision?.editedAt ?? ""))) {
        return scopeHistoryUnreadable("a body revision has no readable text or timestamp.");
      }
    }
    const ordered = [...revisions].sort((a, b) => Date.parse(a.editedAt) - Date.parse(b.editedAt));
    // The earliest revision must be the original body (its editedAt equals the Issue createdAt);
    // otherwise the first real edit cannot be compared and a scope change could be missed.
    if (issue.createdAt && Date.parse(ordered[0].editedAt) !== Date.parse(issue.createdAt)) {
      return scopeHistoryUnreadable("the earliest body revision (" + ordered[0].editedAt
        + ") is not the original body (createdAt " + issue.createdAt + ").");
    }
    if (Date.parse(ordered.at(-1).editedAt) !== Date.parse(issue.lastEditedAt)) {
      return scopeHistoryUnreadable("the latest body revision (" + ordered.at(-1).editedAt
        + ") does not match lastEditedAt (" + issue.lastEditedAt + ").");
    }
    for (let index = 1; index < ordered.length; index += 1) {
      if (normalizeCheckboxes(ordered[index - 1].body) === normalizeCheckboxes(ordered[index].body)) continue;
      reasons.push({ at: ordered[index].editedAt, kind: "text edited" });
    }
  }

  const floor = latestTimestamp(...reasons.map((reason) => reason.at));
  return { floor, blocker: null, reasons };
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
  readScopeHistory,
} = {}) {
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

    mergedAtValues.push(pullRequest.mergedAt);

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

  if (issue.scopeHistory === undefined && typeof readScopeHistory === "function") {
    const history = await readScopeHistory(issue);
    issue = { ...issue, scopeHistory: history && typeof history === "object" ? history : null };
  }
  const freshness = resolveScopeFreshnessFloor(issue, mergedAtValues);
  if (freshness.blocker) return freshness.blocker;

  const hasFreshImplementationEvidence = freshness.floor === null
    || mergedAtValues.some((mergedAt) => isAfter(mergedAt, freshness.floor));
  if (!hasFreshImplementationEvidence) {
    // every change after the last merge, not only the latest one
    const lastMergedAt = latestTimestamp(...mergedAtValues);
    const reasons = (freshness.reasons ?? [])
      .filter((reason) => lastMergedAt === null || isAfter(reason.at, lastMergedAt))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((reason) => reason.kind + " at " + reason.at);
    return leaveOpen(
      "scope-changed-after-implementation",
      "The Issue was edited or reopened after all currently linked implementation PRs merged"
        + (reasons.length > 0 ? " (" + reasons.join(", ") + ")" : "")
        + ". Link and merge fresh required implementation evidence before automatic completion.",
    );
  }

  return closeCompleted(productionReceipts.join(" "));
}
