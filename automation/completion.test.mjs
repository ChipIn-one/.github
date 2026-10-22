import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AWAITING_RELEASE_STATUS,
  CompletionBlocked,
  evaluateAwaitingReleaseCandidate,
  evaluateIssueForIntegrationCompletion,
  formatCompletionSummary,
  projectStatusCoordinates,
  readBranchHead,
  reconcileAwaitingRelease,
  runCompletion,
  runIntegrationCompletionSweep,
  setAwaitingReleaseStatus,
} from "./completion.mjs";
import { AUTOMATIC_COMPLETION_STRATEGIES, loadRegistry, validateRegistry } from "./registry.mjs";

const ORG = "ChipIn-one/.github";
const KB = "ChipIn-one/chipin-knowledge-base";
const FE = "ChipIn-one/chipin-frontend";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE = "1111111111111111111111111111111111111111";

function linkedPr({
  number = 10,
  mergedAt = "2026-10-01T10:00:00Z",
  mergeCommitSha = MERGE,
  baseRefName = "master",
  headRefName = "feat/issue-1-work",
  repository = ORG,
  headRepository = ORG,
} = {}) {
  return { number, state: "MERGED", mergedAt, mergeCommitSha, baseRefName, headRefName, repository, headRepository };
}

function issue({
  number = 1,
  state = "OPEN",
  updatedAt = "2026-10-07T10:00:00Z",
  createdAt = "2026-09-01T10:00:00Z",
  lastEditedAt = null,
  linkedBranchCount = 0,
  linkedPullRequests = [linkedPr()],
  linkedPullRequestTotalCount = linkedPullRequests.length,
  requiredRelationshipsReadable = true,
  blockedBy = [],
  subIssues = [],
  scopeHistory,
} = {}) {
  const value = {
    number, state, updatedAt, createdAt, lastEditedAt, reopenedAt: null,
    timeline: { readable: true, closedAt: [], reopenedAt: [], renamedAt: [] },
    linkedBranchCount, linkedPullRequests, linkedPullRequestTotalCount,
    requiredRelationshipsReadable, blockedBy, subIssues,
  };
  if (scopeHistory !== undefined) value.scopeHistory = scopeHistory;
  return value;
}

const contains = (expected = true) => async () => expected;
const context = (overrides = {}) => ({
  repository: ORG,
  integrationBranch: "master",
  integrationHeadSha: HEAD,
  containsCommit: contains(),
  readScopeHistory: async () => ({ readable: true, closedAt: [], reopenedAt: [], renamedAt: [], bodyRevisions: [] }),
  ...overrides,
});

test("integration-merge: a same-repository PR merged into the integration branch and still on its head closes the Issue", async () => {
  const decision = await evaluateIssueForIntegrationCompletion(issue(), context());
  assert.equal(decision.action, "close-completed");
  assert.equal(decision.code, "integration-complete");
  assert.match(decision.detail, /PR #10 merged into master \(1111111\)/u);
});

test("integration-merge: the fail-closed gates leave the Issue open", async () => {
  const cases = [
    [issue({ state: "CLOSED" }), "already-closed"],
    [issue({ blockedBy: [{ repository: ORG, number: 9, state: "open" }] }), "blocked-by-open-issue"],
    [issue({ subIssues: [{ repository: ORG, number: 9, state: "open", stateReason: null }] }), "required-sub-issue-incomplete"],
    [issue({ requiredRelationshipsReadable: false }), "required-relationships-unreadable"],
    [issue({ linkedBranchCount: 1 }), "development-branch-pending"],
    [issue({ linkedPullRequests: [], linkedPullRequestTotalCount: 0 }), "missing-development"],
    [issue({ linkedPullRequests: [linkedPr()], linkedPullRequestTotalCount: 2 }), "ambiguous-development"],
    [issue({ linkedPullRequests: [linkedPr(), linkedPr()] }), "ambiguous-development"],
    [issue({ linkedPullRequests: [linkedPr({ repository: FE, headRepository: FE })] }), "ambiguous-development"],
    [issue({ linkedPullRequests: [linkedPr({ headRepository: "evil/fork" })] }), "ambiguous-development"],
    [issue({ linkedPullRequests: [linkedPr({ mergedAt: null, mergeCommitSha: null })] }), "implementation-not-merged"],
    [issue({ linkedPullRequests: [linkedPr({ mergeCommitSha: "abc" })] }), "implementation-not-merged"],
    [issue({ linkedPullRequests: [linkedPr({ baseRefName: "feature/other" })] }), "ambiguous-development"],
  ];
  for (const [candidate, code] of cases) {
    const decision = await evaluateIssueForIntegrationCompletion(candidate, context());
    assert.equal(decision.action, "leave-open", code);
    assert.equal(decision.code, code);
  }
});

test("integration-merge: a merge commit no longer reachable from the branch head fails closed", async () => {
  const decision = await evaluateIssueForIntegrationCompletion(issue(), context({ containsCommit: contains(false) }));
  assert.equal(decision.code, "integration-history-diverged");
  assert.match(decision.detail, /not contained in the current master head aaaaaaa/u);
});

test("integration-merge: a PR into the promotion branch of another layout is not accepted (only the integration branch counts)", async () => {
  const decision = await evaluateIssueForIntegrationCompletion(
    issue({ linkedPullRequests: [linkedPr({ baseRefName: "main", repository: KB, headRepository: KB })] }),
    context({ repository: KB, integrationBranch: "master" }),
  );
  assert.equal(decision.code, "ambiguous-development");
  assert.match(decision.detail, /expected the integration branch master/u);
});

test("integration-merge: scope changes after the last merge block, the #178 refinements apply unchanged", async () => {
  // text edit after the merge -> scope changed
  const edited = issue({
    lastEditedAt: "2026-10-03T10:00:00Z",
    scopeHistory: {
      readable: true, closedAt: [], reopenedAt: [], renamedAt: [],
      bodyRevisions: [
        { editedAt: "2026-09-01T10:00:00Z", body: "## Problem\nold" },
        { editedAt: "2026-10-03T10:00:00Z", body: "## Problem\nnew scope" },
      ],
    },
  });
  const changed = await evaluateIssueForIntegrationCompletion(edited, context());
  assert.equal(changed.code, "scope-changed-after-implementation");
  assert.match(changed.detail, /text edited at 2026-10-03T10:00:00Z/u);

  // checkbox-only edit after the merge -> still complete
  const ticked = issue({
    lastEditedAt: "2026-10-03T10:00:00Z",
    scopeHistory: {
      readable: true, closedAt: [], reopenedAt: [], renamedAt: [],
      bodyRevisions: [
        { editedAt: "2026-09-01T10:00:00Z", body: "- [ ] done" },
        { editedAt: "2026-10-03T10:00:00Z", body: "- [x] done" },
      ],
    },
  });
  assert.equal((await evaluateIssueForIntegrationCompletion(ticked, context())).action, "close-completed");

  // close after the merge (GitHub's native auto-close or the engine), then a human reopen -> for
  // integration-merge every reopen after the last merge counts (the #178 exemption is frontend-only)
  const reopened = issue({
    scopeHistory: { readable: true, closedAt: ["2026-10-01T10:00:02Z"], reopenedAt: ["2026-10-04T10:00:00Z"], renamedAt: [], bodyRevisions: [] },
  });
  const reopenedDecision = await evaluateIssueForIntegrationCompletion(reopened, context());
  assert.equal(reopenedDecision.code, "scope-changed-after-implementation");
  assert.match(reopenedDecision.detail, /reopened at 2026-10-04T10:00:00Z/u);
  // a reopen before the last merge is refreshed by that merge
  const reopenedBefore = issue({
    scopeHistory: { readable: true, closedAt: ["2026-09-20T10:00:00Z"], reopenedAt: ["2026-09-25T10:00:00Z"], renamedAt: [], bodyRevisions: [] },
  });
  assert.equal((await evaluateIssueForIntegrationCompletion(reopenedBefore, context())).action, "close-completed");

  // title rename after the merge -> scope changed
  const renamed = issue({
    scopeHistory: { readable: true, closedAt: [], reopenedAt: [], renamedAt: ["2026-10-04T10:00:00Z"], bodyRevisions: [] },
  });
  assert.equal((await evaluateIssueForIntegrationCompletion(renamed, context())).code, "scope-changed-after-implementation");

  // unreadable history -> fail closed
  const unreadable = await evaluateIssueForIntegrationCompletion(issue(), context({
    readScopeHistory: async () => ({ readable: false, detail: "timeline truncated" }),
  }));
  assert.equal(unreadable.code, "scope-history-unreadable");
});

test("integration-merge: the evaluator refuses incomplete context instead of guessing", async () => {
  await assert.rejects(() => evaluateIssueForIntegrationCompletion(issue(), context({ integrationHeadSha: "abc" })), /40-character SHA/u);
  await assert.rejects(() => evaluateIssueForIntegrationCompletion(issue(), context({ containsCommit: null })), /containsCommit/u);
  await assert.rejects(() => evaluateIssueForIntegrationCompletion(issue(), context({ integrationBranch: "" })), /integrationBranch/u);
});

test("readBranchHead fails closed on an unreadable head", async () => {
  assert.equal(await readBranchHead({ request: async () => ({ sha: HEAD }) }, ORG, "master"), HEAD);
  await assert.rejects(() => readBranchHead({ request: async () => ({ sha: "nope" }) }, ORG, "master"),
    (error) => error instanceof CompletionBlocked && error.code === "UNREADABLE_BRANCH_HEAD");
  await assert.rejects(() => readBranchHead({ request: async () => ({}) }, "bad", "master"),
    (error) => error.code === "INVALID_REPOSITORY");
});

function candidateNode(overrides = {}) {
  return {
    number: 1,
    title: "Org task",
    url: "https://github.com/ChipIn-one/.github/issues/1",
    state: "OPEN",
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-10-07T10:00:00Z",
    lastEditedAt: null,
    linkedBranches: { totalCount: 0 },
    timelineItems: { totalCount: 0, nodes: [] },
    closedByPullRequestsReferences: {
      totalCount: 1,
      nodes: [{
        number: 10,
        url: "https://github.com/ChipIn-one/.github/pull/10",
        state: "MERGED",
        mergedAt: "2026-10-01T10:00:00Z",
        baseRefName: "master",
        headRefName: "feat/issue-1-work",
        headRefOid: "2222222222222222222222222222222222222222",
        repository: { nameWithOwner: ORG },
        headRepository: { nameWithOwner: ORG },
        mergeCommit: { oid: MERGE },
      }],
    },
    ...overrides,
  };
}

function fakeClient({
  nodes = [candidateNode()],
  compareStatus = "ahead",
  compareError = null,
  issueUpdatedAt = "2026-10-07T10:00:00Z",
  subIssueTotal = 0,
  log = [],
} = {}) {
  return {
    log,
    graphql: async (query) => {
      if (!query.includes("query FrontendCompletionCandidates")) {
        throw new Error("unexpected GraphQL in repository-local mode: " + query.split("\n")[0]);
      }
      return { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
    },
    listAll: async (path) => {
      if (path.endsWith("/dependencies/blocked_by") || path.endsWith("/sub_issues")) return [];
      throw new Error("unexpected list path: " + path);
    },
    request: async (path, options = {}) => {
      log.push((options.method ?? "GET") + " " + path);
      if (path.endsWith("/commits/master")) return { sha: HEAD };
      if (path.includes("/compare/")) {
        if (compareError) throw new Error(compareError);
        return { status: compareStatus, merge_base_commit: { sha: MERGE } };
      }
      if (/\/issues\/\d+$/u.test(path) && (options.method ?? "GET") === "GET") {
        const issue = { state: "open", updated_at: issueUpdatedAt };
        if (subIssueTotal !== null) issue.sub_issues_summary = { total: subIssueTotal, completed: 0, percent_completed: 0 };
        return issue;
      }
      if (/\/issues\/\d+$/u.test(path) && options.method === "PATCH") {
        assert.deepEqual(options.body, { state: "closed", state_reason: "completed" });
        return { state: "closed", state_reason: "completed" };
      }
      throw new Error("unexpected request: " + path);
    },
  };
}

const orgProfile = () => loadRegistry().repositories.find((profile) => profile.repository === ORG);

test("integration sweep closes a complete .github Issue through the shared stale-snapshot mutation", async () => {
  const client = fakeClient();
  const results = await runIntegrationCompletionSweep(client, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(results.length, 1);
  assert.equal(results[0].decision.action, "closed");
  assert.equal(results[0].decision.code, "closed-completed");
  assert.ok(client.log.some((entry) => entry.startsWith("PATCH ") && entry.endsWith("/issues/1")));
  // the integration head was read once, from the registry branch
  assert.equal(client.log.filter((entry) => entry === "GET /repos/ChipIn-one/.github/commits/master").length, 1);
});

test("integration sweep leaves the Issue open when it changed after evaluation (stale snapshot)", async () => {
  const client = fakeClient({ issueUpdatedAt: "2026-10-07T10:00:01Z" });
  const results = await runIntegrationCompletionSweep(client, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(results[0].decision.action, "leave-open");
  assert.equal(results[0].decision.code, "stale-snapshot");
  assert.ok(!client.log.some((entry) => entry.startsWith("PATCH ")));
});

test("integration sweep never writes for an Issue without Development evidence or with a diverged history", async () => {
  const missing = fakeClient({ nodes: [candidateNode({ closedByPullRequestsReferences: { totalCount: 0, nodes: [] } })] });
  const [none] = await runIntegrationCompletionSweep(missing, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(none.decision.code, "missing-development");
  assert.ok(!missing.log.some((entry) => entry.startsWith("PATCH ")));

  const diverged = fakeClient({ compareStatus: "diverged" });
  const [open] = await runIntegrationCompletionSweep(diverged, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(open.decision.code, "integration-history-diverged");
  assert.ok(!diverged.log.some((entry) => entry.startsWith("PATCH ")));
});

test("integration sweep fails closed when the token cannot see every sub-issue, and skips an Issue whose compare fails", async () => {
  const hidden = fakeClient({ subIssueTotal: 1 });
  const [hiddenResult] = await runIntegrationCompletionSweep(hidden, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(hiddenResult.decision.code, "required-relationships-unreadable");
  assert.match(hiddenResult.decision.detail, /only 0 of 1 sub-issue\(s\) are visible/u);
  assert.ok(!hidden.log.some((entry) => entry.startsWith("PATCH ")));

  const noSummary = fakeClient({ subIssueTotal: null });
  const [noSummaryResult] = await runIntegrationCompletionSweep(noSummary, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(noSummaryResult.decision.code, "required-relationships-unreadable");
  assert.match(noSummaryResult.decision.detail, /sub_issues_summary/u);

  const broken = fakeClient({
    nodes: [candidateNode(), candidateNode({ number: 2, url: "https://github.com/ChipIn-one/.github/issues/2" })],
    compareError: "HTTP 404 compare",
  });
  const results = await runIntegrationCompletionSweep(broken, orgProfile(), { reconcileProjectStatus: false });
  assert.equal(results.length, 2, "one failing compare does not abort the sweep");
  assert.deepEqual(results.map((result) => result.decision.code), ["integration-evidence-unreadable", "integration-evidence-unreadable"]);
  assert.ok(!broken.log.some((entry) => entry.startsWith("PATCH ")));
});

test("integration sweep requires the Project config when reconciliation is on and fails closed on an unreadable head", async () => {
  await assert.rejects(() => runIntegrationCompletionSweep(fakeClient(), orgProfile(), { reconcileProjectStatus: true }), /projectConfig/u);
  const client = fakeClient();
  client.request = async (path) => (path.endsWith("/commits/master") ? { sha: null } : { state: "open" });
  await assert.rejects(() => runIntegrationCompletionSweep(client, orgProfile(), { reconcileProjectStatus: false }),
    (error) => error.code === "UNREADABLE_BRANCH_HEAD");
});

test("runCompletion picks the strategy from the registry and refuses manual or unimplemented records", async () => {
  const receipt = await runCompletion(fakeClient(), { repository: ORG, reconcileProjectStatus: false });
  assert.equal(receipt.contract, "chipin-completion/v1");
  assert.equal(receipt.strategy, "integration-merge");
  assert.equal(receipt.branch, "master");
  assert.equal(receipt.projectNumber, 5);
  assert.equal(receipt.results[0].decision.code, "closed-completed");

  await assert.rejects(() => runCompletion(fakeClient(), { repository: "ChipIn-one/chipin-backend", reconcileProjectStatus: false }),
    (error) => error instanceof CompletionBlocked && error.code === "COMPLETION_NOT_AUTOMATIC");
  await assert.rejects(() => runCompletion(fakeClient(), { repository: "ChipIn-one/unknown", reconcileProjectStatus: false }),
    (error) => error.code === "UNKNOWN_REPOSITORY");
  await assert.rejects(() => runCompletion(fakeClient(), { repository: "ChipIn-one/chipin-notifications", reconcileProjectStatus: false }),
    (error) => error.code === "COMPLETION_NOT_AUTOMATIC");

  // the registry itself refuses `automatic` with a strategy the engine does not implement, so the engine's
  // own STRATEGY_NOT_IMPLEMENTED guard is reached only through a registry that bypassed validation
  const registry = loadRegistry();
  const forged = {
    ...registry,
    repositories: registry.repositories.map((profile) => (profile.repository === ORG
      ? { ...profile, completion: "deployment-receipt" }
      : profile)),
  };
  await assert.rejects(() => runCompletion(fakeClient(), { repository: ORG, registry: forged, reconcileProjectStatus: false }),
    (error) => error.code === "STRATEGY_NOT_IMPLEMENTED");
  assert.deepEqual([...AUTOMATIC_COMPLETION_STRATEGIES], ["production-merge", "integration-merge"]);
});

test("runCompletion: production-merge delegates to the frontend module and refuses another branch layout", async () => {
  // the frontend sweep reads releases from /pulls?...base=main; a client that answers it with no releases
  // yields `awaiting-production` for a dev-merged PR, which proves the delegation path without a fake release
  const feNode = candidateNode({
    url: "https://github.com/ChipIn-one/chipin-frontend/issues/1",
    closedByPullRequestsReferences: {
      totalCount: 1,
      nodes: [{
        number: 10, url: "https://github.com/ChipIn-one/chipin-frontend/pull/10", state: "MERGED",
        mergedAt: "2026-10-01T10:00:00Z", baseRefName: "dev", headRefName: "feat/x", headRefOid: "2222222222222222222222222222222222222222",
        repository: { nameWithOwner: FE }, headRepository: { nameWithOwner: FE }, mergeCommit: { oid: MERGE },
      }],
    },
  });
  const client = fakeClient({ nodes: [feNode] });
  client.listAll = async (path) => {
    if (path.includes("/pulls?state=closed&base=main")) return [];
    if (path.endsWith("/dependencies/blocked_by") || path.endsWith("/sub_issues")) return [];
    throw new Error("unexpected list path: " + path);
  };
  const receipt = await runCompletion(client, { repository: FE, reconcileProjectStatus: false });
  assert.equal(receipt.strategy, "production-merge");
  assert.equal(receipt.branch, "main");
  assert.equal(receipt.results[0].decision.code, "awaiting-production");
  assert.ok(!client.log.some((entry) => entry.startsWith("PATCH ")));
  assert.ok(!client.log.some((entry) => entry.includes("/commits/")), "production-merge must not read an integration head");

  const registry = loadRegistry();
  const forged = {
    ...registry,
    repositories: registry.repositories.map((profile) => (profile.repository === FE
      ? { ...profile, branches: { default: "main", integration: "develop", promotion: "main" } }
      : profile)),
  };
  await assert.rejects(() => runCompletion(client, { repository: FE, registry: forged, reconcileProjectStatus: false }),
    (error) => error.code === "STRATEGY_BRANCH_MISMATCH");
});

test("summary names repository and strategy and escapes the diagnostic", () => {
  const summary = formatCompletionSummary({
    repository: ORG, strategy: "integration-merge", projectNumber: 5, projectReconciliation: false,
    results: [
      { issue: { number: 1, url: "https://github.com/ChipIn-one/.github/issues/1" }, decision: { code: "closed-completed", detail: "a | b\nc" } },
      { issue: { number: 2 }, decision: { code: "missing-development", detail: "x" } },
    ],
  });
  assert.match(summary, /^# Completion ChipIn-one\/\.github \(integration-merge\)/u);
  assert.match(summary, /Closed as completed: 1/u);
  assert.match(summary, /Left open: 1/u);
  assert.match(summary, /Project #5 reconciliation: off/u);
  assert.match(summary, /\| \[#1\]\(https:\/\/github\.com\/ChipIn-one\/\.github\/issues\/1\) \| closed-completed \| a \\\| b c \|/u);
  assert.match(summary, /\| #2 \| missing-development \| x \|/u);
});

test("registry: .github and the knowledge base are automatic integration-merge, backend stays manual", () => {
  const registry = loadRegistry();
  for (const repository of [ORG, KB]) {
    const profile = registry.repositories.find((candidate) => candidate.repository === repository);
    assert.equal(profile.completion, "integration-merge", repository);
    assert.equal(profile.capabilities.completion, "automatic", repository);
  }
  const backend = registry.repositories.find((candidate) => candidate.repository === "ChipIn-one/chipin-backend");
  assert.equal(backend.capabilities.completion, "manual");
  assert.throws(() => validateRegistry({
    ...registry,
    repositories: registry.repositories.map((profile) => (profile.repository === ORG
      ? { ...profile, completion: "deployment-receipt", release: { strategy: "none" }, branches: { default: "master", integration: "master" }, requiredChecks: [] }
      : { ...profile, release: profile.release.strategy === "none" ? { strategy: "none" } : profile.release, branches: Object.fromEntries(Object.entries(profile.branches).filter(([, v]) => v !== null)) })),
  }), /contradicts completion "deployment-receipt"/u);
});

test("org workflow for .github runs only from trusted master pushes and the schedule, with the org write token", async () => {
  const workflow = await readFile(new URL("../.github/workflows/integration-completion.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  push:$/mu);
  assert.match(workflow, /^    branches:\n      - master$/mu);
  assert.match(workflow, /^  schedule:$/mu);
  assert.doesNotMatch(workflow, /workflow_dispatch:/u);
  // the PAT does the reads and writes (private cross-repository relationships, Project #5 repair)
  assert.match(workflow, /^permissions:\n  contents: read\n\n/mu);
  assert.match(workflow, /CHIPIN_CANONICAL_WRITE_TOKEN: \$\{\{ secrets\.CHIPIN_ISSUE_WRITE_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /github\.token/u);
  assert.match(workflow, /CHIPIN_COMPLETION_WRITE: "1"/u);
  assert.doesNotMatch(workflow, /CHIPIN_COMPLETION_PROJECT_RECONCILE/u);
  assert.match(workflow, /node automation\/completion\.mjs --repository "\$GITHUB_REPOSITORY"/u);
  assert.match(workflow, /cancel-in-progress: false/u);
});

test("composite action and knowledge-base caller template run the engine with the caller token only", async () => {
  const action = await readFile(new URL("./completion-action/action.yml", import.meta.url), "utf8");
  assert.match(action, /CHIPIN_COMPLETION_WRITE: "1"/u);
  assert.match(action, /CHIPIN_COMPLETION_PROJECT_RECONCILE: "0"/u);
  assert.match(action, /CHIPIN_CANONICAL_WRITE_TOKEN: \$\{\{ inputs\.token \}\}/u);
  assert.match(action, /completion\.mjs" --repository "\$COMPLETION_REPOSITORY"/u);
  assert.doesNotMatch(action, /frontend-production-completion\.mjs/u);

  const template = await readFile(new URL("../templates/caller-completion-integration.yml", import.meta.url), "utf8");
  assert.match(template, /^on:\n  push:\n    branches: \[master\]/mu);
  assert.match(template, /ChipIn-one\/\.github\/automation\/completion-action@<sha>/u);
  assert.match(template, /issues: write/u);
  assert.match(template, /token: \$\{\{ github\.token \}\}/u);
  assert.match(template, /cancel-in-progress: false/u);
  assert.doesNotMatch(template, /workflow_dispatch/u);
});

// ---- Awaiting release writer (.github#180) ----

const STATUS_OPTIONS = ["Backlog", "Todo", "In Progress", "Awaiting release", "Done"];
const statusOptionId = (name) => "OPT_" + name.replaceAll(" ", "_");
const statusField = (options = STATUS_OPTIONS) => ({
  __typename: "ProjectV2SingleSelectField",
  id: "FIELD_STATUS",
  name: "Status",
  dataType: "SINGLE_SELECT",
  isIssueField: false,
  options: options.map((name) => ({ id: statusOptionId(name), name })),
});

function feCandidateNode({ number = 1, updatedAt = "2026-10-07T10:00:00Z" } = {}) {
  return candidateNode({
    number,
    updatedAt,
    url: "https://github.com/ChipIn-one/chipin-frontend/issues/" + number,
    closedByPullRequestsReferences: {
      totalCount: 1,
      nodes: [{
        number: 100 + number, url: "https://github.com/ChipIn-one/chipin-frontend/pull/" + (100 + number), state: "MERGED",
        mergedAt: "2026-10-01T10:00:00Z", baseRefName: "dev", headRefName: "feat/x-" + number,
        headRefOid: "2222222222222222222222222222222222222222",
        repository: { nameWithOwner: FE }, headRepository: { nameWithOwner: FE }, mergeCommit: { oid: MERGE },
      }],
    },
  });
}

/**
 * Fake GitHub with Project #5: `statuses` maps Project item id -> Status, `items` lists memberships.
 * Each Issue N of `repository` gets item `ITEM_N` unless `items` is given.
 */
function projectClient({
  repository = FE,
  nodes = [feCandidateNode()],
  statuses = { ITEM_1: "Todo" },
  items,
  fields = [statusField()],
  issueState = "open",
  issueUpdatedAt = "2026-10-07T10:00:00Z",
  readBackOverride = null,
} = {}) {
  const log = [];
  const state = { ...statuses };
  const memberships = items ?? nodes.map((node) => ({ id: "ITEM_" + node.number, repository, number: node.number }));
  const optionName = (optionId) => STATUS_OPTIONS.find((name) => statusOptionId(name) === optionId) ?? null;
  const readStatus = (itemId) => (readBackOverride && log.some((entry) => entry.startsWith("mutation"))
    ? readBackOverride
    : state[itemId] ?? null);
  return {
    log,
    state,
    graphql: async (query, variables = {}) => {
      const name = query.trim().split(/[\s(]/u).slice(0, 2).join(" ");
      log.push(name);
      if (name === "query FrontendCompletionCandidates") {
        return { repository: { issues: { totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } };
      }
      if (name === "query MetadataProject") {
        return {
          organization: {
            projectV2: {
              id: "PROJECT_5",
              fields: { totalCount: fields.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes: fields },
              items: {
                totalCount: memberships.length,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: memberships.map((item) => ({
                  id: item.id,
                  content: { __typename: "Issue", number: item.number, repository: { nameWithOwner: item.repository } },
                  fieldValueByName: state[item.id] ? { __typename: "ProjectV2ItemFieldSingleSelectValue", name: state[item.id] } : null,
                })),
              },
            },
          },
        };
      }
      if (name === "query FrontendCompletionProjectItem" || name === "query CompletionProjectItemStatus") {
        const status = readStatus(variables.itemId);
        return { node: { __typename: "ProjectV2Item", id: variables.itemId, fieldValueByName: status ? { name: status } : null } };
      }
      if (name === "mutation SetCompletionAwaitingRelease" || name === "mutation SetFrontendCompletionStatus") {
        assert.equal(variables.projectId, "PROJECT_5");
        assert.equal(variables.fieldId, "FIELD_STATUS");
        state[variables.itemId] = optionName(variables.optionId);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
      }
      throw new Error("unexpected GraphQL: " + name);
    },
    listAll: async (path) => {
      if (path.includes("/pulls?state=closed&base=main")) return [];
      if (path.endsWith("/dependencies/blocked_by") || path.endsWith("/sub_issues")) return [];
      throw new Error("unexpected list path: " + path);
    },
    request: async (path, options = {}) => {
      log.push((options.method ?? "GET") + " " + path);
      if (path.endsWith("/commits/master")) return { sha: HEAD };
      if (path.includes("/compare/")) return { status: "ahead", merge_base_commit: { sha: MERGE } };
      if (/\/issues\/\d+$/u.test(path) && (options.method ?? "GET") === "GET") {
        return { state: issueState, updated_at: issueUpdatedAt, sub_issues_summary: { total: 0, completed: 0, percent_completed: 0 } };
      }
      if (/\/issues\/\d+$/u.test(path) && options.method === "PATCH") return { state: "closed", state_reason: "completed" };
      throw new Error("unexpected request: " + path);
    },
  };
}

const mutations = (client) => client.log.filter((entry) => entry.startsWith("mutation") || entry.startsWith("PATCH "));
const feIssue = (overrides = {}) => ({ number: 1, updatedAt: "2026-10-07T10:00:00Z", ...overrides });
// a normalized frontend sweep candidate with full evidence: one same-repository PR merged into dev
const READABLE_HISTORY = Object.freeze({ readable: true, closedAt: [], reopenedAt: [], renamedAt: [], bodyRevisions: [] });
const fePr = (overrides = {}) => linkedPr({
  number: 101, baseRefName: "dev", headRefName: "feat/x-1", repository: FE, headRepository: FE, ...overrides,
});
const feCandidate = (overrides = {}) => issue({ linkedPullRequests: [fePr()], scopeHistory: READABLE_HISTORY, ...overrides });
const FE_PROJECT_CONFIG = { organization: "ChipIn-one", project: { number: 5, statusField: "Status" } };

test("awaiting release: production-merge sweep moves Todo and In Progress to Awaiting release and reads it back", async () => {
  for (const from of ["Todo", "In Progress"]) {
    const client = projectClient({ statuses: { ITEM_1: from } });
    const receipt = await runCompletion(client, { repository: FE, awaitingRelease: true });
    assert.equal(receipt.results[0].decision.code, "awaiting-production", from);
    assert.equal(client.state.ITEM_1, AWAITING_RELEASE_STATUS, from);
    assert.deepEqual(receipt.awaitingRelease, { enabled: true, updated: [1], skipped: 0, failed: [] });
    assert.match(receipt.results[0].decision.detail, new RegExp("Awaiting release: awaiting-release-set\\. Project Status " + from + " -> Awaiting release\\.", "u"));
    assert.deepEqual(mutations(client), ["mutation SetCompletionAwaitingRelease"], "only the Status write, never a close");
    // read-back after the write
    const writeAt = client.log.indexOf("mutation SetCompletionAwaitingRelease");
    assert.equal(client.log.slice(writeAt + 1).filter((entry) => entry === "query CompletionProjectItemStatus").length, 1);
    assert.match(formatCompletionSummary(receipt), /Awaiting release: on \(set 1, unchanged 0, failed 0\)/u);
  }
});

test("awaiting release: a rerun on Awaiting release is a no-op without a mutation", async () => {
  const client = projectClient({ statuses: { ITEM_1: "Todo" } });
  await runCompletion(client, { repository: FE, awaitingRelease: true });
  const before = mutations(client).length;
  const receipt = await runCompletion(client, { repository: FE, awaitingRelease: true });
  assert.equal(mutations(client).length, before);
  assert.deepEqual(receipt.awaitingRelease, { enabled: true, updated: [], skipped: 1, failed: [] });
  assert.match(receipt.results[0].decision.detail, /awaiting-release-current/u);
});

test("awaiting release: Done, Backlog, unknown and empty Status are left untouched", async () => {
  const project = { id: "PROJECT_5", fields: [statusField()], items: [{ id: "ITEM_1", repository: FE, number: 1 }] };
  for (const [status, code] of [
    ["Done", "awaiting-release-skipped:Done"],
    ["Backlog", "awaiting-release-skipped:Backlog"],
    ["DEV", "awaiting-release-skipped:DEV"],
    [null, "awaiting-release-skipped:none"],
  ]) {
    const client = projectClient({ statuses: status ? { ITEM_1: status } : {} });
    const outcome = await setAwaitingReleaseStatus(client, feIssue(), project, FE);
    assert.equal(outcome.mutated, false, String(status));
    assert.equal(outcome.code, code);
    assert.deepEqual(mutations(client), []);
    assert.ok(!client.log.some((entry) => entry.startsWith("GET ")), "no Issue re-read when nothing is written");
  }

  // sweep level: Backlog stays Backlog
  const backlog = projectClient({ statuses: { ITEM_1: "Backlog" } });
  const receipt = await runCompletion(backlog, { repository: FE, awaitingRelease: true });
  assert.equal(backlog.state.ITEM_1, "Backlog");
  assert.deepEqual(mutations(backlog), []);
  assert.deepEqual(receipt.awaitingRelease, { enabled: true, updated: [], skipped: 1, failed: [] });
});

test("awaiting release: an open Issue showing derived Done is first repaired by the frontend sweep, then moved on", async () => {
  // the unchanged frontend module repairs open + Done -> In Progress inside its sweep; the writer then reads
  // the fresh item Status (In Progress) and sets Awaiting release
  const client = projectClient({ statuses: { ITEM_1: "Done" } });
  const receipt = await runCompletion(client, { repository: FE, awaitingRelease: true });
  assert.deepEqual(mutations(client), ["mutation SetFrontendCompletionStatus", "mutation SetCompletionAwaitingRelease"]);
  assert.equal(client.state.ITEM_1, AWAITING_RELEASE_STATUS);
  assert.deepEqual(receipt.awaitingRelease.updated, [1]);
});

test("awaiting release: missing or ambiguous Project membership is noted without a mutation", async () => {
  const client = projectClient();
  const missing = await setAwaitingReleaseStatus(client, feIssue(), { id: "PROJECT_5", fields: [statusField()], items: [] }, FE);
  assert.equal(missing.code, "project-membership-missing");
  const otherRepository = await setAwaitingReleaseStatus(client, feIssue(),
    { id: "PROJECT_5", fields: [statusField()], items: [{ id: "ITEM_X", repository: ORG, number: 1 }] }, FE);
  assert.equal(otherRepository.code, "project-membership-missing");
  const ambiguous = await setAwaitingReleaseStatus(client, feIssue(), {
    id: "PROJECT_5", fields: [statusField()],
    items: [{ id: "ITEM_1", repository: FE, number: 1 }, { id: "ITEM_2", repository: FE, number: 1 }],
  }, FE);
  assert.equal(ambiguous.code, "project-membership-ambiguous");
  assert.deepEqual(client.log, [], "nothing is read or written for a missing or ambiguous membership");

  const sweep = projectClient({ items: [] });
  const receipt = await runCompletion(sweep, { repository: FE, awaitingRelease: true });
  assert.match(receipt.results[0].decision.detail, /project-membership-missing/u);
  assert.deepEqual(mutations(sweep), []);
});

test("awaiting release: a stale or closed Issue is skipped without a mutation", async () => {
  const project = { id: "PROJECT_5", fields: [statusField()], items: [{ id: "ITEM_1", repository: FE, number: 1 }] };
  const stale = projectClient({ issueUpdatedAt: "2026-10-07T10:00:01Z" });
  const staleOutcome = await setAwaitingReleaseStatus(stale, feIssue(), project, FE);
  assert.equal(staleOutcome.code, "stale-snapshot");
  assert.deepEqual(mutations(stale), []);

  const closed = projectClient({ issueState: "closed" });
  const closedOutcome = await setAwaitingReleaseStatus(closed, feIssue(), project, FE);
  assert.equal(closedOutcome.code, "issue-no-longer-open");
  assert.deepEqual(mutations(closed), []);

  const noSnapshotTime = projectClient();
  assert.equal((await setAwaitingReleaseStatus(noSnapshotTime, feIssue({ updatedAt: null }), project, FE)).code, "stale-snapshot");
  assert.deepEqual(mutations(noSnapshotTime), []);
});

test("awaiting release: a read-back mismatch or a missing option fails closed", async () => {
  const project = { id: "PROJECT_5", fields: [statusField()], items: [{ id: "ITEM_1", repository: FE, number: 1 }] };
  const mismatch = projectClient({ readBackOverride: "In Progress" });
  await assert.rejects(() => setAwaitingReleaseStatus(mismatch, feIssue(), project, FE),
    (error) => error instanceof CompletionBlocked && error.code === "PROJECT_STATUS_WRITE" && /did not read back as Awaiting release/u.test(error.message));

  const noOption = projectClient();
  await assert.rejects(() => setAwaitingReleaseStatus(noOption, feIssue(),
    { ...project, fields: [statusField(["Backlog", "Todo", "In Progress", "Done"])] }, FE),
  (error) => error.code === "PROJECT_STATUS_OPTION");
  assert.deepEqual(mutations(noOption), []);

  assert.throws(() => projectStatusCoordinates({ id: "P", fields: [statusField(), statusField()] }, AWAITING_RELEASE_STATUS),
    (error) => error.code === "PROJECT_STATUS_FIELD");
  assert.throws(() => projectStatusCoordinates({ id: "P", fields: [{ ...statusField(), isIssueField: true }] }, AWAITING_RELEASE_STATUS),
    /project-local/u);
  assert.deepEqual(projectStatusCoordinates({ id: "P", fields: [statusField()] }, AWAITING_RELEASE_STATUS),
    { projectId: "P", fieldId: "FIELD_STATUS", optionId: "OPT_Awaiting_release" });
});

test("awaiting release: only awaiting-production results are touched, and the snapshot is read once per run", async () => {
  const client = projectClient({
    nodes: [feCandidateNode({ number: 1 }), feCandidateNode({ number: 2 })],
    statuses: { ITEM_1: "Todo", ITEM_2: "In Progress" },
  });
  const results = [
    { issue: feCandidate({ number: 1 }), decision: { action: "leave-open", code: "awaiting-production", detail: "a." } },
    { issue: feIssue({ number: 2 }), decision: { action: "leave-open", code: "missing-development", detail: "b." } },
    { issue: feIssue({ number: 3 }), decision: { action: "closed", code: "closed-completed", detail: "c." } },
  ];
  const reconciled = await reconcileAwaitingRelease(client, results, {
    repository: FE, projectConfig: { organization: "ChipIn-one", project: { number: 5, statusField: "Status" } },
  });
  assert.deepEqual(reconciled.awaitingRelease, { enabled: true, updated: [1], skipped: 0, failed: [] });
  assert.equal(client.state.ITEM_2, "In Progress", "another decision code never changes Status");
  assert.equal(reconciled.results[1], results[1]);
  assert.equal(reconciled.results[2], results[2]);
  assert.equal(client.log.filter((entry) => entry === "query MetadataProject").length, 1);

  const none = projectClient();
  const untouched = await reconcileAwaitingRelease(none, results.slice(1), {
    repository: FE, projectConfig: { organization: "ChipIn-one", project: { number: 5, statusField: "Status" } },
  });
  assert.deepEqual(untouched.awaitingRelease, { enabled: true, updated: [], skipped: 0, failed: [] });
  assert.deepEqual(none.log, [], "no Project read without a candidate");
});

test("awaiting release: every linked PR is re-verified, in any order (a later open PR blocks the write)", async () => {
  const merged = fePr();
  const open = fePr({ number: 102, mergedAt: null, mergeCommitSha: null });
  for (const linkedPullRequests of [[merged, open], [open, merged]]) {
    const verdict = await evaluateAwaitingReleaseCandidate(feCandidate({ linkedPullRequests }), { repository: FE });
    assert.equal(verdict.eligible, false);
    assert.equal(verdict.code, "implementation-not-merged");

    const client = projectClient();
    const reconciled = await reconcileAwaitingRelease(client, [
      { issue: feCandidate({ linkedPullRequests }), decision: { action: "leave-open", code: "awaiting-production", detail: "a." } },
    ], { repository: FE, projectConfig: FE_PROJECT_CONFIG });
    assert.match(reconciled.results[0].decision.detail, /Awaiting release: awaiting-release-skipped:implementation-not-merged\./u);
    assert.deepEqual(reconciled.awaitingRelease, { enabled: true, updated: [], skipped: 1, failed: [] });
    assert.deepEqual(client.log, [], "no Project read or write for an ineligible candidate");
  }
});

test("awaiting release: another repository, a fork head, a non-canonical main PR, a linked branch or incomplete linkage are skipped", async () => {
  const cases = [
    [feCandidate({ linkedPullRequests: [fePr(), fePr({ number: 5, repository: ORG, headRepository: ORG })] }), "ambiguous-development"],
    [feCandidate({ linkedPullRequests: [fePr({ headRepository: "someone/chipin-frontend" })] }), "ambiguous-development"],
    [feCandidate({ linkedPullRequests: [fePr({ baseRefName: "main", headRefName: "feat/x" })] }), "ambiguous-production"],
    [feCandidate({ linkedPullRequests: [fePr({ baseRefName: "release" })] }), "ambiguous-development"],
    [feCandidate({ linkedPullRequests: [fePr(), fePr()] }), "ambiguous-development"],
    [feCandidate({ linkedPullRequests: [fePr({ mergeCommitSha: "abc" })] }), "implementation-not-merged"],
    [feCandidate({ linkedBranchCount: 1 }), "development-branch-pending"],
    [feCandidate({ linkedPullRequestTotalCount: 2 }), "ambiguous-development"],
    [feCandidate({ linkedPullRequests: [], linkedPullRequestTotalCount: 0 }), "missing-development"],
    [feCandidate({ state: "CLOSED" }), "already-closed"],
  ];
  for (const [candidate, code] of cases) {
    const verdict = await evaluateAwaitingReleaseCandidate(candidate, { repository: FE });
    assert.equal(verdict.eligible, false, code);
    assert.equal(verdict.code, code);
  }
  // the canonical same-repository dev -> main release PR is valid evidence
  const release = fePr({ number: 103, baseRefName: "main", headRefName: "dev" });
  assert.deepEqual(await evaluateAwaitingReleaseCandidate(feCandidate({ linkedPullRequests: [fePr(), release] }), { repository: FE }),
    { eligible: true });
});

test("awaiting release: scope freshness (#178) is re-checked before the write", async () => {
  // merged 2026-10-01; closed before the merge and reopened after it: a real scope change
  const reopened = feCandidate({
    scopeHistory: { ...READABLE_HISTORY, closedAt: ["2026-09-30T10:00:00Z"], reopenedAt: ["2026-10-02T10:00:00Z"] },
  });
  const reopenedVerdict = await evaluateAwaitingReleaseCandidate(reopened, { repository: FE });
  assert.equal(reopenedVerdict.code, "scope-changed-after-implementation");

  // checkbox-only body edit after the merge: still eligible
  const revisions = (after) => [
    { editedAt: "2026-09-01T10:00:00Z", body: "Scope\n- [ ] one\n- [ ] two" },
    { editedAt: "2026-10-03T10:00:00Z", body: after },
  ];
  const checkbox = feCandidate({ lastEditedAt: "2026-10-03T10:00:00Z",
    scopeHistory: { ...READABLE_HISTORY, bodyRevisions: revisions("Scope\n- [x] one\n- [X] two") } });
  assert.deepEqual(await evaluateAwaitingReleaseCandidate(checkbox, { repository: FE }), { eligible: true });
  const textEdit = feCandidate({ lastEditedAt: "2026-10-03T10:00:00Z",
    scopeHistory: { ...READABLE_HISTORY, bodyRevisions: revisions("Scope\n- [ ] one\n- [ ] two\n- [ ] three") } });
  assert.equal((await evaluateAwaitingReleaseCandidate(textEdit, { repository: FE })).code, "scope-changed-after-implementation");

  // history read through the callback when the sweep result carries none; unreadable or throwing fails closed
  const withoutHistory = feCandidate({ scopeHistory: undefined });
  delete withoutHistory.scopeHistory;
  let reads = 0;
  assert.deepEqual(await evaluateAwaitingReleaseCandidate(withoutHistory, {
    repository: FE, readScopeHistory: async () => { reads += 1; return READABLE_HISTORY; },
  }), { eligible: true });
  assert.equal(reads, 1);
  const unreadable = await evaluateAwaitingReleaseCandidate(withoutHistory, {
    repository: FE, readScopeHistory: async () => ({ readable: false, detail: "timeline unreadable" }),
  });
  assert.equal(unreadable.code, "scope-history-unreadable");
  const throwing = await evaluateAwaitingReleaseCandidate(withoutHistory, {
    repository: FE, readScopeHistory: async () => { throw new Error("boom"); },
  });
  assert.equal(throwing.code, "scope-history-unreadable");

  const client = projectClient();
  const reconciled = await reconcileAwaitingRelease(client, [
    { issue: withoutHistory, decision: { action: "leave-open", code: "awaiting-production", detail: "a." } },
  ], { repository: FE, projectConfig: FE_PROJECT_CONFIG, readScopeHistory: async () => ({ readable: false, detail: "x" }) });
  assert.match(reconciled.results[0].decision.detail, /awaiting-release-skipped:scope-history-unreadable/u);
  assert.deepEqual(client.log, []);
});

test("awaiting release: a failed write on one Issue is recorded and the run continues; missing option stops before any write", async () => {
  const client = projectClient({
    nodes: [feCandidateNode({ number: 1 }), feCandidateNode({ number: 2 })],
    statuses: { ITEM_1: "Todo", ITEM_2: "Todo" },
  });
  const graphql = client.graphql;
  client.graphql = async (query, variables = {}) => {
    const data = await graphql(query, variables);
    if (query.includes("CompletionProjectItemStatus") && variables.itemId === "ITEM_1"
      && client.log.includes("mutation SetCompletionAwaitingRelease")) {
      return { node: { ...data.node, fieldValueByName: { name: "In Progress" } } };
    }
    return data;
  };
  const results = [1, 2].map((number) => ({
    issue: feCandidate({ number }), decision: { action: "leave-open", code: "awaiting-production", detail: "a." },
  }));
  const reconciled = await reconcileAwaitingRelease(client, results, { repository: FE, projectConfig: FE_PROJECT_CONFIG });
  assert.deepEqual(reconciled.awaitingRelease, { enabled: true, updated: [2], skipped: 0, failed: [1] });
  assert.match(reconciled.results[0].decision.detail, /Awaiting release: awaiting-release-failed: Project Status of Issue #1 did not read back/u);
  assert.match(reconciled.results[1].decision.detail, /awaiting-release-set/u);
  assert.equal(client.state.ITEM_2, AWAITING_RELEASE_STATUS);
  assert.match(formatCompletionSummary({ repository: FE, strategy: "production-merge", projectNumber: 5,
    projectReconciliation: true, awaitingRelease: reconciled.awaitingRelease, results: reconciled.results }),
  /Awaiting release: on \(set 1, unchanged 0, failed 1\)/u);

  const noOption = projectClient({ fields: [statusField(["Backlog", "Todo", "In Progress", "Done"])] });
  await assert.rejects(() => reconcileAwaitingRelease(noOption, results, { repository: FE, projectConfig: FE_PROJECT_CONFIG }),
    (error) => error instanceof CompletionBlocked && error.code === "PROJECT_STATUS_OPTION");
  assert.deepEqual(mutations(noOption), []);
  assert.ok(!noOption.log.includes("query CompletionProjectItemStatus"), "coordinates are resolved before any item read");
});

test("awaiting release: off by default and with Project reconciliation off; no Project reads beyond the existing ones", async () => {
  const off = projectClient();
  const receipt = await runCompletion(off, { repository: FE });
  assert.deepEqual(receipt.awaitingRelease, { enabled: false, updated: [], skipped: 0, failed: [] });
  assert.equal(off.log.filter((entry) => entry === "query MetadataProject").length, 1, "only the frontend sweep's own snapshot");
  assert.ok(!off.log.includes("query CompletionProjectItemStatus"));
  assert.equal(off.state.ITEM_1, "Todo");
  assert.match(formatCompletionSummary(receipt), /Awaiting release: off/u);

  const on = projectClient();
  await runCompletion(on, { repository: FE, awaitingRelease: true });
  assert.equal(on.log.filter((entry) => entry === "query MetadataProject").length, 2, "one extra snapshot for the writer");

  // a repository-local run (no Project access) must not silently drop the flag: fail closed before any read
  const local = projectClient();
  await assert.rejects(() => runCompletion(local, { repository: FE, awaitingRelease: true, reconcileProjectStatus: false }),
    (error) => error instanceof CompletionBlocked && error.code === "AWAITING_RELEASE_NEEDS_PROJECT");
  assert.ok(!local.log.some((entry) => entry.includes("Project") || entry.startsWith("mutation")));
});

test("awaiting release: integration-merge never runs the writer (the merge is terminal)", async () => {
  const unmerged = candidateNode({
    closedByPullRequestsReferences: {
      totalCount: 1,
      nodes: [{ ...candidateNode().closedByPullRequestsReferences.nodes[0], state: "OPEN", mergedAt: null, mergeCommit: null }],
    },
  });
  const client = projectClient({ repository: ORG, nodes: [unmerged, candidateNode({ number: 2 })], statuses: { ITEM_1: "In Progress", ITEM_2: "Todo" } });
  const receipt = await runCompletion(client, { repository: ORG, awaitingRelease: true });
  assert.equal(receipt.strategy, "integration-merge");
  assert.deepEqual(receipt.awaitingRelease, { enabled: false, updated: [], skipped: 0, failed: [] });
  assert.deepEqual(receipt.results.map((result) => result.decision.code), ["implementation-not-merged", "closed-completed"]);
  assert.ok(!client.log.includes("query CompletionProjectItemStatus"));
  assert.ok(!client.log.includes("mutation SetCompletionAwaitingRelease"));
  assert.deepEqual(client.state, { ITEM_1: "In Progress", ITEM_2: "Todo" });
});

test("org workflow for the frontend runs the shared engine with Awaiting release on, from master pushes and the schedule only", async () => {
  const workflow = await readFile(new URL("../.github/workflows/frontend-production-completion.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  push:$/mu);
  assert.match(workflow, /^    branches:\n      - master$/mu);
  assert.match(workflow, /^  schedule:$/mu);
  assert.doesNotMatch(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /^permissions:\n  contents: read\n\n/mu);
  assert.match(workflow, /CHIPIN_CANONICAL_WRITE_TOKEN: \$\{\{ secrets\.CHIPIN_ISSUE_WRITE_TOKEN \}\}/u);
  assert.doesNotMatch(workflow, /github\.token/u);
  assert.match(workflow, /CHIPIN_COMPLETION_WRITE: "1"/u);
  assert.match(workflow, /CHIPIN_COMPLETION_AWAITING_RELEASE: "1"/u);
  assert.doesNotMatch(workflow, /CHIPIN_COMPLETION_PROJECT_RECONCILE/u, "Project reconciliation stays on");
  assert.match(workflow, /run: node automation\/completion\.mjs --repository ChipIn-one\/chipin-frontend$/mu);
  assert.doesNotMatch(workflow, /frontend-production-completion\.mjs/u);
  assert.match(workflow, /cancel-in-progress: false/u);

  // the .github workflow never turns the writer on
  const integration = await readFile(new URL("../.github/workflows/integration-completion.yml", import.meta.url), "utf8");
  assert.doesNotMatch(integration, /CHIPIN_COMPLETION_AWAITING_RELEASE/u);
  const action = await readFile(new URL("./completion-action/action.yml", import.meta.url), "utf8");
  assert.doesNotMatch(action, /CHIPIN_COMPLETION_AWAITING_RELEASE/u);
});
