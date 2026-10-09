#!/usr/bin/env node
// One-time, read-only governance bootstrap for .github#53. Not reusable admission.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github-metadata.mjs';
import { validateBody } from './issue-admission.mjs';

const REPO = 'ChipIn-one/.github';
const BOOTSTRAP_ISSUE = 53;
const BOOTSTRAP_PR = 57;
const ALLOWED = new Set([
  'AGENTS.md', 'github-issue-schema.md',
  'automation/README.md', 'automation/issue-intake.md', 'automation/issue-intake.mjs',
  'automation/issue-intake.test.mjs', 'automation/issue-intake-request.mjs',
  'automation/issue-intake-request.test.mjs',
  'automation/development-link-action/action.yml',
  '.github/workflows/automation-tests.yml',
  // Existing KB manual finalizer is an approved intake adapter, not another writer.
  '.github/workflows/issue-metadata-finalize.yml',
]);
export function bootstrapAllowsPath(path) {
  return ALLOWED.has(path) || /^automation\/issue-admission(?:-pr)?(?:\.test)?\.mjs$/.test(path) ||
    path === 'automation/issue-admission-action/action.yml' ||
    path === 'automation/org-governance-bootstrap.mjs' ||
    path === 'automation/org-governance-bootstrap.test.mjs';
}

export function verifyGovernanceBootstrap({ issue, pr, files, expectedHead }) {
  const blockers = [];
  if (issue?.number !== BOOTSTRAP_ISSUE || issue?.user?.login !== 'syllik' ||
      !Array.isArray(issue?.assignees) || !issue.assignees.some(u => u?.login === 'syllik')) {
    blockers.push('Governance bootstrap requires exact .github#53, opened and native-assigned to syllik.');
  }
  blockers.push(...validateBody(issue?.title, issue?.body));
  if (pr?.number !== BOOTSTRAP_PR || pr?.base?.repo?.full_name !== REPO || pr?.head?.repo?.full_name !== REPO ||
      pr?.base?.ref !== 'master' || pr?.head?.ref !== 'feat/53-canonical-admission' ||
      pr?.user?.login !== 'syllik' || pr?.head?.sha !== expectedHead || pr?.state !== 'open') {
    blockers.push('Bootstrap applies only to exact scoped open org PR #57 at current head SHA.');
  }
  if (!Array.isArray(files) || !files.length) blockers.push('Bootstrap changed paths are unreadable or empty.');
  for (const file of files ?? []) {
    if (!file?.filename || !bootstrapAllowsPath(file.filename) || file.status === 'removed' ||
        file.previous_filename && !bootstrapAllowsPath(file.previous_filename)) {
      blockers.push('Out-of-scope or destructive governance bootstrap change: ' + (file?.filename || 'unreadable'));
    }
  }
  return {
    contractVersion: 'chipin-governance-bootstrap/v1',
    status: blockers.length ? 'BLOCKED' : 'GOVERNANCE_BOOTSTRAP_ONLY',
    targetIssue: REPO + '#53', targetPr: REPO + '#57',
    headSha: pr?.head?.sha ?? null, checkedAt: new Date().toISOString(), blockers,
  };
}

export async function checkGovernanceBootstrap({ client, expectedHead }) {
  if (!/^[a-f0-9]{40}$/.test(expectedHead ?? '')) throw new Error('An explicit 40-character current head SHA is required.');
  const [issue, pr, files] = await Promise.all([
    client.request('/repos/' + REPO + '/issues/' + BOOTSTRAP_ISSUE),
    client.request('/repos/' + REPO + '/pulls/' + BOOTSTRAP_PR),
    client.listAll('/repos/' + REPO + '/pulls/' + BOOTSTRAP_PR + '/files'),
  ]);
  return verifyGovernanceBootstrap({ issue, pr, files, expectedHead });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--head') throw new Error('Usage: org-governance-bootstrap.mjs --head <current-head-sha>');
  const receipt = await checkGovernanceBootstrap({
    client: new GitHubClient(process.env.GITHUB_TOKEN),
    expectedHead: argv[1],
  });
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n');
  if (receipt.status !== 'GOVERNANCE_BOOTSTRAP_ONLY') process.exitCode = 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error('Governance bootstrap BLOCKED: ' + e.message); process.exitCode = 2; });
}
