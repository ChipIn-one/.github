#!/usr/bin/env node
// Offline draft check for a new ChipIn Issue (#285). No GitHub call, no credential, no write.
// It runs the same offline rules (all reported at once; the writer stops at the first group): the same body rules as the canonical writer and admission (validateBody), the same
// classification rules as issue-intake.mjs (validateClassification) and the registry owner
// policy, so a local agent can fix a draft before the raw or canonical create.
// A clean result is not admission: after create, issue-admission-preflight.mjs must return
// INTAKE_COMPLETE before any branch, PR or handoff.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requiredOwner, validateBody } from './issue-admission.mjs';
import { isSupportedIntakeRepository, validateClassification } from './issue-intake.mjs';
import { parseDeclarations } from './relationships.mjs';

export const DRAFT_CHECK_CONTRACT = 'chipin-issue-draft-check/v1';
const FLAGS = new Set(['repository', 'title', 'body-file', 'type', 'priority', 'severity', 'owner', 'config']);
// Exit codes: 0 DRAFT_OK, 2 DRAFT_BLOCKED (JSON on stdout), 1 usage error (no JSON).
// A value may not start with "--".
const USAGE = 'Usage: issue-draft-check.mjs --repository ChipIn-one/<repo> --title <text> --body-file <path> ' +
  '--type Task|Feature|Bug --priority P0..P3 [--severity Critical|Major|Minor|none] [--owner <login>] [--config <path>]';

export function parseDraftArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    const value = argv[i + 1];
    if (!key || !FLAGS.has(key) || value == null || value.startsWith('--') || Object.hasOwn(out, key)) throw new Error(USAGE);
    out[key] = value;
  }
  for (const key of ['repository', 'title', 'body-file', 'type', 'priority']) if (!out[key]) throw new Error(USAGE);
  return out;
}

// Pure check: every blocker is returned, none stops the others.
export function checkDraft({ config, repository, title, body, issueType, priority, severity = null, owner = null }) {
  const blockers = [];
  if (!isSupportedIntakeRepository(repository)) blockers.push('Repository is outside ChipIn intake scope: ' + repository + '.');
  else {
    try { requiredOwner(repository, owner); } catch (error) { blockers.push(error.message); }
  }
  const checked = validateClassification(config, { issueType, priority, severity });
  blockers.push(...checked.blockers);
  blockers.push(...validateBody(title, body));
  // Malformed `## Dependencies` declarations are rejected later by the relationship reconciler.
  blockers.push(...parseDeclarations(body).errors.map(error => 'Dependencies: ' + error));
  return {
    contractVersion: DRAFT_CHECK_CONTRACT,
    status: blockers.length ? 'DRAFT_BLOCKED' : 'DRAFT_OK',
    repository, title,
    classification: checked.classification,
    blockers,
    next: blockers.length
      ? 'Fix every blocker and run the check again before any create.'
      : 'Create the Issue, then run issue-admission-preflight.mjs --issue ' + repository + '#<n> until INTAKE_COMPLETE.',
  };
}

export async function main(argv = process.argv.slice(2), overrides = {}) {
  const read = overrides.readFile ?? readFile;
  const stderr = overrides.stderr ?? process.stderr;
  let opts;
  try { opts = parseDraftArgs(argv); }
  catch (error) { stderr.write(error.message + '\n'); process.exitCode = 1; return null; }
  const config = JSON.parse(await read(opts.config ? resolve(opts.config) : fileURLToPath(new URL('./metadata-migration.config.json', import.meta.url)), 'utf8'));
  let body = '';
  let readError = null;
  try { body = await read(resolve(opts['body-file']), 'utf8'); }
  catch (error) { readError = 'Issue body read failed: ' + error.message; }
  const result = checkDraft({
    config, repository: opts.repository, title: opts.title, body,
    issueType: opts.type, priority: opts.priority, severity: opts.severity ?? null, owner: opts.owner ?? null,
  });
  if (readError) {
    result.blockers.unshift(readError);
    result.status = 'DRAFT_BLOCKED';
    result.next = 'Fix every blocker and run the check again before any create.';
  }
  (overrides.stdout ?? process.stdout).write(JSON.stringify(result, null, 2) + '\n');
  for (const blocker of result.blockers) stderr.write('DRAFT BLOCKER: ' + blocker + '\n');
  if (result.blockers.length) process.exitCode = 2;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
