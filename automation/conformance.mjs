#!/usr/bin/env node
// Conformance audit of registry repositories (spec: docs/workflow/conformance.md).
// `audit` is read-only. `upsert` is the only step that writes: one drift Issue per non-conformant
// repository in ChipIn-one/.github, closed as completed when drift reaches zero. An unreadable
// repository never opens, updates or closes anything.
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHubClient, projectReadBudget, readProjectItemsPage } from './github-metadata.mjs';
import { getRepositoryProfile, loadRegistry, parseYamlSubset } from './registry.mjs';
import { githubStore, sortedVersionTags } from './release.mjs';
import { RECEIPT_STATUS_PAGE_SIZE, createReceiptResolver, readBranchHead, readProductionDeployments } from './completion.mjs';
import { compareContainsCommit } from './frontend-production-completion.mjs';

export const CONFORMANCE_CONTRACT = 'chipin-conformance/v1';
export const ISSUE_MARKER = 'Conformance: ';
export const ACTIVATION = 'conformance-v1';
const SHARED = 'ChipIn-one/.github';
const PERIOD_DAYS = 14;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

export const WORKSPACE_PATH = fileURLToPath(new URL('../docs/workflow/workspace.yaml', import.meta.url));

// Declared context file per repository (docs/workflow/workspace.yaml `contextPath`, optional): repository -> path.
// A record without contextPath has AGENTS.md as its only context file.
export function loadContextPaths({ path = WORKSPACE_PATH, text = null } = {}) {
  const document = parseYamlSubset(text ?? readFileSync(path, 'utf8'));
  return new Map((document.projects ?? []).filter(record => record.contextPath).map(record => [record.repository, record.contextPath]));
}

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
  // the shared completion engine reuses the frontend readers and the registry
  'completion-action': [/^automation\/completion(-action\/|\.mjs$)/, /^automation\/frontend-production-completion[a-z-]*(\/|\.mjs$)/,
    /^automation\/github-metadata\.mjs$/, /^automation\/registry\.mjs$/, /^workflow-registry\.yaml$/],
  'pr-gate': [/^\.github\/workflows\/pr-gate\.yml$/, /^automation\//, /^workflow-registry\.yaml$/],
  'issue-gate': [/^\.github\/workflows\/issue-gate\.yml$/, /^automation\//, /^workflow-registry\.yaml$/],
  // reusable release workflow (.github/workflows/release.yml, pin name `release`): the engine, its client and the registry
  release: [/^\.github\/workflows\/release\.yml$/, /^automation\/release(-action\/|\.mjs$)/, /^automation\/github-metadata\.mjs$/,
    /^automation\/registry\.mjs$/, /^workflow-registry\.yaml$/],
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
  // the accepted caller follows the registry strategy (docs/workflow/completion.md); integration-merge and
  // deployment-receipt both use the shared completion-action (deployment-receipt triggers: checkCompletionCaller).
  // `completionRunner: org-sweep` (.github#217) needs no repository caller; checkCompletionSweep checks the org sweep.
  ['completion', p => (p.completion === 'production-merge' ? ['frontend-production-completion-action'] : ['completion-action']),
    p => p.capabilities.completion === 'automatic' && p.completionRunner !== 'org-sweep'],
];

export function checkCallers(profile, pins) {
  // Meta repositories host the shared actions; caller checks start once they adopt pr-gate (#153).
  if (profile.kind === 'meta') return [];
  const used = new Set(pins.map(p => p.name));
  return REQUIRED_USES.filter(([, , applies]) => applies(profile))
    .map(([capability, accepted]) => [capability, typeof accepted === 'function' ? accepted(profile) : accepted])
    .filter(([, accepted]) => !accepted.some(name => used.has(name)))
    .map(([capability, accepted]) => finding('CALLER_MISSING', 'drift',
      `Capability ${capability} is ${profile.capabilities[capability]} but no workflow uses ${accepted.join(' or ')} from ChipIn-one/.github.`,
      `Add the caller workflow (docs/workflow/onboarding.md step 2) and pin it to a tagged SHA.`));
}

// Triggers a deployment-receipt completion caller needs (docs/workflow/completion.md, .github#212): the receipt
// event closes the Issue, the push writes Awaiting release. Read from the top-level `on:` block of the workflow
// file that uses completion-action (block or one-line flow form).
const RECEIPT_CALLER_TRIGGERS = ['deployment_status', 'push'];

export function workflowTriggers(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => /^(?:on|"on"|'on'):(?:\s|$)/.test(line));
  if (start === -1) return [];
  const block = [lines[start].replace(/^[^:]*:/, '')];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line) && !/^#/.test(line)) break;
    block.push(line);
  }
  const body = block.map(line => line.replace(/(^|\s)#.*$/, '')).join('\n');
  const inline = /^\s*\[([^\]]*)\]\s*$/.exec(block[0].replace(/(^|\s)#.*$/, ''));
  if (inline) return inline[1].split(',').map(name => name.trim()).filter(Boolean);
  if (block[0].trim() !== '') return [block[0].trim()];
  const indent = Math.min(...block.slice(1).filter(line => line.trim() && !/^\s*#/.test(line)).map(line => line.length - line.trimStart().length));
  return [...body.matchAll(new RegExp(`^ {${indent}}([A-Za-z_]+)\\s*:`, 'gm'))].map(match => match[1]);
}

export function checkCompletionCaller(profile, workflows, pins) {
  if (profile.kind === 'meta' || profile.capabilities.completion !== 'automatic' || profile.completion !== 'deployment-receipt') return [];
  const paths = new Set(pins.filter(pin => pin.name === 'completion-action').map(pin => pin.path));
  if (!paths.size) return []; // CALLER_MISSING already reports the missing caller
  const triggers = new Set(workflows.filter(file => paths.has(file.path)).flatMap(file => workflowTriggers(file.text)));
  const missing = RECEIPT_CALLER_TRIGGERS.filter(trigger => !triggers.has(trigger));
  if (!missing.length) return [];
  return [finding('COMPLETION_TRIGGER_MISSING', 'drift',
    `completion is deployment-receipt but the completion-action caller (${[...paths].join(', ')}) has no ${missing.join(' or ')} trigger.`,
    `Use templates/caller-completion-deployment-receipt.yml: deployment_status (success only) closes on the production receipt, push to ${profile.branches.integration} writes Awaiting release.`)];
}

// `completionRunner: org-sweep` (.github#217): the engine runs only from an org sweep workflow of ChipIn-one/.github
// (integration branch), so the repository needs no caller. The sweep must exist and be live: a workflow with a
// `schedule` trigger and a job step whose own `run:` key (not text inside a block scalar) is
// `node automation/completion.mjs --repository <repository>` (repository optionally quoted, trailing comment allowed),
// with no constant-false `if:` on the step or its job, and an env (workflow, job or step) that writes
// (CHIPIN_COMPLETION_WRITE=1), writes Awaiting release (CHIPIN_COMPLETION_AWAITING_RELEASE=1) and does not switch
// Project reconciliation off (CHIPIN_COMPLETION_PROJECT_RECONCILE=0).
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const indentOf = line => line.length - line.trimStart().length;
const isBlank = line => line.trim() === '' || /^\s*#/.test(line);
const scalar = value => String(value ?? '').replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
const BLOCK_SCALAR = /:\s*[|>][-+0-9]*\s*(?:#.*)?$/;
const CONSTANT_FALSE = /^(?:false|0|\$\{\{\s*(?:false|0)\s*\}\})$/i;

// Top-level keys of the mapping whose keys sit at `indent` in lines[from, to): { key: { value, line } }; the bodies of
// block scalars and nested mappings are skipped.
function mappingKeys(lines, from, to, indent) {
  const keys = {};
  for (let i = from; i < to; i += 1) {
    const line = lines[i];
    if (isBlank(line) || indentOf(line) !== indent) continue;
    const match = /^\s*(?:-\s+)?([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (match) keys[match[1]] = { value: match[2], line: i };
  }
  return keys;
}
// End (exclusive) of the block that starts at line `at` and holds everything indented deeper than `indent`.
function blockEnd(lines, at, indent) {
  let end = at + 1;
  while (end < lines.length && (isBlank(lines[end]) || indentOf(lines[end]) > indent)) end += 1;
  return end;
}
// `NAME: value` entries of an `env:` mapping (flow form or block form) found at keys.env.
function envOf(lines, keys, indent) {
  if (!keys.env) return {};
  const inline = /^\s*\{(.*)\}\s*(?:#.*)?$/.exec(keys.env.value);
  if (inline) return Object.fromEntries(inline[1].split(',').map(pair => pair.split(':')).filter(pair => pair.length >= 2).map(([k, ...v]) => [k.trim(), scalar(v.join(':'))]));
  const end = blockEnd(lines, keys.env.line, indent);
  const inner = lines.slice(keys.env.line + 1, end).find(line => !isBlank(line));
  if (!inner) return {};
  return Object.fromEntries(Object.entries(mappingKeys(lines, keys.env.line + 1, end, indentOf(inner))).map(([k, v]) => [k, scalar(v.value)]));
}

export function completionSweepCovers(file, repository) {
  const text = String(file.text);
  if (!workflowTriggers(text).includes('schedule')) return false;
  const lines = text.split(/\r?\n/);
  const run = new RegExp(`^node automation/completion\\.mjs\\s+--repository\\s+(['"]?)${escapeRegExp(repository)}\\1$`);
  const top = mappingKeys(lines, 0, lines.length, 0);
  if (!top.jobs) return false;
  const workflowEnv = envOf(lines, top, 0);
  const jobsEnd = blockEnd(lines, top.jobs.line, 0);
  const jobLines = lines.slice(top.jobs.line + 1, jobsEnd);
  const jobIndent = indentOf(jobLines.find(line => !isBlank(line)) ?? '');
  for (const job of Object.values(mappingKeys(lines, top.jobs.line + 1, jobsEnd, jobIndent))) {
    const jobEnd = blockEnd(lines, job.line, jobIndent);
    const firstKey = lines.slice(job.line + 1, jobEnd).find(line => !isBlank(line));
    if (!firstKey) continue;
    const jobKeys = mappingKeys(lines, job.line + 1, jobEnd, indentOf(firstKey));
    if (jobKeys.if && CONSTANT_FALSE.test(scalar(jobKeys.if.value))) continue;
    if (!jobKeys.steps) continue;
    const jobEnv = envOf(lines, jobKeys, indentOf(firstKey));
    const stepsEnd = blockEnd(lines, jobKeys.steps.line, indentOf(firstKey));
    for (let i = jobKeys.steps.line + 1; i < stepsEnd; i += 1) {
      const dash = /^(\s*)-(\s+)\S/.exec(lines[i]);
      if (!dash) continue;
      const dashIndent = dash[1].length;
      const keyColumn = dashIndent + 1 + dash[2].length;
      const stepEnd = blockEnd(lines, i, dashIndent);
      const stepKeys = mappingKeys(lines, i + 1, stepEnd, keyColumn);
      const first = /^\s*-\s+([A-Za-z_][\w-]*)\s*:(.*)$/.exec(lines[i]);
      if (first) stepKeys[first[1]] = { value: first[2], line: i };
      i = stepEnd - 1;
      if (!stepKeys.run || BLOCK_SCALAR.test(`run:${stepKeys.run.value}`) || !run.test(scalar(stepKeys.run.value))) continue;
      if (stepKeys.if && CONSTANT_FALSE.test(scalar(stepKeys.if.value))) continue;
      const env = { ...workflowEnv, ...jobEnv, ...envOf(lines, stepKeys, keyColumn) };
      if (env.CHIPIN_COMPLETION_WRITE === '1' && env.CHIPIN_COMPLETION_AWAITING_RELEASE === '1'
        && env.CHIPIN_COMPLETION_PROJECT_RECONCILE !== '0') return true;
    }
  }
  return false;
}

export function checkCompletionSweep(profile, sharedWorkflows) {
  if (profile.completionRunner !== 'org-sweep' || profile.capabilities.completion !== 'automatic') return [];
  if ((sharedWorkflows ?? []).some(file => completionSweepCovers(file, profile.repository))) return [];
  return [finding('COMPLETION_SWEEP_MISSING', 'drift',
    `completionRunner is org-sweep but no scheduled workflow in ${SHARED} runs completion.mjs --repository ${profile.repository}.`,
    `Add the org sweep (like .github/workflows/frontend-production-completion.yml) or set completionRunner: repository and add the repository caller.`)];
}

// Release flow (docs/workflow/release.md, .github#174). The registry `release` block against reality: a caller of the
// reusable release workflow, the latest `<tagPrefix>X.Y.Z` tag on the release branch history, a published GitHub
// Release for each of the newest RELEASE_TAGS_CHECKED tags (bounded API cost). `none` is a note only.
export const RELEASE_WORKFLOW = '.github/workflows/release.yml';
export const RELEASE_TAGS_CHECKED = 5;
// promotion-merge releases from the promotion branch; integration-merge and deploy-tag (the deployed SHA comes from the
// integration branch) from the integration branch
// Triggers of the workflow file that calls release.yml, per registry trigger (any one is enough). production-deploy
// accepts a deployment_status workflow (frontend), a workflow_run after the deploy, or a job inside the
// workflow_dispatch deploy workflow (backend).
export const RELEASE_CALLER_TRIGGERS = {
  'integration-merge': ['push'],
  'promotion-merge': ['push'],
  'production-deploy': ['deployment_status', 'workflow_run', 'workflow_dispatch'],
};
export const releaseBranchOf = profile => (profile.release.trigger === 'promotion-merge' ? profile.branches.promotion : profile.branches.integration);

// facts: { tags: newest first [{ name, sha }], latestStatus: compare status of latest tag...release branch,
// releases: Map(tag name -> { draft } | null) for the newest RELEASE_TAGS_CHECKED tags }
export function checkRelease(profile, pins, facts, workflows = []) {
  const { strategy, trigger, tagPrefix } = profile.release;
  if (strategy === 'none') {
    return [finding('RELEASE_UNVERSIONED', 'note', 'Release strategy is none: the repository is intentionally unversioned (no tags, no Releases, no release caller).', 'None; set a release strategy in workflow-registry.yaml if it should be versioned.')];
  }
  const findings = [];
  const callerShape = trigger === 'production-deploy'
    ? 'a deployment_status workflow on the successful production deployment (like chipin-frontend .github/workflows/release-on-production.yml) or a job after the successful deploy in the deploy workflow'
    : trigger === 'promotion-merge' ? 'templates/caller-release-promotion.yml' : 'templates/caller-release-integration.yml';
  const callerPaths = new Set(pins.filter(pin => pin.target === RELEASE_WORKFLOW).map(pin => pin.path));
  const expected = RELEASE_CALLER_TRIGGERS[trigger] ?? [];
  if (!callerPaths.size) {
    findings.push(finding('RELEASE_CALLER_MISSING', 'drift', `Release strategy is ${strategy} (${trigger}) but no workflow uses ${RELEASE_WORKFLOW} from ${SHARED}.`,
      `Add the release caller (${callerShape}) and pin it to a tagged SHA (docs/workflow/release.md).`));
  } else if (expected.length) {
    const triggers = new Set(workflows.filter(file => callerPaths.has(file.path)).flatMap(file => workflowTriggers(file.text)));
    if (!expected.some(name => triggers.has(name))) {
      findings.push(finding('RELEASE_TRIGGER_MISSING', 'drift',
        `Release trigger is ${trigger} but the release caller (${[...callerPaths].join(', ')}) has no ${expected.join(' or ')} trigger (has: ${[...triggers].join(', ') || 'none'}).`,
        `Run the release caller from ${callerShape} (docs/workflow/release.md).`));
    }
  }
  const branch = releaseBranchOf(profile);
  const latest = facts.tags[0] ?? null;
  if (!latest) {
    findings.push(finding('RELEASE_NO_TAGS', 'note', `No ${tagPrefix}X.Y.Z tag exists yet.`, 'The first release needs release.mjs --initial-version X.Y.Z (docs/workflow/release.md).'));
    return findings;
  }
  if (!['ahead', 'identical'].includes(facts.latestStatus)) {
    findings.push(finding('RELEASE_TAG_OFF_BRANCH', 'drift', `The latest tag ${latest.name} (${latest.sha.slice(0, 7)}) is not on the history of ${branch} (compare status ${facts.latestStatus}).`,
      `Tag a commit of ${branch}: the release engine takes the previous tag from the ancestors of the release commit${facts.latestStatus === 'not-found' ? ' (the compare returned 404: an orphan tag commit or a missing branch)' : ''}.`));
  }
  const missing = facts.tags.slice(0, RELEASE_TAGS_CHECKED).filter(tag => !facts.releases.get(tag.name) || facts.releases.get(tag.name).draft).map(tag => tag.name);
  if (missing.length) {
    findings.push(finding('RELEASE_MISSING', 'drift', `Tag(s) without a published GitHub Release (newest ${RELEASE_TAGS_CHECKED} checked): ${missing.join(', ')}.`,
      'Run the release caller (release.mjs apply) for the tagged commit, which creates only the Release, or publish the Release by hand.'));
  }
  return findings;
}

export async function readReleaseFacts(profile, source) {
  if (profile.release.strategy === 'none') return { tags: [], latestStatus: null, releases: new Map() };
  const tags = sortedVersionTags(await source.versionTags(profile.repository, profile.release.tagPrefix), profile.release.tagPrefix);
  if (!tags.length) return { tags, latestStatus: null, releases: new Map() };
  const latestStatus = await source.branchStatus(profile.repository, tags[0].sha, releaseBranchOf(profile));
  const releases = new Map();
  for (const tag of tags.slice(0, RELEASE_TAGS_CHECKED)) releases.set(tag.name, await source.release(profile.repository, tag.name));
  return { tags, latestStatus, releases };
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

const ROUTING_START = '<!-- ai-workflow:agents-routing:start -->';
const ROUTING_END = '<!-- ai-workflow:agents-routing:end -->';
// links to the retired personal canon, any case: github.com/syllik (www., gist., raw.githubusercontent.com, git@github.com:),
// api.github.com/repos|users/syllik, syllik.github.io
const PERSONAL_CANON = /(?<![\w.-])(?:(?:www|gist|raw)\.)?github(?:usercontent)?\.com[/:]syllik(?![\w-])|(?<![\w.-])api\.github\.com\/(?:repos|users)\/syllik(?![\w-])|(?<![\w.-])syllik\.github\.io/gi;
// zero-width and bidi controls (incl. isolates and the Arabic letter mark): invisible to a reviewer, readable to an agent
const HIDDEN = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u061C\uFEFF]/;
// URLs in the managed block: any scheme, git@host:path, or a bare host/path
const URLS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()[\]"'`]+|\bgit@[^\s:]+:[^\s<>()[\]"'`]+|(?<![\w:/])\/\/[^\s<>()[\]"'`]+|(?<![\w./:@-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>()[\]"'`]*/gi;
const ALLOWED_URL = /^https:\/\/(?:github\.com|raw\.githubusercontent\.com)\/ChipIn-one\//;
// dot segments (plain or percent-encoded) and encoded separators could leave the ChipIn-one prefix once resolved
const UNSAFE_PATH = /\/\.{1,2}(?:[/?#]|$)|%2e|%2f|%5c|\\/i;
const allowedUrl = url => ALLOWED_URL.test(url) && !UNSAFE_PATH.test(url);

// The managed block from the start marker through the end marker, inclusive, exactly as written.
// Exactly one start and one end marker, the end after the start.
export function extractRoutingBlock(text) {
  const value = text == null ? '' : String(text);
  const starts = value.split(ROUTING_START).length - 1;
  const ends = value.split(ROUTING_END).length - 1;
  if (!starts) return { state: 'missing' };
  if (starts > 1 || ends > 1) return { state: 'duplicated' };
  const start = value.indexOf(ROUTING_START);
  const end = value.indexOf(ROUTING_END, start);
  if (end < 0) return { state: 'unterminated' };
  return { state: 'ok', block: value.slice(start, end + ROUTING_END.length) };
}

// A drift detector, not a security control: text outside the block is guarded only by review in the consumer repository.
// canon: extractRoutingBlock() of .github AGENTS.md on its integration branch (audit() makes a failed read UNREADABLE).
// contextPath: the workspace record's optional contextPath; without it `context` is not read and not required.
export function checkRouting(profile, agents, context, canon, contextPath = null) {
  if (profile.capabilities.agentRouting !== 'required') return [];
  const findings = [];
  const own = extractRoutingBlock(agents);
  const branch = profile.branches.integration;
  const copy = 'Copy the block byte-for-byte from ChipIn-one/.github AGENTS.md, markers included (docs/workflow/onboarding.md step 5).';
  if (own.state === 'missing') {
    findings.push(finding('ROUTING_BLOCK_MISSING', 'drift', `AGENTS.md on ${branch} has no ai-workflow:agents-routing block.`, 'Add the managed routing block (docs/workflow/onboarding.md step 5).'));
  } else if (own.state === 'duplicated') {
    findings.push(finding('ROUTING_BLOCK_DUPLICATED', 'drift', `AGENTS.md on ${branch} has more than one ai-workflow:agents-routing start or end marker.`, `Keep exactly one block. ${copy}`));
  } else if (own.state === 'unterminated') {
    findings.push(finding('ROUTING_BLOCK_UNTERMINATED', 'drift', `AGENTS.md on ${branch} has the ai-workflow:agents-routing start marker but no end marker after it.`, copy));
  } else if (canon?.state === 'ok' && own.block !== canon.block) {
    findings.push(finding('ROUTING_BLOCK_STALE', 'drift', `The ai-workflow:agents-routing block in AGENTS.md on ${branch} differs from the block in ChipIn-one/.github AGENTS.md.`, copy));
  }
  // one trailing sentence mark belongs to the prose, not to the URL
  const foreign = own.state === 'ok' ? (own.block.match(URLS) ?? []).map(url => url.replace(/[.,;:!?]$/, '')).filter(url => !allowedUrl(url)) : [];
  if (foreign.length) {
    findings.push(finding('ROUTING_BLOCK_FOREIGN_URL', 'drift', `The ai-workflow:agents-routing block in AGENTS.md on ${branch} links outside https://github.com/ChipIn-one and https://raw.githubusercontent.com/ChipIn-one: ${foreign.slice(0, 3).join(', ')}${foreign.length > 3 ? ', …' : ''}.`, 'Link only ChipIn-one on github.com or raw.githubusercontent.com over https.'));
  }
  const files = [['AGENTS.md', agents], ...(contextPath ? [[contextPath, context]] : [])];
  const hidden = files.filter(([, text]) => text != null && HIDDEN.test(String(text))).map(([path]) => path);
  if (hidden.length) {
    findings.push(finding('ROUTING_HIDDEN_CHARACTERS', 'drift', `Zero-width or bidi control characters on ${branch} in ${hidden.join(', ')}.`, 'Remove them (U+061C, U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+2066–U+2069, U+FEFF).'));
  }
  const personal = files
    .map(([path, text]) => [path, text == null ? 0 : (String(text).match(PERSONAL_CANON) ?? []).length]).filter(([, n]) => n);
  if (personal.length) {
    findings.push(finding('ROUTING_PERSONAL_CANON', 'drift', `Links to the retired personal canon (syllik) on ${branch}: ${personal.map(([path, n]) => `${path}: ${n}`).join(', ')}.`, 'Remove them; the canon is ChipIn-one/.github docs/workflow (#15).'));
  }
  if (canon?.state !== 'ok') {
    findings.push(finding('ROUTING_CANON_UNREADABLE', 'note', `ChipIn-one/.github AGENTS.md has ${canon ? `a ${canon.state} routing block` : 'not been read'}, so the block could not be compared.`, 'Fix the block in ChipIn-one/.github AGENTS.md (exactly one, both markers).'));
  }
  if (contextPath && context == null) findings.push(finding('AI_CONTEXT_MISSING', 'drift', `${contextPath} is missing on ${branch}.`, `Add ${contextPath} or drop contextPath from the workspace.yaml record (docs/workflow/onboarding.md step 5).`));
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
  // The other mechanism may hide the enforcement: an unreadable answer is "unverifiable", never drift.
  if (missing.length && (rules.state === 'unreadable' || classic.state === 'unreadable')) {
    return [finding('PROTECTION_UNVERIFIABLE', 'note', `Required checks (${missing.join(', ')}) were not found, but the audit token cannot read ${rules.state === 'unreadable' ? 'rulesets' : 'classic branch protection'}.`, 'Grant the audit token administration:read or verify by hand.')];
  }
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
  return [finding('PROJECT_HAS_PULL_REQUESTS', 'drift', `${own.length} pull request(s) are items of Project #5 (${own.slice(0, 8).map(i => `#${i.number}`).join(', ')}${own.length > 8 ? ', …' : ''}).`, 'Remove them from the project: Project #5 holds Issues only; check the built-in workflows in docs/workflow/README.md#project-5-built-in-workflows (#157).')];
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

// Early close guard (.github#181). For the strategies whose completion waits for production (production-merge,
// deployment-receipt), an Issue closed as completed while a Development-linked PR is merged into the integration
// branch but its merge commit is not yet in production has switched the completion engine off for that Issue.
// Read-only: the audit reports such Issues; it never reopens, edits or comments on them.
// Bound: Issues closed in the last CLOSED_BEFORE_PRODUCTION_DAYS days, read newest-updated first in at most
// CLOSED_SCAN_MAX_PAGES pages of CLOSED_SCAN_PAGE_SIZE (a fuller window is reported as a note, not as clean).
export const CLOSED_BEFORE_PRODUCTION_STRATEGIES = Object.freeze(['production-merge', 'deployment-receipt']);
export const CLOSED_BEFORE_PRODUCTION_DAYS = 30;
export const CLOSED_SCAN_PAGE_SIZE = 50;
export const CLOSED_SCAN_MAX_PAGES = 4;
// Closes by these actors come from the completion engine (repository callers run as github-actions). The org sweep
// closes with CHIPIN_ISSUE_WRITE_TOKEN, a PAT that acts as its owner, so its closes cannot be told apart by actor;
// they need no exclusion: the engine closes only when a valid production receipt (or the promotion head) already
// contains every merge commit, so an engine close is never "not yet in production".
export const COMPLETION_ENGINE_ACTORS = Object.freeze(['github-actions', 'github-actions[bot]']);

export const closedBeforeProductionApplies = profile => profile.kind !== 'meta' && CLOSED_BEFORE_PRODUCTION_STRATEGIES.includes(profile.completion);

// Pure filter over normalized closed Issues ({ number, closedAt, stateReason, closedBy, linkedPullRequests:
// [{ number, repository, mergedAt, baseRefName, mergeCommitSha }] }): completed closes in the window, not by an engine
// actor, with at least one same-repository PR merged into the integration branch. Returns the merged PRs to check.
export function closedBeforeProductionCandidates(profile, issues, since) {
  const integration = profile.branches.integration;
  const rows = [];
  for (const issue of issues) {
    if (!issue.closedAt || issue.closedAt < since || issue.stateReason !== 'COMPLETED') continue;
    if (COMPLETION_ENGINE_ACTORS.includes(issue.closedBy)) continue;
    const prs = (issue.linkedPullRequests ?? []).filter(pr => pr.repository === profile.repository && pr.mergedAt
      && pr.baseRefName === integration && SHA.test(String(pr.mergeCommitSha ?? '')));
    if (prs.length) rows.push({ number: issue.number, closedAt: issue.closedAt, closedBy: issue.closedBy ?? 'unknown', prs });
  }
  return rows;
}

// scan: { since, issues, truncated }; production: async () => ({ label, contains: async mergeSha => boolean }), called
// only when a candidate exists. Any read error of the production evidence propagates (the repository is UNREADABLE).
export async function checkClosedBeforeProduction(profile, scan, production) {
  if (!closedBeforeProductionApplies(profile)) return [];
  const findings = [];
  if (scan.truncated) {
    findings.push(finding('CLOSED_BEFORE_PRODUCTION_WINDOW_FULL', 'note',
      `More than ${CLOSED_SCAN_PAGE_SIZE * CLOSED_SCAN_MAX_PAGES} Issues were updated since ${scan.since.slice(0, 10)}; only the newest were checked for CLOSED_BEFORE_PRODUCTION.`,
      'None; older closes in the window were not checked. Raise CLOSED_SCAN_MAX_PAGES if this repeats.'));
  }
  const candidates = closedBeforeProductionCandidates(profile, scan.issues, scan.since);
  if (!candidates.length) return findings;
  const evidence = await production();
  const early = [];
  for (const row of candidates) {
    const pending = [];
    for (const pr of row.prs) if (!(await evidence.contains(pr.mergeCommitSha))) pending.push(pr);
    if (pending.length) early.push({ ...row, pending });
  }
  if (!early.length) return findings;
  const list = early.map(r => `#${r.number} (closed ${r.closedAt.slice(0, 10)} by ${r.closedBy}; ${r.pending.map(pr => `PR #${pr.number} ${pr.mergeCommitSha.slice(0, 7)}`).join(', ')} not in production)`);
  findings.push(finding('CLOSED_BEFORE_PRODUCTION', 'drift',
    `${early.length} Issue(s) closed as completed in the last ${CLOSED_BEFORE_PRODUCTION_DAYS} days while a linked PR merged into ${profile.branches.integration} is not yet in ${evidence.label}: ${list.join('; ')}.`,
    `Reopen each Issue so the completion engine closes it once production contains the merge (Awaiting release shows the wait), or leave it closed if the owner accepts the early close; the finding clears when production contains every listed merge commit. Close ${profile.repository} Issues by hand only after production (docs/workflow/completion.md).`));
  return findings;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function auditRepository(profile, source, shared) {
  const result = { repository: profile.repository, kind: profile.kind, status: 'CONFORMANT', findings: [], notes: [], checkedAt: new Date().toISOString() };
  try {
    const ref = profile.branches.integration;
    const routing = profile.capabilities.agentRouting === 'required';
    const contextPath = shared.contextPaths?.get(profile.repository) ?? null;
    const workflows = await source.workflowFiles(profile.repository, ref);
    const pins = extractPins(workflows);
    const findings = [
      ...checkCallers(profile, pins),
      ...checkCompletionCaller(profile, workflows, pins),
      ...checkCompletionSweep(profile, shared.workflows),
      ...checkRelease(profile, pins, await readReleaseFacts(profile, source), workflows),
      ...await checkPins(profile, pins, source, shared.tags),
      ...checkDependabot(profile, profile.capabilities.dependabot === 'required' ? await source.repoFile(profile.repository, '.github/dependabot.yml', ref) ?? await source.repoFile(profile.repository, '.github/dependabot.yaml', ref) : null),
      ...checkRouting(profile, routing ? await source.repoFile(profile.repository, 'AGENTS.md', ref) : null, routing && contextPath ? await source.repoFile(profile.repository, contextPath, ref) : null, shared.routingCanon, contextPath),
      ...checkProtection(profile, await source.branchRules(profile.repository, ref), await source.classicProtection(profile.repository, ref)),
      ...checkProjectPullRequests(profile, shared.projectPullRequests),
      ...checkIntake(profile, await source.openIssues(profile.repository)),
      ...checkClosedWithOpenPrs(await source.closedIssuesWithOpenPrs(profile.repository)),
    ];
    if (closedBeforeProductionApplies(profile)) {
      const since = new Date(Date.now() - CLOSED_BEFORE_PRODUCTION_DAYS * 86_400_000).toISOString();
      try {
        const scan = { since, ...await source.recentlyClosedIssues(profile.repository, since) };
        findings.push(...await checkClosedBeforeProduction(profile, scan, () => source.productionContainment(profile)));
      } catch (error) {
        // unreadable closes or production evidence is never "clean": the repository becomes UNREADABLE below
        throw new Error(`CLOSED_BEFORE_PRODUCTION unreadable: ${String(error?.message ?? error)}`);
      }
    }
    if (profile.protection === 'unavailable' && profile.requiredChecks.length) {
      try {
        const since = new Date(Date.now() - PERIOD_DAYS * 86_400_000).toISOString();
        const merged = await source.mergedPullRequests(profile.repository, ref, since);
        const rows = [];
        for (const pr of merged) {
          const runs = await source.checkRuns(profile.repository, pr.headSha);
          rows.push({ number: pr.number, failed: profile.requiredChecks.filter(name => runs.some(r => r.name === name && ['failure', 'timed_out', 'cancelled', 'action_required'].includes(r.conclusion))) });
        }
        findings.push(...checkMergedPastRed(profile, rows));
      } catch (error) {
        // A token without checks:read cannot judge this one check; the rest of the audit stays valid.
        if (!/\b403\b/.test(String(error?.message))) throw error;
        findings.push(finding('CHECKS_UNVERIFIABLE', 'note', 'The audit token cannot read check runs, so merges past a red required check could not be verified.', 'Grant the audit token checks:read (and pull requests: read).'));
      }
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

export async function audit({ source, registry = loadRegistry(), repositories = null, contextPaths = loadContextPaths() }) {
  const profiles = registry.repositories.filter(p => !repositories || repositories.includes(p.repository));
  const report = { schemaVersion: 1, contract: CONFORMANCE_CONTRACT, generatedAt: new Date().toISOString(), standardVersion: registry.standardVersion, repositories: [], unregistered: [], summary: {} };
  let shared;
  try {
    shared = { tags: sortTags(await source.tags()), projectPullRequests: await source.projectPullRequests(), workflows: [], workflowsError: null, contextPaths };
  } catch (error) {
    report.repositories = profiles.map(p => ({ repository: p.repository, kind: p.kind, status: 'UNREADABLE', findings: [], notes: [], error: `shared read failed: ${String(error.message).slice(0, 200)}` }));
    report.summary = summarize(report);
    return report;
  }
  report.latestTag = shared.tags[0]?.name ?? null;
  // org sweep workflows (checkCompletionSweep): read only when an audited record relies on one; a failed read makes
  // only those records UNREADABLE
  const sweepProfiles = profiles.filter(p => p.completionRunner === 'org-sweep');
  if (sweepProfiles.length) {
    try {
      shared.workflows = await source.workflowFiles(SHARED, getRepositoryProfile(SHARED, registry)?.branches.integration ?? 'master');
    } catch (error) { shared.workflowsError = String(error.message ?? error).slice(0, 200); }
  }
  // the managed routing block every record copies byte-for-byte (checkRouting): read once, only when a record needs it;
  // a failed read makes only those records UNREADABLE (a missing block there is a note: the .github record shows the drift)
  const routing = p => p.capabilities.agentRouting === 'required';
  if (profiles.some(routing)) {
    try {
      shared.routingCanon = extractRoutingBlock(await source.repoFile(SHARED, 'AGENTS.md', getRepositoryProfile(SHARED, registry)?.branches.integration ?? 'master'));
    } catch (error) { shared.routingCanonError = String(error.message ?? error).slice(0, 200); }
  }
  for (const profile of profiles) {
    if (shared.workflowsError && profile.completionRunner === 'org-sweep') {
      report.repositories.push({ repository: profile.repository, kind: profile.kind, status: 'UNREADABLE', findings: [], notes: [], error: `org sweep workflows unreadable: ${shared.workflowsError}` });
      continue;
    }
    if (shared.routingCanonError && routing(profile)) {
      report.repositories.push({ repository: profile.repository, kind: profile.kind, status: 'UNREADABLE', findings: [], notes: [], error: `routing canon unreadable: ${shared.routingCanonError}` });
      continue;
    }
    report.repositories.push(await auditRepository(profile, source, shared));
  }
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
  constructor(client, registry = loadRegistry(), { pageRetry = {} } = {}) { this.client = client; this.project = registry.project.number; this.pageRetry = pageRetry; }
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
  // release flow (checkRelease): tags and Releases are read exactly as the release engine reads them
  async versionTags(repository, tagPrefix) { return githubStore(this.client, repository).listVersionTags(tagPrefix); }
  async release(repository, tag) { return githubStore(this.client, repository).readRelease(tag); }
  // status of base...branch only (ahead/identical = base is on the branch history); one commit per page keeps it cheap.
  // A 404 (orphan tag commit, missing branch) is `not-found`, reported as RELEASE_TAG_OFF_BRANCH, not UNREADABLE.
  async branchStatus(repository, base, branch) {
    const data = await this.client.request(`/repos/${repository}/compare/${base}...${encodeURIComponent(branch)}?per_page=1`, { allow404: true });
    if (data === null) return 'not-found';
    if (!data?.status) throw new Error(`compare ${base.slice(0, 7)}...${branch} of ${repository} unreadable`);
    return data.status;
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
    let totalCount = null;
    let read = 0;
    const budget = projectReadBudget(this.pageRetry);
    for (;;) {
      const select = d => d?.organization?.projectV2?.items;
      const data = await readProjectItemsPage(this.client, 'query($n:Int!,$a:String){organization(login:"ChipIn-one"){projectV2(number:$n){items(first:100,after:$a){totalCount pageInfo{hasNextPage endCursor} nodes{content{__typename ... on PullRequest{number repository{nameWithOwner}}}}}}}}', { n: this.project, a: after }, { ...this.pageRetry, budget, after, select });
      const items = select(data);
      if (!items?.pageInfo || !Array.isArray(items.nodes) || !Number.isInteger(items.totalCount)) throw new Error('Project #5 items unreadable');
      totalCount ??= items.totalCount;
      read += items.nodes.length;
      for (const node of items.nodes) if (node?.content?.__typename === 'PullRequest') rows.push({ repository: node.content.repository.nameWithOwner, number: node.content.number });
      if (!items.pageInfo.hasNextPage) {
        if (read !== totalCount) throw new Error(`Project #5 items pagination is incomplete: read ${read} of ${totalCount}`);
        return rows;
      }
      if (!items.pageInfo.endCursor) throw new Error('Project #5 items pagination cursor is missing');
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
  // Issues closed since `since` (CLOSED_BEFORE_PRODUCTION): filterBy.since keeps Issues updated since then, which
  // includes every Issue closed since then; newest-updated first, at most CLOSED_SCAN_MAX_PAGES pages.
  async recentlyClosedIssues(repository, since, { pageSize = CLOSED_SCAN_PAGE_SIZE, maxPages = CLOSED_SCAN_MAX_PAGES } = {}) {
    const [owner, name] = repository.split('/');
    const issues = [];
    let after = null;
    for (let page = 1; page <= maxPages; page += 1) {
      const data = await this.client.graphql('query($o:String!,$r:String!,$s:DateTime!,$n:Int!,$a:String){repository(owner:$o,name:$r){issues(states:CLOSED,first:$n,after:$a,orderBy:{field:UPDATED_AT,direction:DESC},filterBy:{since:$s}){pageInfo{hasNextPage endCursor} nodes{number closedAt stateReason timelineItems(last:1,itemTypes:[CLOSED_EVENT]){nodes{... on ClosedEvent{actor{login}}}} closedByPullRequestsReferences(first:50,includeClosedPrs:true){totalCount nodes{number mergedAt baseRefName repository{nameWithOwner} mergeCommit{oid}}}}}}}', { o: owner, r: name, s: since, n: pageSize, a: after });
      const connection = data?.repository?.issues;
      if (!connection?.pageInfo || !Array.isArray(connection.nodes)) throw new Error(`closed Issues of ${repository} unreadable`);
      for (const node of connection.nodes) {
        const linked = node.closedByPullRequestsReferences;
        if (!linked || !Array.isArray(linked.nodes) || linked.totalCount !== linked.nodes.length) throw new Error(`Development-linked PRs of ${repository}#${node.number} are incomplete`);
        issues.push({
          number: node.number, closedAt: node.closedAt, stateReason: node.stateReason,
          closedBy: node.timelineItems?.nodes?.at(-1)?.actor?.login ?? null,
          linkedPullRequests: linked.nodes.map(pr => ({ number: pr.number, repository: pr.repository?.nameWithOwner ?? null, mergedAt: pr.mergedAt, baseRefName: pr.baseRefName, mergeCommitSha: pr.mergeCommit?.oid ?? null })),
        });
      }
      if (!connection.pageInfo.hasNextPage) return { issues, truncated: false };
      if (!connection.pageInfo.endCursor) throw new Error(`closed Issues of ${repository}: pagination cursor is missing`);
      after = connection.pageInfo.endCursor;
    }
    return { issues, truncated: true };
  }
  // Current production evidence, read the way the completion engine reads it (automation/completion.mjs):
  // deployment-receipt = the newest valid receipt of the registry productionEvidence that contains the commit;
  // production-merge = the promotion branch head contains the commit. A window without any valid receipt is
  // unreadable, never "nothing reached production".
  async productionContainment(profile) {
    const repository = profile.repository;
    const containsCommit = (commit, head) => compareContainsCommit(this.client, repository, commit, head);
    if (profile.completion === 'production-merge') {
      const head = await readBranchHead(this.client, repository, profile.branches.promotion);
      return { label: `${profile.branches.promotion} (${head.slice(0, 7)})`, contains: sha => containsCommit(sha, head) };
    }
    const { environment, creator } = profile.productionEvidence ?? {};
    if (!environment || !creator) throw new Error(`${repository} has no productionEvidence in the registry`);
    const integrationHeadSha = await readBranchHead(this.client, repository, profile.branches.integration);
    const window = await readProductionDeployments(this.client, repository, { environment });
    const resolver = createReceiptResolver({
      deployments: window.deployments.filter(d => d?.environment === environment && d?.creator?.login === creator),
      environment, creator, integrationHeadSha, containsCommit,
      readStatuses: id => this.client.request(`/repos/${repository}/deployments/${id}/statuses?per_page=${RECEIPT_STATUS_PAGE_SIZE}`),
    });
    return {
      label: `a valid ${environment} receipt by ${creator}`,
      contains: async sha => {
        if (await resolver.findReceipt(sha)) return true;
        if (!(await resolver.checked()).some(row => row.valid)) throw new Error(`no valid ${environment} receipt by ${creator} among the newest ${window.read} deployment(s) of ${repository}`);
        return false;
      },
    };
  }
  async mergedPullRequests(repository, base, since) {
    const prs = await this.client.request(`/repos/${repository}/pulls?state=closed&base=${encodeURIComponent(base)}&sort=updated&direction=desc&per_page=100`);
    return prs.filter(p => p.merged_at && p.merged_at >= since).map(p => ({ number: p.number, mergedAt: p.merged_at, headSha: p.head.sha }));
  }
  // Fine-grained personal access tokens have no "Checks" permission (GitHub Apps only), so the check-runs
  // endpoint answers 403 for them. Jobs of Actions runs for the same SHA carry the same names and
  // conclusions and need only "Actions: Read-only". A required check that is not an Actions job is unverifiable.
  async checkRuns(repository, sha) {
    try {
      const data = await this.client.request(`/repos/${repository}/commits/${sha}/check-runs?per_page=100`);
      return (data.check_runs ?? []).map(r => ({ name: r.name, conclusion: r.conclusion }));
    } catch (error) {
      if (!/\b403\b/.test(String(error?.message))) throw error;
    }
    const runs = await this.client.request(`/repos/${repository}/actions/runs?head_sha=${sha}&per_page=100`);
    const jobs = [];
    for (const run of runs.workflow_runs ?? []) {
      const page = await this.client.request(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`);
      jobs.push(...(page.jobs ?? []).map(j => ({ name: j.name, conclusion: j.conclusion })));
    }
    return jobs;
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
