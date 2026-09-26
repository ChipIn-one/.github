#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  evaluateDevReadiness,
  INTEGRATION_BRANCHES,
} from './dev-readiness.mjs';
import {
  GitHubClient,
  readIssueSnapshot,
  readProjectSnapshot,
  verifyOrgSchema,
  verifyProjectSnapshot,
} from './metadata-migration.mjs';

const KNOWN_PR_STATES = new Set(['OPEN', 'CLOSED', 'MERGED']);
const COMPARE_STATUSES = new Set(['ahead', 'behind', 'diverged', 'identical']);
const REQUIRED_METADATA_FIELDS = new Set(['Priority', 'Release scope']);

const DEVELOPMENT_PRS_QUERY = `
query DevReadinessPullRequests($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 100, after: $after, includeClosedPrs: true, userLinkedOnly: true) {
        nodes {
          number
          state
          merged
          baseRefName
          headRefName
          mergeCommit { oid }
          repository { nameWithOwner }
          url
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

const DEVELOPMENT_BRANCHES_QUERY = `
query DevReadinessBranches($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      linkedBranches(first: 100, after: $after) {
        nodes {
          id
          ref {
            name
            repository { nameWithOwner }
            target { oid }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

function issueKey(repository, number) {
  return `${repository}#${number}`;
}

export function parseIssueRef(value) {
  const match = /^(?<repository>[^\s#/]+\/[^\s#/]+)#(?<number>[1-9]\d*)$/.exec(value ?? '');
  if (!match) throw new Error(`Invalid issue identity: ${value}`);
  return { repository: match.groups.repository, number: Number(match.groups.number) };
}

function relationKey(relation) {
  if (!relation?.repository || !Number.isInteger(relation?.number)) return null;
  return issueKey(relation.repository, relation.number);
}

export function indexProjectItems(project) {
  const index = new Map();
  const duplicates = new Set();
  for (const item of project?.items ?? []) {
    if (!item?.repository || !Number.isInteger(item?.number)) continue;
    const key = issueKey(item.repository, item.number);
    if (index.has(key)) duplicates.add(key);
    else index.set(key, item);
  }
  return { index, duplicates: [...duplicates].sort() };
}

export function canonicalMetadata(config, snapshot) {
  const blockers = [];
  const valuesById = new Map();
  for (const value of snapshot?.issueFieldValues ?? []) {
    const id = Number(value?.issue_field_id);
    if (!Number.isInteger(id)) continue;
    const list = valuesById.get(id) ?? [];
    list.push(value?.single_select_option?.name ?? value?.value ?? null);
    valuesById.set(id, list);
  }

  const fields = {};
  for (const [name, field] of Object.entries(config.issueFields)) {
    const values = valuesById.get(field.id) ?? [];
    if (values.length > 1) {
      blockers.push(`Canonical ${name} is ambiguous.`);
      fields[name] = null;
      continue;
    }
    const value = values[0] ?? null;
    fields[name] = value;
    if (REQUIRED_METADATA_FIELDS.has(name) && value === null) {
      blockers.push(`Canonical ${name} is missing.`);
    } else if (value !== null && !field.options.includes(value)) {
      blockers.push(`Canonical ${name} has unsupported value ${value}.`);
    }
  }

  const workKind = snapshot?.issue?.type?.name ?? null;
  const expectedTypeId = config.issueTypes[workKind];
  const actualTypeId = snapshot?.issue?.type?.id == null ? null : Number(snapshot.issue.type.id);
  if (!workKind || !expectedTypeId || (actualTypeId !== null && actualTypeId !== expectedTypeId)) {
    blockers.push('Canonical Issue Type is missing or unsupported.');
  }

  return { workKind, fields, blockers };
}

async function readConnection(client, query, variables, connectionName) {
  const nodes = [];
  let after = null;
  do {
    const data = await client.graphql(query, { ...variables, after });
    const issue = data.repository?.issue;
    if (!issue) throw new Error(`Issue ${variables.owner}/${variables.repo}#${variables.number} is unavailable`);
    const connection = issue[connectionName];
    if (!connection?.pageInfo || !Array.isArray(connection.nodes)) {
      throw new Error(`GitHub schema drift: ${connectionName} is unreadable`);
    }
    nodes.push(...connection.nodes.filter(Boolean));
    if (!connection.pageInfo.hasNextPage) break;
    if (!connection.pageInfo.endCursor) throw new Error(`GitHub schema drift: ${connectionName} cursor is missing`);
    after = connection.pageInfo.endCursor;
  } while (after);
  return nodes;
}

export async function readDevelopmentSnapshot(client, repository, number) {
  const [owner, repo] = repository.split('/');
  if (!owner || !repo) throw new Error(`Invalid repository identity: ${repository}`);
  const variables = { owner, repo, number };
  const [pullRequests, branches] = await Promise.all([
    readConnection(client, DEVELOPMENT_PRS_QUERY, variables, 'closedByPullRequestsReferences'),
    readConnection(client, DEVELOPMENT_BRANCHES_QUERY, variables, 'linkedBranches'),
  ]);
  return { pullRequests, branches };
}

async function normalizeDevelopmentPr(client, issueRepository, rawPr) {
  const expectedBranch = INTEGRATION_BRANCHES[issueRepository];
  const repository = rawPr?.repository?.nameWithOwner ?? null;
  const state = rawPr?.state;
  const baseRefName = rawPr?.baseRefName;
  const prNumber = rawPr?.number;
  const evidence = {
    kind: 'pr',
    repository,
    number: prNumber ?? null,
    state: rawPr?.merged === true ? 'merged' : typeof state === 'string' ? state.toLowerCase() : null,
    baseBranch: baseRefName ?? null,
    actualBaseBranch: baseRefName ?? null,
    headBranch: rawPr?.headRefName ?? null,
    integration: null,
    readable: true,
  };

  if (
    !expectedBranch
    || repository !== issueRepository
    || !Number.isInteger(prNumber)
    || !KNOWN_PR_STATES.has(state)
    || typeof baseRefName !== 'string'
    || baseRefName.length === 0
    || (state === 'MERGED') !== (rawPr?.merged === true)
  ) {
    return { ...evidence, readable: false };
  }

  if (evidence.state !== 'merged') return evidence;
  if (baseRefName === expectedBranch) {
    return { ...evidence, baseBranch: expectedBranch, integration: 'direct' };
  }

  const mergeSha = rawPr?.mergeCommit?.oid ?? null;
  if (!mergeSha) return { ...evidence, readable: false };
  const [owner, repo] = repository.split('/');
  try {
    const compare = await client.request(
      `/repos/${owner}/${repo}/compare/${encodeURIComponent(mergeSha)}...${encodeURIComponent(expectedBranch)}`,
    );
    if (!COMPARE_STATUSES.has(compare?.status)) return { ...evidence, readable: false };
    if (compare.status === 'behind' || compare.status === 'identical') {
      return { ...evidence, baseBranch: expectedBranch, integration: 'stacked' };
    }
    return { ...evidence, integration: 'not-integrated' };
  } catch {
    return { ...evidence, readable: false };
  }
}

export async function normalizeDevelopment(client, repository, development) {
  const pullRequests = [];
  for (const pr of development?.pullRequests ?? []) {
    pullRequests.push(await normalizeDevelopmentPr(client, repository, pr));
  }
  const branches = (development?.branches ?? []).map((branch) => ({
    repository: branch?.ref?.repository?.nameWithOwner ?? null,
    name: branch?.ref?.name ?? null,
    oid: branch?.ref?.target?.oid ?? null,
  }));
  return { pullRequests, branches };
}

function normalizeBlockers(snapshot, projectIndex) {
  if (!snapshot?.relationsReadable) return [{ readable: false, state: null }];
  return (snapshot.blockedBy ?? []).map((blocker) => {
    const key = relationKey(blocker);
    if (!key || !['open', 'closed'].includes(blocker?.state)) return { readable: false, state: null };
    return {
      readable: true,
      state: blocker.state,
      projectStatus: projectIndex.get(key)?.status,
      issue: key,
    };
  });
}

function normalizeSubIssues(snapshot, projectIndex) {
  if (!snapshot?.relationsReadable) return [{ kind: 'subissue', readable: false, state: null }];
  return (snapshot.subIssues ?? []).map((subIssue) => {
    const key = relationKey(subIssue);
    const status = key ? projectIndex.get(key)?.status : null;
    return {
      kind: 'subissue',
      readable: Boolean(key && status),
      state: status ?? null,
      issue: key,
    };
  });
}

export function deliveryClassFor({ repository, workKind, isCompositeParent }) {
  if (workKind !== 'Task') return undefined;
  if (repository === 'ChipIn-one/chipin-frontend' || repository === 'ChipIn-one/chipin-backend') return 'code';
  if (repository === 'ChipIn-one/chipin-knowledge-base') return isCompositeParent ? 'code' : 'non-code';
  return undefined;
}

export async function readLiveContext(client, config) {
  const schemaBlockers = [];
  let project = null;
  try {
    const [fields, types] = await Promise.all([
      client.listAll(`/orgs/${config.organization}/issue-fields`),
      client.request(`/orgs/${config.organization}/issue-types`),
    ]);
    schemaBlockers.push(...verifyOrgSchema(config, fields, types));
  } catch (error) {
    schemaBlockers.push(`Organization schema unreadable: ${error.message}`);
  }

  try {
    project = await readProjectSnapshot(client, config);
    schemaBlockers.push(...verifyProjectSnapshot(config, project));
  } catch (error) {
    schemaBlockers.push(`Project #${config.project.number} unreadable: ${error.message}`);
  }

  const { index: projectIndex, duplicates } = indexProjectItems(project);
  for (const key of duplicates) schemaBlockers.push(`Project #${config.project.number} contains duplicate item ${key}.`);
  return { project, projectIndex, schemaBlockers };
}

export async function evaluateLiveIssue(client, config, liveContext, repository, number) {
  const key = issueKey(repository, number);
  const observedAt = new Date().toISOString();
  const evidence = { issue: key, parent: null, developmentBranches: [], developmentPullRequests: [] };
  const adapterBlockers = [...liveContext.schemaBlockers];
  let snapshot = null;
  let development = null;

  try {
    snapshot = await readIssueSnapshot(client, repository, number);
  } catch (error) {
    adapterBlockers.push(`Issue state unreadable: ${error.message}`);
  }
  try {
    development = await readDevelopmentSnapshot(client, repository, number);
  } catch (error) {
    adapterBlockers.push(`Development relationships unreadable: ${error.message}`);
  }

  const metadata = snapshot ? canonicalMetadata(config, snapshot) : { workKind: null, fields: {}, blockers: ['Canonical metadata unreadable.'] };
  adapterBlockers.push(...metadata.blockers);
  const projectItem = liveContext.projectIndex.get(key);
  if (!projectItem) adapterBlockers.push(`Project #${config.project.number} membership is missing.`);
  else if (!projectItem.status) adapterBlockers.push(`Project #${config.project.number} Status is unreadable.`);

  let normalizedDevelopment = { pullRequests: [{ kind: 'pr', readable: false, state: null, baseBranch: null }], branches: [] };
  if (development) normalizedDevelopment = await normalizeDevelopment(client, repository, development);
  evidence.developmentPullRequests = normalizedDevelopment.pullRequests;
  evidence.developmentBranches = normalizedDevelopment.branches;
  evidence.parent = snapshot?.parent ?? null;

  const parentMalformed = snapshot?.parent && !relationKey(snapshot.parent);
  if (parentMalformed) adapterBlockers.push('Native parent relationship is malformed.');
  const subIssues = snapshot ? normalizeSubIssues(snapshot, liveContext.projectIndex) : [];
  const isCompositeParent = subIssues.length > 0;
  const requiredItems = isCompositeParent
    ? [...subIssues, ...normalizedDevelopment.pullRequests]
    : normalizedDevelopment.pullRequests;
  const blockers = snapshot ? normalizeBlockers(snapshot, liveContext.projectIndex) : [{ readable: false, state: null }];
  const deliveryClass = deliveryClassFor({ repository, workKind: metadata.workKind, isCompositeParent });

  const input = {
    repository,
    currentStatus: projectItem?.status ?? null,
    workKind: metadata.workKind,
    requiredItems,
    blockers,
    metadataReadable: adapterBlockers.length === 0,
    projectReadable: liveContext.schemaBlockers.length === 0 && Boolean(projectItem?.status),
    isCompositeParent,
    ...(deliveryClass ? { deliveryClass } : {}),
  };
  const decision = evaluateDevReadiness(input);
  return {
    observedAt,
    issue: key,
    decision,
    adapterBlockers,
    canonical: metadata.fields,
    projectStatus: projectItem?.status ?? null,
    evidence,
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

function parseArgs(argv) {
  const args = { config: 'automation/metadata-migration.config.json', output: null, issues: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--config') args.config = argv[++i];
    else if (value === '--output') args.output = argv[++i];
    else args.issues.push(parseIssueRef(value));
  }
  if (!args.issues.length) throw new Error('Provide at least one owner/repository#issue identity.');
  return args;
}

export async function run(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  const args = parseArgs(argv);
  const config = overrides.config ?? await readJson(args.config);
  const client = overrides.client ?? new GitHubClient(env.GITHUB_TOKEN);
  const liveContext = overrides.liveContext ?? await readLiveContext(client, config);
  const decisions = [];
  for (const issue of args.issues) {
    decisions.push(await evaluateLiveIssue(client, config, liveContext, issue.repository, issue.number));
  }
  const result = {
    schemaVersion: 1,
    readOnly: true,
    generatedAt: new Date().toISOString(),
    project: { number: config.project.number, totalCount: liveContext.project?.totalCount ?? null },
    schemaBlockers: liveContext.schemaBlockers,
    decisions,
  };
  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) await writeFile(resolve(args.output), text, 'utf8');
  else process.stdout.write(text);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
