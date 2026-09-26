import assert from "node:assert/strict";
import test from "node:test";
import {
  assertApplyActivation,
  buildIssuePlan,
  canonicalWriteEligible,
  cleanupEligible,
  projectAudit,
  run,
  verifyOrgSchema,
  verifyProjectSnapshot,
} from "./metadata-migration.mjs";

const config = {
  project: { number: 5, statusField: "Status", statusValues: ["Backlog", "Todo", "In Progress", "DEV", "PROD", "Done"] },
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
