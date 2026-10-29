import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApplyActivation,
  buildIssuePlan,
  canonicalWriteEligible,
  cleanupEligible,
  projectAudit,
  readProjectSnapshot,
  run,
  verifyOrgSchema,
  verifyProjectSnapshot,
} from "./metadata-migration.mjs";
import { GitHubClient, isPhantomProjectItemsPage, readIssueProjectItems } from "./github-metadata.mjs";

const config = {
  project: { number: 5, statusField: "Status", statusValues: ["Backlog", "Todo", "In Progress"] },
  issueFields: {
    Priority: { id: 1, dataType: "single_select", options: ["P0", "P1"] },
    Severity: { id: 2, dataType: "single_select", options: ["Critical", "Major", "Minor"] },
    "Release scope": { id: 3, dataType: "single_select", options: ["PRE-PROD", "POST-PROD"] },
  },
  issueTypes: { Task: 10, Bug: 11, Feature: 12 },
};
const mapping = { priority: "P1", severity: null, releaseScope: "POST-PROD", issueType: "Feature" };
const projectItem = { repository: "ChipIn-one/chipin-backend", number: 101, status: "Todo" };

function snapshot({ priority = "P1", severity = null, scope = "POST-PROD", type = "Feature", labels = [], milestone = null, relationsReadable = true } = {}) {
  return {
    issue: { type: type ? { name: type } : null, labels: labels.map((name) => ({ name })), milestone },
    issueFieldValues: [
      { issue_field_id: 1, single_select_option: { name: priority } },
      ...(severity ? [{ issue_field_id: 2, single_select_option: { name: severity } }] : []),
      { issue_field_id: 3, single_select_option: { name: scope } },
    ],
    blockedBy: [], blocking: [], parent: null, subIssues: [], relationsReadable,
  };
}

test("apply requires two explicit activation signals", () => {
  assert.throws(() => assertApplyActivation({ mode: "apply", activate: "issue-117", env: {} }), /disabled/);
  assert.throws(() => assertApplyActivation({ mode: "apply", activate: null, env: { CHIPIN_METADATA_APPLY: "1" } }), /disabled/);
  assert.doesNotThrow(() => assertApplyActivation({ mode: "apply", activate: "issue-117", env: { CHIPIN_METADATA_APPLY: "1" } }));
});

test("organization field and issue type IDs are authoritative", () => {
  const fields = [
    { id: 1, name: "Priority", data_type: "single_select", options: [{ name: "P0" }, { name: "P1" }] },
    { id: 2, name: "Severity", data_type: "single_select", options: [{ name: "Critical" }, { name: "Major" }, { name: "Minor" }] },
    { id: 3, name: "Release scope", data_type: "single_select", options: [{ name: "PRE-PROD" }, { name: "POST-PROD" }] },
  ];
  const types = [{ id: 10, name: "Task" }, { id: 11, name: "Bug" }, { id: 12, name: "Feature" }];
  assert.deepEqual(verifyOrgSchema(config, fields, types), []);
  fields[0].id = 999;
  assert.match(verifyOrgSchema(config, fields, types).join("\n"), /Priority id=1/);
});

test("Project audit reports current count without making growth a blocker", () => {
  assert.deepEqual(projectAudit(config, { totalCount: 99 }), { number: 5, totalCount: 99 });
  assert.deepEqual(projectAudit(config, null), { number: 5, totalCount: null });
});

test("Project growth is allowed; field linkage remains authoritative", () => {
  const fields = [
    ...Object.entries(config.issueFields).map(([name, field]) => ({
      name, isIssueField: true, issueField: { fullDatabaseId: String(field.id), name }, options: [],
    })),
    { name: "Status", isIssueField: false, options: config.project.statusValues.map((name) => ({ name })) },
  ];
  assert.deepEqual(verifyProjectSnapshot(config, { totalCount: 99, fields }), []);
  assert.deepEqual(verifyProjectSnapshot(config, { totalCount: 107, fields }), []);
  fields[0] = { ...fields[0], isIssueField: false, issueField: null };
  assert.match(verifyProjectSnapshot(config, { totalCount: 107, fields }).join("\n"), /not linked/);
});

test("Project reader paginates fields and items independently", async () => {
  let calls = 0;
  const fieldPages = {
    root: {
      totalCount: 2,
      nodes: [{ name: "Priority" }],
      pageInfo: { hasNextPage: true, endCursor: "F1" },
    },
    F1: {
      totalCount: 2,
      nodes: [{ name: "Status" }],
      pageInfo: { hasNextPage: false, endCursor: "F2" },
    },
    F2: {
      totalCount: 2,
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  const item = (number, status) => ({
    id: `I${number}`,
    content: { __typename: "Issue", number, repository: { nameWithOwner: "ChipIn-one/chipin-backend" } },
    fieldValueByName: { name: status },
  });
  const itemPages = {
    root: {
      totalCount: 3,
      nodes: [item(1, "Todo")],
      pageInfo: { hasNextPage: true, endCursor: "I1" },
    },
    I1: {
      totalCount: 3,
      nodes: [item(2, "In Progress")],
      pageInfo: { hasNextPage: true, endCursor: "I2" },
    },
    I2: {
      totalCount: 3,
      nodes: [item(3, "In Progress")],
      pageInfo: { hasNextPage: false, endCursor: "I3" },
    },
  };
  const client = {
    async graphql(_query, variables) {
      calls += 1;
      return {
        organization: {
          projectV2: {
            fields: fieldPages[variables.fieldsAfter ?? "root"],
            items: itemPages[variables.itemsAfter ?? "root"],
          },
        },
      };
    },
  };

  const snapshot = await readProjectSnapshot(client, { organization: "ChipIn-one", project: { number: 5 } });
  assert.equal(calls, 3);
  assert.deepEqual(snapshot.fields.map((field) => field.name), ["Priority", "Status"]);
  assert.deepEqual(snapshot.items.map((entry) => entry.number), [1, 2, 3]);
  assert.equal(snapshot.totalCount, 3);
});

test("idempotent canonical state produces no writes", () => {
  const plan = buildIssuePlan({ config, repository: "ChipIn-one/chipin-backend", number: 101, mapping, snapshot: snapshot(), projectItem });
  assert.deepEqual(plan.operations, []);
  assert.deepEqual(plan.blockers, []);
  assert.equal(cleanupEligible({ plan }), true);
});

test("cleanup is separate and preserves orthogonal question label", () => {
  const plan = buildIssuePlan({
    config, repository: "ChipIn-one/chipin-backend", number: 101, mapping,
    snapshot: snapshot({ labels: ["P2", "type: enhancement", "question"], milestone: { title: "PRE-PROD" } }),
    projectItem, preserveLabels: ["question"],
  });
  assert.deepEqual(plan.cleanup.map((item) => item.kind), ["removeLegacyLabel", "removeLegacyLabel", "clearLegacyMilestone"]);
  assert.equal(plan.cleanup.some((item) => item.label === "question"), false);
});

test("unreadable native relationships or Status block canonical writes and cleanup", () => {
  const missingRelations = buildIssuePlan({
    config, repository: "ChipIn-one/chipin-backend", number: 101, mapping,
    snapshot: snapshot({ relationsReadable: false }), projectItem,
  });
  assert.equal(canonicalWriteEligible({ plan: missingRelations }), false);
  assert.equal(cleanupEligible({ plan: missingRelations }), false);
  const missingStatus = buildIssuePlan({
    config, repository: "ChipIn-one/chipin-backend", number: 101, mapping,
    snapshot: snapshot(), projectItem: { ...projectItem, status: null },
  });
  assert.equal(canonicalWriteEligible({ plan: missingStatus }), false);
  assert.equal(cleanupEligible({ plan: missingStatus }), false);
});

test("canonical mismatch must be read back before cleanup", () => {
  const plan = buildIssuePlan({
    config, repository: "ChipIn-one/chipin-backend", number: 101, mapping,
    snapshot: snapshot({ priority: "P0" }), projectItem,
  });
  assert.equal(cleanupEligible({ plan }), false);
  assert.equal(plan.operations[0].field, "Priority");
});


function lifecycleConfig() {
  return {
    ...config,
    organization: "ChipIn-one",
    repositories: {
      "ChipIn-one/chipin-backend": {
        preserveLabels: ["question"],
        issues: { "101": mapping },
      },
    },
  };
}

function organizationClient() {
  const fields = [
    { id: 1, name: "Priority", data_type: "single_select", options: [{ name: "P0" }, { name: "P1" }] },
    { id: 2, name: "Severity", data_type: "single_select", options: [{ name: "Critical" }, { name: "Major" }, { name: "Minor" }] },
    { id: 3, name: "Release scope", data_type: "single_select", options: [{ name: "PRE-PROD" }, { name: "POST-PROD" }] },
  ];
  const types = [{ id: 10, name: "Task" }, { id: 11, name: "Bug" }, { id: 12, name: "Feature" }];
  return {
    async listAll(path) {
      assert.match(path, /issue-fields/);
      return fields;
    },
    async request(path) {
      assert.match(path, /issue-types/);
      return types;
    },
  };
}

function projectSnapshot({ includeIssue = true, status = "Todo" } = {}) {
  return {
    totalCount: 107,
    fields: [
      ...Object.entries(config.issueFields).map(([name, field]) => ({
        name,
        isIssueField: true,
        issueField: { fullDatabaseId: String(field.id), name },
        options: [],
      })),
      { name: "Status", isIssueField: false, options: config.project.statusValues.map((name) => ({ name })) },
    ],
    items: includeIssue ? [{ repository: "ChipIn-one/chipin-backend", number: 101, status }] : [],
  };
}

test("apply lifecycle re-reads canonical state and refreshes Project before cleanup", async () => {
  const events = [];
  let issueReads = 0;
  let projectReads = 0;
  const issueSnapshots = [
    snapshot({ priority: "P0", labels: ["P1", "type: enhancement"], milestone: { title: "PRE-PROD" } }),
    snapshot({ labels: ["P1", "type: enhancement"], milestone: { title: "PRE-PROD" } }),
    snapshot(),
  ];
  const result = await run(["apply", "--activate", "issue-117"], { CHIPIN_METADATA_APPLY: "1" }, {
    config: lifecycleConfig(),
    state: { schemaVersion: 1, issues: {} },
    client: organizationClient(),
    readProjectSnapshot: async () => {
      projectReads += 1;
      events.push(`project:${projectReads}`);
      return projectSnapshot();
    },
    readIssueSnapshot: async () => {
      issueReads += 1;
      events.push(`issue:${issueReads}`);
      return issueSnapshots[issueReads - 1];
    },
    writeCanonical: async (_client, _repository, _number, operations) => {
      events.push(`canonical:${operations.length}`);
    },
    writeCleanup: async (_client, _repository, _number, cleanup) => {
      events.push(`cleanup:${cleanup.length}`);
    },
    writeJson: async () => {},
  });

  assert.equal(result.issues[0].apply.status, "complete");
  assert.deepEqual(events, [
    "project:1",
    "issue:1",
    "canonical:1",
    "issue:2",
    "project:2",
    "cleanup:3",
    "issue:3",
  ]);
});

test("resume trusts the checkpoint only after a fresh clean read", async () => {
  let canonicalWrites = 0;
  let cleanupWrites = 0;
  const result = await run(["apply", "--activate", "issue-117"], { CHIPIN_METADATA_APPLY: "1" }, {
    config: lifecycleConfig(),
    state: { schemaVersion: 1, issues: { "ChipIn-one/chipin-backend#101": { status: "complete" } } },
    client: organizationClient(),
    readProjectSnapshot: async () => projectSnapshot(),
    readIssueSnapshot: async () => snapshot(),
    writeCanonical: async () => { canonicalWrites += 1; },
    writeCleanup: async () => { cleanupWrites += 1; },
    writeJson: async () => {},
  });

  assert.equal(result.issues[0].apply.status, "resumed-complete");
  assert.equal(canonicalWrites, 0);
  assert.equal(cleanupWrites, 0);
});

test("stale Project membership blocks cleanup after canonical read-back", async () => {
  const originalExitCode = process.exitCode;
  try {
    let projectReads = 0;
    let cleanupWrites = 0;
    const legacy = snapshot({ labels: ["P1"] });
    const result = await run(["apply", "--activate", "issue-117"], { CHIPIN_METADATA_APPLY: "1" }, {
      config: lifecycleConfig(),
      state: { schemaVersion: 1, issues: {} },
      client: organizationClient(),
      readProjectSnapshot: async () => {
        projectReads += 1;
        return projectReads === 1 ? projectSnapshot() : projectSnapshot({ includeIssue: false });
      },
      readIssueSnapshot: async () => legacy,
      writeCanonical: async () => {},
      writeCleanup: async () => { cleanupWrites += 1; },
      writeJson: async () => {},
    });

    assert.equal(result.issues[0].apply.status, "cleanup-blocked-after-project-refresh");
    assert.match(result.issues[0].blockers.join("\n"), /membership is unreadable or missing/);
    assert.equal(cleanupWrites, 0);
  } finally {
    process.exitCode = originalExitCode;
  }
});

test("partial cleanup failure never checkpoints completion", async () => {
  const state = { schemaVersion: 1, issues: {} };
  let issueReads = 0;
  await assert.rejects(
    run(["apply", "--activate", "issue-117"], { CHIPIN_METADATA_APPLY: "1" }, {
      config: lifecycleConfig(),
      state,
      client: organizationClient(),
      readProjectSnapshot: async () => projectSnapshot(),
      readIssueSnapshot: async () => {
        issueReads += 1;
        return snapshot({ labels: ["P1"] });
      },
      writeCanonical: async () => {},
      writeCleanup: async () => {
        throw new Error("simulated partial cleanup failure");
      },
      writeJson: async () => {
        throw new Error("checkpoint must not be written");
      },
    }),
    /simulated partial cleanup failure/,
  );
  assert.deepEqual(state.issues, {});
  assert.equal(issueReads, 2);
});

test("project items that grow during pagination are re-read; a short read still fails", async () => {
  const page = (numbers, totalCount, next = null) => ({
    totalCount,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
    nodes: numbers.map((number) => ({ id: "I" + number, content: { __typename: "Issue", number, repository: { nameWithOwner: "ChipIn-one/chipin-frontend" } }, fieldValueByName: null })),
  });
  const fields = { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  let pass = 0;
  const growing = {
    graphql: async (_query, variables) => {
      if (variables.itemsAfter === null) pass += 1;
      const items = pass === 1
        ? (variables.itemsAfter === null ? page([1, 2], 2, "c1") : page([3], 2))      // 3 read of 2: grew
        : (variables.itemsAfter === null ? page([1, 2], 3, "c1") : page([3], 3));     // consistent
      return { organization: { projectV2: { id: "P", fields, items } } };
    },
  };
  const snapshot = await readProjectSnapshot(growing, { organization: "ChipIn-one", project: { number: 5 } });
  assert.equal(pass, 2);
  assert.deepEqual(snapshot.items.map((item) => item.number), [1, 2, 3]);
  assert.equal(snapshot.totalCount, 3);

  let passes = 0;
  const alwaysGrowing = {
    graphql: async (_query, variables) => {
      if (variables.itemsAfter === null) passes += 1;
      const items = variables.itemsAfter === null ? page([1, 2], 2, "c1") : page([3], 2);
      return { organization: { projectV2: { id: "P", fields, items } } };
    },
  };
  await assert.rejects(readProjectSnapshot(alwaysGrowing, { organization: "ChipIn-one", project: { number: 5 } }), /grew during pagination: read 3 of 2/);
  assert.equal(passes, 3);

  let shortPasses = 0;
  const short = {
    graphql: async (_query, variables) => {
      if (variables.itemsAfter === null) shortPasses += 1;
      return { organization: { projectV2: { id: "P", fields, items: page([1], 2) } } };
    },
  };
  await assert.rejects(readProjectSnapshot(short, { organization: "ChipIn-one", project: { number: 5 } }), /incomplete: read 1 of 2/);
  assert.equal(shortPasses, 1);
});

// Shape observed live on Project #5 (issue #221): a page (first or cursor) answered with HTTP 200,
// no `errors`, and an empty connection reporting totalCount 0 while the Project holds 280 items.
const PHANTOM_ITEMS = { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

test("phantom empty cursor pages are re-read instead of ending the Project snapshot (#221)", async () => {
  const page = (numbers, totalCount, next = null) => ({
    totalCount,
    pageInfo: { hasNextPage: next !== null, endCursor: next },
    nodes: numbers.map((number) => ({ id: "I" + number, content: { __typename: "Issue", number, repository: { nameWithOwner: "ChipIn-one/chipin-frontend" } }, fieldValueByName: null })),
  });
  const fields = { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const project = (items) => ({ organization: { projectV2: { id: "P", fields, items } } });
  const realPages = { root: page([1, 2], 5, "c1"), c1: page([3, 4], 5, "c2"), c2: page([5], 5) };
  const waits = [];
  const options = { retryDelaysMs: [1, 2, 3], wait: async (ms) => { waits.push(ms); } };

  // Before the fix, page c2 phantom ended the read with "incomplete: read 4 of 5".
  const phantomOnce = { c2: 2 };
  const calls = [];
  const flaky = {
    graphql: async (_query, variables) => {
      const key = variables.itemsAfter ?? "root";
      calls.push(key);
      if (phantomOnce[key] > 0) { phantomOnce[key] -= 1; return project(PHANTOM_ITEMS); }
      return project(realPages[key]);
    },
  };
  const snapshot = await readProjectSnapshot(flaky, { organization: "ChipIn-one", project: { number: 5 } }, options);
  assert.deepEqual(snapshot.items.map((item) => item.number), [1, 2, 3, 4, 5]);
  assert.equal(snapshot.totalCount, 5);
  assert.deepEqual(calls, ["root", "c1", "c2", "c2", "c2"], "the same cursor is re-read, not the whole snapshot");
  assert.deepEqual(waits, [1, 2]);

  // A page that stays phantom after every retry fails closed with its own error.
  waits.length = 0;
  const stuck = {
    graphql: async (_query, variables) => project(variables.itemsAfter === "c2" ? PHANTOM_ITEMS : realPages[variables.itemsAfter ?? "root"]),
  };
  await assert.rejects(readProjectSnapshot(stuck, { organization: "ChipIn-one", project: { number: 5 } }, options),
    (error) => error.code === "PROJECT_ITEMS_PHANTOM" && /page stayed empty after 3 retries \(totalCount 0 after cursor c2\)/.test(error.message));
  assert.deepEqual(waits, [1, 2, 3]);

  // A phantom first page used to yield an "empty" snapshot; it is re-read like any other page.
  let firstReads = 0;
  const phantomFirst = {
    graphql: async (_query, variables) => {
      const key = variables.itemsAfter ?? "root";
      if (key === "root" && (firstReads += 1) === 1) return project(PHANTOM_ITEMS);
      return project(realPages[key]);
    },
  };
  const full = await readProjectSnapshot(phantomFirst, { organization: "ChipIn-one", project: { number: 5 } }, options);
  assert.equal(full.items.length, 5);
  assert.equal(firstReads, 2);
});

test("a first page that stays empty fails closed unless the caller allows an empty Project (#221)", async () => {
  const fields = { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  let reads = 0;
  const empty = { graphql: async () => { reads += 1; return { organization: { projectV2: { id: "P", fields, items: PHANTOM_ITEMS } } }; } };
  const options = { retryDelaysMs: [0, 0, 0], wait: async () => {} };
  await assert.rejects(readProjectSnapshot(empty, { organization: "ChipIn-one", project: { number: 5 } }, options),
    (error) => error.code === "PROJECT_ITEMS_PHANTOM" && /first page stayed empty \(totalCount 0\) after 3 retries; refusing to treat the Project as empty/.test(error.message));
  assert.equal(reads, 4);

  reads = 0;
  const none = await readProjectSnapshot(empty, { organization: "ChipIn-one", project: { number: 5 } }, { ...options, allowEmptyProject: true });
  assert.equal(none.items.length, 0);
  assert.equal(none.totalCount, 0);
  assert.equal(reads, 4, "an allowed empty Project is still re-read before it is believed");
});

test("phantom re-reads stop at the read's overall deadline (#221)", async () => {
  let clock = 0;
  const fields = { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  let reads = 0;
  const empty = { graphql: async () => { reads += 1; return { organization: { projectV2: { id: "P", fields, items: PHANTOM_ITEMS } } }; } };
  const options = { retryDelaysMs: [100, 250, 500, 1000], deadlineMs: 400, now: () => clock, wait: async (ms) => { clock += ms; } };
  await assert.rejects(readProjectSnapshot(empty, { organization: "ChipIn-one", project: { number: 5 } }, options),
    (error) => error.code === "PROJECT_READ_DEADLINE" && /exceeded its 400 ms budget/.test(error.message));
  assert.equal(reads, 3, "100 + 250 fit the budget, the 500 ms wait does not");
  assert.equal(clock, 350);
});

test("once items are done, the next fields pages do not re-read the ignored items connection (#221)", async () => {
  const item = { id: "I1", content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "ChipIn-one/chipin-frontend" } }, fieldValueByName: null };
  const fieldNode = (id) => ({ __typename: "ProjectV2Field", id, name: id, dataType: "TEXT", isIssueField: false, issueField: null });
  const calls = [];
  const client = {
    graphql: async (_query, variables) => {
      calls.push(variables.fieldsAfter ?? "root");
      return { organization: { projectV2: { id: "P",
        fields: variables.fieldsAfter
          ? { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: "f2" }, nodes: [fieldNode("F2")] }
          : { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: "f1" }, nodes: [fieldNode("F1")] },
        items: variables.itemsAfter ? PHANTOM_ITEMS : { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: "i1" }, nodes: [item] },
      } } };
    },
  };
  const snapshot = await readProjectSnapshot(client, { organization: "ChipIn-one", project: { number: 5 } }, { retryDelaysMs: [0, 0], wait: async () => {} });
  assert.deepEqual(calls, ["root", "f1"]);
  assert.deepEqual(snapshot.fields.map((field) => field.id), ["F1", "F2"]);
  assert.deepEqual(snapshot.items.map((entry) => entry.number), [1]);
});

test("phantom page predicate matches an empty zero-count final page", () => {
  assert.equal(isPhantomProjectItemsPage(PHANTOM_ITEMS), true);
  assert.equal(isPhantomProjectItemsPage({ ...PHANTOM_ITEMS, totalCount: 280 }), false);
  assert.equal(isPhantomProjectItemsPage({ ...PHANTOM_ITEMS, nodes: [{ id: "I1" }] }), false);
  assert.equal(isPhantomProjectItemsPage({ ...PHANTOM_ITEMS, pageInfo: { hasNextPage: true, endCursor: "c" } }), false);
  // endCursor is not part of the match: an empty final page reporting totalCount 0 is suspect either way.
  assert.equal(isPhantomProjectItemsPage({ ...PHANTOM_ITEMS, pageInfo: { hasNextPage: false, endCursor: "c" } }), true);
  assert.equal(isPhantomProjectItemsPage(undefined), false);
});

test("GraphQL errors next to partial data fail the read instead of returning a short page", async () => {
  const client = new GitHubClient("t", async () => new Response(JSON.stringify({
    data: { organization: { projectV2: { id: "P", items: { totalCount: 280, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
    errors: [{ type: "RESOURCE_LIMITS_EXCEEDED", message: "Resource limits for this query exceeded." }],
  }), { status: 200 }));
  await assert.rejects(client.graphql("query { x }", {}), /Resource limits/);
});

const ORG_OWNER = { __typename: "Organization", login: "ChipIn-one" };

test("issue-side Project items are read for one org Project and fail closed when incomplete", async () => {
  const client = {
    graphql: async (query, variables) => {
      assert.match(query, /MetadataIssueProjectItems/);
      assert.match(query, /owner \{ __typename \.\.\. on Organization \{ login \} \}/);
      assert.deepEqual(variables, { owner: "ChipIn-one", repo: "chipin-frontend", number: 466 });
      return { repository: { issue: { number: 466, projectItems: { totalCount: 2, nodes: [
        { id: "PVTI_5", project: { number: 5, owner: ORG_OWNER }, fieldValueByName: { name: "Todo" } },
        { id: "PVTI_9", project: { number: 9, owner: ORG_OWNER }, fieldValueByName: null },
      ] } } } };
    },
  };
  assert.deepEqual(await readIssueProjectItems(client, "ChipIn-one/chipin-frontend", 466, 5, "ChipIn-one"), [
    { id: "PVTI_5", repository: "ChipIn-one/chipin-frontend", number: 466, status: "Todo" },
  ]);
  const incomplete = { graphql: async () => ({ repository: { issue: { number: 466, projectItems: { totalCount: 3, nodes: [] } } } }) };
  await assert.rejects(readIssueProjectItems(incomplete, "ChipIn-one/chipin-frontend", 466, 5, "ChipIn-one"), /incomplete: read 0 of 3/);
  const wrong = { graphql: async () => ({ repository: { issue: null } }) };
  await assert.rejects(readIssueProjectItems(wrong, "ChipIn-one/chipin-frontend", 466, 5, "ChipIn-one"), /unreadable/);
  await assert.rejects(readIssueProjectItems(client, "ChipIn-one/chipin-frontend", 466, 5), /organization is required/);
});

test("issue-side Project items ignore a user-owned or other-org Project with the same number (.github#218)", async () => {
  const nodes = [
    { id: "PVTI_USER", project: { number: 5, owner: { __typename: "User", login: "ChipIn-one" } }, fieldValueByName: { name: "Done" } },
    { id: "PVTI_OTHER", project: { number: 5, owner: { __typename: "Organization", login: "other-org" } }, fieldValueByName: null },
    { id: "PVTI_ORG", project: { number: 5, owner: ORG_OWNER }, fieldValueByName: { name: "Backlog" } },
  ];
  const client = { graphql: async () => ({ repository: { issue: { number: 466, projectItems: { totalCount: nodes.length, nodes } } } }) };
  assert.deepEqual(await readIssueProjectItems(client, "ChipIn-one/chipin-frontend", 466, 5, "ChipIn-one"), [
    { id: "PVTI_ORG", repository: "ChipIn-one/chipin-frontend", number: 466, status: "Backlog" },
  ]);
  const onlyUser = { graphql: async () => ({ repository: { issue: { number: 466, projectItems: { totalCount: 1, nodes: [nodes[0]] } } } }) };
  assert.deepEqual(await readIssueProjectItems(onlyUser, "ChipIn-one/chipin-frontend", 466, 5, "ChipIn-one"), []);
  const unreadableOwner = { graphql: async () => ({ repository: { issue: { number: 466, projectItems: { totalCount: 1, nodes: [
    { id: "PVTI_X", project: { number: 5, owner: null }, fieldValueByName: null },
  ] } } } }) };
  await assert.rejects(readIssueProjectItems(unreadableOwner, "ChipIn-one/chipin-frontend", 466, 5, "ChipIn-one"), /owner is unreadable/);
});
