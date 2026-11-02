import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workflowRoot = new URL('../docs/workflow/', import.meta.url);
const workspaceUrl = new URL('workspace.yaml', workflowRoot);
const roleIndexUrl = new URL('roles/workflow.md', workflowRoot);
const readmeUrl = new URL('README.md', workflowRoot);
const agentsUrl = new URL('../AGENTS.md', import.meta.url);
const automationReadmeUrl = new URL('README.md', import.meta.url);
const onboardingUrl = new URL('onboarding.md', workflowRoot);

const repositories = [
  'ChipIn-one/.github',
  'ChipIn-one/chipin-frontend',
  'ChipIn-one/chipin-backend',
  'ChipIn-one/chipin-knowledge-base',
];

function readText(url, description) {
  assert.ok(fs.existsSync(url), `${description} must exist`);
  return fs.readFileSync(url, 'utf8');
}

function workspaceRecords(text) {
  const records = [];
  let current = null;

  for (const line of text.split(/\r?\n/)) {
    const start = /^  - id: (\S+)$/.exec(line);
    if (start) {
      current = { id: start[1], text: '' };
      records.push(current);
      continue;
    }

    if (current && /^\S/.test(line)) current = null;
    if (current) current.text += `${line}\n`;
  }

  return records;
}

function relativeMarkdownLinks(text) {
  return [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map(([, label, target]) => ({ label, target: target.split('#', 1)[0] }))
    .filter(({ target }) => target && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target));
}

function filesUnder(directoryUrl) {
  return fs.readdirSync(directoryUrl, { withFileTypes: true }).flatMap(entry => {
    const entryUrl = new URL(entry.name, directoryUrl);
    return entry.isDirectory() ? filesUnder(new URL(`${entry.name}/`, directoryUrl)) : [entryUrl];
  });
}

test('ChipIn workspace contains exactly the four registered repositories', () => {
  const records = workspaceRecords(readText(workspaceUrl, 'ChipIn workspace'));
  assert.deepEqual(
    records.map(({ id }) => id).sort(),
    [...repositories].sort(),
  );
});

test('ChipIn records preserve integration access and context dependency policy', () => {
  const records = workspaceRecords(readText(workspaceUrl, 'ChipIn workspace'));
  const byId = new Map(records.map(record => [record.id, record.text]));
  const expected = [
    { id: 'ChipIn-one/.github', branch: 'master', access: 'managed', dependsOnKnowledgeBase: false },
    { id: 'ChipIn-one/chipin-frontend', branch: 'master', access: 'managed', dependsOnKnowledgeBase: true },
    { id: 'ChipIn-one/chipin-backend', branch: 'develop', access: 'read-only', dependsOnKnowledgeBase: true },
    { id: 'ChipIn-one/chipin-knowledge-base', branch: 'master', access: 'read-only', dependsOnKnowledgeBase: false },
  ];

  for (const policy of expected) {
    const record = byId.get(policy.id);
    assert.ok(record, `workspace record ${policy.id} must exist`);
    assert.match(record, new RegExp(`^\\s+integrationBranch:\\s*${policy.branch}\\s*$`, 'm'));
    assert.match(record, new RegExp(`^\\s+access:\\s*${policy.access}\\s*$`, 'm'));

    if (policy.dependsOnKnowledgeBase) {
      assert.match(
        record,
        /^\s{4}contextDependencies:\s*\r?\n\s{6}- repository:\s*ChipIn-one\/chipin-knowledge-base\s*\r?\n\s{8}integrationBranch:\s*master\s*\r?\n\s{8}access:\s*read-only\s*$/m,
      );
    } else {
      assert.doesNotMatch(record, /^\s{4}contextDependencies\s*:/m);
    }
  }
});

test('role index resolves every required role file', () => {
  const roleIndex = readText(roleIndexUrl, 'workflow role index');
  const links = relativeMarkdownLinks(roleIndex);
  assert.ok(links.length > 0, 'workflow role index must list relative role links');

  for (const { label, target } of links) {
    assert.ok(fs.existsSync(new URL(target, roleIndexUrl)), `${label} target ${target} must exist`);
  }
});

test('canon contains no personal workflow or personal workspace script dependency', () => {
  assert.ok(fs.existsSync(workflowRoot), 'canonical workflow directory must exist');
  const forbidden = /(?:github\.com\/)?syllik\/ai-workflow|scripts\/workspace\//i;

  for (const fileUrl of filesUnder(workflowRoot)) {
    assert.doesNotMatch(fs.readFileSync(fileUrl, 'utf8'), forbidden, `${fileUrl.href} has a personal dependency`);
  }
});

test('workflow README declares the canonical reading order', () => {
  const readme = readText(readmeUrl, 'workflow README');
  const headings = [...readme.matchAll(/^##\s+(.+)$/gm)].map(([, heading]) => heading.trim());
  assert.equal(headings[0], 'How to read');

  const sectionStart = readme.indexOf('## How to read');
  const nextSection = readme.indexOf('\n## ', sectionStart + 1);
  const section = readme.slice(sectionStart, nextSection === -1 ? undefined : nextSection);
  const links = relativeMarkdownLinks(section);
  const targets = links.map(({ target }) => target.replace(/^\.\//, ''));
  const canonicalFiles = [
    'FLOW.md',
    'workspace.yaml',
    'projects/index.md',
    'roles/workflow.md',
    'roles/core.md',
    'roles/planner.md',
    'roles/architect.md',
    'roles/executor.md',
    'roles/reviewer.md',
    'roles/auditor.md',
    'roles/publisher.md',
    'roles/models.md',
    'roles/documentation.md',
    'roles/context.md',
  ];

  for (const file of canonicalFiles) {
    assert.ok(targets.includes(file), `How to read must link ${file} relatively`);
  }

  const readingOrder = ['FLOW.md', 'workspace.yaml', 'projects/index.md', 'roles/workflow.md'];
  let previousIndex = -1;
  for (const file of readingOrder) {
    const index = targets.indexOf(file);
    assert.ok(index > previousIndex, `${file} must follow the canonical reading order`);
    previousIndex = index;
  }

  const orderText = ['AGENTS.md', '.ai/context.md', 'decisions', 'tasks', 'contextDependencies'];
  previousIndex = -1;
  for (const item of orderText) {
    const index = section.indexOf(item, previousIndex + 1);
    assert.ok(index > previousIndex, `${item} must follow the canonical reading order`);
    previousIndex = index;
  }
});

test('.github managed routing block starts at the organization canon', () => {
  const agents = readText(agentsUrl, 'AGENTS.md');
  const startMarker = '<!-- ai-workflow:agents-routing:start -->';
  const endMarker = '<!-- ai-workflow:agents-routing:end -->';
  const start = agents.indexOf(startMarker);
  const end = agents.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, 'AGENTS.md must have a managed routing block start marker');
  assert.ok(end > start, 'AGENTS.md must have a managed routing block end marker');

  const block = agents.slice(start + startMarker.length, end);
  const targets = relativeMarkdownLinks(block).map(({ target }) => target.replace(/^\.\//, ''));
  const expected = [
    'docs/workflow/README.md',
    'docs/workflow/FLOW.md',
    'docs/workflow/workspace.yaml',
    'docs/workflow/projects/index.md',
    'docs/workflow/roles/workflow.md',
  ];

  assert.equal(targets[0], expected[0], 'managed routing must start at the organization workflow README');
  for (const target of expected) {
    assert.ok(targets.includes(target), `managed routing must link ${target}`);
  }
});

test('.github operational workflow documentation has no personal canon dependency', () => {
  const operationalFiles = [
    [agentsUrl, 'AGENTS.md'],
    [automationReadmeUrl, 'automation/README.md'],
    [readmeUrl, 'docs/workflow/README.md'],
    [onboardingUrl, 'docs/workflow/onboarding.md'],
  ];

  for (const [fileUrl, description] of operationalFiles) {
    assert.doesNotMatch(readText(fileUrl, description), /syllik\/ai-workflow/i, `${description} must use the organization canon`);
  }
});

test('onboarding publishes the exact organization routing order', () => {
  const onboarding = readText(onboardingUrl, 'workflow onboarding guide');
  const targets = relativeMarkdownLinks(onboarding).map(({ target }) => target.replace(/^\.\//, ''));
  const expected = ['README.md', 'FLOW.md', 'workspace.yaml', 'projects/index.md', 'roles/workflow.md'];
  let previousIndex = -1;

  for (const target of expected) {
    const index = targets.indexOf(target, previousIndex + 1);
    assert.ok(index > previousIndex, `${target} must follow the organization routing order in onboarding`);
    previousIndex = index;
  }
});
