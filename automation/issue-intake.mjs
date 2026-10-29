#!/usr/bin/env node
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  GitHubClient,
  readIssueProjectItems,
  readIssueSnapshot,
  readProjectSnapshot,
  verifyOrgSchema,
  verifyProjectSnapshot,
} from './github-metadata.mjs';
import { createHash } from 'node:crypto';
import { isAdmissionRepository, requiredOwner, validateBody, verifyAdmission, ADMISSION_CONTRACT } from './issue-admission.mjs';
import { GitHubNativeStore, appendDeclarations, declare, parseIssueRef as parseRelationshipRef, renderDeclaration } from './relationships.mjs';

const APPLY_ACTIVATION = 'issue-intake-v1';
const APPLY_ENV = 'CHIPIN_ISSUE_WRITE';
const INITIAL_STATUS = 'Backlog';
// `apply create --status` (#218): new work lands in Backlog for triage; Todo is only for an Issue inside a
// scope the owner already approved (for example a sub-task of an approved plan). Reconcile, the finalizer
// and the connector bridge keep Backlog. Every other value is rejected; the Status is written only on an
// item that has none, so an existing human-set Status is never overwritten.
export const INITIAL_STATUS_VALUES = Object.freeze(['Backlog', 'Todo']);
// The membership wait is governed by the time budget; the read cap only bounds a pathological
// zero-latency loop (120 reads x 2 s delay > 4 min, so the budget always ends first in practice).
const MEMBERSHIP_READ_ATTEMPTS = 120;
const MEMBERSHIP_READ_BUDGET_MS = 240000;
export const PENDING_READBACK_CODE = 'PROJECT_MEMBERSHIP_READBACK_PENDING';
export const PENDING_STATUS_READBACK_CODE = 'PROJECT_STATUS_READBACK_PENDING';
// Intake scope is the admission scope of the registry (#183): FE, BE, KB and .github today.
export function isSupportedIntakeRepository(repository) {
  return isAdmissionRepository(repository);
}
const ADD_ITEM = [
  'mutation AddIssue($projectId: ID!, $contentId: ID!) {',
  '  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }',
  '}',
].join('\n');
const SET_STATUS = [
  'mutation SetIssueStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {',
  '  updateProjectV2ItemFieldValue(input: {',
  '    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,',
  '    value: { singleSelectOptionId: $optionId }',
  '  }) { projectV2Item { id } }',
  '}',
].join('\n');

function key(repository, number) { return repository + '#' + number; }

export function parseIssueRef(value) {
  const match = /^([^\s#/]+\/[^\s#/]+)#([1-9]\d*)$/.exec(value || '');
  if (!match) throw new Error('Invalid issue identity: ' + value);
  return { repository: match[1], number: Number(match[2]) };
}

function severity(value) {
  return value == null || value === '' || String(value).toLowerCase() === 'none' ? null : value;
}

export function validateClassification(config, input = {}) {
  const classification = {
    issueType: input.issueType || null,
    priority: input.priority || null,
    severity: severity(input.severity),
  };
  const blockers = [];
  if (!classification.issueType) blockers.push('Issue Type is required.');
  else if (!Object.hasOwn(config.issueTypes || {}, classification.issueType)) blockers.push('Unsupported Issue Type: ' + classification.issueType + '.');
  const priorities = config.issueFields?.Priority?.options || [];
  if (!classification.priority) blockers.push('Priority is required.');
  else if (!priorities.includes(classification.priority)) blockers.push('Unsupported Priority: ' + classification.priority + '.');
  const severities = config.issueFields?.Severity?.options || [];
  if (classification.severity !== null && !severities.includes(classification.severity)) blockers.push('Unsupported Severity: ' + classification.severity + '.');
  if (classification.issueType === 'Bug' && classification.severity === null) blockers.push('Severity is required for Bug issues.');
  return { classification, blockers };
}

export function assertWriteActivation({ mode, activate, env = process.env }) {
  if (mode === 'apply' && (activate !== APPLY_ACTIVATION || env[APPLY_ENV] !== '1')) {
    throw new Error('Issue writes are disabled. Use --activate ' + APPLY_ACTIVATION + ' and ' + APPLY_ENV + '=1 after operator approval.');
  }
}

export function observedMetadata(config, snapshot) {
  const byId = new Map();
  for (const raw of snapshot?.issueFieldValues || []) {
    const id = Number(raw?.issue_field_id);
    if (!Number.isInteger(id)) continue;
    const values = byId.get(id) || [];
    values.push(raw?.single_select_option?.name ?? raw?.value ?? null);
    byId.set(id, values);
  }
  const fields = {};
  const blockers = [];
  for (const [name, field] of Object.entries(config.issueFields || {})) {
    const values = byId.get(field.id) || [];
    if (values.length > 1) blockers.push(name + ' is ambiguous (' + values.length + ' values).');
    fields[name] = values.length === 1 ? values[0] : null;
  }
  return { issueType: snapshot?.issue?.type?.name || null, fields, blockers };
}

export function projectItemsFor(project, repository, number) {
  return (project?.items || []).filter((item) => item?.repository === repository && item?.number === number);
}

function projectStatusConsistencyBlockers(config, snapshot, status, prefix = '') {
  if (!status) return [];
  if (!config.project.statusValues.includes(status)) {
    return [prefix + 'Project Status ' + status + ' is retired or unsupported; expected one of: ' + config.project.statusValues.join(', ') + '.'];
  }
  if (status !== 'Done') return [];
  const state = snapshot?.issue?.state ?? null;
  const reason = snapshot?.issue?.state_reason ?? null;
  if (state === 'closed' && reason === 'completed') return [];
  return [prefix + 'Project Status Done is derived from Issue closed/completed; observed Issue state=' + (state || 'unreadable') + ', state_reason=' + (reason || 'unreadable') + '.'];
}

export function buildReconcilePlan({ config, repository, number, classification, snapshot, project, selectedOwner = null, initialStatus = INITIAL_STATUS }) {
  const operations = [];
  const blockers = [];
  // GitHub /issues/{number} also returns PR-shaped resources. Verify exact
  // native Issue identity BEFORE planning any metadata, owner or Project writes.
  const native = snapshot?.issue;
  const validIdentity = native?.number === number &&
    native?.repository_url === 'https://api.github.com/repos/' + repository &&
    typeof native?.node_id === 'string' && native.node_id.length > 0 &&
    !native.pull_request;
  if (!validIdentity) blockers.push('Native Issue identity is missing, mismatched or PR-shaped; refusing all intake mutations.');
  // Closed/completed is a separate terminal reconciliation path, never admission.
  const state = native?.state;
  const reason = native?.state_reason;
  const validState = state === 'open' || (state === 'closed' && reason === 'completed');
  if (!validState) blockers.push('Native Issue is not open or closed/completed; refusing all intake mutations.');
  const writable = validIdentity && validState;
  if (!isSupportedIntakeRepository(repository)) blockers.push('Repository is outside ChipIn intake scope: ' + repository + '.');
  const observed = observedMetadata(config, snapshot);
  blockers.push(...observed.blockers);
  blockers.push(...validateBody(snapshot?.issue?.title, snapshot?.issue?.body));
  let required = null;
  try { required = requiredOwner(repository, selectedOwner); }
  catch (error) { blockers.push(error.message); }
  if (!Array.isArray(snapshot?.issue?.assignees)) blockers.push('Native Issue assignees are unreadable.');
  else if (writable && required && !snapshot.issue.assignees.some(user => user?.login === required)) {
    operations.push({ kind: 'addAssignee', login: required });
  }
  const desired = {
    Priority: classification.priority,
    ...(classification.severity === null ? {} : { Severity: classification.severity }),
  };
  for (const [name, value] of Object.entries(desired)) {
    const current = observed.fields[name] ?? null;
    if (current === null && writable) operations.push({ kind: 'setIssueField', field: name, fieldId: config.issueFields[name].id, value });
    else if (current !== value) blockers.push(name + ' already has human value ' + current + '; refusing to overwrite it with ' + value + '.');
  }
  if (observed.issueType === null && writable) operations.push({ kind: 'setIssueType', value: classification.issueType });
  else if (observed.issueType !== classification.issueType) blockers.push('Issue Type already has human value ' + observed.issueType + '; refusing to overwrite it with ' + classification.issueType + '.');
  const memberships = projectItemsFor(project, repository, number);
  if (memberships.length === 0) {
    if (writable) operations.push({ kind: 'addProjectMembership' });
  } else if (memberships.length > 1) blockers.push('Project #' + config.project.number + ' has duplicate membership (' + memberships.length + ' items); manual reconciliation is required.');
  else if (!memberships[0].status && writable) operations.push({ kind: 'initializeStatus', itemId: memberships[0].id, value: initialStatus });
  else blockers.push(...projectStatusConsistencyBlockers(config, snapshot, memberships[0].status));
  return {
    issue: key(repository, number),
    issueUrl: snapshot?.issue?.html_url || snapshot?.issue?.url || null,
    desired: classification,
    observed: {
      issueType: observed.issueType,
      fields: observed.fields,
      membershipCount: memberships.length,
      status: memberships.length === 1 ? memberships[0].status || null : null,
      assignees: snapshot?.issue?.assignees?.map(user => user.login) ?? null,
      requiredAssignee: required,
    },
    operations,
    blockers,
    action: blockers.length ? 'incomplete' : operations.length ? 'write' : 'noop',
  };
}

async function readOrganizationSchema(client, config) {
  const [fields, types] = await Promise.all([
    client.listAll('/orgs/' + config.organization + '/issue-fields'),
    client.request('/orgs/' + config.organization + '/issue-types'),
  ]);
  return { fields, types };
}

export async function readGlobalContext(client, config, overrides = {}) {
  const schema = await (overrides.readOrganizationSchema || readOrganizationSchema)(client, config);
  const project = await (overrides.readProjectSnapshot || readProjectSnapshot)(client, config);
  return {
    project,
    blockers: [
      ...verifyOrgSchema(config, schema.fields, schema.types),
      ...verifyProjectSnapshot(config, project),
    ],
  };
}

export async function writeIssueMetadata(client, repository, number, operations) {
  const [owner, repo] = repository.split('/');
  const root = '/repos/' + owner + '/' + repo + '/issues/' + number;
  const fields = operations.filter((op) => op.kind === 'setIssueField');
  if (fields.length) await client.request(root + '/issue-field-values', {
    method: 'POST',
    body: { issue_field_values: fields.map((op) => ({ field_id: op.fieldId, value: op.value })) },
  });
  const type = operations.find((op) => op.kind === 'setIssueType');
  if (type) await client.request(root, { method: 'PATCH', body: { type: type.value } });
}

export async function addRequiredAssignee(client, repository, number, login) {
  // Additive only; GitHub silently ignores unassignable users, so final read-back is mandatory.
  return client.request('/repos/' + repository + '/issues/' + number + '/assignees', {
    method: 'POST', body: { assignees: [login] },
  });
}

export async function addProjectMembership(client, project, snapshot) {
  if (!project?.id || !snapshot?.issue?.node_id) throw new Error('Project or issue node id is unreadable.');
  const data = await client.graphql(ADD_ITEM, { projectId: project.id, contentId: snapshot.issue.node_id });
  const id = data?.addProjectV2ItemById?.item?.id || null;
  if (!id) throw new Error('Project add mutation did not return an item id.');
  return id;
}

function statusCoordinates(config, project, status = INITIAL_STATUS) {
  const blockers = [];
  const fields = (project?.fields || []).filter((field) => field?.name === config.project.statusField);
  if (fields.length !== 1) return { blockers: ['Project Status field is missing or ambiguous (' + fields.length + ' matches).'] };
  const field = fields[0];
  if (field.isIssueField === true) blockers.push('Project Status must remain project-local.');
  if (!INITIAL_STATUS_VALUES.includes(status)) blockers.push('Initial Status ' + status + ' is not one of ' + INITIAL_STATUS_VALUES.join(', ') + '.');
  const options = (field.options || []).filter((option) => option?.name === status);
  if (options.length !== 1) blockers.push(status + ' Status option is missing or ambiguous (' + options.length + ' matches).');
  if (!project?.id) blockers.push('Project node id is unreadable.');
  if (!field?.id) blockers.push('Project Status field node id is unreadable.');
  if (!options[0]?.id) blockers.push(status + ' Status option id is unreadable.');
  return { blockers, projectId: project?.id || null, fieldId: field?.id || null, optionId: options[0]?.id || null };
}

export async function initializeProjectStatus(client, config, project, itemId, status = INITIAL_STATUS) {
  const coordinates = statusCoordinates(config, project, status);
  if (coordinates.blockers.length) throw new Error(coordinates.blockers.join(' '));
  if (!itemId) throw new Error('Project item id is unreadable.');
  const data = await client.graphql(SET_STATUS, {
    projectId: coordinates.projectId,
    itemId,
    fieldId: coordinates.fieldId,
    optionId: coordinates.optionId,
  });
  if (data?.updateProjectV2ItemFieldValue?.projectV2Item?.id !== itemId) throw new Error('Status mutation did not return the expected item id.');
}

export function verifyFinalState({ config, repository, number, classification, snapshot, project, selectedOwner = null }) {
  const observed = observedMetadata(config, snapshot);
  // This is a canonical writer read-back, not permission to execute a closed task.
  // Only the read-only admission preflight uses the default open-Issue requirement.
  const admission = verifyAdmission({ config, repository, number, selectedOwner, snapshot, project, allowTerminalReconciliation: true });
  const blockers = [...admission.blockers];
  if (observed.issueType !== classification.issueType) blockers.push('Read-back Issue Type is ' + (observed.issueType || 'missing') + ', expected ' + classification.issueType + '.');
  const expected = {
    Priority: classification.priority,
    ...(classification.severity === null ? {} : { Severity: classification.severity }),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (observed.fields[name] !== value) blockers.push('Read-back ' + name + ' is ' + (observed.fields[name] || 'missing') + ', expected ' + value + '.');
  }
  const memberships = projectItemsFor(project, repository, number);
  if (memberships.length !== 1) blockers.push('Read-back Project membership count is ' + memberships.length + ', expected exactly 1.');
  const status = memberships.length === 1 ? memberships[0].status || null : null;
  if (!status) blockers.push('Read-back Project Status is missing.');
  else blockers.push(...projectStatusConsistencyBlockers(config, snapshot, status, 'Read-back '));
  return {
    blockers,
    receipt: {
      ...admission.receipt,
      // Terminal reconciliation is observable but never an execution/admission receipt.
      // Keep a separate contract AND status so bridge/assertFreshReceipt cannot mistake
      // a closed/completed Done mirror for an open task's INTAKE_COMPLETE.
      contractVersion: snapshot?.issue?.state === 'closed' && snapshot?.issue?.state_reason === 'completed'
        ? 'chipin-terminal-reconciliation/v1' : admission.receipt.contractVersion,
      status: blockers.length ? 'BLOCKED'
        : snapshot?.issue?.state === 'closed' && snapshot?.issue?.state_reason === 'completed'
          ? 'TERMINAL_RECONCILED' : 'INTAKE_COMPLETE',
      blockers: [...blockers],
      issueUrl: snapshot?.issue?.html_url || snapshot?.issue?.url || null,
      issueType: observed.issueType,
      fields: observed.fields,
      project: { number: config.project.number, itemId: memberships.length === 1 ? memberships[0].id : null, membershipCount: memberships.length, status },
      milestone: snapshot?.issue?.milestone?.title ?? null,
      relationships: {
        blockedBy: snapshot?.blockedBy || [],
        blocking: snapshot?.blocking || [],
        parent: snapshot?.parent || null,
        subIssues: snapshot?.subIssues || [],
      },
    },
  };
}

async function readJson(path) { return JSON.parse(await readFile(resolve(path), 'utf8')); }

async function readCreateState(path) {
  try { return await readJson(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWriteJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = target + '.tmp-' + process.pid;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(temporary, target);
}

export async function reserveCreateState(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  let handle = null;
  try {
    handle = await open(target, 'wx');
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function createIssue(client, config, repository, classification, { title, body, selectedOwner = null }) {
  const [owner, repo] = repository.split('/');
  const assignee = requiredOwner(repository, selectedOwner);
  const values = [
    { field_id: config.issueFields.Priority.id, value: classification.priority },
    ...(classification.severity === null ? [] : [{ field_id: config.issueFields.Severity.id, value: classification.severity }]),
  ];
  return client.request('/repos/' + owner + '/' + repo + '/issues', {
    method: 'POST',
    body: { title, body, assignees: [assignee], type: classification.issueType, issue_field_values: values },
  });
}

function parseArgs(argv) {
  const args = {
    mode: null, operation: null, target: null, issueType: null, priority: null,
    severity: null, title: null, body: null, bodyFile: null, owner: null,
    state: null, output: null, activate: null, config: 'automation/metadata-migration.config.json',
    relationships: [], status: null,
  };
  const values = [...argv];
  args.mode = values.shift(); args.operation = values.shift(); args.target = values.shift();
  if (!['plan', 'apply'].includes(args.mode)) throw new Error('First argument must be plan or apply.');
  if (!['reconcile', 'create'].includes(args.operation)) throw new Error('Second argument must be reconcile or create.');
  if (!args.target) throw new Error('Issue identity or repository target is required.');
  const map = {
    '--type': 'issueType', '--priority': 'priority',
    '--severity': 'severity', '--title': 'title', '--body': 'body', '--body-file': 'bodyFile', '--owner': 'owner',
    '--state': 'state', '--output': 'output', '--activate': 'activate', '--config': 'config',
    '--status': 'status',
  };
  const relationshipFlags = { '--blocked-by': 'blocked_by', '--blocks': 'blocks', '--relates-to': 'relates_to', '--parent': 'parent' };
  for (let i = 0; i < values.length; i += 1) {
    if (relationshipFlags[values[i]]) {
      args.relationships.push({ kind: relationshipFlags[values[i]], target: values[++i] });
      continue;
    }
    const name = map[values[i]];
    if (!name) throw new Error('Unknown argument: ' + values[i]);
    args[name] = values[++i];
  }
  if (args.relationships.length && args.operation !== 'create') {
    throw new Error('Relationship flags are supported only with create; use relationships.mjs declare for an existing Issue.');
  }
  for (const { target } of args.relationships) parseRelationshipRef(target);
  if (args.status !== null && args.operation !== 'create') {
    throw new Error('--status is supported only with create; reconcile keeps an existing Status and initialises ' + INITIAL_STATUS + ' only when it is absent.');
  }
  if (args.status !== null && !INITIAL_STATUS_VALUES.includes(args.status)) {
    throw new Error('Unsupported --status ' + JSON.stringify(args.status) + '; expected one of: ' + INITIAL_STATUS_VALUES.join(', ') + '.');
  }
  args.initialStatus = args.status ?? INITIAL_STATUS;
  if (args.operation === 'create' && args.mode === 'apply' && !args.state) throw new Error('Create apply requires --state for retry-safe issue identity persistence.');
  if (args.operation === 'create' && args.mode === 'apply' && args.output && resolve(args.state) === resolve(args.output)) {
    throw new Error('Create apply requires --state and --output to resolve to different paths.');
  }
  return args;
}

async function emit(result, output, persist) {
  const value = JSON.stringify(result, null, 2) + '\n';
  if (output) await persist(resolve(output), value, 'utf8');
  else process.stdout.write(value);
}

function sameClassification(a, b) {
  return JSON.stringify(a || null) === JSON.stringify(b || null);
}

export async function run(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  const args = parseArgs(argv);
  assertWriteActivation({ mode: args.mode, activate: args.activate, env });
  const persist = overrides.writeFile || writeFile;
  const config = overrides.config || await readJson(args.config);
  const client = overrides.client || new GitHubClient(env.GITHUB_TOKEN);
  const checked = validateClassification(config, args);
  const result = {
    schemaVersion: 2, contractVersion: ADMISSION_CONTRACT, mode: args.mode, operation: args.operation,
    generatedAt: new Date().toISOString(), desired: checked.classification,
    issue: null, action: 'incomplete', blockers: [...checked.blockers], applied: [], receipt: null,
    initialStatus: args.initialStatus, initialStatusApplied: false,
  };

  try { requiredOwner(args.operation === 'create' ? args.target : parseIssueRef(args.target).repository, args.owner); }
  catch (error) { result.blockers.push(error.message); }

  let global = null;
  if (!result.blockers.length) {
    try {
      global = await (overrides.readGlobalContext || readGlobalContext)(client, config, overrides);
      result.blockers.push(...global.blockers);
    } catch (error) { result.blockers.push('Global schema/project read failed: ' + error.message); }
  }

  let target = null;
  if (!result.blockers.length && args.operation === 'reconcile') target = parseIssueRef(args.target);

  if (!result.blockers.length && args.operation === 'create') {
    if (!isSupportedIntakeRepository(args.target)) result.blockers.push('Repository is outside ChipIn intake scope: ' + args.target + '.');
    if (!args.title) result.blockers.push('Create requires --title.');
    let suppliedBody = args.body || '';
    try { if (args.bodyFile) suppliedBody = await (overrides.readFile || readFile)(resolve(args.bodyFile), 'utf8'); }
    catch (error) { result.blockers.push('Issue body read failed: ' + error.message); }
    // Declared relationships become `## Dependencies` lines in the created body; native edges follow after creation.
    if (!result.blockers.length && args.relationships.length) {
      try {
        suppliedBody = appendDeclarations(suppliedBody, args.relationships.map(({ kind, target }) => renderDeclaration(kind, parseRelationshipRef(target).canonical)));
      } catch (error) { result.blockers.push('Relationship declarations rejected: ' + error.message); }
    }
    result.blockers.push(...validateBody(args.title, suppliedBody));
    if (args.mode === 'plan') {
      result.action = result.blockers.length ? 'incomplete' : 'ready-to-create';
      await emit(result, args.output, persist);
      if (result.blockers.length) process.exitCode = 2;
      return result;
    }
    if (!result.blockers.length) {
      try {
        const state = await (overrides.readCreateState || readCreateState)(args.state);
        if (state?.issueRef) {
          target = parseIssueRef(state.issueRef);
          if (target.repository !== args.target) throw new Error('State issue ' + state.issueRef + ' does not belong to ' + args.target + '.');
          if (state.classification && !sameClassification(state.classification, checked.classification)) throw new Error('State classification differs from this retry.');
          if (state.title && state.title !== args.title) throw new Error('State title differs from this retry.');
          if (state.owner && state.owner !== requiredOwner(args.target, args.owner)) throw new Error('State owner differs from this retry.');
          if (state.bodySha256 && state.bodySha256 !== createHash('sha256').update(suppliedBody).digest('hex')) throw new Error('State body differs from this retry.');
          if (state.initialStatus && state.initialStatus !== args.initialStatus) throw new Error('State initial Status differs from this retry.');
          result.applied.push('resume-existing-issue');
        } else if (state) {
          throw new Error('Create checkpoint exists without issue identity; creation outcome is uncertain. Recover the issue manually before retrying to avoid a duplicate.');
        } else {
          const body = suppliedBody;
          const owner = requiredOwner(args.target, args.owner);
          const bodySha256 = createHash('sha256').update(body).digest('hex');
          const reserveState = overrides.reserveCreateState || reserveCreateState;
          const writeState = overrides.writeCreateState || atomicWriteJson;
          await reserveState(args.state, {
            schemaVersion: 1,
            repository: args.target,
            classification: checked.classification,
            title: args.title, owner, bodySha256, initialStatus: args.initialStatus,
            phase: 'reserved-before-create',
            reservedAt: new Date().toISOString(),
          });
          result.applied.push('create-checkpoint-reserved');

          const created = await (overrides.createIssue || createIssue)(client, config, args.target, checked.classification, { title: args.title, body, selectedOwner: args.owner });
          if (!Number.isInteger(created?.number)) throw new Error('Create API did not return an issue number.');
          target = { repository: args.target, number: created.number };
          await writeState(args.state, {
            schemaVersion: 1, repository: args.target, issueRef: key(args.target, created.number),
            issueUrl: created.html_url || created.url || null, classification: checked.classification,
            title: args.title, owner, bodySha256, initialStatus: args.initialStatus, createdAt: new Date().toISOString(),
          });
          result.applied.push('issue-created-and-identity-persisted');
        }
      } catch (error) { result.blockers.push('Create/resume failed: ' + error.message); }
    }
  }

  if (!result.blockers.length && target) {
    result.issue = key(target.repository, target.number);
    const readIssue = overrides.readIssueSnapshot || readIssueSnapshot;
    const readProject = overrides.readProjectSnapshot || readProjectSnapshot;
    try {
      let snapshot = await readIssue(client, target.repository, target.number);
      let project = global.project;
      let statusWritten = false; // this run wrote the initial Status (checked again at the final read-back)
      const plan = buildReconcilePlan({ config, repository: target.repository, number: target.number, classification: checked.classification, snapshot, project, selectedOwner: args.owner, initialStatus: args.initialStatus });
      result.plan = plan;
      result.blockers.push(...plan.blockers);
      if (!result.blockers.length && args.mode === 'plan') result.action = plan.action;
      if (!result.blockers.length && args.mode === 'apply') {
        const metadata = plan.operations.filter((op) => op.kind === 'setIssueField' || op.kind === 'setIssueType');
        const assign = plan.operations.find(op => op.kind === 'addAssignee');
        if (metadata.length) {
          try { await (overrides.writeIssueMetadata || writeIssueMetadata)(client, target.repository, target.number, metadata); result.applied.push('issue-metadata'); }
          catch (error) { result.blockers.push('Issue metadata write failed: ' + error.message); }
        }
        if (!result.blockers.length && assign) {
          try {
            await (overrides.addAssignee || addRequiredAssignee)(client, target.repository, target.number, assign.login);
            result.applied.push('native-assignee:' + assign.login);
          } catch (error) { result.blockers.push('Native assignee write failed: ' + error.message); }
        }
        if (!result.blockers.length) {
          try {
            snapshot = await readIssue(client, target.repository, target.number);
            const check = buildReconcilePlan({ config, repository: target.repository, number: target.number, classification: checked.classification, snapshot, project, selectedOwner: args.owner, initialStatus: args.initialStatus });
            const remaining = check.operations.filter((op) => op.kind === 'setIssueField' || op.kind === 'setIssueType');
            if (remaining.length || check.operations.some(op => op.kind === 'addAssignee') || check.blockers.length) result.blockers.push('Issue metadata/assignee read-back did not confirm canonical state: ' + check.blockers.join(' '));
          } catch (error) { result.blockers.push('Issue metadata read-back failed: ' + error.message); }
        }
        if (!result.blockers.length) {
          try {
            project = await readProject(client, config);
            const projectBlockers = verifyProjectSnapshot(config, project);
            if (projectBlockers.length) throw new Error(projectBlockers.join(' '));
            let memberships = projectItemsFor(project, target.repository, target.number);
            if (memberships.length > 1) throw new Error('Project #' + config.project.number + ' has duplicate membership (' + memberships.length + ' items).');

            const membershipAttempts = overrides.projectMembershipReadAttempts ?? MEMBERSHIP_READ_ATTEMPTS;
            const membershipBudgetMs = overrides.projectMembershipReadBudgetMs ?? MEMBERSHIP_READ_BUDGET_MS;
            const statusAttempts = overrides.projectStatusReadAttempts ?? 6;
            const delayMs = overrides.projectMembershipReadDelayMs ?? 2000;
            const sleep = overrides.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
            const now = overrides.now || (() => Date.now());
            const readIssueItems = overrides.readIssueProjectItems || readIssueProjectItems;
            let statusInitialized = false;
            let knownStatus = null; // Status already visible on the Issue side (human-owned, never re-initialised)

            const pendingReturn = async (code, detail) => {
              // Retryable, not a blocker: the next drain re-runs the same idempotent reconcile.
              result.pending = { code, detail };
              result.action = 'pending-readback';
              await emit(result, args.output, persist);
              process.exitCode = 2;
              return result;
            };

            if (!memberships.length) {
              // The Project items listing can lag behind an earlier add (2026-10-20: more than 60 s).
              // The Issue's own projectItems view is read first so a retry never adds a second item.
              const issueSide = await readIssueItems(client, target.repository, target.number, config.project.number);
              if (issueSide.length > 1) throw new Error('Project #' + config.project.number + ' has duplicate membership (' + issueSide.length + ' items on the Issue).');
              let knownItemId = null;
              if (!issueSide.length) {
                knownItemId = (await (overrides.addProjectMembership || addProjectMembership)(client, project, snapshot)) || null;
                result.applied.push('project-membership');
              } else {
                knownItemId = issueSide[0].id || null;
                knownStatus = issueSide[0].status || null;
                result.applied.push('project-membership:already-present');
              }
              // Status is initialised on the item id we already know, so a lagging listing cannot turn
              // the Status step into a blocker later; the listing wait below only confirms visibility.
              if (knownItemId && !knownStatus) {
                await (overrides.initializeProjectStatus || initializeProjectStatus)(client, config, project, knownItemId, args.initialStatus);
                result.applied.push('status:' + args.initialStatus);
                statusInitialized = true;
                statusWritten = true;
              }

              const startedAt = now();
              for (let attempt = 0; attempt < membershipAttempts; attempt += 1) {
                project = await readProject(client, config);
                memberships = projectItemsFor(project, target.repository, target.number);
                if (memberships.length !== 0) break;
                if (attempt + 1 >= membershipAttempts || now() - startedAt + delayMs > membershipBudgetMs) break;
                await sleep(delayMs);
              }

              if (!memberships.length) {
                // The add succeeded (or was already present on the Issue) but the Project listing has not
                // caught up within the budget. The next drain skips the add once the membership is visible.
                let issueSideCount = 'unknown';
                try { issueSideCount = String((await readIssueItems(client, target.repository, target.number, config.project.number)).length); }
                catch { /* diagnostic only; the pending state does not depend on it */ }
                return pendingReturn(PENDING_READBACK_CODE,
                  'Project #' + config.project.number + ' membership for ' + key(target.repository, target.number)
                    + ' is not visible in the Project items listing after ' + Math.round((now() - startedAt) / 1000)
                    + ' s (' + issueSideCount + ' item(s) visible on the Issue side). Retry the same intake later; nothing is re-added while the Issue shows the item.');
              }
            }

            if (memberships.length > 1) throw new Error('Project #' + config.project.number + ' has duplicate membership (' + memberships.length + ' items).');
            if (memberships.length === 1 && !memberships[0].status && !statusInitialized && !knownStatus) {
              await (overrides.initializeProjectStatus || initializeProjectStatus)(client, config, project, memberships[0].id, args.initialStatus);
              result.applied.push('status:' + args.initialStatus);
              statusInitialized = true;
              statusWritten = true;
            }

            if (statusInitialized) {
              for (let attempt = 0; attempt < statusAttempts; attempt += 1) {
                project = await readProject(client, config);
                memberships = projectItemsFor(project, target.repository, target.number);
                if (memberships.length > 1) break;
                if (memberships.length === 1 && memberships[0].status) break;
                if (attempt + 1 < statusAttempts) await sleep(delayMs);
              }
            }

            if (memberships.length !== 1) throw new Error('Project membership read-back count is ' + memberships.length + ', expected exactly 1.');
            if (!memberships[0].status) {
              if (!statusInitialized && !knownStatus) throw new Error('Project Status read-back is missing after mutation.');
              return pendingReturn(PENDING_STATUS_READBACK_CODE,
                'Project #' + config.project.number + ' Status ' + (knownStatus ?? args.initialStatus) + ' is ' + (knownStatus ? 'visible on the Issue side' : 'set on item ' + memberships[0].id)
                  + ' but the Project listing does not show it yet. Retry the same intake later; Status is initialised only when still absent.');
            }
          } catch (error) { result.blockers.push('Project reconciliation failed: ' + error.message); }
        }
        if (!result.blockers.length) {
          try {
            snapshot = await readIssue(client, target.repository, target.number);
            const first = verifyFinalState({
              config, repository: target.repository, number: target.number,
              classification: checked.classification, snapshot, project, selectedOwner: args.owner,
            });
            result.receipt = first.receipt;
            result.blockers.push(...first.blockers);
            if (!result.blockers.length) {
              // A Project read performed before the final Issue fetch can become stale.
              // Re-read BOTH authorities and require one unchanged combined revision.
              // Never expose an INTAKE_COMPLETE writer receipt on divergent read-back.
              const [latestIssue, latestProject] = await Promise.all([
                readIssue(client, target.repository, target.number),
                readProject(client, config),
              ]);
              const confirmed = verifyFinalState({
                config, repository: target.repository, number: target.number,
                classification: checked.classification, snapshot: latestIssue,
                project: latestProject, selectedOwner: args.owner,
              });
              const blockers = [
                ...verifyProjectSnapshot(config, latestProject),
                ...confirmed.blockers,
              ];
              if (confirmed.receipt.revision !== first.receipt.revision) {
                blockers.push('STALE: native Issue/metadata/Project changed during final intake read-back.');
              }
              // The Status this run wrote must read back as written; a Status found already set is preserved as-is.
              if (statusWritten && confirmed.receipt.project?.status !== args.initialStatus) {
                blockers.push('Read-back Project Status is ' + (confirmed.receipt.project?.status || 'missing') + ', expected the initial ' + args.initialStatus + ' written by this run.');
              }
              result.blockers.push(...blockers);
              result.receipt = {
                ...confirmed.receipt,
                status: blockers.length ? 'BLOCKED' : confirmed.receipt.status,
                blockers,
              };
            }
          } catch (error) {
            result.blockers.push('Final read-back failed: ' + error.message);
            if (result.receipt) {
              result.receipt = { ...result.receipt, status: 'BLOCKED', blockers: [...result.blockers] };
            }
          }
        }
        if (!result.blockers.length && args.relationships.length) {
          try {
            const store = overrides.relationshipStore || new GitHubNativeStore(client);
            result.relationships = await declare({ store, issue: key(target.repository, target.number), additions: args.relationships, apply: true });
            result.blockers.push(...result.relationships.blockers.map((blocker) => 'Relationships: ' + blocker));
            if (!result.relationships.blockers.length) result.applied.push('native-relationships');
          } catch (error) { result.blockers.push('Relationships failed: ' + error.message); }
        }
        // Receipt-level answer to "did this run set the initial Status?" (.github#218).
        result.initialStatusApplied = statusWritten;
        const observedStatus = result.receipt?.project?.status ?? null;
        if (!statusWritten && observedStatus && observedStatus !== args.initialStatus) {
          result.initialStatusNote = 'Requested initial Status ' + args.initialStatus + ' was not written: the item already had Status ' + observedStatus + ', which is preserved.';
        }
        result.action = result.blockers.length ? 'incomplete' : 'complete';
      }
    } catch (error) { result.blockers.push('Issue read failed: ' + error.message); }
  }

  await emit(result, args.output, persist);
  if (result.blockers.length || (args.mode === 'apply' && result.action !== 'complete')) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
