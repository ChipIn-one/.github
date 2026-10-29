import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { GitHubClient, readIssueProjectItems, readProjectSnapshot } from "./github-metadata.mjs";
import { readAdmission, assertFreshReceipt } from "./issue-admission.mjs";
import { getRepositoryProfile, integrationBranch, listRepositories } from "./registry.mjs";

// Development-link repositories come from workflow-registry.yaml: every kind whose record keeps
// `developmentLink` on. Meta repositories host the shared automation; their Issues are admitted (#183)
// and, since the `.github` caller of #179, their PRs are Development-linked by this reconciler too
// (the completion engine needs the link to close a `.github` Issue after the merge into master).
export const SUPPORTED_REPOSITORIES = new Set(
  listRepositories({ kinds: ["code", "docs", "meta"], capability: "developmentLink" }),
);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const TASK_IDENTITY_PATTERN = new RegExp(
  "^ChipIn-one\\/(" + [...SUPPORTED_REPOSITORIES].map((name) => escapeRegExp(name.split("/")[1])).join("|") + ")#([1-9]\\d*)$",
  "u",
);
const TASK_IDENTITY_MARKER = "Task identity:";

// In Progress writer (.github#218): opt-in, run only after the native Development link is confirmed.
export const IN_PROGRESS_STATUS = "In Progress";
// Only these move forward to In Progress; In Progress, Awaiting release, Done, empty and unknown stay as they are.
export const IN_PROGRESS_SOURCES = Object.freeze(["Backlog", "Todo"]);
const DEPENDABOT_LOGIN = "dependabot[bot]";

const PROJECT_ITEM_STATUS_QUERY = `
query DevelopmentLinkProjectItemStatus($itemId: ID!, $statusField: String!) {
  node(id: $itemId) {
    __typename
    ... on ProjectV2Item {
      id
      fieldValueByName(name: $statusField) {
        __typename
        ... on ProjectV2ItemFieldSingleSelectValue { name }
      }
    }
  }
}`;

const SET_IN_PROGRESS_MUTATION = `
mutation SetDevelopmentLinkInProgress($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;

const TARGET_QUERY = `
query DevelopmentLinkTarget(
  $owner: String!
  $repo: String!
  $issueNumber: Int!
  $pullRequestNumber: Int!
  $after: String
) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    taskIssue: issue(number: $issueNumber) {
      id
      number
      url
      repository { nameWithOwner }
      closedByPullRequestsReferences(
        first: 100
        after: $after
        includeClosedPrs: true
        userLinkedOnly: true
      ) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          number
          url
          repository { nameWithOwner }
        }
      }
    }
    implementationPr: pullRequest(number: $pullRequestNumber) {
      id
      number
      url
      repository { nameWithOwner }
      body
    }
  }
}`;

const LINK_MUTATION = `
mutation AddNativeDevelopmentLink($issueId: ID!, $pullRequestIds: [ID!]!) {
  addCloseIssueReferences(input: { issueId: $issueId, pullRequestIds: $pullRequestIds }) {
    issue { id number url repository { nameWithOwner } }
  }
}`;

export function parseTaskIdentity(value) {
  const normalized = String(value ?? "").trim();
  const match = TASK_IDENTITY_PATTERN.exec(normalized);
  if (!match) {
    throw new Error(
      "Task identity must be exactly ChipIn-one/<supported-repository>#<issue-number>.",
    );
  }
  const repository = `ChipIn-one/${match[1]}`;
  return {
    canonical: `${repository}#${match[2]}`,
    repository,
    issueNumber: Number(match[2]),
  };
}

export function readTaskIdentityMarker(body) {
  const markerLines = String(body ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(TASK_IDENTITY_MARKER));

  if (markerLines.length === 0) return null;
  if (markerLines.length !== 1) {
    throw new Error(
      `Task identity is ambiguous: expected exactly one \`${TASK_IDENTITY_MARKER} ...\` PR body line, found ${markerLines.length}.`,
    );
  }

  const line = markerLines[0];
  if (!line.startsWith(`${TASK_IDENTITY_MARKER} `)) {
    throw new Error(
      `Task identity marker must be exactly \`${TASK_IDENTITY_MARKER} ChipIn-one/<supported-repository>#<issue-number>\`.`,
    );
  }
  return parseTaskIdentity(line.slice(`${TASK_IDENTITY_MARKER} `.length));
}

// Reuse the same explicit KB owner marker at both PR admission and the
// immediate native Development mutation boundary; never infer a KB default.
export function readKBTaskOwnerMarker(body) {
  const matches = String(body ?? '').match(/^Task owner:\s*@?([a-z\d-]+)\s*$/gim) ?? [];
  if (matches.length !== 1) throw new Error('KB PR requires one explicit Task owner: @login line.');
  return matches[0].split(':')[1].trim().replace(/^@/, '');
}

function resolveTaskIdentity({ explicitTaskIdentity, pullRequestBody }) {
  const bodyIdentity = readTaskIdentityMarker(pullRequestBody);
  if (!explicitTaskIdentity) {
    if (!bodyIdentity) {
      throw new Error(
        `Task identity is missing. Add exactly one \`${TASK_IDENTITY_MARKER} ChipIn-one/<supported-repository>#<issue-number>\` line to the PR body or supply the explicit workflow input.`,
      );
    }
    return bodyIdentity;
  }

  const explicit = parseTaskIdentity(explicitTaskIdentity);
  if (bodyIdentity && bodyIdentity.canonical !== explicit.canonical) {
    throw new Error(
      `Task identity is ambiguous: explicit input ${explicit.canonical} conflicts with PR body ${bodyIdentity.canonical}.`,
    );
  }
  return explicit;
}

function assertSupportedRepository(repository) {
  if (!SUPPORTED_REPOSITORIES.has(repository)) {
    throw new Error(`Unsupported repository ${repository}.`);
  }
}

function splitRepository(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error(`Invalid repository identity ${repository}.`);
  }
  return parts;
}

function parsePositiveInteger(value, label) {
  const normalized = String(value ?? "").trim();
  if (!/^[1-9]\d*$/u.test(normalized)) {
    throw new Error(`${label} must be a positive integer.`);
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${label} must be a safe positive integer.`);
  }
  return number;
}

async function readNativeState(client, { repository, issueNumber, pullRequestNumber }) {
  const [owner, repo] = splitRepository(repository);
  const references = [];
  let after = null;
  let expectedIssueId = null;
  let expectedPullRequestId = null;
  let totalCount = null;
  let issueSnapshot = null;
  let pullRequestSnapshot = null;

  do {
    let data;
    try {
      data = await client.graphql(TARGET_QUERY, {
        owner,
        repo,
        issueNumber,
        pullRequestNumber,
        after,
      });
    } catch (error) {
      throw new Error(`Native Development relationship state is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const root = data?.repository;
    if (!root || root.nameWithOwner !== repository) {
      throw new Error(`Repository ${repository} is unreadable.`);
    }
    const issue = root.taskIssue;
    const pullRequest = root.implementationPr;
    if (!issue || !issue.id || issue.repository?.nameWithOwner !== repository || issue.number !== issueNumber) {
      throw new Error(`Issue ${repository}#${issueNumber} is unreadable or is not an Issue.`);
    }
    if (!pullRequest || !pullRequest.id || pullRequest.repository?.nameWithOwner !== repository || pullRequest.number !== pullRequestNumber) {
      throw new Error(`Pull request ${repository}#${pullRequestNumber} is unreadable.`);
    }
    if (!issue.closedByPullRequestsReferences?.pageInfo || !Array.isArray(issue.closedByPullRequestsReferences.nodes)) {
      throw new Error(`Native Development relationship state for ${repository}#${issueNumber} is unreadable.`);
    }

    if (expectedIssueId !== null && expectedIssueId !== issue.id) {
      throw new Error(`Issue identity changed while reading ${repository}#${issueNumber}.`);
    }
    if (expectedPullRequestId !== null && expectedPullRequestId !== pullRequest.id) {
      throw new Error(`Pull request identity changed while reading ${repository}#${pullRequestNumber}.`);
    }
    expectedIssueId ??= issue.id;
    expectedPullRequestId ??= pullRequest.id;
    issueSnapshot ??= issue;
    pullRequestSnapshot ??= pullRequest;
    const pageTotalCount = issue.closedByPullRequestsReferences.totalCount;
    if (!Number.isInteger(pageTotalCount) || pageTotalCount < 0) {
      throw new Error(`Native Development relationship count for ${repository}#${issueNumber} is unreadable.`);
    }
    if (totalCount !== null && totalCount !== pageTotalCount) {
      throw new Error(`Native Development relationship count changed while reading ${repository}#${issueNumber}.`);
    }
    totalCount ??= pageTotalCount;

    for (const reference of issue.closedByPullRequestsReferences.nodes) {
      if (!reference?.id || !reference.repository?.nameWithOwner || !Number.isInteger(reference.number)) {
        throw new Error(`Native Development relationship state for ${repository}#${issueNumber} contains an unreadable PR reference.`);
      }
      references.push(reference);
    }

    const pageInfo = issue.closedByPullRequestsReferences.pageInfo;
    if (pageInfo.hasNextPage && !pageInfo.endCursor) {
      throw new Error(`Native Development relationship pagination for ${repository}#${issueNumber} is missing a cursor.`);
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
  } while (after !== null);

  if (references.length !== totalCount) {
    throw new Error(
      `Native Development relationship pagination for ${repository}#${issueNumber} is incomplete: read ${references.length} of ${totalCount}.`,
    );
  }

  return {
    issue: issueSnapshot,
    pullRequest: pullRequestSnapshot,
    references,
    linked: references.some((reference) => (
      reference.id === pullRequestSnapshot.id
      && reference.number === pullRequestNumber
      && reference.repository.nameWithOwner === repository
    )),
  };
}

async function readPullRequest(client, repository, pullRequestNumber) {
  const [owner, repo] = splitRepository(repository);
  let data;
  try {
    data = await client.graphql(`
query DevelopmentLinkPullRequest($owner: String!, $repo: String!, $pullRequestNumber: Int!) {
  repository(owner: $owner, name: $repo) {
    nameWithOwner
    pullRequest(number: $pullRequestNumber) {
      id
      number
      body
      repository { nameWithOwner }
    }
  }
}`, { owner, repo, pullRequestNumber });
  } catch (error) {
    throw new Error(`Pull request ${repository}#${pullRequestNumber} is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pullRequest = data?.repository?.pullRequest;
  if (
    data?.repository?.nameWithOwner !== repository
    || !pullRequest
    || !pullRequest.id
    || pullRequest.repository?.nameWithOwner !== repository
    || pullRequest.number !== pullRequestNumber
  ) {
    throw new Error(`Pull request ${repository}#${pullRequestNumber} is unreadable.`);
  }
  return pullRequest;
}

export class InProgressBlocked extends Error {
  // `mutated`: false = nothing was written, true = the Status mutation succeeded before this error,
  // null = the mutation call returned something unexpected, so whether it applied is unknown.
  constructor(code, message, { mutated = false } = {}) {
    super(message);
    this.name = "InProgressBlocked";
    this.code = code;
    this.mutated = mutated;
  }
}

function inProgressBlocked(code, message, options) {
  return new InProgressBlocked(code, message, options);
}

function statusSkip(code, detail) {
  return { result: "unchanged", mutated: false, code, detail };
}

const errorText = (error) => (error instanceof Error ? error.message : String(error));

// Deterministic faults fail the job (exit 1, after the link): a broken Project write path, missing access to
// Project #5, a broken configuration or an unexpected exception. Transient reads and stale or drifted state are
// warnings (exit 0). Neither ever undoes or hides the Development link.
export const IN_PROGRESS_ERROR_CODES = Object.freeze([
  "PROJECT_STATUS_WRITE", "PROJECT_STATUS_READBACK", "PROJECT_STATUS_FIELD",
  "PROJECT_ACCESS", "PROJECT_CONFIG", "PROJECT_STATUS_ERROR", "OPT_IN_MISCONFIGURED",
]);
// Skips that mean the PR, the Issue or the Status drifted during the run, not a settled no-op.
export const IN_PROGRESS_WARNING_SKIP_CODES = Object.freeze(["stale-snapshot", "pr-not-integration-branch", "pr-task-identity-changed"]);

export function inProgressOutcomeSeverity(projectStatus) {
  if (!projectStatus) return "none";
  if (projectStatus.result === "blocked") return IN_PROGRESS_ERROR_CODES.includes(projectStatus.code) ? "error" : "warning";
  if (IN_PROGRESS_WARNING_SKIP_CODES.includes(projectStatus.code)) return "warning";
  if (projectStatus.prStateAfterWrite || projectStatus.issueStateAfterWrite) return "warning";
  return "none";
}

// Prints the Status outcome after the receipt: `::error::` + exit 1 or `::warning::` + exit 0.
export function reportInProgressOutcome(receipt, { write = (text) => process.stdout.write(text), setExitCode = (code) => { process.exitCode = code; } } = {}) {
  const severity = inProgressOutcomeSeverity(receipt?.projectStatus);
  if (severity === "none") return severity;
  const line = `In Progress Status ${receipt.projectStatus.code} (Development link kept): ${receipt.projectStatus.detail}`;
  write(`::${severity}::${line.replace(/\r?\n/gu, " ")}\n`);
  if (severity === "error") setExitCode(1);
  return severity;
}

// Project reads that fail for a deterministic reason (Project gone, token without access) are errors;
// phantom pages, read deadlines, item growth and other transient failures are warnings.
const TRANSIENT_PROJECT_CODES = new Set(["PROJECT_ITEMS_PHANTOM", "PROJECT_READ_DEADLINE", "PROJECT_ITEMS_GREW"]);
const ACCESS_FAILURE = /is unavailable|Could not resolve to a ProjectV2|not accessible|INSUFFICIENT_SCOPES|FORBIDDEN|-> 40[13]\b/iu;

function projectReadBlocked(projectNumber, error, what) {
  const text = errorText(error);
  const transient = TRANSIENT_PROJECT_CODES.has(error?.code) || !ACCESS_FAILURE.test(text);
  return inProgressBlocked(transient ? "PROJECT_UNREADABLE" : "PROJECT_ACCESS",
    `Project #${projectNumber} ${what} ${transient ? "is unreadable" : "is not accessible with the Project token"}: ${text}`);
}

function inProgressCoordinates(project, statusField) {
  const fields = (project?.fields ?? []).filter((field) => field?.name === statusField);
  if (fields.length !== 1) {
    throw inProgressBlocked("PROJECT_STATUS_FIELD", `Project Status field is missing or ambiguous (${fields.length} matches).`);
  }
  const field = fields[0];
  if (field.isIssueField === true) throw inProgressBlocked("PROJECT_STATUS_FIELD", "Project Status must remain project-local.");
  const options = (field.options ?? []).filter((option) => option?.name === IN_PROGRESS_STATUS);
  if (options.length !== 1) {
    throw inProgressBlocked("PROJECT_STATUS_FIELD", `${IN_PROGRESS_STATUS} Status option is missing or ambiguous (${options.length} matches).`);
  }
  if (!project?.id || !field.id || !options[0].id) {
    throw inProgressBlocked("PROJECT_STATUS_FIELD", "Project Status mutation coordinates are unreadable.");
  }
  return { projectId: project.id, fieldId: field.id, optionId: options[0].id };
}

async function readItemStatus(client, itemId, statusField) {
  let data;
  try { data = await client.graphql(PROJECT_ITEM_STATUS_QUERY, { itemId, statusField }); }
  catch (error) { throw inProgressBlocked("PROJECT_ITEM_UNREADABLE", `Project item ${itemId} Status is unreadable: ${errorText(error)}`); }
  const item = data?.node;
  if (item?.id !== itemId) throw inProgressBlocked("PROJECT_ITEM_UNREADABLE", `Project item ${itemId} Status read did not return the expected item.`);
  return item.fieldValueByName?.name ?? null;
}

// Every eligibility check that GitHub can change between the link and the Status write. Returns a skip
// receipt when the PR or Issue is no longer eligible, null when the write may proceed; throws when unreadable.
async function readInProgressEligibility(client, { repository, issueNumber, pullRequestNumber, allowMissingMarker = false }) {
  let pullRequest;
  let issue;
  try {
    [pullRequest, issue] = await Promise.all([
      client.request(`/repos/${repository}/pulls/${pullRequestNumber}`),
      client.request(`/repos/${repository}/issues/${issueNumber}`),
    ]);
  } catch (error) {
    throw inProgressBlocked("ISSUE_OR_PR_UNREADABLE", `Issue/PR state for the In Progress write is unreadable: ${errorText(error)}`);
  }
  if (pullRequest?.number !== pullRequestNumber || !pullRequest?.user?.login || !pullRequest?.state) {
    throw inProgressBlocked("ISSUE_OR_PR_UNREADABLE", `Pull request ${repository}#${pullRequestNumber} is unreadable.`);
  }
  if (pullRequest.user.login === DEPENDABOT_LOGIN) {
    return statusSkip("dependabot-pr", "Dependabot PRs never move Project Status.");
  }
  if (pullRequest.state !== "open") {
    return statusSkip("pr-not-open", `PR ${repository}#${pullRequestNumber} is ${pullRequest.state}; Project Status left unchanged.`);
  }
  // A draft PR is parked work: converting a PR to draft is one of the ways to keep an Issue out of In Progress.
  if (pullRequest.draft === true) {
    return statusSkip("pr-draft", `PR ${repository}#${pullRequestNumber} is a draft; Project Status left unchanged until it is ready for review.`);
  }
  if (pullRequest.head?.repo?.full_name !== repository || pullRequest.base?.repo?.full_name !== repository) {
    return statusSkip("pr-not-same-repository", "Only same-repository PRs move Project Status.");
  }
  if (pullRequest.base?.ref !== integrationBranch(repository)) {
    return statusSkip("pr-not-integration-branch", `PR ${repository}#${pullRequestNumber} targets ${pullRequest.base?.ref ?? "an unreadable base"}, not ${integrationBranch(repository)}; Project Status left unchanged.`);
  }
  let marker;
  try { marker = readTaskIdentityMarker(pullRequest.body); }
  catch (error) { return statusSkip("pr-task-identity-changed", `PR Task identity is no longer readable (${errorText(error)}); Project Status left unchanged.`); }
  const expected = `${repository}#${issueNumber}`;
  if (marker ? marker.canonical !== expected : !allowMissingMarker) {
    return statusSkip("pr-task-identity-changed", `PR Task identity is ${marker?.canonical ?? "missing"}, not the linked ${expected}; Project Status left unchanged.`);
  }
  if (issue?.number !== issueNumber || issue?.pull_request) {
    throw inProgressBlocked("NOT_AN_ISSUE", `${repository}#${issueNumber} is unreadable or is not an Issue.`);
  }
  if (issue.state !== "open") {
    return statusSkip("issue-not-open", `Issue ${repository}#${issueNumber} is ${issue.state ?? "unreadable"}; Project Status left unchanged.`);
  }
  return null;
}

function sourceStatusSkip(status) {
  if (status === IN_PROGRESS_STATUS) return statusSkip("in-progress-current", `Project Status is already ${IN_PROGRESS_STATUS}.`);
  if (!IN_PROGRESS_SOURCES.includes(status)) {
    return statusSkip("in-progress-skipped:" + (status ?? "none"), `Project Status ${status === null ? "is empty" : status}; `
      + `only ${IN_PROGRESS_SOURCES.join(" or ")} move to ${IN_PROGRESS_STATUS}.`);
  }
  return null;
}

/**
 * In Progress writer (.github#218), run only after the native Development link of an open same-repository
 * PR to its open Issue is confirmed. Moves the Issue's Project #5 Status Backlog / Todo -> In Progress.
 * In Progress, Awaiting release, Done, empty or any other value is left as it is (never backwards). Dependabot,
 * draft, closed, cross-repository, wrong-base or re-targeted PRs and closed Issues are no-ops.
 * Cheap path first: the Issue's own projectItems decides whether there is anything to do; only a Backlog/Todo
 * item reads the full Project (readProjectSnapshot, the .github#221 phantom-page reader) for the cross-check and
 * the mutation coordinates. At the mutation boundary the PR/Issue eligibility and then the item Status are read
 * again; after the write the Status is read back (one retry) and the PR/Issue state is read once more.
 */
export async function setInProgressAfterLink(client, {
  repository,
  issueNumber,
  pullRequestNumber,
  config,
  allowMissingMarker = false,
  readProject = readProjectSnapshot,
  readIssueItems = readIssueProjectItems,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)),
  readBackRetryDelayMs = 1000,
}) {
  const projectNumber = config?.project?.number;
  const statusField = config?.project?.statusField;
  if (!config?.organization || !Number.isInteger(projectNumber) || typeof statusField !== "string" || !statusField) {
    throw inProgressBlocked("PROJECT_CONFIG", "Project #5 configuration (organization, project number, statusField) is missing.");
  }
  const eligibility = { repository, issueNumber, pullRequestNumber, allowMissingMarker };

  const ineligible = await readInProgressEligibility(client, eligibility);
  if (ineligible) return ineligible;

  let issueSide;
  try { issueSide = await readIssueItems(client, repository, issueNumber, projectNumber); }
  catch (error) { throw projectReadBlocked(projectNumber, error, "membership of the Issue"); }
  if (!Array.isArray(issueSide) || issueSide.length !== 1 || !issueSide[0]?.id) {
    throw inProgressBlocked("PROJECT_MEMBERSHIP", `Project #${projectNumber} membership of ${repository}#${issueNumber} is missing or ambiguous `
      + `(Issue side ${Array.isArray(issueSide) ? issueSide.length : "unreadable"}); manual reconciliation is required.`);
  }
  const itemId = issueSide[0].id;
  const baselineStatus = issueSide[0].status ?? null;
  const settled = sourceStatusSkip(baselineStatus);
  if (settled) return settled;

  let project;
  try { project = await readProject(client, config); }
  catch (error) { throw projectReadBlocked(projectNumber, error, "items"); }
  const listed = (project?.items ?? []).filter((item) => item?.repository === repository && item?.number === issueNumber);
  if (listed.length !== 1 || listed[0].id !== itemId) {
    throw inProgressBlocked("PROJECT_MEMBERSHIP", `Project #${projectNumber} item of ${repository}#${issueNumber} differs between the listing `
      + `(${listed.length} item(s)) and the Issue side; manual reconciliation is required.`);
  }
  const coordinates = inProgressCoordinates(project, statusField);

  // Stale check at the mutation boundary: PR/Issue eligibility first, the item Status last (closest to the write).
  const lateIneligible = await readInProgressEligibility(client, eligibility);
  if (lateIneligible) return lateIneligible;
  const currentStatus = await readItemStatus(client, itemId, statusField);
  if (currentStatus !== baselineStatus) {
    return statusSkip("stale-snapshot", `Project Status changed from ${baselineStatus} to ${currentStatus ?? "empty"} after the snapshot; left unchanged.`);
  }

  let data;
  try {
    data = await client.graphql(SET_IN_PROGRESS_MUTATION, { ...coordinates, itemId });
  } catch (error) {
    throw inProgressBlocked("PROJECT_STATUS_WRITE", `Project Status mutation failed: ${errorText(error)}. Check that the token writes Project #${projectNumber}.`);
  }
  if (data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) {
    throw inProgressBlocked("PROJECT_STATUS_WRITE", "Project Status mutation did not return the expected item id; whether it applied is unknown.", { mutated: null });
  }

  // From here on the mutation succeeded: every error carries mutated: true.
  let readBack = null;
  let readBackError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await wait(readBackRetryDelayMs);
    try {
      readBack = await readItemStatus(client, itemId, statusField);
      readBackError = null;
      if (readBack === IN_PROGRESS_STATUS) break;
    } catch (error) {
      readBackError = error;
    }
  }
  if (readBackError) {
    throw inProgressBlocked("PROJECT_STATUS_READBACK", `Project Status of ${repository}#${issueNumber} was written but its read-back is unreadable: ${errorText(readBackError)}`, { mutated: true });
  }
  if (readBack !== IN_PROGRESS_STATUS) {
    throw inProgressBlocked("PROJECT_STATUS_READBACK", `Project Status of ${repository}#${issueNumber} did not read back as ${IN_PROGRESS_STATUS} (read ${readBack ?? "none"}).`, { mutated: true });
  }

  const updated = { result: "updated", mutated: true, code: "in-progress-set", detail: `Project Status ${baselineStatus} -> ${IN_PROGRESS_STATUS}.`, itemId };
  // The PR or the Issue may close between the last eligibility read and the write. Report it; never revert.
  const [prAfter, issueAfter] = await Promise.all([
    client.request(`/repos/${repository}/pulls/${pullRequestNumber}`).then((value) => value?.state ?? null, () => null),
    client.request(`/repos/${repository}/issues/${issueNumber}`).then((value) => value?.state ?? null, () => null),
  ]);
  const flags = {};
  if (prAfter !== "open") flags.prStateAfterWrite = prAfter ?? "unreadable";
  if (issueAfter !== "open") flags.issueStateAfterWrite = issueAfter ?? "unreadable";
  if (!Object.keys(flags).length) return updated;
  const parts = Object.entries(flags).map(([key, value]) => `the ${key.startsWith("pr") ? "PR" : "Issue"} is ${value}`);
  return { ...updated, ...flags, detail: `${updated.detail} After the write ${parts.join(" and ")}; check the Issue Status by hand.` };
}

// Runs the opt-in writer after a confirmed link. A blocked Status write never discards the link result: the
// receipt keeps result/readBackConfirmed of the link and reports the Status outcome next to it.
async function applyInProgress(receipt, inProgress) {
  if (inProgress?.misconfigured) {
    return { ...receipt, projectStatus: { result: "blocked", mutated: false, code: "OPT_IN_MISCONFIGURED", detail: inProgress.misconfigured } };
  }
  if (!inProgress?.enabled) return receipt;
  try {
    const projectStatus = await (inProgress.write ?? setInProgressAfterLink)(inProgress.client, {
      repository: receipt.repository,
      issueNumber: receipt.issueNumber,
      pullRequestNumber: receipt.pullRequestNumber,
      config: inProgress.config,
      // a PR without a body marker is acceptable only when an explicit dispatch input named the Task identity
      allowMissingMarker: inProgress.allowMissingMarker === true,
    });
    return { ...receipt, projectStatus };
  } catch (error) {
    return {
      ...receipt,
      projectStatus: {
        result: "blocked",
        mutated: error instanceof InProgressBlocked ? error.mutated : false,
        code: error instanceof InProgressBlocked ? error.code : "PROJECT_STATUS_ERROR",
        detail: errorText(error),
      },
    };
  }
}

export async function reconcileDevelopmentLink(client, {
  repository,
  pullRequestNumber,
  explicitTaskIdentity = null,
  expectedHeadSha = null,
  admission = null,
  inProgress = null,
}) {
  assertSupportedRepository(repository);
  const prNumber = parsePositiveInteger(pullRequestNumber, "Pull request number");
  const pullRequest = await readPullRequest(client, repository, prNumber);
  const task = resolveTaskIdentity({
    explicitTaskIdentity,
    pullRequestBody: pullRequest.body,
  });

  assertSupportedRepository(task.repository);
  if (task.repository !== repository) {
    throw new Error(
      `Task identity ${task.canonical} does not belong to pull request repository ${repository}; cross-repository guessing is not allowed.`,
    );
  }

  const before = await readNativeState(client, {
    repository,
    issueNumber: task.issueNumber,
    pullRequestNumber: prNumber,
  });

  if (before.pullRequest.id !== pullRequest.id) {
    throw new Error(`Pull request identity changed while reconciling ${repository}#${prNumber}.`);
  }

  const finalPullRequest = await readPullRequest(client, repository, prNumber);
  if (finalPullRequest.id !== pullRequest.id || finalPullRequest.id !== before.pullRequest.id) {
    throw new Error(`Pull request identity changed while reconciling ${repository}#${prNumber}.`);
  }
  const revalidatedTask = resolveTaskIdentity({
    explicitTaskIdentity,
    pullRequestBody: finalPullRequest.body,
  });
  if (revalidatedTask.canonical !== task.canonical) {
    throw new Error(
      `Task identity changed while reconciling ${repository}#${prNumber}: ${task.canonical} -> ${revalidatedTask.canonical}.`,
    );
  }

  let admittedPRBody = null;
  if (expectedHeadSha !== null) {
    if (!/^[a-f0-9]{40}$/.test(expectedHeadSha)) throw new Error('Trusted PR head SHA must be exactly 40 lowercase hex characters.');
    // Before any Development mutation, re-read the trusted head/branches/body;
    // the PR node ID alone survives pushes and cannot prove current admission.
    let current;
    try { current = await client.request('/repos/' + repository + '/pulls/' + prNumber); }
    catch (error) { throw new Error('Current PR head before Development mutation is unreadable: ' + error.message); }
    if (current?.number !== prNumber || current?.state !== 'open' ||
        current?.head?.sha !== expectedHeadSha || current?.head?.repo?.full_name !== repository ||
        current?.base?.repo?.full_name !== repository ||
        current?.base?.ref !== integrationBranch(repository)) {
      throw new Error('STALE: PR head SHA/state/branch changed after canonical admission.');
    }
    const admittedMarker = readTaskIdentityMarker(current.body);
    if (!admittedMarker || admittedMarker.canonical !== task.canonical) {
      throw new Error('STALE: PR Task identity changed or disappeared after canonical admission.');
    }
    // Registry owner null = the task owner is chosen at intake (KB), so the PR must declare it.
    if (getRepositoryProfile(repository)?.owner === null) {
      let currentOwner;
      try { currentOwner = readKBTaskOwnerMarker(current.body); }
      catch (error) { throw new Error('STALE: ' + error.message); }
      if (currentOwner !== admission?.selectedOwner) {
        throw new Error('STALE: KB PR Task owner differs from the admitted native assignee.');
      }
    }
    admittedPRBody = current.body;
  }

  if (expectedHeadSha !== null) {
    // A PR-SHA reread alone cannot prove the Issue is still admitted:
    // native closure/ownership/fields/Project may drift after the earlier action step.
    // The read-only canonical reader must confirm the SAME revision at this boundary.
    if (!admission?.client || !admission?.config ||
        !/^[a-f0-9]{64}$/.test(admission.expectedRevision ?? '') ||
        !admission.selectedOwner) {
      throw new Error('Live exact-Issue admission revision and org read credential are required before Development mutation.');
    }
    const latest = await (admission.read ?? readAdmission)({
      client: admission.client, config: admission.config,
      repository: task.repository, number: task.issueNumber,
      selectedOwner: admission.selectedOwner,
      expectedRevision: admission.expectedRevision,
    });
    if (latest?.blockers?.length) {
      throw new Error('STALE: Issue admission changed before Development mutation: ' + latest.blockers.join('; '));
    }
    assertFreshReceipt(latest?.receipt, {
      issue: task.canonical, revision: admission.expectedRevision,
    });
    // Issue/Project read-back is multi-request. A push or PR-body edit during it
    // must not authorize a different PR revision to receive a native link.
    let afterAdmission;
    try { afterAdmission = await client.request('/repos/' + repository + '/pulls/' + prNumber); }
    catch (error) { throw new Error('Current PR head after Issue admission is unreadable: ' + error.message); }
    if (afterAdmission?.number !== prNumber || afterAdmission?.state !== 'open' ||
        afterAdmission?.head?.sha !== expectedHeadSha ||
        afterAdmission?.head?.repo?.full_name !== repository ||
        afterAdmission?.base?.repo?.full_name !== repository ||
        afterAdmission?.base?.ref !== integrationBranch(repository) ||
        afterAdmission?.body !== admittedPRBody) {
      throw new Error('STALE: PR head, state, branch or body changed during live Issue admission.');
    }
    // The awaited PR read may exceed the receipt's 120-second lifetime.
    // Recheck freshness at the final authorized boundary, for both the
    // already-linked return and the first Development write.
    assertFreshReceipt(latest.receipt, {
      issue: task.canonical, revision: admission.expectedRevision,
    });
  }

  if (before.linked) {
    return applyInProgress({
      result: "already-linked",
      taskIdentity: task.canonical,
      repository,
      issueNumber: task.issueNumber,
      pullRequestNumber: prNumber,
      readBackConfirmed: true,
    }, inProgress);
  }

  let mutation;
  try {
    mutation = await client.graphql(LINK_MUTATION, {
      issueId: before.issue.id,
      pullRequestIds: [before.pullRequest.id],
    });
  } catch (error) {
    throw new Error(
      `Native Development link mutation failed for ${task.canonical} -> ${repository}#${prNumber}: ${error instanceof Error ? error.message : String(error)}. Check Issues write permission and GraphQL addCloseIssueReferences capability.`,
    );
  }

  const mutatedIssue = mutation?.addCloseIssueReferences?.issue;
  if (
    !mutatedIssue
    || mutatedIssue.id !== before.issue.id
    || mutatedIssue.number !== task.issueNumber
    || mutatedIssue.repository?.nameWithOwner !== repository
  ) {
    throw new Error(`Native Development link mutation returned an unexpected Issue for ${task.canonical}.`);
  }

  const after = await readNativeState(client, {
    repository,
    issueNumber: task.issueNumber,
    pullRequestNumber: prNumber,
  });
  if (!after.linked) {
    throw new Error(
      `Native Development link read-back failed: ${task.canonical} is not linked to ${repository}#${prNumber} through user-linked Development references.`,
    );
  }

  return applyInProgress({
    result: "linked",
    taskIdentity: task.canonical,
    repository,
    issueNumber: task.issueNumber,
    pullRequestNumber: prNumber,
    readBackConfirmed: true,
  }, inProgress);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument ${key}.`);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`Missing value for ${key}.`);
    values.set(key, value);
    index += 1;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repository = args.get("--repository") || process.env.CHIPIN_PR_REPOSITORY;
  const pullRequestNumber = args.get("--pull-request") || process.env.CHIPIN_PR_NUMBER;
  const explicitTaskIdentity = args.get("--task") || process.env.CHIPIN_TASK_IDENTITY || null;
  const expectedHeadSha = args.get("--expected-head-sha") || process.env.CHIPIN_EXPECTED_HEAD_SHA || null;
  if (!repository) throw new Error("PR repository is required.");
  if (!pullRequestNumber) throw new Error("Pull request number is required.");
  if (!expectedHeadSha || !process.env.CHIPIN_ADMISSION_TOKEN ||
      !/^[a-f0-9]{64}$/.test(process.env.CHIPIN_EXPECTED_ADMISSION_REVISION ?? '') ||
      !process.env.CHIPIN_SELECTED_OWNER) {
    throw new Error('Trusted PR SHA, live admission token, exact revision and native required owner are mandatory.');
  }
  const configPath = process.env.GITHUB_ACTION_PATH
    ? resolve(process.env.GITHUB_ACTION_PATH, '../metadata-migration.config.json')
    : resolve('automation/metadata-migration.config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const admission = {
    client: new GitHubClient(process.env.CHIPIN_ADMISSION_TOKEN),
    config, expectedRevision: process.env.CHIPIN_EXPECTED_ADMISSION_REVISION,
    selectedOwner: process.env.CHIPIN_SELECTED_OWNER,
  };
  const client = new GitHubClient(process.env.GITHUB_TOKEN);
  const optIn = readInProgressOptIn(process.env, config);
  // CHIPIN_TASK_IDENTITY is always the admitted identity in the action; only a requested (dispatch) identity
  // lets the Status writer accept a PR body without its own marker.
  const inProgress = optIn?.enabled
    ? { ...optIn, allowMissingMarker: Boolean(args.get("--task") || process.env.CHIPIN_REQUESTED_TASK_IDENTITY) }
    : optIn;
  const receipt = await reconcileDevelopmentLink(client, {
    repository,
    pullRequestNumber,
    explicitTaskIdentity,
    expectedHeadSha,
    admission,
    inProgress,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  // The native link above is done and read back in every case; only the Status move is reported here.
  reportInProgressOutcome(receipt);
}

// Opt-in (.github#218): CHIPIN_SET_IN_PROGRESS is the exact-match flag the action computes once in bash
// (`true` / `false`; `invalid` for any other input). Off for `false` or unset. A misconfigured opt-in (an
// invalid value, or `true` without a Project #5 write token) never blocks the link: the link runs, the Status
// move is skipped and reported as OPT_IN_MISCONFIGURED, an error (exit 1) after the link.
export function readInProgressOptIn(env, config, makeClient = (token) => new GitHubClient(token)) {
  const flag = env.CHIPIN_SET_IN_PROGRESS ?? "";
  if (flag === "" || flag === "false") return null;
  if (flag !== "true") return { misconfigured: `set-in-progress must be exactly true or false (got ${JSON.stringify(flag)}); Project Status left unchanged.` };
  if (!env.CHIPIN_PROJECT_STATUS_TOKEN) {
    return { misconfigured: "set-in-progress is true but project-status-token is empty; Project Status left unchanged." };
  }
  return { enabled: true, client: makeClient(env.CHIPIN_PROJECT_STATUS_TOKEN), config };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`DEVELOPMENT LINK BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
