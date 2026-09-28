#!/usr/bin/env node
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INTEGRATION_BRANCHES } from './dev-readiness.mjs';
import {
  GitHubClient,
  readIssueSnapshot,
  readProjectSnapshot,
  verifyOrgSchema,
  verifyProjectSnapshot,
} from './metadata-migration.mjs';

const APPLY_ACTIVATION = 'issue-intake-v1';
const APPLY_ENV = 'CHIPIN_ISSUE_WRITE';
const INITIAL_STATUS = 'Backlog';
const SUPPORTED = new Set(Object.keys(INTEGRATION_BRANCHES));
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
    releaseScope: input.releaseScope || null,
    severity: severity(input.severity),
  };
  const blockers = [];
  if (!classification.issueType) blockers.push('Issue Type is required.');
  else if (!Object.hasOwn(config.issueTypes || {}, classification.issueType)) blockers.push('Unsupported Issue Type: ' + classification.issueType + '.');
  const priorities = config.issueFields?.Priority?.options || [];
  if (!classification.priority) blockers.push('Priority is required.');
  else if (!priorities.includes(classification.priority)) blockers.push('Unsupported Priority: ' + classification.priority + '.');
  const releases = config.issueFields?.['Release scope']?.options || [];
  if (!classification.releaseScope) blockers.push('Release scope is required.');
  else if (!releases.includes(classification.releaseScope)) blockers.push('Unsupported Release scope: ' + classification.releaseScope + '.');
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

export function buildReconcilePlan({ config, repository, number, classification, snapshot, project }) {
  const operations = [];
  const blockers = [];
  if (!SUPPORTED.has(repository)) blockers.push('Repository is outside ChipIn intake scope: ' + repository + '.');
  const observed = observedMetadata(config, snapshot);
  blockers.push(...observed.blockers);
  const desired = {
    Priority: classification.priority,
    'Release scope': classification.releaseScope,
    ...(classification.severity === null ? {} : { Severity: classification.severity }),
  };
  for (const [name, value] of Object.entries(desired)) {
    const current = observed.fields[name] ?? null;
    if (current === null) operations.push({ kind: 'setIssueField', field: name, fieldId: config.issueFields[name].id, value });
    else if (current !== value) blockers.push(name + ' already has human value ' + current + '; refusing to overwrite it with ' + value + '.');
  }
  if (observed.issueType === null) operations.push({ kind: 'setIssueType', value: classification.issueType });
  else if (observed.issueType !== classification.issueType) blockers.push('Issue Type already has human value ' + observed.issueType + '; refusing to overwrite it with ' + classification.issueType + '.');
  const memberships = projectItemsFor(project, repository, number);
  if (memberships.length === 0) operations.push({ kind: 'addProjectMembership' });
  else if (memberships.length > 1) blockers.push('Project #' + config.project.number + ' has duplicate membership (' + memberships.length + ' items); manual reconciliation is required.');
  else if (!memberships[0].status) operations.push({ kind: 'initializeStatus', itemId: memberships[0].id, value: INITIAL_STATUS });
  return {
    issue: key(repository, number),
    issueUrl: snapshot?.issue?.html_url || snapshot?.issue?.url || null,
    desired: classification,
    observed: {
      issueType: observed.issueType,
      fields: observed.fields,
      membershipCount: memberships.length,
      status: memberships.length === 1 ? memberships[0].status || null : null,
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

export async function addProjectMembership(client, project, snapshot) {
  if (!project?.id || !snapshot?.issue?.node_id) throw new Error('Project or issue node id is unreadable.');
  const data = await client.graphql(ADD_ITEM, { projectId: project.id, contentId: snapshot.issue.node_id });
  const id = data?.addProjectV2ItemById?.item?.id || null;
  if (!id) throw new Error('Project add mutation did not return an item id.');
  return id;
}

function statusCoordinates(config, project) {
  const blockers = [];
  const fields = (project?.fields || []).filter((field) => field?.name === config.project.statusField);
  if (fields.length !== 1) return { blockers: ['Project Status field is missing or ambiguous (' + fields.length + ' matches).'] };
  const field = fields[0];
  if (field.isIssueField === true) blockers.push('Project Status must remain project-local.');
  const options = (field.options || []).filter((option) => option?.name === INITIAL_STATUS);
  if (options.length !== 1) blockers.push(INITIAL_STATUS + ' Status option is missing or ambiguous (' + options.length + ' matches).');
  if (!project?.id) blockers.push('Project node id is unreadable.');
  if (!field?.id) blockers.push('Project Status field node id is unreadable.');
  if (!options[0]?.id) blockers.push(INITIAL_STATUS + ' Status option id is unreadable.');
  return { blockers, projectId: project?.id || null, fieldId: field?.id || null, optionId: options[0]?.id || null };
}

export async function initializeProjectStatus(client, config, project, itemId) {
  const coordinates = statusCoordinates(config, project);
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

export function verifyFinalState({ config, repository, number, classification, snapshot, project }) {
  const observed = observedMetadata(config, snapshot);
  const blockers = [...observed.blockers, ...verifyProjectSnapshot(config, project)];
  if (observed.issueType !== classification.issueType) blockers.push('Read-back Issue Type is ' + (observed.issueType || 'missing') + ', expected ' + classification.issueType + '.');
  const expected = {
    Priority: classification.priority,
    'Release scope': classification.releaseScope,
    ...(classification.severity === null ? {} : { Severity: classification.severity }),
  };
  for (const [name, value] of Object.entries(expected)) {
    if (observed.fields[name] !== value) blockers.push('Read-back ' + name + ' is ' + (observed.fields[name] || 'missing') + ', expected ' + value + '.');
  }
  const memberships = projectItemsFor(project, repository, number);
  if (memberships.length !== 1) blockers.push('Read-back Project membership count is ' + memberships.length + ', expected exactly 1.');
  const status = memberships.length === 1 ? memberships[0].status || null : null;
  if (!status) blockers.push('Read-back Project Status is missing.');
  return {
    blockers,
    receipt: {
      issueUrl: snapshot?.issue?.html_url || snapshot?.issue?.url || null,
      issueType: observed.issueType,
      fields: observed.fields,
      project: { number: config.project.number, membershipCount: memberships.length, status },
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

export async function createIssue(client, config, repository, classification, { title, body }) {
  const [owner, repo] = repository.split('/');
  const values = [
    { field_id: config.issueFields.Priority.id, value: classification.priority },
    { field_id: config.issueFields['Release scope'].id, value: classification.releaseScope },
    ...(classification.severity === null ? [] : [{ field_id: config.issueFields.Severity.id, value: classification.severity }]),
  ];
  return client.request('/repos/' + owner + '/' + repo + '/issues', {
    method: 'POST',
    body: { title, body, type: classification.issueType, issue_field_values: values },
  });
}

function parseArgs(argv) {
  const args = {
    mode: null, operation: null, target: null, issueType: null, priority: null,
    releaseScope: null, severity: null, title: null, body: null, bodyFile: null,
    state: null, output: null, activate: null, config: 'automation/metadata-migration.config.json',
  };
  const values = [...argv];
  args.mode = values.shift(); args.operation = values.shift(); args.target = values.shift();
  if (!['plan', 'apply'].includes(args.mode)) throw new Error('First argument must be plan or apply.');
  if (!['reconcile', 'create'].includes(args.operation)) throw new Error('Second argument must be reconcile or create.');
  if (!args.target) throw new Error('Issue identity or repository target is required.');
  const map = {
    '--type': 'issueType', '--priority': 'priority', '--release-scope': 'releaseScope',
    '--severity': 'severity', '--title': 'title', '--body': 'body', '--body-file': 'bodyFile',
    '--state': 'state', '--output': 'output', '--activate': 'activate', '--config': 'config',
  };
  for (let i = 0; i < values.length; i += 1) {
    const name = map[values[i]];
    if (!name) throw new Error('Unknown argument: ' + values[i]);
    args[name] = values[++i];
  }
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
    schemaVersion: 1, mode: args.mode, operation: args.operation,
    generatedAt: new Date().toISOString(), desired: checked.classification,
    issue: null, action: 'incomplete', blockers: [...checked.blockers], applied: [], receipt: null,
  };

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
    if (!SUPPORTED.has(args.target)) result.blockers.push('Repository is outside ChipIn intake scope: ' + args.target + '.');
    if (!args.title) result.blockers.push('Create requires --title.');
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
          result.applied.push('resume-existing-issue');
        } else if (state) {
          throw new Error('Create checkpoint exists without issue identity; creation outcome is uncertain. Recover the issue manually before retrying to avoid a duplicate.');
        } else {
          let body = args.body || '';
          if (args.bodyFile) body = await (overrides.readFile || readFile)(resolve(args.bodyFile), 'utf8');

          const reserveState = overrides.reserveCreateState || reserveCreateState;
          const writeState = overrides.writeCreateState || atomicWriteJson;
          await reserveState(args.state, {
            schemaVersion: 1,
            repository: args.target,
            classification: checked.classification,
            title: args.title,
            phase: 'reserved-before-create',
            reservedAt: new Date().toISOString(),
          });
          result.applied.push('create-checkpoint-reserved');

          const created = await (overrides.createIssue || createIssue)(client, config, args.target, checked.classification, { title: args.title, body });
          if (!Number.isInteger(created?.number)) throw new Error('Create API did not return an issue number.');
          target = { repository: args.target, number: created.number };
          await writeState(args.state, {
            schemaVersion: 1, repository: args.target, issueRef: key(args.target, created.number),
            issueUrl: created.html_url || created.url || null, classification: checked.classification,
            title: args.title, createdAt: new Date().toISOString(),
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
      const plan = buildReconcilePlan({ config, repository: target.repository, number: target.number, classification: checked.classification, snapshot, project });
      result.plan = plan;
      result.blockers.push(...plan.blockers);
      if (!result.blockers.length && args.mode === 'plan') result.action = plan.action;
      if (!result.blockers.length && args.mode === 'apply') {
        const metadata = plan.operations.filter((op) => op.kind === 'setIssueField' || op.kind === 'setIssueType');
        if (metadata.length) {
          try { await (overrides.writeIssueMetadata || writeIssueMetadata)(client, target.repository, target.number, metadata); result.applied.push('issue-metadata'); }
          catch (error) { result.blockers.push('Issue metadata write failed: ' + error.message); }
        }
        if (!result.blockers.length) {
          try {
            snapshot = await readIssue(client, target.repository, target.number);
            const check = buildReconcilePlan({ config, repository: target.repository, number: target.number, classification: checked.classification, snapshot, project });
            const remaining = check.operations.filter((op) => op.kind === 'setIssueField' || op.kind === 'setIssueType');
            if (remaining.length || check.blockers.some((b) => b.includes('human value'))) result.blockers.push('Issue metadata read-back did not confirm the requested canonical values.');
          } catch (error) { result.blockers.push('Issue metadata read-back failed: ' + error.message); }
        }
        if (!result.blockers.length) {
          try {
            project = await readProject(client, config);
            const projectBlockers = verifyProjectSnapshot(config, project);
            if (projectBlockers.length) throw new Error(projectBlockers.join(' '));
            let memberships = projectItemsFor(project, target.repository, target.number);
            if (memberships.length > 1) throw new Error('Project #' + config.project.number + ' has duplicate membership (' + memberships.length + ' items).');
            if (!memberships.length) {
              await (overrides.addProjectMembership || addProjectMembership)(client, project, snapshot);
              result.applied.push('project-membership');
              const attempts = overrides.projectMembershipReadAttempts ?? 6;
              const delayMs = overrides.projectMembershipReadDelayMs ?? 1000;
              const sleep = overrides.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
              for (let attempt = 0; attempt < attempts; attempt += 1) {
                project = await readProject(client, config);
                memberships = projectItemsFor(project, target.repository, target.number);
                if (memberships.length) break;
                if (attempt + 1 < attempts) await sleep(delayMs);
              }
            }
            if (memberships.length !== 1) throw new Error('Project membership read-back count is ' + memberships.length + ', expected exactly 1.');
            if (!memberships[0].status) {
              await (overrides.initializeProjectStatus || initializeProjectStatus)(client, config, project, memberships[0].id);
              result.applied.push('status:' + INITIAL_STATUS);
            }
          } catch (error) { result.blockers.push('Project reconciliation failed: ' + error.message); }
        }
        if (!result.blockers.length) {
          try {
            snapshot = await readIssue(client, target.repository, target.number);
            project = await readProject(client, config);
            const final = verifyFinalState({ config, repository: target.repository, number: target.number, classification: checked.classification, snapshot, project });
            result.receipt = final.receipt;
            result.blockers.push(...final.blockers);
          } catch (error) { result.blockers.push('Final read-back failed: ' + error.message); }
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
