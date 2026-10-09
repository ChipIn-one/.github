#!/usr/bin/env node
// Canonical admission READER. All metadata writes remain in issue-intake.mjs.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHubClient, readIssueSnapshot, readProjectSnapshot, verifyOrgSchema, verifyProjectSnapshot } from './github-metadata.mjs';

export const ADMISSION_CONTRACT = 'chipin-issue-admission/v1';
export const ADMISSION_MAX_AGE_MS = 120_000;
const REQUIRED = new Map([
  ['ChipIn-one/chipin-frontend', 'syllik'],
  ['ChipIn-one/chipin-backend', 'olegbal'],
]);
const REPOSITORIES = new Set([...REQUIRED.keys(), 'ChipIn-one/chipin-knowledge-base']);
const PLACEHOLDER = /^(?:tbd|todo|n\/a|none|placeholder|coming soon|\.\.\.|-)\s*[.!]?$/i;

export function validateBody(title, body) {
  const blockers = [];
  if (typeof title !== 'string' || title.trim().length < 8 || PLACEHOLDER.test(title.trim())) blockers.push('Durable Issue title is missing or placeholder.');
  if (typeof body !== 'string' || body.trim().length < 70) blockers.push('Durable Issue body is missing or too short.');
  const sections = {};
  const matches = [...String(body ?? '').matchAll(/^#{2,3}\s+(Problem|Outcome|Acceptance|Dependencies|References)\s*$/gim)];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const name = current[1].toLowerCase();
    if (sections[name] !== undefined) blockers.push('Repeated Issue section: ' + name + '.');
    sections[name] = String(body).slice(current.index + current[0].length, matches[i + 1]?.index ?? String(body).length).trim();
  }
  for (const key of ['problem', 'outcome', 'acceptance']) {
    if (!sections[key] || sections[key].length < 15 || PLACEHOLDER.test(sections[key])) blockers.push('Issue body needs substantive ## ' + key + '.');
  }
  if (sections.acceptance && !/^(?:\s*[-*]\s+(?:\[[ xX]\]\s*)?\S|\s*\d+[.)]\s+\S)/m.test(sections.acceptance)) {
    blockers.push('Acceptance must contain verifiable checklist/list items.');
  }
  return blockers;
}

export function requiredOwner(repository, selectedOwner = null) {
  if (!REPOSITORIES.has(repository)) throw new Error('Unsupported admission repository: ' + repository);
  const fixed = REQUIRED.get(repository);
  if (fixed && selectedOwner && selectedOwner !== fixed) throw new Error('Owner policy conflict: ' + repository + ' requires ' + fixed + '.');
  if (fixed) return fixed;
  if (!/^[a-z\d](?:[a-z\d-]{0,37})$/i.test(selectedOwner || '')) throw new Error('KB requires an explicitly selected --owner GitHub login.');
  return selectedOwner;
}

function observedFields(config, snapshot) {
  const blockers = [];
  const fields = {};
  for (const [name, field] of Object.entries(config.issueFields)) {
    const rows = (snapshot?.issueFieldValues ?? []).filter(row => Number(row?.issue_field_id) === field.id);
    fields[name] = rows.length === 1 ? rows[0]?.single_select_option?.name ?? rows[0]?.value ?? null : null;
    if (rows.length > 1) blockers.push('Ambiguous ' + name + ' Issue Field read-back.');
  }
  return { fields, blockers };
}

export function verifyAdmission({ config, repository, number, selectedOwner = null, snapshot, project, checkedAt = new Date().toISOString(), expectedRevision = null }) {
  const blockers = [];
  let owner = null;
  try { owner = requiredOwner(repository, selectedOwner); } catch (error) { blockers.push(error.message); }
  const issue = snapshot?.issue;
  if (!issue || issue.number !== number || issue.pull_request) blockers.push('Unreadable or mismatched native Issue identity.');
  if (issue?.repository_url && !issue.repository_url.endsWith('/' + repository)) blockers.push('Native Issue repository identity mismatch.');
  if (!issue?.node_id || !issue?.updated_at) blockers.push('Issue node_id/updated_at unavailable for revision-bound admission.');
  blockers.push(...validateBody(issue?.title, issue?.body));
  if (snapshot?.relationsReadable !== true) blockers.push('Issue native relationships are unreadable.');
  const actualOwners = (issue?.assignees ?? []).map(user => user?.login).filter(Boolean);
  if (!Array.isArray(issue?.assignees)) blockers.push('Native assignees are unreadable.');
  if (owner && !actualOwners.includes(owner)) blockers.push('Required native assignee ' + owner + ' is missing.');
  const type = issue?.type?.name ?? null;
  if (!Object.hasOwn(config.issueTypes ?? {}, type)) blockers.push('Native Issue Type missing or unsupported: ' + (type || 'missing') + '.');
  const observed = observedFields(config, snapshot);
  blockers.push(...observed.blockers);
  for (const field of ['Priority', 'Severity']) {
    const value = observed.fields[field];
    if (field === 'Priority' || type === 'Bug' || value != null) {
      if (!config.issueFields[field]?.options.includes(value)) blockers.push('Native ' + field + ' missing or unsupported: ' + (value || 'missing') + '.');
    }
  }
  blockers.push(...verifyProjectSnapshot(config, project));
  const items = (project?.items ?? []).filter(row => row.repository === repository && row.number === number);
  if (items.length !== 1) blockers.push('Project #5 membership count ' + items.length + ', expected one.');
  const status = items.length === 1 ? items[0].status : null;
  if (!config.project.statusValues.includes(status)) blockers.push('Project #5 Status missing or unsupported.');
  if (status === 'Done' && !(issue?.state === 'closed' && issue?.state_reason === 'completed')) blockers.push('Done requires native closed/completed.');
  if (issue?.state === 'closed' && issue?.state_reason === 'completed' && status !== 'Done') blockers.push('Closed/completed Issue requires derived Project Done.');
  const revision = createHash('sha256').update(JSON.stringify({
    repository, number, title: issue?.title, body: issue?.body,
    updatedAt: issue?.updated_at, type, priority: observed.fields.Priority,
    severity: observed.fields.Severity, actualOwners: [...actualOwners].sort(),
    projectId: project?.id, itemId: items[0]?.id, status, milestone: issue?.milestone?.number ?? null,
  })).digest('hex');
  if (expectedRevision && revision !== expectedRevision) blockers.push('STALE: Issue/metadata/ownership/Project revision changed.');
  if (!Number.isFinite(Date.parse(checkedAt)) || Math.abs(Date.now() - Date.parse(checkedAt)) > ADMISSION_MAX_AGE_MS) blockers.push('STALE: admission read-back outside freshness window.');
  const receipt = {
    contractVersion: ADMISSION_CONTRACT,
    status: blockers.length ? 'BLOCKED' : 'INTAKE_COMPLETE',
    issue: repository + '#' + number,
    issueUrl: issue?.html_url ?? null,
    revision, issueUpdatedAt: issue?.updated_at ?? null, checkedAt,
    issueType: type, fields: observed.fields,
    assignees: actualOwners, requiredAssignee: owner,
    project: { number: config.project.number, itemId: items[0]?.id ?? null, membershipCount: items.length, status },
    milestone: issue?.milestone?.title ?? null, blockers,
  };
  return { blockers, receipt };
}

async function readOrgSchema(client, config) {
  const [fields, types] = await Promise.all([
    client.listAll('/orgs/' + config.organization + '/issue-fields'),
    client.request('/orgs/' + config.organization + '/issue-types'),
  ]);
  return verifyOrgSchema(config, fields, types);
}

export async function readAdmission({ client, config, repository, number, selectedOwner = null, expectedRevision = null, overrides = {} }) {
  const blockers = [];
  let project, snapshot;
  try { blockers.push(...await (overrides.readOrgSchema ?? readOrgSchema)(client, config)); }
  catch (error) { blockers.push('Organization schema unreadable: ' + error.message); }
  try { project = await (overrides.readProjectSnapshot ?? readProjectSnapshot)(client, config); }
  catch (error) { blockers.push('Project #5 unreadable: ' + error.message); }
  try { snapshot = await (overrides.readIssueSnapshot ?? readIssueSnapshot)(client, repository, number); }
  catch (error) { blockers.push('Native Issue unreadable: ' + error.message); }
  const result = verifyAdmission({ config, repository, number, selectedOwner, snapshot, project, expectedRevision });
  blockers.push(...result.blockers);
  if (!blockers.length) {
    try {
      const latest = await (overrides.readIssueSnapshot ?? readIssueSnapshot)(client, repository, number);
      if (latest.issue?.updated_at !== snapshot.issue?.updated_at ||
          latest.issue?.title !== snapshot.issue?.title || latest.issue?.body !== snapshot.issue?.body ||
          JSON.stringify(latest.issue?.assignees) !== JSON.stringify(snapshot.issue?.assignees)) {
        blockers.push('STALE: Issue changed during admission read-back.');
      }
    } catch (error) { blockers.push('Second Issue read-back failed: ' + error.message); }
  }
  return { ...result, blockers, receipt: { ...result.receipt, status: blockers.length ? 'BLOCKED' : 'INTAKE_COMPLETE', blockers } };
}

export function assertFreshReceipt(receipt, { issue, revision = null, now = Date.now() } = {}) {
  if (receipt?.contractVersion !== ADMISSION_CONTRACT || receipt?.status !== 'INTAKE_COMPLETE') throw new Error('INTAKE_COMPLETE admission receipt required; queued/legacy/blocked is not sufficient.');
  if (receipt.issue !== issue || (revision && receipt.revision !== revision)) throw new Error('Admission identity/revision mismatch.');
  if (!Number.isFinite(Date.parse(receipt.checkedAt)) || now - Date.parse(receipt.checkedAt) > ADMISSION_MAX_AGE_MS || now < Date.parse(receipt.checkedAt)) throw new Error('STALE admission receipt.');
  if (receipt.blockers?.length) throw new Error('Admission receipt has blockers.');
  return true;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) throw new Error('Expected --issue, --owner (KB), --expected-revision, --output, --config.');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = args(argv);
  const match = /^(ChipIn-one\/[^#]+)#([1-9]\d*)$/.exec(opts.issue ?? '');
  if (!match) throw new Error('Exact --issue owner/repo#number is required.');
  const config = JSON.parse(await readFile(resolve(opts.config ?? 'automation/metadata-migration.config.json'), 'utf8'));
  const result = await readAdmission({
    client: new GitHubClient(env.GITHUB_TOKEN), config, repository: match[1], number: Number(match[2]),
    selectedOwner: opts.owner ?? null, expectedRevision: opts['expected-revision'] ?? null,
  });
  if (opts.output) await writeFile(resolve(opts.output), JSON.stringify(result.receipt, null, 2) + '\n');
  else process.stdout.write(JSON.stringify(result.receipt, null, 2) + '\n');
  if (result.blockers.length) process.exitCode = 2;
  return result.receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 2; });
}
