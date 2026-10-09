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
  repository = REPOSITORY,
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
            nameWithOwner: repository,
            pullRequest: exists ? {
              id: ids.get(number),
              number,
              body: sequencedBodies[readCount]
                ?? bodies[number]
                ?? `Task identity: ${repository}#${issueNumber}`,
              repository: { nameWithOwner: repository },
            } : null,
          },
        };
      }

      if (query.includes("query DevelopmentLinkTarget")) {
        const number = variables.pullRequestNumber;
        const referenceNodes = [...links].map((linkedNumber) => ({
          id: ids.get(linkedNumber) ?? `PR_${linkedNumber}`,
          number: linkedNumber,
          url: `https://github.com/${repository}/pull/${linkedNumber}`,
          repository: { nameWithOwner: repository },
        }));
        return {
          repository: {
            nameWithOwner: repository,
            taskIssue: issueUnreadable ? null : {
              id: `ISSUE_${variables.issueNumber}`,
              number: variables.issueNumber,
              url: `https://github.com/${repository}/issues/${variables.issueNumber}`,
              repository: { nameWithOwner: repository },
              closedByPullRequestsReferences: relationshipUnreadable ? null : {
                totalCount: referenceNodes.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: referenceNodes,
              },
            },
            implementationPr: ids.has(number) && !pullRequestUnreadable ? {
              id: ids.get(number),
              number,
              url: `https://github.com/${repository}/pull/${number}`,
              body: stateBodies[number] ?? bodies[number] ?? `Task identity: ${repository}#${issueNumber}`,
              repository: { nameWithOwner: repository },
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
              url: `https://github.com/${repository}/issues/${issueNumber}`,
              repository: { nameWithOwner: repository },
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
    }), /STALE|INTAKE_COMPLETE|admission receipt|Admission identity\/revision mismatch/);
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

test('head/body drift during live Issue re-read blocks Development mutation', async () => {
  for (const changed of ['head', 'body', 'state']) {
    const client = admittedClient();
    const originalRead = client.request;
    let reads = 0;
    client.request = async (...args) => {
      const pr = await originalRead(...args);
      if (++reads === 2) {
        if (changed === 'head') pr.head.sha = 'b'.repeat(40);
        if (changed === 'body') pr.body += '\\nChanged after admission';
        if (changed === 'state') pr.state = 'closed';
      }
      return pr;
    };
    await assert.rejects(() => reconcileDevelopmentLink(client, {
      repository: REPOSITORY, pullRequestNumber: 10,
      expectedHeadSha: ADMITTED_SHA,
      admission: allowedAdmission(async () => acceptedRead()),
    }), /STALE: PR head, state, branch or body changed during live Issue admission/);
    assert.equal(mutationCalls(client).length, 0);
    assert.equal(reads, 2);
  }
});

const KB_REPOSITORY = 'ChipIn-one/chipin-knowledge-base';
function kbAdmittedClient(body) {
  const client = makeClient({ repository: KB_REPOSITORY, bodies: { 10: body } });
  client.request = async () => ({
    number: 10, state: 'open', body,
    head: { sha: ADMITTED_SHA, repo: { full_name: KB_REPOSITORY } },
    base: { ref: 'master', repo: { full_name: KB_REPOSITORY } },
  });
  return client;
}

test('KB native link accepts exactly the owner that passed canonical admission', async () => {
  const client = kbAdmittedClient('Task identity: ' + KB_REPOSITORY + '#7\nTask owner: @syllik');
  const outcome = await reconcileDevelopmentLink(client, {
    repository: KB_REPOSITORY, pullRequestNumber: 10, expectedHeadSha: ADMITTED_SHA,
    admission: {
      ...allowedAdmission(async ({ selectedOwner }) => {
        assert.equal(selectedOwner, 'syllik');
        return { ...acceptedRead(), receipt: { ...acceptedRead().receipt, issue: KB_REPOSITORY + '#7' } };
      }),
    },
  });
  assert.equal(outcome.result, 'linked');
  assert.equal(mutationCalls(client).length, 1);
});

test('KB owner edit, removal and duplicate marker block before native link mutation', async () => {
  const bodies = [
    'Task identity: ' + KB_REPOSITORY + '#7\nTask owner: @another-owner',
    'Task identity: ' + KB_REPOSITORY + '#7',
    'Task identity: ' + KB_REPOSITORY + '#7\nTask owner: @syllik\nTask owner: @another-owner',
  ];
  for (const body of bodies) {
    const client = kbAdmittedClient(body);
    let admissionReads = 0;
    await assert.rejects(() => reconcileDevelopmentLink(client, {
      repository: KB_REPOSITORY, pullRequestNumber: 10, expectedHeadSha: ADMITTED_SHA,
      admission: {
        ...allowedAdmission(async () => {
          admissionReads++;
          return { ...acceptedRead(), receipt: { ...acceptedRead().receipt, issue: KB_REPOSITORY + '#7' } };
        }),
      },
    }), /STALE: KB PR Task owner|STALE: KB PR requires one explicit Task owner/);
    assert.equal(admissionReads, 0);
    assert.equal(mutationCalls(client).length, 0);
  }
});

test('expired admission after slow final PR REST read blocks both linked and unlinked paths', async () => {
  const originalNow = Date.now;
  const checkedAt = originalNow();
  try {
    for (const alreadyLinked of [false, true]) {
      Date.now = () => checkedAt;
      const client = admittedClient({ linkedPullRequests: alreadyLinked ? [10] : [] });
      const baseRequest = client.request;
      let requestCount = 0;
      client.request = async (...args) => {
        const response = await baseRequest(...args);
        requestCount += 1;
        if (requestCount === 2) Date.now = () => checkedAt + 121_000;
        return response;
      };
      let admissionReads = 0;
      await assert.rejects(() => reconcileDevelopmentLink(client, {
        repository: REPOSITORY,
        pullRequestNumber: 10,
        expectedHeadSha: ADMITTED_SHA,
        admission: allowedAdmission(async () => {
          admissionReads += 1;
          const result = acceptedRead();
          result.receipt.checkedAt = new Date(checkedAt).toISOString();
          return result;
        }),
      }), /STALE admission receipt/);
      assert.equal(admissionReads, 1, 'live admission succeeded before the final slow PR read');
      assert.equal(requestCount, 2);
      assert.equal(mutationCalls(client).length, 0);
    }
  } finally {
    Date.now = originalNow;
  }
});
