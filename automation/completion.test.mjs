import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AWAITING_RELEASE_STATUS,
  CompletionBlocked,
  completionSkipNotice,
  RECEIPT_MAX_PAGES,
  RECEIPT_PAGE_SIZE,
  RECEIPT_STATUS_PAGE_SIZE,
  createReceiptResolver,
  deploymentReceiptAwaitingVerifier,
  evaluateAwaitingReleaseCandidate,
  evaluateIssueForDeploymentReceiptCompletion,
  evaluateIssueForIntegrationCompletion,
  formatCompletionSummary,
  projectStatusCoordinates,
  readBranchHead,
  readDeclaredTargetStates,
  readIssueRecord,
  readProductionDeployments,
  reconcileAwaitingRelease,
  runCompletion,
  runIntegrationCompletionSweep,
  setAwaitingReleaseStatus,
  validateProductionReceipt,
} from "./completion.mjs";
import { AUTOMATIC_COMPLETION_STRATEGIES, loadRegistry, validateRegistry } from "./registry.mjs";

const ORG = "ChipIn-one/.github";
const KB = "ChipIn-one/chipin-knowledge-base";
const FE = "ChipIn-one/chipin-frontend";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE = "1111111111111111111111111111111111111111";

// The live frontend record is canonical master + deployment-receipt (.github#216) with the engine on since
// .github#217 (capabilities.completion automatic, completionRunner org-sweep). The dev/main record before the cutover
// stays the rollback target of chipin-frontend#497, so the production-merge path keeps its tests on that record.
const legacyFrontendRegistry = (registry = loadRegistry()) => ({
  ...registry,
  repositories: registry.repositories.map((profile) => {
    if (profile.repository !== FE) return profile;
    const { productionEvidence, ...rest } = profile;
    return {
      ...rest,
      branches: { default: "main", integration: "dev", promotion: "main" },
      completion: "production-merge",
      release: { strategy: "semver-by-impact", trigger: "promotion-merge", tagPrefix: "v" },
      capabilities: { ...profile.capabilities, completion: "automatic" },
    };
  }),
});

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
  body,
  declaredTargetStates,
} = {}) {
  const value = {
    number, state, updatedAt, createdAt, lastEditedAt, reopenedAt: null,
    timeline: { readable: true, closedAt: [], reopenedAt: [], renamedAt: [] },
    linkedBranchCount, linkedPullRequests, linkedPullRequestTotalCount,
    requiredRelationshipsReadable, blockedBy, subIssues,
  };
  if (scopeHistory !== undefined) value.scopeHistory = scopeHistory;
  if (body !== undefined) value.body = body;
  if (declaredTargetStates !== undefined) value.declaredTargetStates = declaredTargetStates;
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

// .github#217 shape: the intake `--relates-to` mirror appended a declaration after the PR merged (.github#223)
const REL_BODY = "## Outcome\n\n- [ ] Ship it.\n\n## Dependencies\n\nParent: ChipIn-one/chipin-frontend#497\n"
  + "Blocked by: ChipIn-one/.github#216\n\n## References\n\n- Plan.\n";
const REL_BODY_MIRRORED = REL_BODY.replace("Blocked by: ChipIn-one/.github#216\n",
  "Blocked by: ChipIn-one/.github#216\nRelates to: ChipIn-one/.github#221\n");
const relationshipEdit = (before, after, extra = {}) => ({
  lastEditedAt: "2026-10-03T10:00:00Z",
  scopeHistory: {
    readable: true, closedAt: [], reopenedAt: [], renamedAt: [],
    bodyRevisions: [
      { editedAt: "2026-09-01T10:00:00Z", body: before },
      { editedAt: "2026-10-03T10:00:00Z", body: after },
    ],
    ...extra,
  },
});

test("integration-merge: relationship declaration edits in ## Dependencies are not a scope change (#223)", async () => {
  // added mirror line -> still complete
  assert.equal((await evaluateIssueForIntegrationCompletion(issue(relationshipEdit(REL_BODY, REL_BODY_MIRRORED)), context())).action,
    "close-completed");
  // removed mirror line -> still complete
  assert.equal((await evaluateIssueForIntegrationCompletion(issue(relationshipEdit(REL_BODY_MIRRORED, REL_BODY)), context())).action,
    "close-completed");
  // mirror line plus any other text change -> scope changed
  const mixed = await evaluateIssueForIntegrationCompletion(
    issue(relationshipEdit(REL_BODY, REL_BODY_MIRRORED.replace("Ship it.", "Ship it and more."))), context());
  assert.equal(mixed.code, "scope-changed-after-implementation");
  assert.match(mixed.detail, /text edited at 2026-10-03T10:00:00Z/u);
  // mirror line plus an extra blank line -> scope changed (only the declaration lines themselves are ignored)
  assert.equal((await evaluateIssueForIntegrationCompletion(
    issue(relationshipEdit(REL_BODY, REL_BODY_MIRRORED.replace("#221\n", "#221\n\n"))), context())).code,
  "scope-changed-after-implementation");
  // a relation-looking line outside ## Dependencies -> scope changed
  assert.equal((await evaluateIssueForIntegrationCompletion(
    issue(relationshipEdit(REL_BODY, REL_BODY.replace("- Plan.\n", "- Plan.\nRelates to: ChipIn-one/.github#221\n"))), context())).code,
  "scope-changed-after-implementation");
  // a malformed declaration (not exactly owner/repo#number) is text, not relationship data -> scope changed
  assert.equal((await evaluateIssueForIntegrationCompletion(
    issue(relationshipEdit(REL_BODY, REL_BODY.replace("#216\n", "#216\nRelates to: see #221\n"))), context())).code,
  "scope-changed-after-implementation");
  // a second ## Dependencies section makes the projection ambiguous -> fail closed
  assert.equal((await evaluateIssueForIntegrationCompletion(
    issue(relationshipEdit(REL_BODY + "\n## Dependencies\n", REL_BODY_MIRRORED + "\n## Dependencies\n")), context())).code,
  "scope-changed-after-implementation");
  // a relationship-only edit plus a reopen after the merge -> the reopen still blocks
  const reopened = await evaluateIssueForIntegrationCompletion(issue(relationshipEdit(REL_BODY, REL_BODY_MIRRORED, {
    closedAt: ["2026-10-01T10:00:02Z"], reopenedAt: ["2026-10-04T10:00:00Z"],
  })), context());
  assert.equal(reopened.code, "scope-changed-after-implementation");
  assert.match(reopened.detail, /reopened at 2026-10-04T10:00:00Z/u);
  assert.doesNotMatch(reopened.detail, /text edited/u);
  // title rename stays a scope change
  assert.equal((await evaluateIssueForIntegrationCompletion(issue(relationshipEdit(REL_BODY, REL_BODY_MIRRORED, {
    renamedAt: ["2026-10-04T10:00:00Z"],
  })), context())).code, "scope-changed-after-implementation");
});

test("deployment-receipt: a relationship-only body revision does not block, a mixed one does (#223)", async () => {
  const receiptContext = context({ repository: FE, findReceipt: async () => null });
  const pr = linkedPr({ repository: FE, headRepository: FE });
  const mirrored = await evaluateIssueForDeploymentReceiptCompletion(
    issue({ linkedPullRequests: [pr], ...relationshipEdit(REL_BODY, REL_BODY_MIRRORED) }), receiptContext);
  assert.equal(mirrored.code, "awaiting-production", "scope gate passed; only the missing receipt keeps it open");
  const mixed = await evaluateIssueForDeploymentReceiptCompletion(
    issue({ linkedPullRequests: [pr], ...relationshipEdit(REL_BODY, REL_BODY_MIRRORED.replace("Ship it.", "Ship more.")) }), receiptContext);
  assert.equal(mixed.code, "scope-changed-after-implementation");
});

test("declared Blocked by without a native edge keeps the Issue open (relationship-not-reconciled, #223)", async () => {
  const declared = "## Dependencies\n\nBlocked by: ChipIn-one/.github#300\n";
  // integration-merge: declared after the merge, reconciler not yet run -> open
  const pending = await evaluateIssueForIntegrationCompletion(issue({ body: declared }), context());
  assert.equal(pending.code, "relationship-not-reconciled");
  assert.match(pending.detail, /ChipIn-one\/\.github#300/u);
  // unknown target state counts as open; a closed target would not block even with the edge
  assert.equal((await evaluateIssueForIntegrationCompletion(issue({ body: declared, declaredTargetStates: { "ChipIn-one/.github#300": "open" } }), context())).code,
    "relationship-not-reconciled");
  assert.equal((await evaluateIssueForIntegrationCompletion(issue({ body: declared, declaredTargetStates: { "ChipIn-one/.github#300": "closed" } }), context())).action,
    "close-completed");
  // once the native edge exists the existing blocker gate decides
  assert.equal((await evaluateIssueForIntegrationCompletion(issue({ body: declared, blockedBy: [{ repository: ORG, number: 300, state: "open" }] }), context())).code,
    "blocked-by-open-issue");
  assert.equal((await evaluateIssueForIntegrationCompletion(issue({ body: declared, blockedBy: [{ repository: ORG, number: 300, state: "closed" }] }), context())).action,
    "close-completed");
  // other declaration kinds and no body (legacy callers) do not trigger the gate
  assert.equal((await evaluateIssueForIntegrationCompletion(issue({ body: "## Dependencies\n\nRelates to: ChipIn-one/.github#300\nBlocks: ChipIn-one/.github#301\n" }), context())).action,
    "close-completed");
  assert.equal((await evaluateIssueForIntegrationCompletion(issue(), context())).action, "close-completed");

  // deployment-receipt: same gate before any receipt is consulted
  let receiptReads = 0;
  const receiptContext = context({ repository: FE, findReceipt: async () => { receiptReads += 1; return null; } });
  const pr = linkedPr({ repository: FE, headRepository: FE });
  const fe = "## Dependencies\n\nBlocked by: ChipIn-one/chipin-frontend#900\n";
  assert.equal((await evaluateIssueForDeploymentReceiptCompletion(issue({ linkedPullRequests: [pr], body: fe }), receiptContext)).code,
    "relationship-not-reconciled");
  assert.equal(receiptReads, 0);
  assert.equal((await evaluateIssueForDeploymentReceiptCompletion(
    issue({ linkedPullRequests: [pr], body: fe, blockedBy: [{ repository: FE, number: 900, state: "open" }] }), receiptContext)).code,
  "blocked-by-open-issue");
});

test("readIssueRecord and readDeclaredTargetStates feed the declared-blocker gate (reads only missing targets)", async () => {
  const reads = [];
  const client = { request: async (path) => {
    reads.push(path);
    if (path.endsWith("/issues/1")) return { sub_issues_summary: { total: 0 }, body: null };
    if (path.endsWith("/issues/300")) return { state: "closed" };
    if (path.endsWith("/issues/301")) return { state: "open" };
    throw new Error("404");
  } };
  assert.deepEqual(await readIssueRecord(client, ORG, 1), { subIssueTotal: 0, body: "" });
  await assert.rejects(() => readIssueRecord({ request: async () => ({ sub_issues_summary: { total: 0 }, body: 7 }) }, ORG, 1),
    (error) => error.code === "UNREADABLE_ISSUE_BODY");
  reads.length = 0;
  const body = "## Dependencies\n\nBlocked by: ChipIn-one/.github#300\nBlocked by: ChipIn-one/.github#301\n"
    + "Blocked by: ChipIn-one/.github#302\nBlocked by: ChipIn-one/.github#303\n";
  const states = await readDeclaredTargetStates(client, { body, blockedBy: [{ repository: ORG, number: 303, state: "open" }] });
  assert.deepEqual(states, { "ChipIn-one/.github#300": "closed", "ChipIn-one/.github#301": "open" });
  assert.equal(reads.length, 3, "#303 has a native edge and is not read; #302 is unreadable and stays unknown");
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
      ? { ...profile, completion: "manual" }
      : profile)),
  };
  await assert.rejects(() => runCompletion(fakeClient(), { repository: ORG, registry: forged, reconcileProjectStatus: false }),
    (error) => error.code === "STRATEGY_NOT_IMPLEMENTED");
  assert.deepEqual([...AUTOMATIC_COMPLETION_STRATEGIES], ["production-merge", "integration-merge", "deployment-receipt"]);
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
  const receipt = await runCompletion(client, { repository: FE, registry: legacyFrontendRegistry(), reconcileProjectStatus: false });
  assert.equal(receipt.strategy, "production-merge");
  assert.equal(receipt.branch, "main");
  assert.equal(receipt.results[0].decision.code, "awaiting-production");
  assert.ok(!client.log.some((entry) => entry.startsWith("PATCH ")));
  assert.ok(!client.log.some((entry) => entry.includes("/commits/")), "production-merge must not read an integration head");

  const registry = legacyFrontendRegistry();
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
      ? { ...profile, completion: "manual", release: { strategy: "none" }, branches: { default: "master", integration: "master" }, requiredChecks: [] }
      : { ...profile, release: profile.release.strategy === "none" ? { strategy: "none" } : profile.release, branches: Object.fromEntries(Object.entries(profile.branches).filter(([, v]) => v !== null)) })),
  }), /contradicts completion "manual"/u);
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
    const receipt = await runCompletion(client, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
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
  await runCompletion(client, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
  const before = mutations(client).length;
  const receipt = await runCompletion(client, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
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
  const receipt = await runCompletion(backlog, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
  assert.equal(backlog.state.ITEM_1, "Backlog");
  assert.deepEqual(mutations(backlog), []);
  assert.deepEqual(receipt.awaitingRelease, { enabled: true, updated: [], skipped: 1, failed: [] });
});

test("awaiting release: an open Issue showing derived Done is first repaired by the frontend sweep, then moved on", async () => {
  // the unchanged frontend module repairs open + Done -> In Progress inside its sweep; the writer then reads
  // the fresh item Status (In Progress) and sets Awaiting release
  const client = projectClient({ statuses: { ITEM_1: "Done" } });
  const receipt = await runCompletion(client, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
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

  // Project #5 is never empty; an empty zero-count items page is re-read as phantom (#221).
  const sweep = projectClient({ items: [{ id: "ITEM_X", repository: ORG, number: 1 }] });
  const receipt = await runCompletion(sweep, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
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
  const receipt = await runCompletion(off, { repository: FE, registry: legacyFrontendRegistry() });
  assert.deepEqual(receipt.awaitingRelease, { enabled: false, updated: [], skipped: 0, failed: [] });
  assert.equal(off.log.filter((entry) => entry === "query MetadataProject").length, 1, "only the frontend sweep's own snapshot");
  assert.ok(!off.log.includes("query CompletionProjectItemStatus"));
  assert.equal(off.state.ITEM_1, "Todo");
  assert.match(formatCompletionSummary(receipt), /Awaiting release: off/u);

  const on = projectClient();
  await runCompletion(on, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true });
  assert.equal(on.log.filter((entry) => entry === "query MetadataProject").length, 2, "one extra snapshot for the writer");

  // a repository-local run (no Project access) must not silently drop the flag: fail closed before any read
  const local = projectClient();
  await assert.rejects(() => runCompletion(local, { repository: FE, registry: legacyFrontendRegistry(), awaitingRelease: true, reconcileProjectStatus: false }),
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
  // kept from .github#216: harmless while the frontend record is automatic (.github#217), a green no-op if it is
  // switched back to manual
  assert.match(workflow, /CHIPIN_COMPLETION_SKIP_MANUAL: "1"/u);
  assert.doesNotMatch(workflow, /CHIPIN_COMPLETION_PROJECT_RECONCILE/u, "Project reconciliation stays on");
  assert.match(workflow, /run: node automation\/completion\.mjs --repository ChipIn-one\/chipin-frontend$/mu);
  assert.doesNotMatch(workflow, /frontend-production-completion\.mjs/u);
  assert.match(workflow, /cancel-in-progress: false/u);

  // the .github workflow never turns the writer on
  const integration = await readFile(new URL("../.github/workflows/integration-completion.yml", import.meta.url), "utf8");
  assert.doesNotMatch(integration, /CHIPIN_COMPLETION_AWAITING_RELEASE/u);
  // .github itself must never be skipped silently: its record is automatic and a manual one stays a red run
  assert.doesNotMatch(integration, /CHIPIN_COMPLETION_SKIP_MANUAL/u);
  // the composite action turns the writer on only behind its explicit `awaiting-release: "true"` input (.github#212)
  const action = await readFile(new URL("./completion-action/action.yml", import.meta.url), "utf8");
  assert.doesNotMatch(action, /^\s+CHIPIN_COMPLETION_AWAITING_RELEASE:/mu, "never in the step env");
  assert.match(action, /^ {2}awaiting-release:\n(?: {4}.*\n)*? {4}default: "false"$/mu);
});

test("composite action: awaiting-release defaults to false and only true/false are accepted", async () => {
  const action = await readFile(new URL("./completion-action/action.yml", import.meta.url), "utf8");
  assert.match(action, /COMPLETION_AWAITING_RELEASE: \$\{\{ inputs\.awaiting-release \}\}/u);
  assert.match(action, /^ {10}false\) ;;$/mu);
  assert.match(action, / {12}export CHIPIN_COMPLETION_PROJECT_RECONCILE=1\n {12}export CHIPIN_COMPLETION_AWAITING_RELEASE=1\n/u);
  assert.match(action, /awaiting-release must be/u);
  assert.match(action, /exit 1/u);
});

test("deployment-receipt caller template: deployment_status (success, Production), push to the integration branch, dispatch", async () => {
  const template = await readFile(new URL("../templates/caller-completion-deployment-receipt.yml", import.meta.url), "utf8");
  assert.match(template, /^on:\n  deployment_status:\n  push:\n    branches: \[master\][^\n]*\n  workflow_dispatch:\n/mu);
  assert.match(template, /github\.event\.deployment_status\.state == 'success'/u);
  assert.match(template, /github\.event\.deployment\.environment == 'Production'/u);
  assert.match(template, /github\.event_name != 'deployment_status' \|\|/u);
  assert.match(template, /^permissions:\n {2}contents: read {16}# GITHUB_TOKEN is not used/mu);
  assert.doesNotMatch(template, /^ {2}(issues|deployments|pull-requests): /mu, "the PAT carries the access");
  assert.match(template, /ChipIn-one\/\.github\/automation\/completion-action@<sha>/u);
  assert.match(template, /awaiting-release: "true"/u);
  assert.match(template, /cancel-in-progress: false/u);
  assert.doesNotMatch(template, /\bjob\./u, "job context is never used in the template");
});

// ---- deployment-receipt (.github#212) ----

const RECEIPT_SHA = "cccccccccccccccccccccccccccccccccccccccc";
const OLD_RECEIPT_SHA = "dddddddddddddddddddddddddddddddddddddddd";
const MERGE_2 = "3333333333333333333333333333333333333333";

// the live frontend record with the engine on (.github#217)
const ENGINE_ON = /^      completion: automatic {5}# automatic \| manual; engine on since #217 \(Promote evidence checked in cutover step 7\)$/mu;
async function receiptRegistry() {
  const live = await readFile(new URL("../workflow-registry.yaml", import.meta.url), "utf8");
  assert.match(live, ENGINE_ON, "the live frontend record has the engine on");
  return loadRegistry({ text: live });
}
// the frontend record switched back off (the .github#216 state, rollback of .github#217): org-sweep needs automatic,
// so the runner returns to its default
async function engineOffRegistry() {
  const live = await readFile(new URL("../workflow-registry.yaml", import.meta.url), "utf8");
  return loadRegistry({ text: live.replace(ENGINE_ON, "      completion: manual").replace(/^    completionRunner: org-sweep[^\n]*\n/mu, "") });
}

function deployment({ id = 900, sha = RECEIPT_SHA, environment = "Production", creator = "vercel[bot]", createdAt = "2026-10-08T10:00:00Z" } = {}) {
  return { id, sha, ref: sha, environment, creator: { login: creator }, created_at: createdAt };
}
function deploymentStatus({ id = 9000, state = "success", creator = "vercel[bot]", createdAt = "2026-10-08T10:01:00Z", environment = "Production" } = {}) {
  return { id, state, creator: { login: creator }, created_at: createdAt, environment };
}

function receiptPrNode(number, mergeCommit = MERGE, overrides = {}) {
  return {
    number, url: "https://github.com/ChipIn-one/chipin-frontend/pull/" + number, state: "MERGED",
    mergedAt: "2026-10-01T10:00:00Z", baseRefName: "master", headRefName: "feat/x-" + number,
    headRefOid: "2222222222222222222222222222222222222222",
    repository: { nameWithOwner: FE }, headRepository: { nameWithOwner: FE }, mergeCommit: { oid: mergeCommit },
    ...overrides,
  };
}
function receiptNode({ number = 1, pullRequests = [receiptPrNode(101)], updatedAt = "2026-10-07T10:00:00Z" } = {}) {
  return candidateNode({
    number, updatedAt,
    url: "https://github.com/ChipIn-one/chipin-frontend/issues/" + number,
    closedByPullRequestsReferences: { totalCount: pullRequests.length, nodes: pullRequests },
  });
}

/**
 * Fake frontend with Deployments on top of projectClient. `ancestry` lists "base...head" pairs where base is an
 * ancestor of head (compare answers `ahead`); everything else is `diverged`. `deploymentStatuses` maps deployment id ->
 * statuses list (or an Error to throw); `deploymentPages` overrides the list answers per page.
 */
function receiptClient({
  nodes = [receiptNode()],
  deployments = [deployment()],
  deploymentStatuses = { 900: [deploymentStatus()] },
  ancestry = [MERGE + "..." + HEAD, RECEIPT_SHA + "..." + HEAD, MERGE + "..." + RECEIPT_SHA],
  deploymentsError = null,
  deploymentPages = null,
  compareErrors = {},
  ...projectOptions
} = {}) {
  const client = projectClient({ nodes, ...projectOptions });
  const base = client.request;
  client.request = async (path, options = {}) => {
    const deploymentsMatch = /\/repos\/ChipIn-one\/chipin-frontend\/deployments\?environment=([^&]+)&per_page=(\d+)&page=(\d+)$/u.exec(path);
    if (deploymentsMatch) {
      client.log.push("GET " + path);
      assert.equal(decodeURIComponent(deploymentsMatch[1]), "Production");
      if (deploymentsError) throw new Error(deploymentsError);
      const [perPage, page] = [Number(deploymentsMatch[2]), Number(deploymentsMatch[3])];
      if (deploymentPages) return deploymentPages[page - 1] ?? [];
      return deployments.slice((page - 1) * perPage, page * perPage);
    }
    const statusMatch = /\/deployments\/(\d+)\/statuses\?per_page=100$/u.exec(path);
    if (statusMatch) {
      client.log.push("GET " + path);
      const answer = deploymentStatuses[statusMatch[1]];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error("GET " + path + " -> 404: Not Found");
      return answer;
    }
    const compareMatch = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/u.exec(path);
    if (compareMatch) {
      client.log.push("GET " + path);
      const key = compareMatch[1] + "..." + compareMatch[2];
      if (compareErrors[key]) throw new Error(compareErrors[key]);
      return ancestry.includes(key)
        ? { status: "ahead", merge_base_commit: { sha: compareMatch[1] } }
        : { status: "diverged", merge_base_commit: { sha: "ffffffffffffffffffffffffffffffffffffffff" } };
    }
    return base(path, options);
  };
  return client;
}

const receiptRun = async (client, options = {}) => runCompletion(client, {
  repository: FE, registry: await receiptRegistry(), reconcileProjectStatus: false, ...options,
});

test("deployment-receipt: the cutover registry record validates and runs the new strategy on master", async () => {
  const registry = await receiptRegistry();
  const profile = registry.repositories.find((candidate) => candidate.repository === FE);
  assert.equal(profile.completion, "deployment-receipt");
  assert.equal(profile.capabilities.completion, "automatic");
  assert.deepEqual(profile.productionEvidence, { environment: "Production", creator: "vercel[bot]" });
  // .github#217: no FE caller, the org sweep is the only runner
  assert.equal(profile.completionRunner, "org-sweep");
  assert.deepEqual(profile.branches, { default: "master", integration: "master", promotion: null });
  // the engine-off record (.github#216, rollback of #217) keeps strategy and evidence
  const off = (await engineOffRegistry()).repositories.find((candidate) => candidate.repository === FE);
  assert.equal(off.completion, "deployment-receipt");
  assert.deepEqual(off.productionEvidence, profile.productionEvidence);
  assert.equal(off.capabilities.completion, "manual");
  assert.equal(off.completionRunner, "repository");
});

test("frontend engine off (.github#216 state): a direct run refuses, the org sweep skips as a green no-op before any read", async () => {
  const client = receiptClient();
  const offRegistry = await engineOffRegistry();
  await assert.rejects(() => runCompletion(client, { repository: FE, registry: offRegistry, awaitingRelease: true }),
    (error) => error instanceof CompletionBlocked && error.code === "COMPLETION_NOT_AUTOMATIC");
  assert.deepEqual(client.log, []);

  // the org workflow's options (CHIPIN_COMPLETION_SKIP_MANUAL=1, Awaiting release on, Project reconciliation on)
  const receipt = await runCompletion(client, { repository: FE, registry: offRegistry, awaitingRelease: true, skipWhenManual: true });
  assert.deepEqual(client.log, [], "no Issue, Project, Deployment or branch read");
  assert.deepEqual(mutations(client), []);
  assert.equal(receipt.skipped.code, "COMPLETION_NOT_AUTOMATIC");
  assert.equal(receipt.strategy, "deployment-receipt");
  assert.equal(receipt.branch, "master");
  assert.deepEqual(receipt.results, []);
  assert.deepEqual(receipt.awaitingRelease, { enabled: false, updated: [], skipped: 0, failed: [] });
  assert.match(formatCompletionSummary(receipt),
    /^# Completion ChipIn-one\/chipin-frontend \(deployment-receipt\)\n\n- Skipped: COMPLETION_NOT_AUTOMATIC .*capabilities\.completion "manual"/u);

  assert.equal(completionSkipNotice(receipt),
    "::notice title=Completion skipped::completion skipped for ChipIn-one/chipin-frontend: capabilities.completion is manual"
    + " in workflow-registry.yaml (no Issue closed, no Project #5 Status written)");

  // skipWhenManual never skips an automatic record: with the live record (engine on, .github#217) the same run sweeps
  const on = receiptClient();
  const swept = await runCompletion(on, { repository: FE, registry: await receiptRegistry(), reconcileProjectStatus: false, skipWhenManual: true });
  assert.equal(swept.skipped, undefined);
  assert.equal(completionSkipNotice(swept), null, "no notice for a run that swept");
  assert.equal(swept.results[0].decision.code, "closed-completed");
  // nor does it turn another refusal into a skip
  const forged = { ...loadRegistry(), repositories: loadRegistry().repositories.map((profile) => (profile.repository === ORG
    ? { ...profile, completion: "manual" } : profile)) };
  await assert.rejects(() => runCompletion(fakeClient(), { repository: ORG, registry: forged, reconcileProjectStatus: false, skipWhenManual: true }),
    (error) => error.code === "STRATEGY_NOT_IMPLEMENTED");
});

test("deployment-receipt: a merge commit contained in a valid production receipt closes the Issue with explicit evidence", async () => {
  const client = receiptClient();
  const receipt = await receiptRun(client);
  assert.equal(receipt.strategy, "deployment-receipt");
  assert.equal(receipt.branch, "master");
  const [result] = receipt.results;
  assert.equal(result.decision.action, "closed");
  assert.equal(result.decision.code, "closed-completed");
  assert.match(result.decision.detail,
    /PR #101 \(1111111\) is in production receipt deployment 900 \(Production, vercel\[bot\], sha ccccccc, status 9000 success at 2026-10-08T10:01:00Z\)\. Closed as completed\./u);
  assert.deepEqual(result.decision.evidence, {
    pullRequests: [{
      number: 101, mergeCommitSha: MERGE,
      receipt: {
        deploymentId: 900, sha: RECEIPT_SHA, environment: "Production", creator: "vercel[bot]", createdAt: "2026-10-08T10:00:00Z",
        statusId: 9000, statusState: "success", statusCreatedAt: "2026-10-08T10:01:00Z",
      },
    }],
  });
  assert.equal(mutations(client).filter((entry) => entry.startsWith("PATCH ")).length, 1);
  assert.equal(receipt.productionEvidence.environment, "Production");
  assert.equal(receipt.productionEvidence.deploymentsRead, 1);
  assert.equal(receipt.productionEvidence.truncated, false);
  assert.deepEqual(receipt.productionEvidence.checked.map((row) => [row.deploymentId, row.valid, row.reason]), [[900, true, null]]);
  assert.match(formatCompletionSummary(receipt), /- Production evidence: Production by vercel\[bot\]; 1 deployment\(s\) read, 1 checked, valid receipts: 900 \(ccccccc, status 9000\)/u);
  // compare direction: receipt on the branch is RECEIPT...HEAD, merge in the receipt is MERGE...RECEIPT
  assert.ok(client.log.includes("GET /repos/ChipIn-one/chipin-frontend/compare/" + RECEIPT_SHA + "..." + HEAD));
  assert.ok(client.log.includes("GET /repos/ChipIn-one/chipin-frontend/compare/" + MERGE + "..." + RECEIPT_SHA));
});

test("deployment-receipt: the merge commit equal to the receipt SHA needs no compare", async () => {
  const client = receiptClient({ deployments: [deployment({ sha: MERGE })], ancestry: [MERGE + "..." + HEAD] });
  const [result] = (await receiptRun(client)).results;
  assert.equal(result.decision.code, "closed-completed");
  assert.ok(!client.log.some((entry) => entry.includes("/compare/" + MERGE + "..." + MERGE)));
});

test("deployment-receipt: merged but not in any valid receipt is awaiting-production, never a close", async () => {
  for (const [label, options] of [
    ["no deployments", { deployments: [] }],
    ["receipt older than the merge", { ancestry: [MERGE + "..." + HEAD, RECEIPT_SHA + "..." + HEAD] }],
    ["only invalid receipts", { deployments: [deployment({ creator: "someone" }), deployment({ id: 901, environment: "Preview" })] }],
  ]) {
    const client = receiptClient(options);
    const receipt = await receiptRun(client);
    const [result] = receipt.results;
    assert.equal(result.decision.action, "leave-open", label);
    assert.equal(result.decision.code, "awaiting-production", label);
    assert.match(result.decision.detail, /Merged into master but not yet in a valid production receipt: PR #101 \(1111111\)\./u);
    assert.deepEqual(result.decision.evidence, { pullRequests: [{ number: 101, mergeCommitSha: MERGE, receipt: null }] });
    assert.deepEqual(mutations(client), [], label);
  }
});

test("deployment-receipt: every linked PR needs a receipt; receipts are checked newest first and cached", async () => {
  const twoPrs = receiptNode({ pullRequests: [receiptPrNode(101, MERGE), receiptPrNode(102, MERGE_2)] });
  // MERGE is in the newest receipt, MERGE_2 nowhere -> awaiting
  const partial = receiptClient({
    nodes: [twoPrs],
    ancestry: [MERGE + "..." + HEAD, MERGE_2 + "..." + HEAD, RECEIPT_SHA + "..." + HEAD, MERGE + "..." + RECEIPT_SHA],
  });
  const [awaiting] = (await receiptRun(partial)).results;
  assert.equal(awaiting.decision.code, "awaiting-production");
  assert.match(awaiting.decision.detail, /PR #102 \(3333333\)\.$/u);
  assert.equal(awaiting.decision.evidence.pullRequests[0].receipt.deploymentId, 900);
  assert.equal(awaiting.decision.evidence.pullRequests[1].receipt, null);

  // MERGE in the newest receipt, MERGE_2 only in an older one (both on master) -> close; three Issues share the cache
  const older = deployment({ id: 800, sha: OLD_RECEIPT_SHA, createdAt: "2026-10-05T10:00:00Z" });
  const client = receiptClient({
    nodes: [twoPrs, receiptNode({ number: 2, pullRequests: [receiptPrNode(103, MERGE)] }), receiptNode({ number: 3, pullRequests: [receiptPrNode(104, MERGE)] })],
    deployments: [older, deployment()], // listed out of order: the engine sorts newest first
    deploymentStatuses: { 900: [deploymentStatus()], 800: [deploymentStatus({ id: 8000, createdAt: "2026-10-05T10:01:00Z" })] },
    ancestry: [MERGE + "..." + HEAD, MERGE_2 + "..." + HEAD, RECEIPT_SHA + "..." + HEAD, OLD_RECEIPT_SHA + "..." + HEAD,
      MERGE + "..." + RECEIPT_SHA, MERGE_2 + "..." + OLD_RECEIPT_SHA],
  });
  const receipt = await receiptRun(client);
  assert.deepEqual(receipt.results.map((result) => result.decision.code), ["closed-completed", "closed-completed", "closed-completed"]);
  assert.deepEqual(receipt.results[0].decision.evidence.pullRequests.map((entry) => entry.receipt.deploymentId), [900, 800]);
  for (const id of [900, 800]) {
    assert.equal(client.log.filter((entry) => entry.includes("/deployments/" + id + "/statuses")).length, 1, "statuses of " + id + " read once");
  }
  assert.equal(client.log.filter((entry) => entry.endsWith("/compare/" + MERGE + "..." + RECEIPT_SHA)).length, 1, "compare cached");
  assert.deepEqual(receipt.productionEvidence.checked.map((row) => row.deploymentId), [900, 800]);

  // when the newest receipt contains everything, older receipts are never read
  const newestOnly = receiptClient({
    deployments: [deployment(), older],
    deploymentStatuses: { 900: [deploymentStatus()], 800: [deploymentStatus({ id: 8000 })] },
  });
  await receiptRun(newestOnly);
  assert.ok(!newestOnly.log.some((entry) => entry.includes("/deployments/800/statuses")));
});

test("deployment-receipt: receipt validity (environment, creator, newest status success, status creator, SHA on the branch)", async () => {
  const head = HEAD;
  const onBranch = async (base, target) => base === RECEIPT_SHA && target === head;
  const check = (deploymentRecord, statuses, containsCommit = onBranch) => validateProductionReceipt(deploymentRecord, {
    environment: "Production", creator: "vercel[bot]", integrationHeadSha: head,
    readStatuses: async () => { if (statuses instanceof Error) throw statuses; return statuses; },
    containsCommit,
  });
  const cases = [
    [deployment({ environment: "Preview" }), [deploymentStatus()], "environment-mismatch"],
    [deployment({ environment: "production" }), [deploymentStatus()], "environment-mismatch"],
    [deployment({ creator: "github-actions[bot]" }), [deploymentStatus()], "creator-mismatch"],
    [deployment({ sha: "abc" }), [deploymentStatus()], "sha-unreadable"],
    [{ ...deployment(), id: "900" }, [deploymentStatus()], "deployment-id-unreadable"],
    [deployment(), [], "no-status"],
    [deployment(), [deploymentStatus({ id: 1, state: "success", createdAt: "2026-10-08T10:00:00Z" }),
      deploymentStatus({ id: 2, state: "inactive", createdAt: "2026-10-09T10:00:00Z" })], "newest-status-inactive"],
    [deployment(), [deploymentStatus({ state: "in_progress" })], "newest-status-in_progress"],
    [deployment(), [deploymentStatus({ state: "failure" })], "newest-status-failure"],
    [deployment(), [deploymentStatus({ creator: "syllik" })], "status-creator-mismatch"],
    [deployment(), [deploymentStatus({ environment: "Preview" })], "status-environment-mismatch"],
    [deployment(), new Error("GET /repos/x/deployments/900/statuses -> 404: Not Found"), "deployment-not-found"],
    [deployment({ sha: OLD_RECEIPT_SHA }), [deploymentStatus()], "not-on-integration-branch"],
  ];
  for (const [record, statuses, reason] of cases) {
    const verdict = await check(record, statuses);
    assert.equal(verdict.valid, false, reason);
    assert.equal(verdict.reason, reason);
  }
  const notFound = await check(deployment(), [deploymentStatus()], async () => { throw new Error("GET /compare -> 404: No commit found"); });
  assert.equal(notFound.reason, "sha-not-found");
  // the newest status wins even when an older success is listed first; equal timestamps fall back to the id
  const newest = await check(deployment(), [
    deploymentStatus({ id: 5, state: "failure", createdAt: "2026-10-08T09:00:00Z" }),
    deploymentStatus({ id: 7, state: "success", createdAt: "2026-10-08T10:00:00Z" }),
    deploymentStatus({ id: 6, state: "pending", createdAt: "2026-10-08T10:00:00Z" }),
  ]);
  assert.equal(newest.valid, true);
  assert.equal(newest.receipt.statusId, 7);
  // a full statuses page cannot prove the newest status: invalid, never read further or assumed
  const fullPage = Array.from({ length: RECEIPT_STATUS_PAGE_SIZE }, (_, index) => deploymentStatus({ id: index + 1 }));
  assert.equal((await check(deployment(), fullPage)).reason, "statuses-truncated");
  assert.equal((await check(deployment(), fullPage.slice(1))).valid, true, "one below the page size is complete");
  // other read errors are not a verdict: they propagate so the Issue fails closed
  await assert.rejects(() => check(deployment(), new Error("GET statuses -> 502: Bad Gateway")), /502/u);
  await assert.rejects(() => check(deployment(), [deploymentStatus()], async () => { throw new Error("compare -> 500"); }), /500/u);
  await assert.rejects(() => check(deployment(), { not: "a list" }), /not a list/u);
});

test("deployment-receipt: read errors fail closed (run blocked before any write, or the one Issue left open)", async () => {
  const listError = receiptClient({ deploymentsError: "GET deployments -> 500: boom" });
  await assert.rejects(() => receiptRun(listError),
    (error) => error instanceof CompletionBlocked && error.code === "PRODUCTION_EVIDENCE_UNREADABLE");
  assert.deepEqual(mutations(listError), []);
  assert.ok(!listError.log.some((entry) => entry.startsWith("query FrontendCompletionCandidates")), "nothing evaluated");

  const notList = receiptClient({ deploymentPages: [{ message: "weird" }] });
  await assert.rejects(() => receiptRun(notList), (error) => error.code === "PRODUCTION_EVIDENCE_UNREADABLE");

  const statusError = receiptClient({ deploymentStatuses: { 900: new Error("GET statuses -> 502: Bad Gateway") } });
  const receipt = await receiptRun(statusError);
  assert.equal(receipt.results[0].decision.code, "production-evidence-unreadable");
  assert.match(receipt.results[0].decision.detail, /502/u);
  assert.deepEqual(mutations(statusError), []);
  assert.match(receipt.productionEvidence.checked[0].reason, /^unreadable: .*502/u);

  const compareError = receiptClient({ compareErrors: { [MERGE + "..." + RECEIPT_SHA]: "compare -> 500: boom" } });
  const [compareResult] = (await receiptRun(compareError)).results;
  assert.equal(compareResult.decision.code, "production-evidence-unreadable");
  assert.deepEqual(mutations(compareError), []);

  // an unreadable error is not awaiting-production: the writer never runs for it
  const project = receiptClient({ deploymentStatuses: { 900: new Error("GET statuses -> 502") } });
  const withWriter = await runCompletion(project, { repository: FE, registry: await receiptRegistry(), awaitingRelease: true });
  assert.equal(withWriter.results[0].decision.code, "production-evidence-unreadable");
  assert.deepEqual(withWriter.awaitingRelease, { enabled: true, updated: [], skipped: 0, failed: [] });
  assert.equal(project.state.ITEM_1, "Todo");
});

test("deployment-receipt: Deployments are read with bounded pagination, newest first", async () => {
  const page = (ids) => ids.map((id) => deployment({ id, createdAt: new Date(Date.UTC(2026, 9, 1, 0, id)).toISOString() }));
  const client = { log: [], request: async (path) => {
    client.log.push(path);
    const pageNumber = Number(/page=(\d+)$/u.exec(path)[1]);
    return [page([1, 2]), page([3, 4]), page([5, 6])][pageNumber - 1];
  } };
  const full = await readProductionDeployments(client, FE, { environment: "Production", pageSize: 2, maxPages: 2 });
  assert.equal(full.read, 4);
  assert.equal(full.truncated, true, "the window is full, older records exist");
  assert.deepEqual(full.deployments.map((entry) => entry.id), [4, 3, 2, 1]);
  assert.equal(client.log.length, 2, "never more than maxPages requests");
  assert.match(client.log[0], /\/repos\/ChipIn-one\/chipin-frontend\/deployments\?environment=Production&per_page=2&page=1$/u);

  const short = await readProductionDeployments({ request: async (path) => (path.endsWith("page=1") ? page([1]) : assert.fail("no page 2")) },
    FE, { environment: "Production", pageSize: 2, maxPages: 3 });
  assert.deepEqual([short.read, short.truncated], [1, false]);
  assert.equal(RECEIPT_PAGE_SIZE * RECEIPT_MAX_PAGES, 100);
  await assert.rejects(() => readProductionDeployments(client, FE, {}), /environment is required/u);
});

test("deployment-receipt: the shared integration-merge gates run first and are unchanged", async () => {
  let receiptReads = 0;
  const findReceipt = async () => { receiptReads += 1; return null; };
  const receiptContext = (overrides = {}) => context({ repository: FE, findReceipt, ...overrides });
  const pr = (overrides = {}) => linkedPr({ repository: FE, headRepository: FE, ...overrides });
  const cases = [
    [issue({ state: "CLOSED", linkedPullRequests: [pr()] }), "already-closed"],
    [issue({ linkedPullRequests: [pr()], blockedBy: [{ repository: FE, number: 9, state: "open" }] }), "blocked-by-open-issue"],
    [issue({ linkedPullRequests: [pr()], subIssues: [{ repository: FE, number: 9, state: "open", stateReason: null }] }), "required-sub-issue-incomplete"],
    [issue({ linkedPullRequests: [pr()], linkedBranchCount: 1 }), "development-branch-pending"],
    [issue({ linkedPullRequests: [], linkedPullRequestTotalCount: 0 }), "missing-development"],
    [issue({ linkedPullRequests: [pr()], linkedPullRequestTotalCount: 2 }), "ambiguous-development"],
    [issue({ linkedPullRequests: [pr({ headRepository: "evil/fork" })] }), "ambiguous-development"],
    [issue({ linkedPullRequests: [pr({ baseRefName: "dev" })] }), "ambiguous-development"],
    [issue({ linkedPullRequests: [pr({ mergedAt: null, mergeCommitSha: null })] }), "implementation-not-merged"],
    [issue({ linkedPullRequests: [pr()], scopeHistory: { readable: true, closedAt: ["2026-10-01T10:00:02Z"], reopenedAt: ["2026-10-04T10:00:00Z"], renamedAt: [], bodyRevisions: [] } }),
      "scope-changed-after-implementation"],
  ];
  for (const [candidate, code] of cases) {
    const decision = await evaluateIssueForDeploymentReceiptCompletion(candidate, receiptContext());
    assert.equal(decision.code, code);
    assert.equal(decision.evidence, undefined, code);
  }
  const diverged = await evaluateIssueForDeploymentReceiptCompletion(issue({ linkedPullRequests: [pr()] }), receiptContext({ containsCommit: contains(false) }));
  assert.equal(diverged.code, "integration-history-diverged");
  assert.equal(receiptReads, 0, "no receipt is consulted before every shared gate passed");
  await assert.rejects(() => evaluateIssueForDeploymentReceiptCompletion(issue(), context({ repository: FE })), /findReceipt/u);
});

test("deployment-receipt: stale snapshot and Status are never inputs of the close", async () => {
  const stale = receiptClient({ issueUpdatedAt: "2026-10-07T10:00:01Z" });
  const [staleResult] = (await receiptRun(stale)).results;
  assert.equal(staleResult.decision.code, "stale-snapshot");
  assert.deepEqual(mutations(stale), []);

  // Backlog (or any Status) does not block the close; the open + Done repair stays the only Status write besides the writer
  const backlog = receiptClient({ deploymentStatuses: { 900: [deploymentStatus()] } });
  backlog.state.ITEM_1 = "Backlog";
  const receipt = await runCompletion(backlog, { repository: FE, registry: await receiptRegistry(), awaitingRelease: true });
  assert.equal(receipt.results[0].decision.code, "closed-completed");
  assert.equal(backlog.state.ITEM_1, "Backlog");
  assert.ok(!backlog.log.includes("mutation SetCompletionAwaitingRelease"));

  const closed = receiptClient({ issueState: "closed" });
  const [closedResult] = (await receiptRun(closed)).results;
  assert.equal(closedResult.decision.code, "already-closed");
  assert.deepEqual(mutations(closed), [], "never reopens, never patches a closed Issue");
});

test("deployment-receipt: awaiting-production feeds the Awaiting release writer (Todo / In Progress only)", async () => {
  for (const from of ["Todo", "In Progress"]) {
    const client = receiptClient({ deployments: [], statuses: { ITEM_1: from } });
    const receipt = await runCompletion(client, { repository: FE, registry: await receiptRegistry(), awaitingRelease: true });
    assert.equal(receipt.results[0].decision.code, "awaiting-production");
    assert.equal(client.state.ITEM_1, AWAITING_RELEASE_STATUS, from);
    assert.deepEqual(receipt.awaitingRelease, { enabled: true, updated: [1], skipped: 0, failed: [] });
    assert.match(receipt.results[0].decision.detail, new RegExp("Awaiting release: awaiting-release-set\\. Project Status " + from + " -> Awaiting release\\.", "u"));
    assert.deepEqual(mutations(client), ["mutation SetCompletionAwaitingRelease"]);
    assert.deepEqual(receipt.results[0].decision.evidence.pullRequests[0].receipt, null, "evidence survives the writer");
  }
  for (const status of ["Backlog", "Awaiting release"]) {
    const client = receiptClient({ deployments: [], statuses: { ITEM_1: status } });
    const receipt = await runCompletion(client, { repository: FE, registry: await receiptRegistry(), awaitingRelease: true });
    assert.deepEqual(mutations(client), [], status);
    assert.equal(client.state.ITEM_1, status);
    assert.equal(receipt.awaitingRelease.updated.length, 0, status);
  }
  // an open Issue still showing derived Done: the existing repair (Done -> In Progress) runs first, then the writer
  const done = receiptClient({ deployments: [], statuses: { ITEM_1: "Done" } });
  await runCompletion(done, { repository: FE, registry: await receiptRegistry(), awaitingRelease: true });
  assert.deepEqual(mutations(done), ["mutation SetFrontendCompletionStatus", "mutation SetCompletionAwaitingRelease"]);
  assert.equal(done.state.ITEM_1, AWAITING_RELEASE_STATUS);
  // writer off by default; a repository-local run cannot turn it on
  const off = receiptClient({ deployments: [], statuses: { ITEM_1: "Todo" } });
  const offReceipt = await runCompletion(off, { repository: FE, registry: await receiptRegistry() });
  assert.equal(offReceipt.awaitingRelease.enabled, false);
  assert.equal(off.state.ITEM_1, "Todo");
  await assert.rejects(() => receiptRun(receiptClient({ deployments: [] }), { awaitingRelease: true }),
    (error) => error.code === "AWAITING_RELEASE_NEEDS_PROJECT");
});

test("deployment-receipt: the Awaiting release verifier re-asserts the master layout", async () => {
  const verify = deploymentReceiptAwaitingVerifier("master");
  const pr = (overrides = {}) => linkedPr({ repository: FE, headRepository: FE, ...overrides });
  assert.deepEqual(await verify(issue({ linkedPullRequests: [pr()] }), { repository: FE }), { eligible: true });
  for (const [candidate, code] of [
    [issue({ state: "CLOSED", linkedPullRequests: [pr()] }), "already-closed"],
    [issue({ linkedPullRequests: [pr()], linkedPullRequestTotalCount: 2 }), "ambiguous-development"],
    [issue({ linkedPullRequests: [], linkedPullRequestTotalCount: 0 }), "ambiguous-development"],
    [issue({ linkedPullRequests: [pr()], linkedBranchCount: 1 }), "development-branch-pending"],
    [issue({ linkedPullRequests: [pr({ headRepository: "evil/fork" })] }), "ambiguous-development"],
    [issue({ linkedPullRequests: [pr({ mergedAt: null })] }), "implementation-not-merged"],
    [issue({ linkedPullRequests: [pr({ baseRefName: "dev" })] }), "ambiguous-development"],
  ]) {
    const verdict = await verify(candidate, { repository: FE });
    assert.equal(verdict.eligible, false, code);
    assert.equal(verdict.code, code);
  }
});

test("deployment-receipt: a record without productionEvidence is refused before any read", async () => {
  const registry = await receiptRegistry();
  const forged = {
    ...registry,
    repositories: registry.repositories.map((profile) => {
      if (profile.repository !== FE) return profile;
      const { productionEvidence, ...rest } = profile;
      return rest;
    }),
  };
  const client = receiptClient();
  await assert.rejects(() => runCompletion(client, { repository: FE, registry: forged, reconcileProjectStatus: false }),
    (error) => error instanceof CompletionBlocked && error.code === "PRODUCTION_EVIDENCE_UNDECLARED");
  assert.deepEqual(client.log, []);
  assert.equal(createReceiptResolver.length, 1);
  assert.throws(() => createReceiptResolver({ deployments: [], readStatuses: null, containsCommit: null }), /callbacks are required/u);
});
