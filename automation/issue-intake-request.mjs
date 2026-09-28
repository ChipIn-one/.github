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

const REQUEST_SCHEMA_VERSION = 1;
const BRIDGE_SCHEMA_VERSION = 1;
const REQUEST_TITLE_PREFIX = '[issue-intake]';
const REQUEST_MARKER = 'chipin-issue-intake-request:v1';
const TRUSTED_ACTORS = new Set(['syllik']);
const ALLOWED_REQUEST_KEYS = new Set([
  'target',
  'issueType',
  'priority',
  'releaseScope',
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
  for (const key of ['target', 'issueType', 'priority', 'releaseScope']) {
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
    releaseScope: parsed.releaseScope.trim(),
    severity: normalizeSeverity(parsed.severity),
  };
}

export function validateRequestEvent({ event, config, trustedActors = TRUSTED_ACTORS }) {
  const blockers = [];
  const repository = event?.repository?.full_name ?? null;
  const issue = event?.issue ?? null;
  const actor = issue?.user?.login ?? null;
  const title = issue?.title ?? '';
  let request = null;

  if (repository !== 'ChipIn-one/.github') {
    blockers.push(`Request event repository is ${repository ?? 'unreadable'}, expected ChipIn-one/.github.`);
  }
  if (!actor || !trustedActors.has(actor)) {
    blockers.push(`Request author ${actor ?? 'unreadable'} is not trusted for canonical intake.`);
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
    '--release-scope',
    request.releaseScope,
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

export function renderReceiptComment(receipt) {
  const complete = receipt?.status === 'complete';
  const lines = [
    '### Canonical issue intake',
    '',
    `- Outcome: **${complete ? 'COMPLETE' : 'BLOCKED'}**`,
  ];
  if (receipt?.request?.target) lines.push(`- Target: \`${receipt.request.target}\``);
  if (receipt?.request) {
    lines.push(
      `- Requested: \`${receipt.request.issueType}\` / \`${receipt.request.priority}\` / \`${receipt.request.releaseScope}\` / severity \`${receipt.request.severity ?? 'none'}\``,
    );
  }
  if (receipt?.intake?.receipt) {
    lines.push(
      `- Read-back: Type \`${receipt.intake.receipt.issueType ?? 'missing'}\`, Priority \`${field(receipt, 'Priority') ?? 'missing'}\`, Release scope \`${field(receipt, 'Release scope') ?? 'missing'}\`, Severity \`${field(receipt, 'Severity') ?? 'none'}\``,
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
  return `${lines.join('\n')}\n`;
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
  throw new Error('Command must be validate, apply, render, or assert-success.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
