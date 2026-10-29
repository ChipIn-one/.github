import assert from "node:assert/strict";
import test from "node:test";

import {
  InProgressBlocked,
  inProgressOutcomeSeverity,
  parseTaskIdentity,
  readInProgressOptIn,
  readTaskIdentityMarker,
  reconcileDevelopmentLink,
  setInProgressAfterLink,
} from "./development-link.mjs";
import { integrationBranch } from "./registry.mjs";

const REPOSITORY = "ChipIn-one/chipin-frontend";
// the PR base the Development link accepts is the registry integration branch (master since .github#216)
const INTEGRATION = integrationBranch(REPOSITORY);

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
    base: { ref: INTEGRATION, repo: { full_name: REPOSITORY } },
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
      repository: "ChipIn-one/chipin-notifications",
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
    base: { ref: INTEGRATION, repo: { full_name: REPOSITORY } },
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

test('frontend on canonical master (.github#216): a PR into dev or main never gets a Development link', async () => {
  // In production PR admission rejects such a PR first (Unsupported PR branch transition, issue-admission-pr tests).
  // This is the link module's own defence in depth: even with an admission stub that accepts, its pre-mutation
  // re-read requires base = the registry integration branch (master) and blocks with its generic STALE error.
  assert.equal(INTEGRATION, 'master');
  for (const base of ['dev', 'main']) {
    const client = admittedClient();
    const read = client.request;
    client.request = async (...args) => ({ ...(await read(...args)), base: { ref: base, repo: { full_name: REPOSITORY } } });
    await assert.rejects(() => reconcileDevelopmentLink(client, {
      repository: REPOSITORY, pullRequestNumber: 10, expectedHeadSha: ADMITTED_SHA,
      admission: allowedAdmission(async () => acceptedRead()),
    }), /STALE: PR head SHA\/state\/branch changed/, base + ': base is not the registry integration branch');
    assert.equal(mutationCalls(client).length, 0, base);
  }
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

// ---- In Progress writer (.github#218) ----

const PROJECT_CONFIG = {
  organization: "ChipIn-one",
  project: { number: 5, statusField: "Status", statusValues: ["Backlog", "Todo", "In Progress", "Awaiting release", "Done"] },
};

function statusProject(status, { items = null } = {}) {
  return {
    id: "PROJECT",
    fields: [{
      id: "STATUS_FIELD", name: "Status", isIssueField: false,
      options: PROJECT_CONFIG.project.statusValues.map((name) => ({ id: "OPT_" + name, name })),
    }],
    items: items ?? [{ id: "ITEM_7", repository: REPOSITORY, number: 7, status }],
  };
}

function statusClient({
  status = "Backlog",
  liveStatus = undefined,
  readBack = "In Progress",
  prUser = "syllik",
  prState = "open",
  issueState = "open",
  lateIssueState = undefined,
  headRepo = REPOSITORY,
  mutationError = null,
  draft = false,
  prStateAfterWrite = "open",
} = {}) {
  const calls = [];
  let statusReads = 0;
  let issueReads = 0;
  let written = false;
  let current = liveStatus === undefined ? status : liveStatus;
  return {
    calls,
    async request(path) {
      calls.push({ path });
      if (path === `/repos/${REPOSITORY}/pulls/10`) {
        return { number: 10, state: written ? prStateAfterWrite : prState, draft, user: { login: prUser }, head: { repo: { full_name: headRepo } }, base: { repo: { full_name: REPOSITORY } } };
      }
      if (path === `/repos/${REPOSITORY}/issues/7`) {
        issueReads += 1;
        const state = issueReads > 1 && lateIssueState !== undefined ? lateIssueState : issueState;
        return { number: 7, state };
      }
      throw new Error("Unexpected REST path " + path);
    },
    async graphql(query, variables) {
      calls.push({ query, variables });
      if (query.includes("query DevelopmentLinkProjectItemStatus")) {
        statusReads += 1;
        return { node: { __typename: "ProjectV2Item", id: variables.itemId, fieldValueByName: current === null ? null : { name: current } } };
      }
      if (query.includes("mutation SetDevelopmentLinkInProgress")) {
        if (mutationError) throw new Error(mutationError);
        written = true;
        current = readBack;
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
      }
      throw new Error("Unexpected GraphQL operation " + query);
    },
    get statusReads() { return statusReads; },
  };
}

function writeStatus(client, { status = "Backlog", project = null, issueSide = null, readProject = null } = {}) {
  return setInProgressAfterLink(client, {
    repository: REPOSITORY, issueNumber: 7, pullRequestNumber: 10, config: PROJECT_CONFIG,
    readProject: readProject ?? (async () => project ?? statusProject(status)),
    readIssueItems: async () => issueSide ?? [{ id: "ITEM_7", repository: REPOSITORY, number: 7, status }],
  });
}

const statusMutations = (client) => client.calls.filter(({ query }) => query?.includes("mutation SetDevelopmentLinkInProgress"));

for (const source of ["Backlog", "Todo"]) {
  test(`In Progress writer moves ${source} -> In Progress with stale re-read and read-back`, async () => {
    const client = statusClient({ status: source });
    const result = await writeStatus(client, { status: source });
    assert.equal(result.result, "updated");
    assert.equal(result.code, "in-progress-set");
    assert.equal(result.detail, `Project Status ${source} -> In Progress.`);
    const mutations = statusMutations(client);
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].variables, { projectId: "PROJECT", fieldId: "STATUS_FIELD", optionId: "OPT_In Progress", itemId: "ITEM_7" });
    assert.equal(client.statusReads, 2); // one re-read right before the write, one read-back after it
  });
}

for (const other of ["In Progress", "Awaiting release", "Done", null, "Someday"]) {
  test(`In Progress writer never touches Status ${other ?? "(empty)"}`, async () => {
    const client = statusClient({ status: other });
    const result = await writeStatus(client, { status: other });
    assert.equal(result.result, "unchanged");
    assert.equal(result.mutated, false);
    assert.equal(result.code, other === "In Progress" ? "in-progress-current" : "in-progress-skipped:" + (other ?? "none"));
    assert.equal(statusMutations(client).length, 0);
  });
}

test("In Progress writer is a no-op for closed Issues, Dependabot, closed, draft and cross-repository PRs", async () => {
  for (const [options, code] of [
    [{ issueState: "closed" }, "issue-not-open"],
    [{ prUser: "dependabot[bot]" }, "dependabot-pr"],
    [{ prState: "closed" }, "pr-not-open"],
    [{ headRepo: "someone/fork" }, "pr-not-same-repository"],
    [{ draft: true }, "pr-draft"],
  ]) {
    let projectReads = 0;
    const client = statusClient(options);
    const result = await writeStatus(client, { readProject: async () => { projectReads += 1; return statusProject("Backlog"); } });
    assert.equal(result.code, code);
    assert.equal(result.mutated, false);
    assert.equal(projectReads, 0, code + " must not read the Project");
    assert.equal(statusMutations(client).length, 0);
  }
});

test("Awaiting release race: the Status re-read returns Awaiting release, so nothing is written", async () => {
  const client = statusClient({ status: "Backlog", liveStatus: "Awaiting release" });
  const result = await writeStatus(client, { status: "Backlog" });
  assert.equal(result.code, "stale-snapshot");
  assert.equal(result.mutated, false);
  assert.equal(statusMutations(client).length, 0);
  assert.equal(inProgressOutcomeSeverity(result), "warning");
});

test("mutation boundary order: PR/Issue eligibility re-read, then Status re-read, then the write; field name is a variable", async () => {
  const client = statusClient({ status: "Todo" });
  await writeStatus(client, { status: "Todo" });
  const steps = client.calls.map((call) => call.path ?? (call.query.includes("mutation") ? "WRITE" : "STATUS"));
  const write = steps.indexOf("WRITE");
  assert.deepEqual(steps.slice(write - 3, write), [`/repos/${REPOSITORY}/pulls/10`, `/repos/${REPOSITORY}/issues/7`, "STATUS"]);
  const statusQueries = client.calls.filter(({ query }) => query?.includes("query DevelopmentLinkProjectItemStatus"));
  assert.match(statusQueries[0].query, /fieldValueByName\(name: \$statusField\)/);
  assert.ok(statusQueries.every(({ variables }) => variables.statusField === "Status"));
});

test("a PR closed right after the write is flagged in the receipt, never reverted", async () => {
  const client = statusClient({ status: "Backlog", prStateAfterWrite: "closed" });
  const result = await writeStatus(client, { status: "Backlog" });
  assert.equal(result.result, "updated");
  assert.equal(result.prStateAfterWrite, "closed");
  assert.match(result.detail, /PR is closed after the write/);
  assert.equal(statusMutations(client).length, 1);
  assert.equal(inProgressOutcomeSeverity(result), "warning");
});

test("only a broken Project write path is an error; transient failures and stale reads are warnings", () => {
  for (const code of ["PROJECT_STATUS_WRITE", "PROJECT_STATUS_READBACK", "PROJECT_STATUS_FIELD"]) {
    assert.equal(inProgressOutcomeSeverity({ result: "blocked", code }), "error", code);
  }
  for (const code of ["PROJECT_UNREADABLE", "PROJECT_ITEM_UNREADABLE", "ISSUE_OR_PR_UNREADABLE", "PROJECT_MEMBERSHIP", "NOT_AN_ISSUE", "PROJECT_STATUS_ERROR"]) {
    assert.equal(inProgressOutcomeSeverity({ result: "blocked", code }), "warning", code);
  }
  assert.equal(inProgressOutcomeSeverity({ result: "unchanged", code: "stale-snapshot" }), "warning");
  assert.equal(inProgressOutcomeSeverity({ result: "unchanged", code: "opt-in-misconfigured" }), "warning");
  assert.equal(inProgressOutcomeSeverity({ result: "unchanged", code: "in-progress-skipped:Done" }), "none");
  assert.equal(inProgressOutcomeSeverity({ result: "updated", code: "in-progress-set" }), "none");
  assert.equal(inProgressOutcomeSeverity(undefined), "none");
});

test("In Progress writer abandons the write when the Issue closed during the stale re-read", async () => {
  const client = statusClient({ status: "Todo", lateIssueState: "closed" });
  const result = await writeStatus(client, { status: "Todo" });
  assert.equal(result.code, "issue-not-open");
  assert.equal(statusMutations(client).length, 0);
});

test("In Progress writer reports a read-back mismatch as blocked", async () => {
  const client = statusClient({ status: "Backlog", readBack: "Backlog" });
  await assert.rejects(writeStatus(client, { status: "Backlog" }), (error) => {
    assert.equal(error.code, "PROJECT_STATUS_READBACK");
    assert.match(error.message, /did not read back as In Progress \(read Backlog\)/);
    return true;
  });
});

test("In Progress writer fails closed on unreadable, missing, duplicate or divergent Project data", async () => {
  const cases = [
    [{ readProject: async () => { const e = new Error("Project items first page stayed empty"); e.code = "PROJECT_ITEMS_PHANTOM"; throw e; } }, "PROJECT_UNREADABLE"],
    [{ project: statusProject("Backlog", { items: [] }), issueSide: [] }, "PROJECT_MEMBERSHIP"],
    [{ project: statusProject("Backlog", { items: [
      { id: "ITEM_7", repository: REPOSITORY, number: 7, status: "Backlog" },
      { id: "ITEM_8", repository: REPOSITORY, number: 7, status: "Backlog" },
    ] }) }, "PROJECT_MEMBERSHIP"],
    [{ issueSide: [{ id: "OTHER", repository: REPOSITORY, number: 7, status: "Backlog" }] }, "PROJECT_MEMBERSHIP"],
    [{ project: { ...statusProject("Backlog"), fields: [] } }, "PROJECT_STATUS_FIELD"],
  ];
  for (const [options, code] of cases) {
    const client = statusClient();
    await assert.rejects(writeStatus(client, options), (error) => error.code === code);
    assert.equal(statusMutations(client).length, 0, code);
  }
});

test("In Progress writer is off by default: the link flow makes no Project read or write", async () => {
  const client = makeClient();
  const receipt = await reconcileDevelopmentLink(client, { repository: REPOSITORY, pullRequestNumber: 10 });
  assert.equal(receipt.result, "linked");
  assert.equal("projectStatus" in receipt, false);
  assert.equal(client.calls.some(({ query }) => /ProjectV2|projectV2|Status/.test(query)), false);
  assert.equal(readInProgressOptIn({}, PROJECT_CONFIG), null);
  assert.equal(readInProgressOptIn({ CHIPIN_SET_IN_PROGRESS: "0", CHIPIN_PROJECT_STATUS_TOKEN: "t" }, PROJECT_CONFIG), null);
});

test("a misconfigured opt-in never blocks the link: Status is skipped with a warning", async () => {
  assert.match(readInProgressOptIn({ CHIPIN_SET_IN_PROGRESS: "1" }, PROJECT_CONFIG).misconfigured, /project-status-token is empty/);
  assert.match(readInProgressOptIn({ CHIPIN_SET_IN_PROGRESS: "yes", CHIPIN_PROJECT_STATUS_TOKEN: "t" }, PROJECT_CONFIG).misconfigured, /must be 0 or 1/);
  const client = makeClient();
  const receipt = await reconcileDevelopmentLink(client, {
    repository: REPOSITORY, pullRequestNumber: 10, inProgress: readInProgressOptIn({ CHIPIN_SET_IN_PROGRESS: "1" }, PROJECT_CONFIG),
  });
  assert.equal(receipt.result, "linked");
  assert.equal(receipt.readBackConfirmed, true);
  assert.equal(receipt.projectStatus.code, "opt-in-misconfigured");
  assert.equal(inProgressOutcomeSeverity(receipt.projectStatus), "warning");
});

test("In Progress opt-in with a token and the exact flag enables the writer", () => {
  const enabled = readInProgressOptIn({ CHIPIN_SET_IN_PROGRESS: "1", CHIPIN_PROJECT_STATUS_TOKEN: "t" }, PROJECT_CONFIG, (token) => ({ token }));
  assert.deepEqual(enabled, { enabled: true, client: { token: "t" }, config: PROJECT_CONFIG });
});

test("In Progress runs after a confirmed link (new and already-linked) and only then", async () => {
  for (const linkedPullRequests of [[], [10]]) {
    const writes = [];
    const client = makeClient({ linkedPullRequests });
    const receipt = await reconcileDevelopmentLink(client, {
      repository: REPOSITORY, pullRequestNumber: 10,
      inProgress: { enabled: true, client: "PROJECT_CLIENT", config: PROJECT_CONFIG, write: async (projectClient, input) => {
        writes.push({ projectClient, input, linkedAtWrite: client.links.has(10) });
        return { result: "updated", mutated: true, code: "in-progress-set" };
      } },
    });
    assert.equal(receipt.result, linkedPullRequests.length ? "already-linked" : "linked");
    assert.equal(receipt.projectStatus.code, "in-progress-set");
    assert.deepEqual(writes, [{ projectClient: "PROJECT_CLIENT", input: { repository: REPOSITORY, issueNumber: 7, pullRequestNumber: 10, config: PROJECT_CONFIG }, linkedAtWrite: true }]);
  }
  let called = false;
  await assert.rejects(reconcileDevelopmentLink(makeClient({ readBackFailure: true }), {
    repository: REPOSITORY, pullRequestNumber: 10,
    inProgress: { enabled: true, config: PROJECT_CONFIG, write: async () => { called = true; } },
  }));
  assert.equal(called, false, "no Status write without a read-back link");
});

test("a blocked Status write keeps the confirmed link result in the receipt", async () => {
  const client = makeClient();
  const receipt = await reconcileDevelopmentLink(client, {
    repository: REPOSITORY, pullRequestNumber: 10,
    inProgress: { enabled: true, config: PROJECT_CONFIG, write: async () => { throw new InProgressBlocked("PROJECT_UNREADABLE", "Project #5 is unreadable"); } },
  });
  assert.equal(receipt.result, "linked");
  assert.equal(receipt.readBackConfirmed, true);
  assert.deepEqual(receipt.projectStatus, { result: "blocked", mutated: false, code: "PROJECT_UNREADABLE", detail: "Project #5 is unreadable" });
});

test("action keeps the In Progress writer opt-in; no caller enables it while pinned to a tag without it", async () => {
  const { readFile } = await import("node:fs/promises");
  const action = await readFile(new URL("./development-link-action/action.yml", import.meta.url), "utf8");
  assert.match(action, /set-in-progress:\n(?:.*\n)*?    default: 'false'/);
  assert.match(action, /project-status-token:\n(?:.*\n)*?    default: ''/);
  assert.match(action, /CHIPIN_SET_IN_PROGRESS: \$\{\{ inputs\.set-in-progress == 'true' && '1' \|\| '0' \}\}/);
  // the admission step sees only whether a token exists, never the token itself
  const admissionStep = action.slice(action.indexOf("Require canonical Issue admission"), action.indexOf("Reconcile native Development relationship"));
  assert.match(admissionStep, /HAS_PROJECT_STATUS_TOKEN: \$\{\{ inputs\.project-status-token != '' \}\}/);
  assert.doesNotMatch(admissionStep, /: \$\{\{ inputs\.project-status-token \}\}/);
  assert.doesNotMatch(admissionStep, /exit 2 ;;/);
  const caller = await readFile(new URL("../.github/workflows/native-development-link.yml", import.meta.url), "utf8");
  assert.doesNotMatch(caller, /set-in-progress|project-status-token/);
});
