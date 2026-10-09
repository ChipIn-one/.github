#!/usr/bin/env node
// Read-only, exact-identity admission before PR reconciliation/review/handoff.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github-metadata.mjs';
import { readAdmission, assertFreshReceipt } from './issue-admission.mjs';
import { readTaskIdentityMarker } from './development-link.mjs';

const BRANCHES = new Map([
  ['ChipIn-one/chipin-frontend', 'dev'],
  ['ChipIn-one/chipin-backend', 'develop'],
  ['ChipIn-one/chipin-knowledge-base', 'master'],
]);
export function taskIdentitiesForPr(repository, pr) {
  const integration = BRANCHES.get(repository);
  if (!integration) throw new Error('Unsupported PR admission repository ' + repository);
  if (pr?.head?.repo?.full_name !== repository || pr?.base?.repo?.full_name !== repository) throw new Error('Untrusted fork/cross-repository PR.');
  const head = pr.head.ref, base = pr.base.ref;
  if (base === integration && head !== integration) {
    const marker = readTaskIdentityMarker(pr.body);
    if (!marker || marker.repository !== repository) throw new Error('Missing or mismatched single Task identity in implementation PR.');
    return [marker];
  }
  if (repository === 'ChipIn-one/chipin-frontend' && base === 'main' && head === 'dev') {
    const matches = String(pr.body ?? '').match(/^Included Issues:\s*(.*)$/gm);
    if (matches?.length !== 1) throw new Error('Release PR must have one exact Included Issues line.');
    const ids = matches[0].slice('Included Issues:'.length).split(',').map(s => s.trim());
    if (!ids.length || ids.length > 30 || ids.some(x => !/^ChipIn-one\/chipin-frontend#[1-9]\d*$/.test(x)) || new Set(ids).size !== ids.length) {
      throw new Error('Invalid or duplicate release Included Issues identity.');
    }
    return ids.map(id => ({ canonical: id, repository, issueNumber: Number(id.split('#')[1]) }));
  }
  throw new Error('Unsupported PR branch transition; no admission bypass.');
}

export function selectedOwnerForPr(repository, body) {
  if (repository !== 'ChipIn-one/chipin-knowledge-base') return null;
  const owners = String(body ?? '').match(/^Task owner:\s*@?([a-z\d-]+)\s*$/gim) ?? [];
  if (owners.length !== 1) throw new Error('KB PR requires one explicit Task owner: @login line.');
  return owners[0].split(':')[1].trim().replace(/^@/, '');
}

export async function preflightPr({ client, config, repository, number, read = readAdmission }) {
  const pr = await client.request('/repos/' + repository + '/pulls/' + number);
  if (pr?.number !== number || pr?.state !== 'open') throw new Error('PR identity/state mismatch or unreadable.');
  const ids = taskIdentitiesForPr(repository, pr);
  const owner = selectedOwnerForPr(repository, pr.body);
  const receipts = [];
  for (const id of ids) {
    const result = await read({ client, config, repository: id.repository, number: id.issueNumber, selectedOwner: owner });
    if (result.blockers.length) throw new Error(id.canonical + ' BLOCKED: ' + result.blockers.join('; '));
    assertFreshReceipt(result.receipt, { issue: id.canonical });
    receipts.push(result.receipt);
  }
  return { contractVersion: 'chipin-pr-admission/v1', pr: repository + '#' + number,
    prHeadSha: pr.head.sha, verifiedAt: new Date().toISOString(), status: 'INTAKE_COMPLETE', receipts };
}

function args(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith('--') || !argv[i + 1]) throw new Error('Expected --repository --pr --output (optional).');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}
export async function main(argv = process.argv.slice(2), env = process.env) {
  const opts = args(argv);
  const number = Number(opts.pr);
  if (!Number.isInteger(number) || number < 1) throw new Error('Positive --pr required.');
  const config = JSON.parse(await readFile(resolve(opts.config ?? 'automation/metadata-migration.config.json'), 'utf8'));
  const result = await preflightPr({ client: new GitHubClient(env.GITHUB_TOKEN), config, repository: opts.repository, number });
  if (opts.output) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(resolve(opts.output), JSON.stringify(result, null, 2) + '\n');
  } else process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('PUBLICATION/PR ADMISSION BLOCKED: ' + error.message); process.exitCode = 2; });
}
