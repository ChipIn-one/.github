#!/usr/bin/env node
// Issue-based, read-only canonical preflight (does not require an existing PR).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github-metadata.mjs';
import { readAdmission } from './issue-admission.mjs';
import { GhReadClient, PreflightError, safeAdmissionDiagnostics, retryTransient, selectDirectTransport } from './issue-admission-transport.mjs';
import { createAdmissionEnvelope } from './issue-admission-evidence.mjs';

export function parsePreflightArgs(argv) {
  const params = {};
  const allowed = new Set(['issue', 'owner', 'expected-revision', 'config', 'output', 'request-id', 'producer']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (!argv[i]?.startsWith('--') || !allowed.has(key) || !argv[i + 1] || Object.hasOwn(params, key)) {
      throw new PreflightError('INVALID_REQUEST');
    }
    params[key] = argv[i + 1];
  }
  const match = /^(ChipIn-one\/(?:chipin-frontend|chipin-backend|chipin-knowledge-base))#([1-9]\d*)$/.exec(params.issue ?? '');
  if (!match || (params.owner && !/^[a-z\d](?:[a-z\d-]{0,37})$/i.test(params.owner)) ||
      (match[1] === 'ChipIn-one/chipin-knowledge-base' && !params.owner) ||
      (params['expected-revision'] && !/^[a-f0-9]{64}$/.test(params['expected-revision'])) ||
      (!!params.producer !== !!params['request-id'])) throw new PreflightError('INVALID_REQUEST');
  return { ...params, repository: match[1], number: Number(match[2]) };
}

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function metadataSha(path) {
  // Safe in trusted Actions producer only. No task-controlled checkout or ref.
  return execFileSync('git', ['rev-parse', `HEAD:${path}`], { encoding: 'utf8', timeout: 5000 }).trim();
}
function producerContext(env, configBytes) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_EVENT_NAME !== 'repository_dispatch' ||
      env.GITHUB_REPOSITORY !== 'ChipIn-one/.github' || env.GITHUB_REF !== 'refs/heads/master' ||
      !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') || !env.GITHUB_TOKEN ||
      !/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '') ||
      !env.GITHUB_ACTOR || env.GITHUB_ACTOR !== env.CHIPIN_TRUSTED_PREFLIGHT_ACTOR ||
      !env.GITHUB_TRIGGERING_ACTOR || env.GITHUB_TRIGGERING_ACTOR !== env.CHIPIN_TRUSTED_PREFLIGHT_ACTOR) {
    throw new PreflightError('UNTRUSTED_PRODUCER_RUNTIME');
  }
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
  if (checkout !== env.GITHUB_SHA) throw new PreflightError('UNTRUSTED_PRODUCER_RUNTIME');
  return {
    producer: env.GITHUB_ACTOR, sourceSha: checkout,
    readerBlobSha: metadataSha('automation/issue-admission.mjs'), configSha256: sha(configBytes),
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
}

export async function runPreflight(argv, env = process.env, overrides = {}) {
  const o = parsePreflightArgs(argv);
  const configBytes = await (overrides.loadConfig ?? readFile)(resolve(o.config ?? 'automation/metadata-migration.config.json'));
  const config = JSON.parse(configBytes.toString());
  if (o.producer && o.producer !== 'actions') throw new PreflightError('INVALID_REQUEST');
  // Never let a GitHub Actions run silently fall back to gh's lower-privilege token.
  if (env.GITHUB_ACTIONS === 'true' && !env.GITHUB_TOKEN) throw new PreflightError('AUTH_UNAVAILABLE');
  const producer = o.producer ? (overrides.producerContext ?? producerContext)(env, configBytes) : null;
  const route = selectDirectTransport({ token: env.GITHUB_TOKEN,
    makeTokenClient: overrides.makeTokenClient ?? (token => new GitHubClient(token)),
    makeGhClient: overrides.makeGhClient ?? (() => new GhReadClient()) });
  const result = await retryTransient(async () => {
    const current = await (overrides.reader ?? readAdmission)({
      client: route.client, config, repository: o.repository, number: o.number,
      selectedOwner: o.owner ?? null, expectedRevision: o['expected-revision'] ?? null,
    });
    // The canonical reader collects exceptions as blockers. Retry only when
    // *every* blocker is explicitly a transport failure, never policy/auth.
    // readAdmission() also reports derived validation blockers when a mandatory
    // snapshot is missing; classify only exact canonical read-boundary failures.
    const readFailure = /^(?:Organization schema unreadable|Project #5 unreadable|Native Issue unreadable|Second canonical read-back failed): /;
    const transientReadFailure = current.blockers.some(value =>
      readFailure.test(value) && value.endsWith(': TRANSPORT_ERROR'));
    const permanentReadFailure = current.blockers.some(value =>
      readFailure.test(value) && !value.endsWith(': TRANSPORT_ERROR'));
    if (transientReadFailure && !permanentReadFailure) throw new PreflightError('TRANSPORT_ERROR');
    return current;
  }, overrides.retryOptions);
  if (result.blockers.length) {
    throw new PreflightError('ADMISSION_BLOCKED', { principal: route.principal, transport: route.transport,
      capability: 'full native Issue/org schema/relationships/Project #5 canonical read',
      remedy: JSON.stringify(safeAdmissionDiagnostics(result.blockers, route.principal, route.transport)) });
  }
  const receipt = result.receipt;
  const output = producer ? createAdmissionEnvelope({ receipt, requestId: o['request-id'], ...producer }) : receipt;
  if (o.output) await (overrides.saveOutput ?? writeFile)(resolve(o.output), JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  else if (!producer) process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPreflight(process.argv.slice(2)).catch(e => {
    // Fail closed without echoing raw GraphQL/REST/gh bodies or tokens.
    const diagnostic = e instanceof PreflightError ? (e.diagnostic ?? { code: e.code }) : { code: 'PREFLIGHT_FAILED' };
    process.stderr.write(JSON.stringify({ status: 'BLOCKED', diagnostic }) + '\n');
    process.exitCode = 2;
  });
}
