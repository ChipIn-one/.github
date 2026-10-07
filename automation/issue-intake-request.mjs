#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  isSupportedIntakeRepository,
  parseIssueRef,
  run as runIntake,
  validateClassification,
} from './issue-intake.mjs';
import { GitHubClient } from './github-metadata.mjs';

const REQUEST_SCHEMA_VERSION = 1;
const BRIDGE_SCHEMA_VERSION = 1;
const REQUEST_TITLE_PREFIX = '[issue-intake]';
const REQUEST_MARKER = 'chipin-issue-intake-request:v1';
const QUEUE_MARKER = 'chipin-issue-intake-queued:v1';
const RESULT_MARKER = 'chipin-issue-intake-result:v1';
const QUEUE_COMMENT_AUTHOR = 'github-actions[bot]';
const TRUSTED_ACTORS = new Set(['syllik', QUEUE_COMMENT_AUTHOR]);
const ALLOWED_REQUEST_KEYS = new Set([
  'target',
  'issueType',
  'priority',
  'severity',
]);

function normalizeSeverity(value) {
  if (value == null || value === '' || String(value).toLowerCase() === 'none') return 'none';
  return String(value);
}

function uniqueMarkerPayload(body) {
  const text = String(body ?? '');
  const startToken = `<!-- ${REQUEST_MARKER}`;
  const starts = [];
  let offset = 0;
  while (true) {
    const index = text.indexOf(startToken, offset);
    if (index === -1) break;
    starts.push(index);
    offset = index + startToken.length;
  }
  if (starts.length !== 1) {
    throw new Error(`Expected exactly one ${REQUEST_MARKER} marker, found ${starts.length}.`);
  }
  const start = starts[0] + startToken.length;
  const end = text.indexOf('-->', start);
  if (end === -1) throw new Error('Request marker is missing closing -->.');
  const raw = text.slice(start, end).trim();
  if (!raw) throw new Error('Request marker payload is empty.');
  return raw;
}

export function parseRequestBody(body) {
  let parsed;
  try {
    parsed = JSON.parse(uniqueMarkerPayload(body));
  } catch (error) {
    throw new Error(`Invalid intake request payload: ${error.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Intake request payload must be a JSON object.');
  }
  const keys = Object.keys(parsed);
  const unexpected = keys.filter((key) => !ALLOWED_REQUEST_KEYS.has(key));
  if (unexpected.length) {
    throw new Error(`Unsupported intake request keys: ${unexpected.join(', ')}.`);
  }
  for (const key of ['target', 'issueType', 'priority']) {
    if (typeof parsed[key] !== 'string' || !parsed[key].trim()) {
      throw new Error(`Intake request field ${key} must be a non-empty string.`);
    }
  }
  if (parsed.severity != null && typeof parsed.severity !== 'string') {
    throw new Error('Intake request field severity must be a string when present.');
  }
  return {
    target: parsed.target.trim(),
    issueType: parsed.issueType.trim(),
    priority: parsed.priority.trim(),
    severity: normalizeSeverity(parsed.severity),
  };
}


function markerJson(body, marker) {
  const text = String(body ?? '');
  const token = '<!-- ' + marker;
  const start = text.indexOf(token);
  if (start === -1 || text.indexOf(token, start + token.length) !== -1) return null;
  const end = text.indexOf('-->', start + token.length);
  if (end === -1) return null;
  const raw = text.slice(start + token.length, end).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function validateQueuedRequest(config, rawRequest) {
  const blockers = [];
  const request = {
    target: typeof rawRequest?.target === 'string' ? rawRequest.target.trim() : '',
    issueType: typeof rawRequest?.issueType === 'string' ? rawRequest.issueType.trim() : '',
    priority: typeof rawRequest?.priority === 'string' ? rawRequest.priority.trim() : '',
    severity: normalizeSeverity(rawRequest?.severity),
  };

  try {
    const target = parseIssueRef(request.target);
    if (!isSupportedIntakeRepository(target.repository)) {
      blockers.push('Target repository is outside canonical ChipIn intake scope: ' + target.repository + '.');
    }
  } catch (error) {
    blockers.push(error.message);
  }

  const checked = validateClassification(config, request);
  blockers.push(...checked.blockers);
  return {
    valid: blockers.length === 0,
    blockers,
    request: {
      ...request,
      severity: checked.classification.severity ?? 'none',
    },
  };
}

export function renderQueueComment(request) {
  const payload = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    requestIssue: request.requestIssue,
    requestIssueUrl: request.requestIssueUrl ?? null,
    actor: request.actor ?? null,
    triggerActor: request.triggerActor ?? null,
    target: request.target,
    issueType: request.issueType,
    priority: request.priority,
    severity: request.severity ?? 'none',
  };
  return [
    '<!-- ' + QUEUE_MARKER,
    JSON.stringify(payload),
    '-->',
    '### Canonical issue intake',
    '',
    '- Outcome: **QUEUED**',
    '- Target: \`' + payload.target + '\`',
    '',
    'This validated request is durably queued. Canonical writes are performed only by the shared serialized intake drain.',
    '',
  ].join('\n');
}

export function parseQueueComment(body) {
  const parsed = markerJson(body, QUEUE_MARKER);
  if (!parsed || parsed.schemaVersion !== REQUEST_SCHEMA_VERSION || !Number.isInteger(parsed.requestIssue)) return null;
  return parsed;
}

export function parseResultComment(body) {
  const parsed = markerJson(body, RESULT_MARKER);
  if (!parsed || !Number.isInteger(parsed.queueCommentId)) return null;
  return parsed;
}

export function pendingQueueItems(issue, comments) {
  const resultIds = new Set();
  const queued = [];
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== QUEUE_COMMENT_AUTHOR) continue;
    const result = parseResultComment(comment.body);
    if (result) resultIds.add(result.queueCommentId);
    const request = parseQueueComment(comment.body);
    if (request) queued.push({ id: comment.id, request });
  }
  return queued
    .filter((entry) => !resultIds.has(entry.id) && entry.request.requestIssue === issue?.number)
    .sort((a, b) => a.id - b.id);
}

export function validateRequestEvent({ event, config, trustedActors = TRUSTED_ACTORS }) {
  const blockers = [];
  const repository = event?.repository?.full_name ?? null;
  const issue = event?.issue ?? null;
  const actor = issue?.user?.login ?? null;
  const triggerActor = event?.sender?.login ?? null;
  const title = issue?.title ?? '';
  let request = null;

  if (repository !== 'ChipIn-one/.github') {
    blockers.push(`Request event repository is ${repository ?? 'unreadable'}, expected ChipIn-one/.github.`);
  }
  if (!actor || !trustedActors.has(actor)) {
    blockers.push(`Request author ${actor ?? 'unreadable'} is not trusted for canonical intake.`);
  }
  if (!triggerActor || !trustedActors.has(triggerActor)) {
    blockers.push(`Request trigger actor ${triggerActor ?? 'unreadable'} is not trusted for canonical intake.`);
  }
  if (!title.startsWith(`${REQUEST_TITLE_PREFIX} `)) {
    blockers.push(`Request title must start with "${REQUEST_TITLE_PREFIX} ".`);
  }

  try {
    request = parseRequestBody(issue?.body ?? '');
  } catch (error) {
    blockers.push(error.message);
  }

  if (request) {
    let target;
    try {
      target = parseIssueRef(request.target);
      if (!isSupportedIntakeRepository(target.repository)) {
        blockers.push(`Target repository is outside canonical ChipIn intake scope: ${target.repository}.`);
      }
    } catch (error) {
      blockers.push(error.message);
    }

    const expectedTitle = `${REQUEST_TITLE_PREFIX} ${request.target}`;
    if (title !== expectedTitle) {
      blockers.push(`Request title must exactly match "${expectedTitle}".`);
    }

    const checked = validateClassification(config, request);
    blockers.push(...checked.blockers);
    request = {
      ...request,
      severity: checked.classification.severity ?? 'none',
    };
  }

  return {
    valid: blockers.length === 0,
    blockers,
    actor,
    triggerActor,
    requestIssue: issue?.number ?? null,
    requestIssueUrl: issue?.html_url ?? null,
    request,
  };
}

export function buildIntakeArgs(request, outputPath) {
  return [
    'apply',
    'reconcile',
    request.target,
    '--type',
    request.issueType,
    '--priority',
    request.priority,
    '--severity',
    request.severity ?? 'none',
    '--activate',
    'issue-intake-v1',
    '--output',
    outputPath,
  ];
}

function bridgeReceiptBase(validation) {
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    requestSchemaVersion: REQUEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    requestIssue: validation.requestIssue,
    requestIssueUrl: validation.requestIssueUrl,
    actor: validation.actor,
    triggerActor: validation.triggerActor,
    request: validation.request,
    status: validation.valid ? 'validated' : 'blocked',
    blockers: [...validation.blockers],
    intake: null,
  };
}

async function writeJson(path, value) {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

export async function validateCommand({
  eventPath,
  configPath,
  requestOutput,
  bridgeOutput,
  trustedActors = TRUSTED_ACTORS,
}) {
  const [event, config] = await Promise.all([readJson(eventPath), readJson(configPath)]);
  const validation = validateRequestEvent({ event, config, trustedActors });
  const receipt = bridgeReceiptBase(validation);
  await writeJson(bridgeOutput, receipt);
  if (validation.valid) await writeJson(requestOutput, {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    requestIssue: validation.requestIssue,
    requestIssueUrl: validation.requestIssueUrl,
    actor: validation.actor,
    triggerActor: validation.triggerActor,
    ...validation.request,
  });
  return receipt;
}

export async function applyCommand({
  requestPath,
  bridgeOutput,
  intakeOutput,
  env = process.env,
  intakeRunner = runIntake,
}) {
  const request = await readJson(requestPath);
  const prior = await readJson(bridgeOutput);
  const receipt = {
    ...prior,
    generatedAt: new Date().toISOString(),
    status: 'blocked',
    blockers: [],
  };

  if (request?.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    receipt.blockers.push(`Unsupported request schemaVersion ${request?.schemaVersion ?? 'missing'}.`);
    await writeJson(bridgeOutput, receipt);
    return receipt;
  }

  const beforeExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const intake = await intakeRunner(buildIntakeArgs(request, intakeOutput), env);
    receipt.intake = intake;
    receipt.blockers.push(...(intake?.blockers ?? []));
    if (intake?.action === 'complete' && receipt.blockers.length === 0) {
      receipt.status = 'complete';
    } else if (receipt.blockers.length === 0) {
      receipt.blockers.push(`Canonical intake returned action ${intake?.action ?? 'unreadable'}, expected complete.`);
    }
  } catch (error) {
    receipt.blockers.push(`Canonical intake execution failed: ${error.message}`);
  } finally {
    process.exitCode = beforeExitCode;
  }

  await writeJson(bridgeOutput, receipt);
  return receipt;
}

function field(receipt, name) {
  return receipt?.intake?.receipt?.fields?.[name] ?? null;
}

export function renderReceiptComment(receipt, queueCommentId = null) {
  const complete = receipt?.status === 'complete';
  const lines = [
    '### Canonical issue intake',
    '',
    `- Outcome: **${complete ? 'COMPLETE' : 'BLOCKED'}**`,
  ];
  if (receipt?.request?.target) lines.push(`- Target: \`${receipt.request.target}\``);
  if (receipt?.request) {
    lines.push(
      `- Requested: \`${receipt.request.issueType}\` / \`${receipt.request.priority}\` / severity \`${receipt.request.severity ?? 'none'}\``,
    );
  }
  if (receipt?.intake?.receipt) {
    lines.push(
      `- Read-back: Type \`${receipt.intake.receipt.issueType ?? 'missing'}\`, Priority \`${field(receipt, 'Priority') ?? 'missing'}\`, Severity \`${field(receipt, 'Severity') ?? 'none'}\`, Milestone \`${receipt.intake.receipt.milestone ?? 'none'}\``,
      `- Project #5: membership \`${receipt.intake.receipt.project?.membershipCount ?? 'unreadable'}\`, Status \`${receipt.intake.receipt.project?.status ?? 'unreadable'}\``,
    );
  }
  if (receipt?.intake?.applied?.length) {
    lines.push(`- Applied: ${receipt.intake.applied.map((item) => `\`${item}\``).join(', ')}`);
  }
  if (receipt?.blockers?.length) {
    lines.push('', 'Blockers:');
    for (const blocker of receipt.blockers) lines.push(`- ${blocker}`);
  }
  lines.push('', complete
    ? 'Raw connector issue creation has been completed through the canonical intake path.'
    : 'No successful canonical completion is claimed. Fix the request or blocker and edit/reopen this request to retry.');
  if (Number.isInteger(queueCommentId)) {
    lines.push(
      '',
      '<!-- ' + RESULT_MARKER,
      JSON.stringify({ queueCommentId, status: complete ? 'complete' : 'blocked' }),
      '-->',
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function drainQueue({
  config,
  queueClient,
  writeToken,
  intakeRunner = runIntake,
  outputPrefix = 'issue-intake-drain',
}) {
  if (!writeToken) throw new Error('CHIPIN_CANONICAL_WRITE_TOKEN is required for canonical queue drain.');
  const issues = await queueClient.listAll('/repos/ChipIn-one/.github/issues?state=all&sort=created&direction=asc');
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    entries: [],
  };

  for (const issue of issues) {
    if (issue?.pull_request || !Number.isInteger(issue?.number) || !String(issue?.title ?? '').startsWith(REQUEST_TITLE_PREFIX + ' ')) continue;
    const comments = await queueClient.listAll('/repos/ChipIn-one/.github/issues/' + issue.number + '/comments');
    const pending = pendingQueueItems(issue, comments);
    if (!pending.length) continue;

    for (const queued of pending) {
      const checked = validateQueuedRequest(config, queued.request);
      const receipt = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        requestSchemaVersion: REQUEST_SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        requestIssue: issue.number,
        requestIssueUrl: issue.html_url ?? null,
        actor: queued.request.actor ?? null,
        triggerActor: queued.request.triggerActor ?? null,
        request: checked.request,
        status: 'blocked',
        blockers: [...checked.blockers],
        intake: null,
      };

      if (checked.valid) {
        const beforeExitCode = process.exitCode;
        process.exitCode = undefined;
        try {
          const intakeOutput = outputPrefix + '-' + issue.number + '-' + queued.id + '.json';
          const intake = await intakeRunner(
            buildIntakeArgs(checked.request, intakeOutput),
            { ...process.env, GITHUB_TOKEN: writeToken, CHIPIN_ISSUE_WRITE: '1' },
          );
          receipt.intake = intake;
          receipt.blockers.push(...(intake?.blockers ?? []));
          if (intake?.action === 'complete' && receipt.blockers.length === 0) {
            receipt.status = 'complete';
          } else if (receipt.blockers.length === 0) {
            receipt.blockers.push('Canonical intake returned action ' + (intake?.action ?? 'unreadable') + ', expected complete.');
          }
        } catch (error) {
          receipt.blockers.push('Canonical intake execution failed: ' + error.message);
        } finally {
          process.exitCode = beforeExitCode;
        }
      }

      await queueClient.request('/repos/ChipIn-one/.github/issues/' + issue.number + '/comments', {
        method: 'POST',
        body: { body: renderReceiptComment(receipt, queued.id) },
      });
      summary.entries.push({
        requestIssue: issue.number,
        queueCommentId: queued.id,
        target: checked.request.target,
        status: receipt.status,
        blockers: receipt.blockers,
      });
    }

    await queueClient.request('/repos/ChipIn-one/.github/issues/' + issue.number, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
  }

  summary.outcome = summary.entries.some((entry) => entry.status !== 'complete') ? 'attention-required' : 'complete';
  return summary;
}

function parseCli(argv) {
  const args = { command: argv[0] ?? null };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[++i];
    if (!key?.startsWith('--') || value == null) throw new Error(`Invalid argument near ${key ?? '<end>'}.`);
    args[key.slice(2)] = value;
  }
  return args;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseCli(argv);
  if (args.command === 'validate') {
    const receipt = await validateCommand({
      eventPath: args.event,
      configPath: args.config ?? 'automation/metadata-migration.config.json',
      requestOutput: args['request-output'],
      bridgeOutput: args['bridge-output'],
    });
    if (receipt.status !== 'validated') process.exitCode = 2;
    return;
  }
  if (args.command === 'queue') {
    const request = await readJson(args.request);
    await writeFile(resolve(args.output), renderQueueComment(request), 'utf8');
    return;
  }
  if (args.command === 'drain') {
    const config = await readJson(args.config ?? 'automation/metadata-migration.config.json');
    const queueClient = new GitHubClient(process.env.GITHUB_TOKEN);
    const summary = await drainQueue({
      config,
      queueClient,
      writeToken: process.env.CHIPIN_CANONICAL_WRITE_TOKEN,
      outputPrefix: args['output-prefix'] ?? 'issue-intake-drain',
    });
    if (args['summary-output']) await writeJson(args['summary-output'], summary);
    if (summary.outcome !== 'complete') process.exitCode = 2;
    return;
  }
  if (args.command === 'apply') {
    let receipt;
    try {
      receipt = await applyCommand({
        requestPath: args.request,
        bridgeOutput: args['bridge-output'],
        intakeOutput: args['intake-output'],
      });
    } catch (error) {
      const prior = await readJson(args['bridge-output']).catch(() => ({
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        blockers: [],
      }));
      receipt = {
        ...prior,
        generatedAt: new Date().toISOString(),
        status: 'blocked',
        blockers: [...(prior.blockers ?? []), `Bridge apply failed: ${error.message}`],
      };
      await writeJson(args['bridge-output'], receipt);
    }
    if (receipt.status !== 'complete') process.exitCode = 2;
    return;
  }
  if (args.command === 'render') {
    const receipt = await readJson(args.receipt);
    await writeFile(resolve(args.output), renderReceiptComment(receipt), 'utf8');
    return;
  }
  if (args.command === 'assert-success') {
    const receipt = await readJson(args.receipt);
    if (receipt.status !== 'complete') {
      throw new Error(`Canonical intake bridge status is ${receipt.status ?? 'unreadable'}.`);
    }
    return;
  }
  throw new Error('Command must be validate, queue, drain, apply, render, or assert-success.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
