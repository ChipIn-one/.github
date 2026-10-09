import assert from "node:assert/strict";
import test from "node:test";

import {
  parseTaskIdentity,
  readTaskIdentityMarker,
  reconcileDevelopmentLink,
} from "./development-link.mjs";

const REPOSITORY = "ChipIn-one/chipin-frontend";

function makeClient({
  issueNumber = 7,
  pullRequests = [10],
  bodies = {},
  pullRequestBodySequence = {},
  stateBodies = {},
  linkedPullRequests = [],
  mutationFailure = null,
  readBackFailure = false,
  relationshipUnreadable = false,
  issueUnreadable = false,
  pullRequestUnreadable = false,
} = {}) {
  const links = new Set(linkedPullRequests);
  const calls = [];
  const ids = new Map(pullRequests.map((number) => [number, `PR_${number}`]));
  const pullRequestReadCounts = new Map();

  return {
    calls,
    links,
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (query.includes("query DevelopmentLinkPullRequest")) {
        const number = variables.pullRequestNumber;
        const exists = ids.has(number) && !pullRequestUnreadable;
        const readCount = pullRequestReadCounts.get(number) ?? 0;
        pullRequestReadCounts.set(number, readCount + 1);
        const sequencedBodies = pullRequestBodySequence[number] ?? [];
        return {
          repository: {
            nameWithOwner: REPOSITORY,
            pullRequest: exists ? {
              id: ids.get(number),
              number,
              body: sequencedBodies[readCount]
                ?? bodies[number]
                ?? `Task identity: ${REPOSITORY}#${issueNumber}`,
              repository: { nameWithOwner: REPOSITORY },
            } : null,
          },
        };
      }

      if (query.includes("query DevelopmentLinkTarget")) {
        const number = variables.pullRequestNumber;
        const referenceNodes = [...links].map((linkedNumber) => ({
          id: ids.get(linkedNumber) ?? `PR_${linkedNumber}`,
          number: linkedNumber,
          url: `https://github.com/${REPOSITORY}/pull/${linkedNumber}`,
          repository: { nameWithOwner: REPOSITORY },
        }));
        return {
          repository: {
            nameWithOwner: REPOSITORY,
            taskIssue: issueUnreadable ? null : {
              id: `ISSUE_${variables.issueNumber}`,
              number: variables.issueNumber,
              url: `https://github.com/${REPOSITORY}/issues/${variables.issueNumber}`,
              repository: { nameWithOwner: REPOSITORY },
              closedByPullRequestsReferences: relationshipUnreadable ? null : {
                totalCount: referenceNodes.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: referenceNodes,
              },
            },
            implementationPr: ids.has(number) && !pullRequestUnreadable ? {
              id: ids.get(number),
              number,
              url: `https://github.com/${REPOSITORY}/pull/${number}`,
              body: stateBodies[number] ?? bodies[number] ?? `Task identity: ${REPOSITORY}#${issueNumber}`,
              repository: { nameWithOwner: REPOSITORY },
            } : null,
          },
        };
      }

      if (query.includes("mutation AddNativeDevelopmentLink")) {
        if (mutationFailure) throw new Error(mutationFailure);
        const number = [...ids.entries()].find(([, id]) => id === variables.pullRequestIds[0])?.[0];
        if (!readBackFailure && number) links.add(number);
        return {
          addCloseIssueReferences: {
            issue: {
              id: `ISSUE_${issueNumber}`,
              number: issueNumber,
              url: `https://github.com/${REPOSITORY}/issues/${issueNumber}`,
              repository: { nameWithOwner: REPOSITORY },
            },
          },
        };
      }

      throw new Error(`Unexpected GraphQL operation: ${query}`);
    },
  };
}

function mutationCalls(client) {
  return client.calls.filter(({ query }) => query.includes("mutation AddNativeDevelopmentLink"));
}

test("parses only the canonical task identity form", () => {
  assert.deepEqual(parseTaskIdentity("ChipIn-one/chipin-frontend#42"), {
    canonical: "ChipIn-one/chipin-frontend#42",
    repository: "ChipIn-one/chipin-frontend",
    issueNumber: 42,
  });
  assert.throws(() => parseTaskIdentity("#42"), /must be exactly/u);
  assert.throws(() => parseTaskIdentity("https:\/\/github.com\/ChipIn-one\/chipin-frontend\/issues\/42"), /must be exactly/u);
});

test("requires exactly one explicit PR body task marker", () => {
  assert.equal(readTaskIdentityMarker("Summary only"), null);
  assert.throws(
    () => readTaskIdentityMarker(`Task identity: ${REPOSITORY}#7\nTask identity: ${REPOSITORY}#8`),
    /ambiguous/u,
  );
});

test("exact Issue + PR creates a native link and confirms read-back", async () => {
  const client = makeClient();
  const receipt = await reconcileDevelopmentLink(client, {
    repository: REPOSITORY,
    pullRequestNumber: 10,
  });
  assert.equal(receipt.result, "linked");
  assert.equal(receipt.readBackConfirmed, true);
  assert.equal(mutationCalls(client).length, 1);
  assert.equal(client.links.has(10), true);
});

test("task identity drift on the final PR reread fails closed", async () => {
  const client = makeClient({
    bodies: { 10: `Task identity: ${REPOSITORY}#7` },
    stateBodies: { 10: `Task identity: ${REPOSITORY}#7` },
    pullRequestBodySequence: {
      10: [
        `Task identity: ${REPOSITORY}#7`,
        `Task identity: ${REPOSITORY}#8`,
      ],
    },
  });
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /Task identity changed while reconciling/u,
  );
  assert.equal(mutationCalls(client).length, 0);
  assert.equal(
    client.calls.filter(({ query }) => query.includes("query DevelopmentLinkPullRequest")).length,
    2,
  );
});

test('link mutation blocks stale PR head after a positive preflight', async () => {
  const client = makeClient();
  client.request = async () => ({
    number: 10, state: 'open', body: `Task identity: ${REPOSITORY}#7`,
    head: { sha: 'b'.repeat(40), repo: { full_name: REPOSITORY } },
    base: { ref: 'dev', repo: { full_name: REPOSITORY } },
  });
  await assert.rejects(() => reconcileDevelopmentLink(client, {
    repository: REPOSITORY, pullRequestNumber: 10,
    expectedHeadSha: 'a'.repeat(40),
  }), /STALE: PR head SHA/);
  assert.equal(mutationCalls(client).length, 0);
});

test("already linked is an idempotent noop success", async () => {
  const client = makeClient({ linkedPullRequests: [10] });
  const receipt = await reconcileDevelopmentLink(client, {
    repository: REPOSITORY,
    pullRequestNumber: 10,
  });
  assert.equal(receipt.result, "already-linked");
  assert.equal(receipt.readBackConfirmed, true);
  assert.equal(mutationCalls(client).length, 0);
});

test("rerun after successful linking does not create a duplicate", async () => {
  const client = makeClient();
  const first = await reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 });
  const second = await reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 });
  assert.equal(first.result, "linked");
  assert.equal(second.result, "already-linked");
  assert.equal(mutationCalls(client).length, 1);
});

test("missing task identity fails closed", async () => {
  const client = makeClient({ bodies: { 10: "No task metadata" } });
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /Task identity is missing/u,
  );
  assert.equal(mutationCalls(client).length, 0);
});

test("ambiguous task identity fails closed", async () => {
  const client = makeClient({
    bodies: { 10: `Task identity: ${REPOSITORY}#7\nTask identity: ${REPOSITORY}#8` },
  });
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /ambiguous/u,
  );
  assert.equal(mutationCalls(client).length, 0);
});

test("conflicting explicit and PR body identities fail closed", async () => {
  const client = makeClient({ bodies: { 10: `Task identity: ${REPOSITORY}#7` } });
  await assert.rejects(
    reconcileDevelopmentLink(client, {
      repository: REPOSITORY,
      pullRequestNumber: 10,
      explicitTaskIdentity: `${REPOSITORY}#8`,
    }),
    /conflicts/u,
  );
  assert.equal(mutationCalls(client).length, 0);
});

test("rejects non-integer PR numbers before any GitHub read", async () => {
  const client = makeClient();
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: "10.0" }),
    /positive integer/u,
  );
  assert.equal(client.calls.length, 0);
});

test("unsupported repository fails closed before GitHub reads", async () => {
  const client = makeClient();
  await assert.rejects(
    reconcileDevelopmentLink(client, {
      repository: "ChipIn-one/.github",
      pullRequestNumber: 10,
      explicitTaskIdentity: "ChipIn-one/chipin-frontend#7",
    }),
    /Unsupported repository/u,
  );
  assert.equal(client.calls.length, 0);
});

test("multiple PRs can link to one Issue without disturbing existing links", async () => {
  const client = makeClient({ pullRequests: [10, 11] });
  await reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 });
  await reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 11 });
  assert.deepEqual([...client.links].sort((a, b) => a - b), [10, 11]);
  assert.equal(mutationCalls(client).length, 2);
});

test("native mutation failure is actionable and fails closed", async () => {
  const client = makeClient({ mutationFailure: "FORBIDDEN" });
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /addCloseIssueReferences capability/u,
  );
  assert.equal(client.links.has(10), false);
});

test("read-back failure never reports success", async () => {
  const client = makeClient({ readBackFailure: true });
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /read-back failed/u,
  );
  assert.equal(mutationCalls(client).length, 1);
});

test("unrelated task repository is never linked", async () => {
  const client = makeClient({ bodies: { 10: "Task identity: ChipIn-one/chipin-backend#7" } });
  await assert.rejects(
    reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /does not belong to pull request repository/u,
  );
  assert.equal(mutationCalls(client).length, 0);
});

test("unreadable Issue, PR, or native relationship fails closed", async () => {
  const issueClient = makeClient({ issueUnreadable: true });
  await assert.rejects(
    reconcileDevelopmentLink(issueClient, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /Issue .* unreadable/u,
  );
  const prClient = makeClient({ pullRequestUnreadable: true });
  await assert.rejects(
    reconcileDevelopmentLink(prClient, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /Pull request .* unreadable/u,
  );
  const relationClient = makeClient({ relationshipUnreadable: true });
  await assert.rejects(
    reconcileDevelopmentLink(relationClient, { repository: REPOSITORY, pullRequestNumber: 10 }),
    /relationship state .* unreadable/u,
  );
});


const ADMITTED_SHA = 'a'.repeat(40);
const REVISION = 'f'.repeat(64);
const acceptedRead = () => ({
  blockers: [],
  receipt: {
    contractVersion: 'chipin-issue-admission/v1',
    status: 'INTAKE_COMPLETE',
    issue: REPOSITORY + '#7',
    revision: REVISION,
    checkedAt: new Date().toISOString(),
    blockers: [],
  },
});
function admittedClient(options = {}) {
  const client = makeClient(options);
  client.request = async () => ({
    number: 10, state: 'open', body: 'Task identity: ' + REPOSITORY + '#7',
    head: { sha: ADMITTED_SHA, repo: { full_name: REPOSITORY } },
    base: { ref: 'dev', repo: { full_name: REPOSITORY } },
  });
  return client;
}
const allowedAdmission = read => ({
  client: {}, config: {}, selectedOwner: 'syllik',
  expectedRevision: REVISION, read,
});

test('revalidates current exact Issue revision immediately before native Development mutation', async () => {
  const client = admittedClient();
  let count = 0;
  const result = await reconcileDevelopmentLink(client, {
    repository: REPOSITORY, pullRequestNumber: 10, expectedHeadSha: ADMITTED_SHA,
    admission: allowedAdmission(async input => {
      count += 1;
      assert.equal(input.repository, REPOSITORY);
      assert.equal(input.number, 7);
      assert.equal(input.expectedRevision, REVISION);
      assert.equal(input.selectedOwner, 'syllik');
      return acceptedRead();
    }),
  });
  assert.equal(result.result, 'linked');
  assert.equal(count, 1);
  assert.equal(mutationCalls(client).length, 1);
});

test('stale, cancelled, closed and expired Issues block before native Development mutation', async () => {
  const bad = [
    { blockers: ['Native Issue must be open (closed/not_planned)'], receipt: acceptedRead().receipt },
    { blockers: ['STALE: native Issue revision changed'], receipt: acceptedRead().receipt },
    { blockers: [], receipt: { ...acceptedRead().receipt, revision: 'b'.repeat(64) } },
    { blockers: [], receipt: { ...acceptedRead().receipt, checkedAt: '2020-01-01T00:00:00Z' } },
    { blockers: [], receipt: { ...acceptedRead().receipt, status: 'TERMINAL_RECONCILED',
      contractVersion: 'chipin-terminal-reconciliation/v1' } },
  ];
  for (const output of bad) {
    const client = admittedClient();
    await assert.rejects(() => reconcileDevelopmentLink(client, {
      repository: REPOSITORY, pullRequestNumber: 10, expectedHeadSha: ADMITTED_SHA,
      admission: allowedAdmission(async () => output),
    }), /STALE|INTAKE_COMPLETE|admission receipt/);
    assert.equal(mutationCalls(client).length, 0);
  }
});

test('trusted SHA without live admission input never mutates Development relationship', async () => {
  const client = admittedClient();
  await assert.rejects(() => reconcileDevelopmentLink(client, {
    repository: REPOSITORY, pullRequestNumber: 10, expectedHeadSha: ADMITTED_SHA,
  }), /Live exact-Issue admission revision/);
  assert.equal(mutationCalls(client).length, 0);
});

test("the only write operation is addCloseIssueReferences", async () => {
  const client = makeClient();
  await reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 });
  const writes = client.calls.filter(({ query }) => /mutation\s/u.test(query));
  assert.equal(writes.length, 1);
  assert.match(writes[0].query, /addCloseIssueReferences/u);
  assert.doesNotMatch(writes[0].query, /closeIssue|reopen|updateIssue|updateProject|ProjectV2/u);
});
