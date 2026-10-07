import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(root, '.github/workflows/kb-docs-validation.yml');

test('KB docs validation stays external, exact-revision, read-only, and fail-closed', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /^permissions:\n  contents: read$/m);
  assert.match(workflow, /CHIPIN_DEV_READ_TOKEN/);
  assert.match(workflow, /gh api "repos\/\$\{KB_REPOSITORY\}\/git\/ref\/heads\/\$\{KB_BRANCH\}"/);
  assert.match(workflow, /ref: \$\{\{ steps\.target\.outputs\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /python-version: '3\.13'/);
  assert.match(workflow, /infra\/requirements-docs\.txt/);
  assert.match(workflow, /check-docs\.py --self-test/);
  assert.match(workflow, /check-docs\.py --base master/);
  assert.match(workflow, /validatorBlob/);
  assert.match(workflow, /requirementsBlob/);
  assert.match(workflow, /outcome=complete/);
  assert.match(workflow, /Enforce fail-closed validation/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.doesNotMatch(workflow, /^\s+(issues|pull-requests|actions): write$/m);
});
