#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.github.com";
const GRAPHQL = `${API}/graphql`;
const API_VERSION = "2026-03-10";
const LEGACY_PRIORITY = /^P[0-3]$/;
const LEGACY_SEVERITY = /^severity\s*:/i;
const LEGACY_TYPE = /^type\s*:/i;

export function assertApplyActivation({ mode, activate, env = process.env }) {
  if (mode !== "apply") return;
  if (activate !== "issue-117" || env.CHIPIN_METADATA_APPLY !== "1") {
    throw new Error("Live metadata writes are disabled. Use --activate issue-117 and CHIPIN_METADATA_APPLY=1 after operator approval.");
  }
}

export function verifyOrgSchema(config, fields, types) {
  const blockers = [];
  for (const [name, expected] of Object.entries(config.issueFields)) {
    const matches = fields.filter((field) => Number(field.id) === expected.id);
    if (matches.length !== 1) {
      blockers.push(`Issue field ${name} id=${expected.id} is missing or ambiguous`);
      continue;
    }
    const field = matches[0];
    if (field.name !== name || field.data_type !== expected.dataType) {
      blockers.push(`Issue field id=${expected.id} has unexpected name/data type`);
      continue;
    }
    const options = new Set((field.options ?? []).map((option) => option.name));
    for (const option of expected.options) {
      if (!options.has(option)) blockers.push(`Issue field ${name} is missing option ${option}`);
    }
  }
  for (const [name, id] of Object.entries(config.issueTypes)) {
    const matches = types.filter((type) => Number(type.id) === id);
    if (matches.length !== 1 || matches[0].name !== name || matches[0].is_enabled === false) {
      blockers.push(`Issue Type ${name} id=${id} is missing, renamed, disabled, or ambiguous`);
    }
  }
  return blockers;
}

export function projectAudit(config, project) {
  return {
    number: config.project.number,
    totalCount: project?.totalCount ?? null,
  };
}

export function verifyProjectSnapshot(config, project) {
  const blockers = [];
  if (!project) return [`Project #${config.project.number} is unreadable`];
  for (const [name, expected] of Object.entries(config.issueFields)) {
    const matches = project.fields.filter((field) => field.name === name);
    if (matches.length !== 1) {
      blockers.push(`Project field ${name} is missing or ambiguous (${matches.length} matches)`);
      continue;
    }
    const field = matches[0];
    const linkedId = field.issueField?.fullDatabaseId == null ? null : Number(field.issueField.fullDatabaseId);
    if (!field.isIssueField || linkedId !== expected.id || field.issueField?.name !== name) {
      blockers.push(`Project field ${name} is not linked to org Issue Field id=${expected.id}`);
    }
  }
  const statusMatches = project.fields.filter((field) => field.name === config.project.statusField);
  if (statusMatches.length !== 1) {
    blockers.push(`Project Status is missing or ambiguous (${statusMatches.length} matches)`);
  } else {
    const status = statusMatches[0];
    if (status.isIssueField) blockers.push("Project Status must remain project-local");
    const options = new Set((status.options ?? []).map((option) => option.name));
    for (const value of config.project.statusValues) {
      if (!options.has(value)) blockers.push(`Project Status is missing option ${value}`);
    }
  }
  return blockers;
}

function fieldState(config, snapshot) {
  const byId = new Map((snapshot.issueFieldValues ?? []).map((value) => [
    Number(value.issue_field_id),
    value.single_select_option?.name ?? value.value ?? null,
  ]));
  return Object.fromEntries(Object.entries(config.issueFields).map(([name, field]) => [name, byId.get(field.id) ?? null]));
}

export function buildIssuePlan({ config, repository, number, mapping, snapshot, projectItem, preserveLabels = [] }) {
  const observedFields = fieldState(config, snapshot);
  const desiredFields = {
    Priority: mapping.priority,
    Severity: mapping.severity,
    "Release scope": mapping.releaseScope,
  };
  const operations = [];
  for (const [name, after] of Object.entries(desiredFields)) {
    const before = observedFields[name];
    const fieldId = config.issueFields[name].id;
    if (before === after) continue;
    operations.push(after === null
      ? { kind: "clearIssueField", field: name, fieldId, before }
      : { kind: "setIssueField", field: name, fieldId, before, after });
  }
  const currentType = snapshot.issue?.type?.name ?? null;
  if (currentType !== mapping.issueType) operations.push({ kind: "setIssueType", before: currentType, after: mapping.issueType });

  const blockers = [];
  if (!snapshot.relationsReadable) blockers.push("Native dependency/parent/sub-issue relationships are unreadable");
  if (!projectItem) blockers.push(`Project #${config.project.number} membership is unreadable or missing`);
  else if (!projectItem.status) blockers.push(`Project #${config.project.number} Status is unreadable`);

  const preserved = new Set(preserveLabels);
  const cleanup = [];
  for (const raw of snapshot.issue?.labels ?? []) {
    const label = typeof raw === "string" ? raw : raw.name;
    if (preserved.has(label)) continue;
    if (LEGACY_PRIORITY.test(label)) cleanup.push({ kind: "removeLegacyLabel", axis: "Priority", label });
    else if (LEGACY_SEVERITY.test(label)) cleanup.push({ kind: "removeLegacyLabel", axis: "Severity", label });
    else if (LEGACY_TYPE.test(label)) cleanup.push({ kind: "removeLegacyLabel", axis: "Issue Type", label });
  }
  if (snapshot.issue?.milestone?.title === "PRE-PROD") {
    cleanup.push({ kind: "clearLegacyMilestone", axis: "Release scope", milestone: "PRE-PROD" });
  }

  return {
    issue: `${repository}#${number}`,
    desired: { ...desiredFields, "Issue Type": mapping.issueType },
    observed: {
      issueFields: observedFields,
      issueType: currentType,
      projectMembership: Boolean(projectItem),
      status: projectItem?.status ?? null,
      blockedBy: snapshot.blockedBy ?? [],
      blocking: snapshot.blocking ?? [],
      parent: snapshot.parent ?? null,
      subIssues: snapshot.subIssues ?? [],
    },
    operations,
    cleanup,
    blockers,
  };
}

export function canonicalWriteEligible({ plan, globalBlockers = [] }) {
  return globalBlockers.length === 0 && plan.blockers.length === 0;
}

export function cleanupEligible({ plan, globalBlockers = [] }) {
  return canonicalWriteEligible({ plan, globalBlockers }) && plan.operations.length === 0;
}

export class GitHubClient {
  constructor(token, fetchImpl = fetch) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  async request(path, { method = "GET", body, allow404 = false } = {}) {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`);
    if (response.status === 204) return null;
    return response.json();
  }
  async listAll(path) {
    const separator = path.includes("?") ? "&" : "?";
    const values = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Expected array from ${path}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }
  async graphql(query, variables) {
    const response = await this.fetchImpl(GRAPHQL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GraphQL -> ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
    return payload.data;
  }
}

const PROJECT_QUERY = `
query MetadataProject($org: String!, $number: Int!, $after: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      fields(first: 100) {
        nodes {
          __typename
          ... on ProjectV2Field {
            id name dataType isIssueField
            issueField { __typename ... on IssueFieldSingleSelect { fullDatabaseId name } }
          }
          ... on ProjectV2SingleSelectField {
            id name dataType isIssueField options { id name }
            issueField { __typename ... on IssueFieldSingleSelect { fullDatabaseId name } }
          }
        }
      }
      items(first: 100, after: $after) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content { __typename ... on Issue { number repository { nameWithOwner } } }
          fieldValueByName(name: "Status") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

export async function readProjectSnapshot(client, config) {
  const items = [];
  let after = null;
  let fields = null;
  let totalCount = null;
  do {
    const data = await client.graphql(PROJECT_QUERY, { org: config.organization, number: config.project.number, after });
    const project = data.organization?.projectV2;
    if (!project) throw new Error(`Project #${config.project.number} is unavailable`);
    fields ??= project.fields.nodes.filter(Boolean);
    totalCount ??= project.items.totalCount;
    items.push(...project.items.nodes.filter(Boolean));
    after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (after);
  return {
    totalCount,
    fields,
    items: items.map((item) => ({
      id: item.id,
      repository: item.content?.repository?.nameWithOwner ?? null,
      number: item.content?.number ?? null,
      status: item.fieldValueByName?.name ?? null,
    })),
  };
}

function compactIssue(issue) {
  if (!issue) return null;
  return { repository: issue.repository_url?.split("/repos/")[1] ?? null, number: issue.number, state: issue.state };
}

export async function readIssueSnapshot(client, repository, number) {
  const [owner, repo] = repository.split("/");
  const root = `/repos/${owner}/${repo}/issues/${number}`;
  const [issue, issueFieldValues, blockedBy, blocking, parent, subIssues] = await Promise.all([
    client.request(root),
    client.listAll(`${root}/issue-field-values`),
    client.listAll(`${root}/dependencies/blocked_by`),
    client.listAll(`${root}/dependencies/blocking`),
    client.request(`${root}/parent`, { allow404: true }),
    client.listAll(`${root}/sub_issues`),
  ]);
  return {
    issue,
    issueFieldValues,
    blockedBy: blockedBy.map(compactIssue),
    blocking: blocking.map(compactIssue),
    parent: compactIssue(parent),
    subIssues: subIssues.map(compactIssue),
    relationsReadable: true,
  };
}

async function writeCanonical(client, repository, number, operations) {
  const [owner, repo] = repository.split("/");
  const root = `/repos/${owner}/${repo}/issues/${number}`;
  const updates = operations.filter((op) => op.kind === "setIssueField");
  if (updates.length) {
    await client.request(`${root}/issue-field-values`, {
      method: "POST",
      body: { issue_field_values: updates.map((op) => ({ field_id: op.fieldId, value: op.after })) },
    });
  }
  for (const op of operations.filter((item) => item.kind === "clearIssueField")) {
    await client.request(`${root}/issue-field-values/${op.fieldId}`, { method: "DELETE" });
  }
  const type = operations.find((op) => op.kind === "setIssueType");
  if (type) await client.request(root, { method: "PATCH", body: { type: type.after } });
}

async function writeCleanup(client, repository, number, cleanup) {
  const [owner, repo] = repository.split("/");
  const root = `/repos/${owner}/${repo}/issues/${number}`;
  for (const op of cleanup) {
    if (op.kind === "removeLegacyLabel") {
      await client.request(`${root}/labels/${encodeURIComponent(op.label)}`, { method: "DELETE", allow404: true });
    } else if (op.kind === "clearLegacyMilestone") {
      await client.request(root, { method: "PATCH", body: { milestone: null } });
    }
  }
}

function parseArgs(argv) {
  const args = { mode: "plan", config: "automation/metadata-migration.config.json", output: null, state: null, activate: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "plan" || value === "apply") args.mode = value;
    else if (value === "--config") args.config = argv[++i];
    else if (value === "--output") args.output = argv[++i];
    else if (value === "--state") args.state = argv[++i];
    else if (value === "--activate") args.activate = argv[++i];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}
async function readState(path) {
  if (!path) return { schemaVersion: 1, issues: {} };
  try {
    const state = await readJson(path);
    return { schemaVersion: 1, issues: state.issues ?? {} };
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, issues: {} };
    throw error;
  }
}
async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

export async function run(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  const args = parseArgs(argv);
  assertApplyActivation({ mode: args.mode, activate: args.activate, env });
  const config = overrides.config ?? await readJson(args.config);
  const state = overrides.state ?? await readState(args.state);
  const client = overrides.client ?? new GitHubClient(env.GITHUB_TOKEN);
  const readProject = overrides.readProjectSnapshot ?? readProjectSnapshot;
  const readIssue = overrides.readIssueSnapshot ?? readIssueSnapshot;
  const writeCanonicalState = overrides.writeCanonical ?? writeCanonical;
  const writeCleanupState = overrides.writeCleanup ?? writeCleanup;
  const persistJson = overrides.writeJson ?? writeJson;
  const globalBlockers = [];
  let project = null;

  try {
    const [fields, types] = await Promise.all([
      client.listAll(`/orgs/${config.organization}/issue-fields`),
      client.request(`/orgs/${config.organization}/issue-types`),
    ]);
    globalBlockers.push(...verifyOrgSchema(config, fields, types));
  } catch (error) {
    globalBlockers.push(`Organization schema unreadable: ${error.message}`);
  }
  try {
    project = await readProject(client, config);
    globalBlockers.push(...verifyProjectSnapshot(config, project));
  } catch (error) {
    globalBlockers.push(`Project #${config.project.number} unreadable: ${error.message}`);
  }

  const projectIndex = new Map((project?.items ?? []).filter((item) => item.repository && item.number)
    .map((item) => [`${item.repository}#${item.number}`, item]));
  const result = {
    schemaVersion: 1,
    mode: args.mode,
    generatedAt: new Date().toISOString(),
    project: projectAudit(config, project),
    globalBlockers,
    issues: [],
  };

  for (const [repository, repoConfig] of Object.entries(config.repositories)) {
    for (const [numberText, mapping] of Object.entries(repoConfig.issues)) {
      const number = Number(numberText);
      const key = `${repository}#${number}`;
      let snapshot;
      try {
        snapshot = await readIssue(client, repository, number);
      } catch (error) {
        result.issues.push({ issue: key, blockers: [`Issue state unreadable: ${error.message}`], operations: [], cleanup: [] });
        continue;
      }
      const planArgs = { config, repository, number, mapping, projectItem: projectIndex.get(key), preserveLabels: repoConfig.preserveLabels };
      let plan = buildIssuePlan({ ...planArgs, snapshot });
      if (args.mode === "plan") {
        result.issues.push(plan);
        continue;
      }
      if (state.issues[key]?.status === "complete" && plan.operations.length === 0 && plan.cleanup.length === 0 && plan.blockers.length === 0) {
        result.issues.push({ ...plan, apply: { status: "resumed-complete" } });
        continue;
      }
      if (!canonicalWriteEligible({ plan, globalBlockers })) {
        const reason = globalBlockers.length ? "global preflight failed" : "issue preflight failed";
        result.issues.push({ ...plan, apply: { status: "blocked", reason } });
        continue;
      }

      await writeCanonicalState(client, repository, number, plan.operations);
      snapshot = await readIssue(client, repository, number);
      plan = buildIssuePlan({ ...planArgs, snapshot });
      if (!cleanupEligible({ plan, globalBlockers })) {
        result.issues.push({ ...plan, apply: { status: "cleanup-blocked-after-read-back" } });
        continue;
      }

      if (plan.cleanup.length) {
        let cleanupProject;
        try {
          cleanupProject = await readProject(client, config);
        } catch (error) {
          result.issues.push({
            ...plan,
            blockers: [...plan.blockers, `Project #${config.project.number} refresh failed: ${error.message}`],
            apply: { status: "cleanup-blocked-after-project-refresh" },
          });
          continue;
        }
        const cleanupProjectBlockers = verifyProjectSnapshot(config, cleanupProject);
        const cleanupProjectIndex = new Map((cleanupProject?.items ?? []).filter((item) => item.repository && item.number)
          .map((item) => [`${item.repository}#${item.number}`, item]));
        plan = buildIssuePlan({
          ...planArgs,
          snapshot,
          projectItem: cleanupProjectIndex.get(key),
        });
        if (cleanupProjectBlockers.length) {
          plan = { ...plan, blockers: [...plan.blockers, ...cleanupProjectBlockers] };
        }
        if (!cleanupEligible({ plan, globalBlockers })) {
          result.issues.push({ ...plan, apply: { status: "cleanup-blocked-after-project-refresh" } });
          continue;
        }
      }

      await writeCleanupState(client, repository, number, plan.cleanup);
      const finalSnapshot = await readIssue(client, repository, number);
      const finalPlan = buildIssuePlan({ ...planArgs, snapshot: finalSnapshot });
      if (finalPlan.operations.length || finalPlan.cleanup.length || finalPlan.blockers.length) {
        throw new Error(`${key}: final read-back is not clean`);
      }
      result.issues.push({ ...finalPlan, apply: { status: "complete" } });
      if (args.state) {
        state.issues[key] = { status: "complete", updatedAt: new Date().toISOString() };
        await persistJson(args.state, state);
      }
    }
  }

  if (args.output) await persistJson(args.output, result);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (globalBlockers.length || result.issues.some((item) => item.blockers?.length || String(item.apply?.status ?? "").includes("blocked"))) {
    process.exitCode = 2;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
