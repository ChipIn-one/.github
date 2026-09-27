#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { INTEGRATION_BRANCHES } from './dev-readiness.mjs';
import { GitHubClient } from './metadata-migration.mjs';
import {
  evaluateLiveIssue,
  parseIssueRef,
  readLiveContext,
} from './dev-readiness-live.mjs';

const PRE_DEV_STATUSES = new Set(['Backlog', 'Todo', 'In Progress']);
const MANUAL_TERMINAL_STATUSES = new Set(['PROD', 'Done']);
const APPLY_ACTIVATION = 'dev-status-v1';
const APPLY_ENV = 'CHIPIN_DEV_WRITE';
const ATTENTION_APPLY_STATUSES = new Set([
  'operational-read-failed',
  'mutation-outcome-uncertain',
  'applied-read-back-uncertain',
  'applied-but-read-back-inconsistent',
]);
const EXACT_BLOCKED_APPLY_STATUSES = new Set(['blocked', 'blocked-after-refresh', 'skipped-write-cap']);

const UPDATE_STATUS_MUTATION = `
mutation DevReadinessSetStatus(
  $projectId: ID!,
  $itemId: ID!,
  $fieldId: ID!,
  $optionId: String!
) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

function issueKey(repository, number) {
  return `${repository}#${number}`;
}

export function assertWriteActivation({ mode, activate, env = process.env }) {
  if (mode !== 'apply') return;
  if (activate !== APPLY_ACTIVATION || env[APPLY_ENV] !== '1') {
    throw new Error(
      `DEV writes are disabled. Use --activate ${APPLY_ACTIVATION} and ${APPLY_ENV}=1 after operator approval.`,
    );
  }
}

export function resolveDevCoordinates({ config, liveContext, evaluation }) {
  const blockers = [];
  const project = liveContext?.project;
  const item = liveContext?.projectIndex?.get(evaluation.issue) ?? null;

  if (!project?.id || typeof project.id !== 'string') {
    blockers.push('Project node id is unreadable.');
  }
  if (!item?.id || typeof item.id !== 'string') {
    blockers.push('Project item node id is unreadable.');
  }
  if (item?.status !== evaluation.projectStatus) {
    blockers.push('Project item status does not match evaluated status.');
  }

  const statusFields = (project?.fields ?? []).filter(
    (field) => field?.name === config.project.statusField,
  );
  if (statusFields.length !== 1) {
    blockers.push(`Project Status field is missing or ambiguous (${statusFields.length} matches).`);
    return { blockers, projectId: project?.id ?? null, itemId: item?.id ?? null, fieldId: null, optionId: null };
  }

  const statusField = statusFields[0];
  if (statusField.isIssueField === true) {
    blockers.push('Project Status must remain project-local.');
  }
  if (!statusField.id || typeof statusField.id !== 'string') {
    blockers.push('Project Status field node id is unreadable.');
  }

  const devOptions = (statusField.options ?? []).filter((option) => option?.name === 'DEV');
  if (devOptions.length !== 1) {
    blockers.push(`DEV Status option is missing or ambiguous (${devOptions.length} matches).`);
  }
  const devOption = devOptions[0] ?? null;
  if (!devOption?.id || typeof devOption.id !== 'string') {
    blockers.push('DEV Status option id is unreadable.');
  }

  return {
    blockers,
    projectId: project?.id ?? null,
    itemId: item?.id ?? null,
    fieldId: statusField.id ?? null,
    optionId: devOption?.id ?? null,
  };
}

export function buildDevTransitionPlan({ config, liveContext, evaluation }) {
  const blockers = [];
  const status = evaluation?.projectStatus ?? null;
  const state = evaluation?.decision?.state ?? null;

  if (!evaluation?.issue) blockers.push('Issue identity is unreadable.');
  if (!Array.isArray(evaluation?.readErrors)) blockers.push('Read error collection is unreadable.');
  else blockers.push(...evaluation.readErrors.map((error) => `Read failure: ${error}`));
  if (!Array.isArray(evaluation?.adapterBlockers)) blockers.push('Adapter blocker collection is unreadable.');
  else blockers.push(...evaluation.adapterBlockers.map((error) => `Adapter blocker: ${error}`));

  if (status === 'DEV') {
    const alreadyDev = state === 'NOT_READY'
      && String(evaluation?.decision?.reason ?? '').includes('already DEV');
    if (alreadyDev && blockers.length === 0) {
      return {
        issue: evaluation.issue,
        action: 'noop',
        from: 'DEV',
        to: 'DEV',
        decision: evaluation.decision,
        blockers: [],
        reason: 'Item is already DEV; no mutation is required.',
      };
    }
    blockers.push('DEV item is not a clean idempotent no-op.');
  } else if (MANUAL_TERMINAL_STATUSES.has(status)) {
    blockers.push(`Project status ${status} is manual and must never be changed by DEV automation.`);
  } else if (!PRE_DEV_STATUSES.has(status)) {
    blockers.push(`Project status ${status ?? 'unreadable'} is not eligible for a DEV transition.`);
  }

  if (status !== 'DEV' && state !== 'READY_FOR_DEV') {
    blockers.push(`Evaluator state is ${state ?? 'unreadable'}, not READY_FOR_DEV.`);
  }

  const coordinates = resolveDevCoordinates({ config, liveContext, evaluation });
  blockers.push(...coordinates.blockers);

  return {
    issue: evaluation.issue,
    action: blockers.length === 0 ? 'write' : 'blocked',
    from: status,
    to: 'DEV',
    decision: evaluation.decision,
    blockers,
    ...(blockers.length === 0 ? {
      projectId: coordinates.projectId,
      itemId: coordinates.itemId,
      fieldId: coordinates.fieldId,
      optionId: coordinates.optionId,
    } : {}),
  };
}

export async function writeDevStatus(client, plan) {
  if (plan?.action !== 'write') {
    throw new Error('Refusing Project mutation for a non-write plan.');
  }
  for (const key of ['projectId', 'itemId', 'fieldId', 'optionId']) {
    if (!plan[key] || typeof plan[key] !== 'string') {
      throw new Error(`Refusing Project mutation with unreadable ${key}.`);
    }
  }

  const data = await client.graphql(UPDATE_STATUS_MUTATION, {
    projectId: plan.projectId,
    itemId: plan.itemId,
    fieldId: plan.fieldId,
    optionId: plan.optionId,
  });
  const updatedId = data?.updateProjectV2ItemFieldValue?.projectV2Item?.id ?? null;
  if (updatedId !== plan.itemId) {
    throw new Error('Project mutation did not return the expected item id.');
  }
}

export function verifyAppliedDev(evaluation) {
  const blockers = [];
  if (evaluation?.projectStatus !== 'DEV') {
    blockers.push(`Read-back Project status is ${evaluation?.projectStatus ?? 'unreadable'}, expected DEV.`);
  }
  if ((evaluation?.readErrors ?? []).length) {
    blockers.push(...evaluation.readErrors.map((error) => `Read-back failure: ${error}`));
  }
  if ((evaluation?.adapterBlockers ?? []).length) {
    blockers.push(...evaluation.adapterBlockers.map((error) => `Read-back blocker: ${error}`));
  }
  const cleanAlreadyDev = evaluation?.decision?.state === 'NOT_READY'
    && String(evaluation?.decision?.reason ?? '').includes('already DEV');
  if (!cleanAlreadyDev) {
    blockers.push(`Read-back evaluator state is ${evaluation?.decision?.state ?? 'unreadable'}, expected clean already-DEV no-op.`);
  }
  return blockers;
}

function parseArgs(argv) {
  const args = {
    mode: 'plan',
    config: 'automation/metadata-migration.config.json',
    output: null,
    activate: null,
    all: false,
    issues: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === 'plan' || value === 'apply') args.mode = value;
    else if (value === '--config') args.config = argv[++i];
    else if (value === '--output') args.output = argv[++i];
    else if (value === '--activate') args.activate = argv[++i];
    else if (value === '--all') args.all = true;
    else args.issues.push(parseIssueRef(value));
  }

  if (args.all && args.issues.length) throw new Error('Use either exact issue refs or --all, not both.');
  if (!args.all && !args.issues.length) throw new Error('Provide one or more exact issue refs, or use --all.');
  return args;
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

export function scanPreflightBlockers(liveContext) {
  const blockers = [...(Array.isArray(liveContext?.schemaBlockers) ? liveContext.schemaBlockers : ['Schema blocker collection is unreadable.'])];
  if (!liveContext?.project) blockers.push('Project snapshot is unreadable.');
  else if (!Array.isArray(liveContext.project.items)) blockers.push('Project item collection is unreadable.');
  return [...new Set(blockers)];
}

function targetsFromProject(liveContext) {
  const knownRepositories = new Set(Object.keys(INTEGRATION_BRANCHES));
  return [...(liveContext?.project?.items ?? [])]
    .filter((item) => (
      knownRepositories.has(item?.repository)
      && PRE_DEV_STATUSES.has(item?.status)
      && Number.isInteger(item?.number)
    ))
    .map((item) => ({ repository: item.repository, number: item.number }))
    .sort((a, b) => issueKey(a.repository, a.number).localeCompare(issueKey(b.repository, b.number)));
}

async function evaluateOne({ client, config, liveContext, target, evaluate = evaluateLiveIssue }) {
  return evaluate(client, config, liveContext, target.repository, target.number);
}

export async function run(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  const args = parseArgs(argv);
  assertWriteActivation({ mode: args.mode, activate: args.activate, env });

  const config = overrides.config ?? await readJson(args.config);
  const client = overrides.client ?? new GitHubClient(env.GITHUB_TOKEN);
  const readContext = overrides.readLiveContext ?? readLiveContext;
  const evaluate = overrides.evaluateLiveIssue ?? evaluateLiveIssue;
  const mutate = overrides.writeDevStatus ?? writeDevStatus;
  const persist = overrides.writeFile ?? writeFile;
  const setExitCode = overrides.setExitCode ?? ((code) => {
    process.exitCode = code;
  });

  const result = {
    schemaVersion: 1,
    mode: args.mode,
    readOnly: args.mode === 'plan',
    generatedAt: new Date().toISOString(),
    outcome: 'in-progress',
    preflightBlockers: [],
    safety: {
      mutation: 'Project #5 Status only',
      targetStatus: 'DEV',
      maxWritesPerRun: 1,
      regressionsAllowed: false,
    },
    entries: [],
  };

  const persistReceipt = async () => {
    if (!args.output) return;
    await persist(resolve(args.output), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  };

  const recordOperationalReadFailure = async (target, error) => {
    const message = error instanceof Error ? error.message : String(error);
    result.entries.push({
      issue: issueKey(target.repository, target.number),
      action: 'blocked',
      from: null,
      to: 'DEV',
      decision: null,
      blockers: [`Operational read failure: ${message}`],
      apply: {
        status: 'operational-read-failed',
        error: message,
        note: 'No mutation was attempted for this item.',
      },
    });
    result.outcome = 'attention-required';
    await persistReceipt();
  };

  // Create the workflow artifact payload before the first live GitHub read.
  await persistReceipt();

  let initialContext;
  try {
    initialContext = await readContext(client, config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.preflightBlockers = [`Initial live context read failed: ${message}`];
    result.outcome = 'attention-required';
    if (args.all) {
      await persistReceipt();
    } else {
      for (const target of args.issues) {
        await recordOperationalReadFailure(target, error);
      }
    }
    setExitCode(2);
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (args.output) await persist(resolve(args.output), text, 'utf8');
    else process.stdout.write(text);
    return result;
  }

  const preflightBlockers = args.all ? scanPreflightBlockers(initialContext) : [];
  result.preflightBlockers = preflightBlockers;
  const targets = args.all && preflightBlockers.length === 0 ? targetsFromProject(initialContext) : args.issues;

  let writeAttempts = 0;
  for (const target of targets) {
    let planningContext;
    let evaluation;
    let plan;
    try {
      planningContext = args.mode === 'plan' ? initialContext : await readContext(client, config);
      evaluation = await evaluateOne({ client, config, liveContext: planningContext, target, evaluate });
      plan = buildDevTransitionPlan({ config, liveContext: planningContext, evaluation });
    } catch (error) {
      await recordOperationalReadFailure(target, error);
      continue;
    }

    if (args.mode === 'plan') {
      result.entries.push({ ...plan, apply: { status: 'not-requested' } });
      continue;
    }

    if (plan.action !== 'write') {
      result.entries.push({ ...plan, apply: { status: plan.action === 'noop' ? 'noop' : 'blocked' } });
      continue;
    }

    if (writeAttempts >= 1) {
      result.entries.push({
        ...plan,
        action: 'blocked',
        blockers: ['Per-run write cap reached; no additional Project mutation is allowed.'],
        apply: {
          status: 'skipped-write-cap',
          note: 'Normal per-run throttling; a later run may evaluate this item again.',
        },
      });
      continue;
    }

    let preWriteContext;
    let preWriteEvaluation;
    let preWritePlan;
    try {
      // Fresh read/evaluation immediately before the single allowed mutation.
      preWriteContext = await readContext(client, config);
      preWriteEvaluation = await evaluateOne({ client, config, liveContext: preWriteContext, target, evaluate });
      preWritePlan = buildDevTransitionPlan({ config, liveContext: preWriteContext, evaluation: preWriteEvaluation });
    } catch (error) {
      await recordOperationalReadFailure(target, error);
      continue;
    }

    if (preWritePlan.action !== 'write') {
      result.entries.push({
        ...preWritePlan,
        apply: { status: preWritePlan.action === 'noop' ? 'noop-after-refresh' : 'blocked-after-refresh' },
      });
      continue;
    }

    const entry = {
      ...preWritePlan,
      apply: {
        status: 'mutation-intent-recorded',
        note: 'A Project Status mutation is about to be attempted. If this is the last durable receipt state, do not infer whether GitHub applied it; re-read live state before any retry.',
      },
    };
    result.entries.push(entry);

    // Persist exact identity and mutation intent before entering the uncertain write window.
    await persistReceipt();
    writeAttempts += 1;

    try {
      await mutate(client, preWritePlan);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.blockers = [...(entry.blockers ?? []), `Mutation outcome is uncertain: ${message}`];
      entry.apply = {
        status: 'mutation-outcome-uncertain',
        error: message,
        note: 'The mutation call did not complete cleanly. Do not retry from this receipt; re-read the exact live issue and Project Status first.',
      };
      result.outcome = 'attention-required';
      await persistReceipt();
      continue;
    }

    entry.apply = {
      status: 'mutation-returned-read-back-pending',
      note: 'The mutation call returned the expected Project item id; post-write verification is still pending.',
    };
    await persistReceipt();

    let readBackEvaluation;
    try {
      // Read back after mutation. Never auto-regress if required work changed concurrently.
      const readBackContext = await readContext(client, config);
      readBackEvaluation = await evaluateOne({ client, config, liveContext: readBackContext, target, evaluate });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.blockers = [...(entry.blockers ?? []), `Post-write read-back failed: ${message}`];
      entry.apply = {
        status: 'applied-read-back-uncertain',
        error: message,
        note: 'The write returned successfully, but final live state is unknown. Never auto-regress or repeat the mutation from this receipt; re-read the exact live issue first.',
      };
      result.outcome = 'attention-required';
      await persistReceipt();
      continue;
    }

    const readBackBlockers = verifyAppliedDev(readBackEvaluation);
    if (readBackBlockers.length) {
      entry.blockers = readBackBlockers;
      entry.apply = {
        status: 'applied-but-read-back-inconsistent',
        note: 'No automatic regression is allowed; operator review and a fresh live read are required before any retry.',
      };
      result.outcome = 'attention-required';
      await persistReceipt();
      continue;
    }

    entry.apply = { status: 'complete', observedStatus: 'DEV' };
    await persistReceipt();
  }

  const exactApply = args.mode === 'apply' && !args.all;
  const attentionRequired = preflightBlockers.length > 0
    || result.entries.some((entry) => ATTENTION_APPLY_STATUSES.has(entry.apply?.status));
  const blockedExactApply = exactApply
    && result.entries.some((entry) => EXACT_BLOCKED_APPLY_STATUSES.has(entry.apply?.status));

  if (attentionRequired) {
    result.outcome = 'attention-required';
    setExitCode(2);
  } else if (blockedExactApply) {
    result.outcome = 'blocked';
    setExitCode(2);
  } else {
    result.outcome = 'complete';
  }

  const text = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) await persist(resolve(args.output), text, 'utf8');
  else process.stdout.write(text);

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
