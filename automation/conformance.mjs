#!/usr/bin/env node
// Conformance audit of registry repositories (spec: docs/workflow/conformance.md).
// `audit` is read-only. `upsert` is the only step that writes: one drift Issue per non-conformant
// repository in ChipIn-one/.github, closed as completed when drift reaches zero. An unreadable
// repository never opens, updates or closes anything.
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github-metadata.mjs';
import { getRepositoryProfile, loadRegistry } from './registry.mjs';

export const CONFORMANCE_CONTRACT = 'chipin-conformance/v1';
export const ISSUE_MARKER = 'Conformance: ';
export const ACTIVATION = 'conformance-v1';
const SHARED = 'ChipIn-one/.github';
const PERIOD_DAYS = 14;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

export const finding = (check, severity, message, remediation) => ({ check, severity, message, remediation });

// ---------------------------------------------------------------------------
// Pins in caller workflows
// ---------------------------------------------------------------------------

const USES = /^\s*(?:-\s*)?uses:\s*ChipIn-one\/\.github\/((?:automation\/[a-z0-9-]+)|(?:\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml))@([^\s#]+)\s*(?:#\s*(.*?))?\s*$/;

export function extractPins(workflows) {
  const pins = [];
  for (const { path, text } of workflows) {
    String(text).split(/\r?\n/).forEach((line, index) => {
      const match = USES.exec(line);
      if (!match) return;
      const target = match[1];
      pins.push({ path, line: index + 1, target, name: target.split('/').pop().replace(/\.ya?ml$/, ''), ref: match[2], comment: match[3] ?? '' });
    });
  }
  return pins;
}

const ADMISSION_CORE = [/^automation\/issue-admission[a-z-]*\.mjs$/, /^automation\/github-metadata\.mjs$/, /^automation\/registry\.mjs$/,
  /^automation\/relationships\.mjs$/, /^automation\/metadata-migration\.config\.json$/, /^workflow-registry\.yaml$/];
const TOUCHES = {
  'issue-admission-action': [/^automation\/issue-admission-action\//, ...ADMISSION_CORE],
  'development-link-action': [/^automation\/development-link(-action\/|\.mjs$)/, ...ADMISSION_CORE],
  'pr-metadata-action': [/^automation\/pr-metadata(-action\/|[a-z.-]*\.(mjs|json)$)/, /^automation\/development-link\.mjs$/, ...ADMISSION_CORE],
  'create-milestone-action': [/^automation\/create-milestone(-action\/|\.mjs$)/, /^automation\/registry\.mjs$/, /^workflow-registry\.yaml$/],
  'frontend-production-completion-action': [/^automation\/frontend-production-completion[a-z-]*(\/|\.mjs$)/, /^automation\/github-metadata\.mjs$/],
  'pr-gate': [/^\.github\/workflows\/pr-gate\.yml$/, /^automation\//, /^workflow-registry\.yaml$/],
  'issue-gate': [/^\.github\/workflows\/issue-gate\.yml$/, /^automation\//, /^workflow-registry\.yaml$/],
};
const IGNORED_CHANGE = /(\.test\.mjs|\.md)$/;
export const touchesCapability = (name, files) => {
  const patterns = TOUCHES[name] ?? [/^automation\//, /^workflow-registry\.yaml$/];
  return files.filter(f => !IGNORED_CHANGE.test(f)).some(f => patterns.some(p => p.test(f)));
};

const semver = tag => TAG.exec(tag.name).slice(1).map(Number);
export const sortTags = tags => tags.filter(t => TAG.test(t.name)).sort((a, b) => {
  const [x, y] = [semver(a), semver(b)];
  return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
});

// ---------------------------------------------------------------------------
// Checks. Each returns findings; a thrown error makes the repository UNREADABLE.
// ---------------------------------------------------------------------------

const REQUIRED_USES = [
  ['admission', ['issue-admission-action', 'development-link-action', 'pr-gate'], p => p.capabilities.admission !== 'off'],
  ['developmentLink', ['development-link-action', 'pr-gate'], p => p.capabilities.developmentLink !== 'off'],
  ['prMetadata', ['pr-metadata-action', 'pr-gate'], p => p.capabilities.prMetadata === 'required'],
  ['milestones', ['create-milestone-action'], p => p.capabilities.milestones === 'enabled'],
  ['completion', ['frontend-production-completion-action'], p => p.capabilities.completion === 'automatic'],
];

export function checkCallers(profile, pins) {
  // Meta repositories host the shared actions; caller checks start once they adopt pr-gate (#153).
  if (profile.kind === 'meta') return [];
  const used = new Set(pins.map(p => p.name));
  return REQUIRED_USES.filter(([, , applies]) => applies(profile))
    .filter(([, accepted]) => !accepted.some(name => used.has(name)))
    .map(([capability, accepted]) => finding('CALLER_MISSING', 'drift',
      `Capability ${capability} is ${profile.capabilities[capability]} but no workflow uses ${accepted.join(' or ')} from ChipIn-one/.github.`,
      `Add the caller workflow (docs/workflow/onboarding.md step 2) and pin it to a tagged SHA.`));
}

export async function checkPins(profile, pins, source, tags) {
  const findings = [];
  const latest = tags[0] ?? null;
  const bySha = new Map(tags.map(t => [t.sha, t.name]));
  const seen = new Set();
  for (const pin of pins) {
    const where = `${pin.path}:${pin.line} (${pin.name})`;
    if (!SHA.test(pin.ref)) { findings.push(finding('PIN_NOT_SHA', 'drift', `${where} is pinned to "${pin.ref}", not a commit SHA.`, 'Pin by full 40-character SHA with a "# vX.Y.Z" comment.')); continue; }
    const commented = /^v\d+\.\d+\.\d+\b/.exec(pin.comment)?.[0] ?? null;
    if (!commented) findings.push(finding('PIN_NO_VERSION', 'drift', `${where} has no "# vX.Y.Z" version comment.`, 'Add the version comment so Dependabot and reviewers can read the pin.'));
    const tagOfSha = bySha.get(pin.ref) ?? null;
    if (commented && tagOfSha && commented !== tagOfSha) findings.push(finding('PIN_VERSION_MISMATCH', 'drift', `${where} says ${commented} but the SHA is ${tagOfSha}.`, 'Fix the version comment.'));
    if (commented && !tagOfSha) findings.push(finding('PIN_UNTAGGED_SHA', 'drift', `${where} claims ${commented} but the SHA is not a release tag.`, 'Pin the SHA of a published tag.'));
    if (!latest || pin.ref === latest.sha) continue;
    const key = `${pin.name}@${pin.ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let cmp;
    try { cmp = await source.compare(pin.ref, latest.sha); }
    catch (error) { findings.push(finding('PIN_UNKNOWN', 'drift', `${where}: cannot compare ${pin.ref.slice(0, 7)} with ${latest.name} (${error.message}).`, 'Pin a SHA of the ChipIn-one/.github history.')); continue; }
    if (cmp.status === 'identical') continue;
    if (cmp.status === 'diverged') { findings.push(finding('PIN_STALE', 'drift', `${where} (${pin.ref.slice(0, 7)}) is not on the history of ${latest.name}.`, `Bump to ${latest.name} (${latest.sha.slice(0, 7)}).`)); continue; }
    if (cmp.status === 'behind') { findings.push(finding('PIN_AHEAD_OF_TAG', 'note', `${where} is newer than the latest tag ${latest.name}.`, 'Tag the commit or pin a tagged SHA.')); continue; }
    if (touchesCapability(pin.name, cmp.files ?? [])) {
      findings.push(finding('PIN_STALE', 'drift', `${where} (${commented ?? pin.ref.slice(0, 7)}) is older than ${latest.name} and the newer tag changes files this capability uses.`, `Bump to ${latest.name} (${latest.sha.slice(0, 7)}).`));
    } else {
      findings.push(finding('PIN_BEHIND', 'note', `${where} is behind ${latest.name} but the newer tag does not touch this capability.`, 'Bump with the next routine update.'));
    }
  }
  return findings;
}

export function checkDependabot(profile, text) {
  if (profile.capabilities.dependabot !== 'required') return [];
  if (text === null) return [finding('DEPENDABOT_MISSING', 'drift', `.github/dependabot.yml is missing on ${profile.branches.integration}.`, 'Add dependabot.yml with ecosystem github-actions (weekly, target = integration branch).')];
  const blocks = String(text).split(/^\s*-\s+(?=package-ecosystem:)/m).slice(1);
  const actions = blocks.find(b => /^package-ecosystem:\s*['"]?github-actions['"]?\s*$/m.test(b));
  if (!actions) return [finding('DEPENDABOT_NO_ACTIONS', 'drift', 'dependabot.yml has no github-actions ecosystem.', 'Add an update entry for package-ecosystem github-actions.')];
  const target = /^\s*target-branch:\s*['"]?([^'"\s#]+)['"]?/m.exec(actions)?.[1] ?? null;
  const { default: base, integration } = profile.branches;
  if ((target ?? base) !== integration) {
    return [finding('DEPENDABOT_TARGET', 'drift', `github-actions updates target ${target ?? `${base} (default)`}, not the integration branch ${integration}.`, `Set target-branch: ${integration}.`)];
  }
  return [];
}

export function checkRouting(profile, agents, context) {
  if (profile.capabilities.agentRouting !== 'required') return [];
  const findings = [];
  if (agents === null || !/ai-workflow:agents-routing:start/.test(agents)) {
    findings.push(finding('ROUTING_BLOCK_MISSING', 'drift', `AGENTS.md on ${profile.branches.integration} has no ai-workflow:agents-routing block.`, 'Add the managed routing block (docs/workflow/onboarding.md step 5).'));
  }
  if (context === null) findings.push(finding('AI_CONTEXT_MISSING', 'drift', `.ai/context.md is missing on ${profile.branches.integration}.`, 'Add .ai/context.md from templates/ai-context.md.'));
  return findings;
}

export function checkProtection(profile, rules, classic) {
  const { protection, requiredChecks } = profile;
  const unavailable = s => s.state === 'unavailable';
  if (protection === 'unavailable') {
    // Any answer other than "upgrade required" (including 404 Branch not protected) proves the plan allows it.
    if (rules.state === 'ok' || classic.state === 'ok' || classic.state === 'unprotected') {
      return [finding('PROTECTION_REGISTRY_STALE', 'drift', 'Registry says protection is unavailable but the API now answers (plan upgraded?).', 'Create the ruleset and set protection: ruleset in workflow-registry.yaml.')];
    }
    return [finding('PROTECTION_UNAVAILABLE', 'note', 'Branch protection is unavailable on this plan (as recorded in the registry); required checks are advisory.', 'Upgrade to GitHub Team (#161), then create the ruleset.')];
  }
  const enforced = new Set([...(rules.requiredChecks ?? []), ...(classic.requiredChecks ?? [])]);
  const readable = rules.state === 'ok' || classic.state === 'ok';
  if (!readable) {
    if (unavailable(rules) && unavailable(classic)) return [finding('PROTECTION_MISSING', 'drift', `Registry says ${protection} but protection is unavailable on this plan.`, 'Set protection: unavailable in the registry or upgrade the plan.')];
    if (rules.state === 'unreadable' || classic.state === 'unreadable') return [finding('PROTECTION_UNVERIFIABLE', 'note', 'The audit token cannot read branch protection for this repository.', 'Grant the audit token administration:read or verify manually.')];
    return [finding('PROTECTION_MISSING', 'drift', `Registry says ${protection} but neither a ruleset nor branch protection applies to ${profile.branches.integration}.`, 'Create the ruleset / protection with the registry required checks.')];
  }
  const findings = [];
  const missing = requiredChecks.filter(check => !enforced.has(check));
  if (missing.length) findings.push(finding('REQUIRED_CHECKS_MISSING', 'drift', `Required checks not enforced on ${profile.branches.integration}: ${missing.join(', ')}.`, 'Add them to the ruleset / branch protection or fix requiredChecks in the registry.'));
  const mechanism = rules.state === 'ok' && (rules.rules?.length ?? 0) > 0 ? 'ruleset' : 'protection';
  if (mechanism !== protection) findings.push(finding('PROTECTION_MECHANISM', 'note', `Registry says ${protection} but ${profile.branches.integration} is enforced by ${mechanism}.`, 'Align the registry or migrate the protection to a ruleset.'));
  if (protection === 'ruleset' && rules.state === 'ok' && rules.rules.length && !rules.rules.includes('pull_request')) {
    findings.push(finding('RULESET_NO_PULL_REQUEST', 'drift', 'The ruleset does not require pull requests.', 'Add the pull_request rule.'));
  }
  return findings;
}

export function checkProjectPullRequests(profile, items) {
  const own = items.filter(i => i.repository === profile.repository);
  if (!own.length) return [];
  return [finding('PROJECT_HAS_PULL_REQUESTS', 'drift', `${own.length} pull request(s) are items of Project #5 (${own.slice(0, 8).map(i => `#${i.number}`).join(', ')}${own.length > 8 ? ', …' : ''}).`, 'Remove them from the project and disable the built-in workflows that add them (#157).')];
}

export function checkIntake(profile, issues) {
  const missingType = issues.filter(i => !i.type).length;
  const missingPriority = issues.filter(i => !i.priority).length;
  const noProject = issues.filter(i => i.projectCount === 0).length;
  const dupProject = issues.filter(i => i.projectCount > 1).length;
  if (!missingType && !missingPriority && !noProject && !dupProject) return [];
  return [finding('INTAKE_GAPS', 'note', `Open Issues: ${issues.length}; without Type ${missingType}, without Priority ${missingPriority}, without Project #5 ${noProject}, duplicate Project #5 items ${dupProject}.`, 'Repair through the canonical intake writer with owner-approved values (see #159).')];
}

export function checkClosedWithOpenPrs(rows) {
  if (!rows.length) return [];
  return [finding('CLOSED_WITH_OPEN_PR', 'drift', `Closed Issues with open Development-linked PRs: ${rows.slice(0, 8).map(r => `#${r.number} → PR ${r.prs.map(n => `#${n}`).join('/')}`).join('; ')}.`, 'Reopen the Issue or merge/close the PR; close Issues only after the PR merged.')];
}

export function checkMergedPastRed(profile, rows) {
  if (profile.protection !== 'unavailable' || !profile.requiredChecks.length) return [];
  const bad = rows.filter(r => r.failed.length);
  if (!bad.length) return [];
  return [finding('MERGED_PAST_RED_CHECK', 'drift', `Merged into ${profile.branches.integration} with a failed required check in the last ${PERIOD_DAYS} days: ${bad.map(r => `PR #${r.number} (${r.failed.join(', ')})`).join('; ')}.`, 'Fix forward and upgrade the plan so required checks are enforced (#161).')];
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function auditRepository(profile, source, shared) {
  const result = { repository: profile.repository, kind: profile.kind, status: 'CONFORMANT', findings: [], notes: [], checkedAt: new Date().toISOString() };
  try {
    const ref = profile.branches.integration;
    const workflows = await source.workflowFiles(profile.repository, ref);
    const pins = extractPins(workflows);
    const findings = [
      ...checkCallers(profile, pins),
      ...await checkPins(profile, pins, source, shared.tags),
      ...checkDependabot(profile, profile.capabilities.dependabot === 'required' ? await source.repoFile(profile.repository, '.github/dependabot.yml', ref) ?? await source.repoFile(profile.repository, '.github/dependabot.yaml', ref) : null),
      ...checkRouting(profile, profile.capabilities.agentRouting === 'required' ? await source.repoFile(profile.repository, 'AGENTS.md', ref) : null, profile.capabilities.agentRouting === 'required' ? await source.repoFile(profile.repository, '.ai/context.md', ref) : null),
      ...checkProtection(profile, await source.branchRules(profile.repository, ref), await source.classicProtection(profile.repository, ref)),
      ...checkProjectPullRequests(profile, shared.projectPullRequests),
      ...checkIntake(profile, await source.openIssues(profile.repository)),
      ...checkClosedWithOpenPrs(await source.closedIssuesWithOpenPrs(profile.repository)),
    ];
    if (profile.protection === 'unavailable' && profile.requiredChecks.length) {
      const since = new Date(Date.now() - PERIOD_DAYS * 86_400_000).toISOString();
      const merged = await source.mergedPullRequests(profile.repository, ref, since);
      const rows = [];
      for (const pr of merged) {
        const runs = await source.checkRuns(profile.repository, pr.headSha);
        rows.push({ number: pr.number, failed: profile.requiredChecks.filter(name => runs.some(r => r.name === name && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion))) });
      }
      findings.push(...checkMergedPastRed(profile, rows));
    }
    result.findings = findings.filter(f => f.severity === 'drift');
    result.notes = findings.filter(f => f.severity !== 'drift');
    result.status = result.findings.length ? 'DRIFT' : 'CONFORMANT';
  } catch (error) {
    result.status = 'UNREADABLE';
    result.findings = [];
    result.error = String(error.message ?? error).slice(0, 300);
  }
  return result;
}

export async function audit({ source, registry = loadRegistry(), repositories = null }) {
  const profiles = registry.repositories.filter(p => !repositories || repositories.includes(p.repository));
  const report = { schemaVersion: 1, contract: CONFORMANCE_CONTRACT, generatedAt: new Date().toISOString(), standardVersion: registry.standardVersion, repositories: [], unregistered: [], summary: {} };
  let shared;
  try {
    shared = { tags: sortTags(await source.tags()), projectPullRequests: await source.projectPullRequests() };
  } catch (error) {
    report.repositories = profiles.map(p => ({ repository: p.repository, kind: p.kind, status: 'UNREADABLE', findings: [], notes: [], error: `shared read failed: ${String(error.message).slice(0, 200)}` }));
    report.summary = summarize(report);
    return report;
  }
  report.latestTag = shared.tags[0]?.name ?? null;
  for (const profile of profiles) report.repositories.push(await auditRepository(profile, source, shared));
  if (!repositories) {
    try {
      const org = await source.orgRepositories();
      report.unregistered = org.filter(r => !r.archived && !getRepositoryProfile(r.fullName, registry)).map(r => r.fullName).sort();
    } catch (error) { report.unregisteredError = String(error.message).slice(0, 200); }
  }
  report.summary = summarize(report);
  return report;
}

function summarize(report) {
  const count = status => report.repositories.filter(r => r.status === status).length;
  return { repositories: report.repositories.length, conformant: count('CONFORMANT'), drift: count('DRIFT'), unreadable: count('UNREADABLE'), unregistered: report.unregistered.length };
}

// ---------------------------------------------------------------------------
// Drift Issues
// ---------------------------------------------------------------------------

export function renderIssue(result, owner) {
  const drift = result.findings;
  return `${ISSUE_MARKER}${result.repository}

## Problem

\`${result.repository}\` drifts from the ChipIn Workflow Standard (workflow-registry.yaml). This Issue is maintained by the weekly \`conformance-audit\` workflow; it is rewritten on every run while drift exists and closed as completed when drift reaches zero.

## Outcome

\`${result.repository}\` conforms to its registry record (owner: ${owner}).

## Acceptance

${drift.map(f => `- [ ] ${f.check}: ${f.message} Remediation: ${f.remediation}`).join('\n')}

## References

- docs/workflow/conformance.md
- Audit time: ${result.checkedAt}
`;
}

export const parseMarker = body => {
  const first = String(body ?? '').split(/\r?\n/).find(l => l.trim() !== '') ?? '';
  const m = /^Conformance: (ChipIn-one\/[A-Za-z0-9._-]+)\s*$/.exec(first.trim());
  return m ? m[1] : null;
};

export async function upsertIssues({ report, store, registry = loadRegistry(), apply = false }) {
  const existing = new Map();
  const duplicates = [];
  for (const issue of await store.listDriftIssues()) {
    const repo = parseMarker(issue.body);
    if (!repo || issue.state !== 'open') continue;
    if (existing.has(repo)) duplicates.push({ repository: repo, number: issue.number });
    else existing.set(repo, issue);
  }
  const fallbackOwner = getRepositoryProfile(SHARED, registry)?.owner ?? null;
  const actions = [];
  for (const result of report.repositories) {
    const profile = getRepositoryProfile(result.repository, registry);
    const open = existing.get(result.repository) ?? null;
    const entry = { repository: result.repository, action: 'unchanged', number: open?.number ?? null };
    actions.push(entry);
    if (result.status === 'UNREADABLE') { entry.action = 'skipped-unreadable'; continue; }
    const owner = profile.owner ?? fallbackOwner;
    if (result.status === 'DRIFT') {
      const body = renderIssue(result, owner);
      const stable = b => String(b).replace(/^- Audit time: .*$/m, '');
      if (!open) { entry.action = 'create'; if (apply) { const made = await store.create({ repository: result.repository, title: `Conformance drift: ${result.repository}`, body, owner }); entry.number = made.number; entry.action = 'created'; } }
      else if (stable(open.body) !== stable(body)) { entry.action = 'update'; if (apply) { await store.update(open.number, body); entry.action = 'updated'; } }
    } else if (open) {
      entry.action = 'close';
      if (apply) { await store.closeCompleted(open.number, `Drift reached zero in the audit of ${result.checkedAt}; closing as completed.`); entry.action = 'closed'; }
    }
  }
  return { actions, duplicates, applied: apply };
}

export class GitHubConformanceStore {
  constructor(client, config, registry = loadRegistry()) { this.client = client; this.config = config; this.registry = registry; this.project = null; }
  async listDriftIssues() {
    const rows = await this.client.listAll(`/repos/${SHARED}/issues?state=open&sort=created&direction=asc`);
    return rows.filter(i => !i.pull_request && parseMarker(i.body)).map(i => ({ number: i.number, state: i.state, body: i.body, nodeId: i.node_id }));
  }
  async projectMeta() {
    if (!this.project) {
      const data = await this.client.graphql('query($n:Int!){organization(login:"ChipIn-one"){projectV2(number:$n){id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}', { n: this.config.project.number });
      this.project = data.organization.projectV2;
    }
    return this.project;
  }
  async setStatus(nodeId, status, itemId = null) {
    const project = await this.projectMeta();
    const option = project.field.options.find(o => o.name === status)?.id;
    if (!option) throw new Error(`Project Status option ${status} is unavailable`);
    let item = itemId;
    if (!item) {
      const added = await this.client.graphql('mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}', { p: project.id, c: nodeId });
      item = added.addProjectV2ItemById.item.id;
    }
    await this.client.graphql('mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}', { p: project.id, i: item, f: project.field.id, o: option });
    return item;
  }
  async create({ title, body, owner }) {
    const created = await this.client.request(`/repos/${SHARED}/issues`, { method: 'POST', body: { title, body, assignees: owner ? [owner] : [], type: 'Task', issue_field_values: [{ field_id: this.config.issueFields.Priority.id, value: 'P2' }] } });
    await this.setStatus(created.node_id, 'Backlog');
    const back = await this.client.request(`/repos/${SHARED}/issues/${created.number}`);
    if (back?.type?.name !== 'Task') throw new Error(`Created Issue #${created.number} did not read back with Type Task`);
    return { number: created.number };
  }
  async update(number, body) { await this.client.request(`/repos/${SHARED}/issues/${number}`, { method: 'PATCH', body: { body } }); }
  async closeCompleted(number, comment) {
    await this.client.request(`/repos/${SHARED}/issues/${number}/comments`, { method: 'POST', body: { body: comment } });
    const closed = await this.client.request(`/repos/${SHARED}/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    // Project Done is the derived mirror of closed/completed; keep it consistent without relying on built-in workflows.
    const data = await this.client.graphql('query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:5){nodes{id project{number}}}}}}', { o: 'ChipIn-one', r: '.github', n: number });
    const item = data.repository.issue.projectItems.nodes.find(i => i.project.number === this.config.project.number);
    await this.setStatus(closed.node_id, 'Done', item?.id ?? null);
  }
}

// ---------------------------------------------------------------------------
// GitHub source
// ---------------------------------------------------------------------------

const notAvailable = error => /403|Upgrade to GitHub/.test(String(error?.message)) && /Upgrade to GitHub|private repositor/i.test(String(error?.message));

export class GitHubConformanceSource {
  constructor(client, registry = loadRegistry()) { this.client = client; this.project = registry.project.number; }
  async repoFile(repository, path, ref) {
    const data = await this.client.request(`/repos/${repository}/contents/${path}?ref=${encodeURIComponent(ref)}`, { allow404: true });
    if (!data) return null;
    if (Array.isArray(data) || data.type !== 'file') return null;
    return Buffer.from(data.content ?? '', data.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  }
  async workflowFiles(repository, ref) {
    const listing = await this.client.request(`/repos/${repository}/contents/.github/workflows?ref=${encodeURIComponent(ref)}`, { allow404: true });
    if (!Array.isArray(listing)) return [];
    const files = [];
    for (const entry of listing.filter(e => e.type === 'file' && /\.ya?ml$/.test(e.name))) {
      files.push({ path: entry.path, text: await this.repoFile(repository, entry.path, ref) ?? '' });
    }
    return files;
  }
  async tags() { return (await this.client.listAll(`/repos/${SHARED}/tags`)).map(t => ({ name: t.name, sha: t.commit.sha })); }
  async compare(base, head) {
    const data = await this.client.request(`/repos/${SHARED}/compare/${base}...${head}`);
    return { status: data.status, files: (data.files ?? []).map(f => f.filename) };
  }
  async branchRules(repository, branch) {
    try {
      const rules = await this.client.request(`/repos/${repository}/rules/branches/${encodeURIComponent(branch)}`);
      const requiredChecks = rules.filter(r => r.type === 'required_status_checks').flatMap(r => (r.parameters?.required_status_checks ?? []).map(c => c.context));
      return { state: 'ok', rules: rules.map(r => r.type), requiredChecks };
    } catch (error) { return { state: notAvailable(error) ? 'unavailable' : 'unreadable' }; }
  }
  async classicProtection(repository, branch) {
    try {
      const p = await this.client.request(`/repos/${repository}/branches/${encodeURIComponent(branch)}/protection`);
      return { state: 'ok', requiredChecks: [...(p.required_status_checks?.contexts ?? []), ...(p.required_status_checks?.checks ?? []).map(c => c.context)] };
    } catch (error) {
      if (notAvailable(error)) return { state: 'unavailable' };
      if (/404/.test(String(error.message)) && /Branch not protected/.test(String(error.message))) return { state: 'unprotected' };
      return { state: 'unreadable' };
    }
  }
  async projectPullRequests() {
    const rows = [];
    let after = null;
    for (;;) {
      const data = await this.client.graphql('query($n:Int!,$a:String){organization(login:"ChipIn-one"){projectV2(number:$n){items(first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{content{__typename ... on PullRequest{number repository{nameWithOwner}}}}}}}}', { n: this.project, a: after });
      const items = data?.organization?.projectV2?.items;
      if (!items?.pageInfo) throw new Error('Project #5 items unreadable');
      for (const node of items.nodes) if (node?.content?.__typename === 'PullRequest') rows.push({ repository: node.content.repository.nameWithOwner, number: node.content.number });
      if (!items.pageInfo.hasNextPage) return rows;
      after = items.pageInfo.endCursor;
    }
  }
  async openIssues(repository) {
    const [owner, name] = repository.split('/');
    const rows = [];
    let after = null;
    for (;;) {
      const data = await this.client.graphql('query($o:String!,$r:String!,$a:String){repository(owner:$o,name:$r){issues(states:OPEN,first:100,after:$a){pageInfo{hasNextPage endCursor} nodes{number issueType{name} issueFieldValues(first:10){nodes{__typename ... on IssueFieldSingleSelectValue{name field{... on IssueFieldSingleSelect{name}}}}} projectItems(first:10){nodes{project{number}}}}}}}', { o: owner, r: name, a: after });
      const page = data?.repository?.issues;
      if (!page?.pageInfo) throw new Error(`open Issues of ${repository} unreadable`);
      for (const n of page.nodes) rows.push({ number: n.number, type: n.issueType?.name ?? null, priority: n.issueFieldValues.nodes.find(v => v.field?.name === 'Priority')?.name ?? null, projectCount: n.projectItems.nodes.filter(i => i.project.number === this.project).length });
      if (!page.pageInfo.hasNextPage) return rows;
      after = page.pageInfo.endCursor;
    }
  }
  async closedIssuesWithOpenPrs(repository) {
    const [owner, name] = repository.split('/');
    const data = await this.client.graphql('query($o:String!,$r:String!){repository(owner:$o,name:$r){issues(states:CLOSED,first:100,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number closedByPullRequestsReferences(first:10,includeClosedPrs:true){nodes{number state}}}}}}', { o: owner, r: name });
    return (data?.repository?.issues?.nodes ?? []).map(n => ({ number: n.number, prs: n.closedByPullRequestsReferences.nodes.filter(p => p.state === 'OPEN').map(p => p.number) })).filter(r => r.prs.length);
  }
  async mergedPullRequests(repository, base, since) {
    const prs = await this.client.request(`/repos/${repository}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=100`);
    return prs.filter(p => p.merged_at && p.merged_at >= since).map(p => ({ number: p.number, mergedAt: p.merged_at, headSha: p.head.sha }));
  }
  async checkRuns(repository, sha) {
    const data = await this.client.request(`/repos/${repository}/commits/${sha}/check-runs?per_page=100`);
    return (data.check_runs ?? []).map(r => ({ name: r.name, conclusion: r.conclusion }));
  }
  async orgRepositories() { return (await this.client.listAll('/orgs/ChipIn-one/repos?type=all')).map(r => ({ fullName: r.full_name, archived: r.archived })); }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function renderSummary(report) {
  const lines = [`## Conformance audit (${report.standardVersion}, latest tag ${report.latestTag ?? 'none'})`, '', '| Repository | Status | Drift | Notes |', '| --- | --- | --- | --- |'];
  for (const r of report.repositories) lines.push(`| ${r.repository} | ${r.status} | ${r.findings.length} | ${r.notes?.length ?? 0} |`);
  for (const r of report.repositories.filter(x => x.findings.length)) lines.push('', `### ${r.repository}`, ...r.findings.map(f => `- **${f.check}** ${f.message}`));
  for (const r of report.repositories.filter(x => x.status === 'UNREADABLE')) lines.push('', `### ${r.repository} UNREADABLE`, `- ${r.error}`);
  if (report.unregistered.length) lines.push('', '### UNREGISTERED (no action)', ...report.unregistered.map(n => `- ${n}`));
  return `${lines.join('\n')}\n`;
}

export async function main(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  const [command, ...rest] = argv;
  const opt = { repositories: [], apply: false, activate: null, output: null, summary: null, report: null, dir: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--apply') opt.apply = true;
    else if (flag === '--repository') opt.repositories.push(rest[++i]);
    else if (['--activate', '--output', '--summary', '--report', '--dir'].includes(flag)) opt[flag.slice(2)] = rest[++i];
    else throw new Error(`unknown argument ${flag}`);
  }
  const write = overrides.writeFile ?? writeFile;
  if (command === 'audit') {
    const source = overrides.source ?? new GitHubConformanceSource(new GitHubClient(env.GITHUB_TOKEN));
    const report = await audit({ source, repositories: opt.repositories.length ? opt.repositories : null });
    if (opt.dir) for (const r of report.repositories) await write(`${opt.dir}/conformance-${r.repository.split('/')[1].replace(/^\./, 'dot-')}.json`, JSON.stringify({ ...r, standardVersion: report.standardVersion, latestTag: report.latestTag }, null, 2) + '\n');
    if (opt.output) await write(opt.output, JSON.stringify(report, null, 2) + '\n');
    if (opt.summary) await write(opt.summary, renderSummary(report));
    if (!opt.output && !opt.summary && !opt.dir) process.stdout.write(renderSummary(report));
    process.exitCode = report.summary.unreadable ? 2 : 0;
    return report;
  }
  if (command === 'upsert') {
    if (opt.apply && (opt.activate !== ACTIVATION || env.CHIPIN_CONFORMANCE_WRITE !== '1')) throw new Error(`apply requires --activate ${ACTIVATION} and CHIPIN_CONFORMANCE_WRITE=1`);
    if (!opt.report) throw new Error('upsert needs --report <audit json>');
    const report = JSON.parse(await (overrides.readFile ?? readFile)(opt.report, 'utf8'));
    const config = JSON.parse(await readFile(new URL('./metadata-migration.config.json', import.meta.url), 'utf8'));
    const store = overrides.store ?? new GitHubConformanceStore(new GitHubClient(env.GITHUB_TOKEN), config);
    const result = await upsertIssues({ report, store, apply: opt.apply });
    const text = JSON.stringify(result, null, 2) + '\n';
    if (opt.output) await write(opt.output, text); else process.stdout.write(text);
    return result;
  }
  throw new Error('first argument must be audit or upsert');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`CONFORMANCE BLOCKED: ${error.message}\n`); process.exitCode = 2; });
}
