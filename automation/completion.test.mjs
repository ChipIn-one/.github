import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CompletionBlocked,
  evaluateIssueForIntegrationCompletion,
  formatCompletionSummary,
  readBranchHead,
  runCompletion,
  runIntegrationCompletionSweep,
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
