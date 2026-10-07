import process from "node:process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { GitHubClient } from "./github-metadata.mjs";

export const SUPPORTED_REPOSITORIES = new Set([
  "ChipIn-one/chipin-frontend",
  "ChipIn-one/chipin-backend",
  "ChipIn-one/chipin-knowledge-base",
]);

const TASK_IDENTITY_PATTERN = /^ChipIn-one\/(chipin-frontend|chipin-backend|chipin-knowledge-base)#([1-9]\d*)$/u;
const TASK_IDENTITY_MARKER = "Task identity:";

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

export async function reconcileDevelopmentLink(client, {
  repository,
  pullRequestNumber,
  explicitTaskIdentity = null,
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

  if (before.linked) {
    return {
      result: "already-linked",
      taskIdentity: task.canonical,
      repository,
      issueNumber: task.issueNumber,
      pullRequestNumber: prNumber,
      readBackConfirmed: true,
    };
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

  return {
    result: "linked",
    taskIdentity: task.canonical,
    repository,
    issueNumber: task.issueNumber,
    pullRequestNumber: prNumber,
    readBackConfirmed: true,
  };
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
  if (!repository) throw new Error("PR repository is required.");
  if (!pullRequestNumber) throw new Error("Pull request number is required.");

  const client = new GitHubClient(process.env.GITHUB_TOKEN);
  const receipt = await reconcileDevelopmentLink(client, {
    repository,
    pullRequestNumber,
    explicitTaskIdentity,
  });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`DEVELOPMENT LINK BLOCKED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
