import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadRegistry, parseYamlSubset } from './registry.mjs';

const workflowRoot = new URL('../docs/workflow/', import.meta.url);
const workspaceUrl = new URL('workspace.yaml', workflowRoot);
const projectIndexUrl = new URL('projects/index.md', workflowRoot);
const roleIndexUrl = new URL('roles/workflow.md', workflowRoot);
const rolesRoot = new URL('roles/', workflowRoot);
const coreUrl = new URL('roles/core.md', workflowRoot);
const modelsUrl = new URL('roles/models.md', workflowRoot);
const executorUrl = new URL('roles/executor.md', workflowRoot);
const readmeUrl = new URL('README.md', workflowRoot);
const agentsUrl = new URL('../AGENTS.md', import.meta.url);
const automationReadmeUrl = new URL('README.md', import.meta.url);
const onboardingUrl = new URL('onboarding.md', workflowRoot);
const flowUrl = new URL('FLOW.md', workflowRoot);
const publisherUrl = new URL('roles/publisher.md', workflowRoot);
const contextUrl = new URL('../.ai/context.md', import.meta.url);

const canonBase = 'https://github.com/ChipIn-one/.github/blob/master/';
const flowCanonUrl = `${canonBase}docs/workflow/FLOW.md`;

const forbiddenWorkflowReferences = /(?:github\.com\/)?syllik\/ai-workflow|~\/Desktop|scripts\/workspace\/|\/Users\/|\.local\/share/i;

const repositories = [
  'ChipIn-one/.github',
  'ChipIn-one/chipin-frontend',
  'ChipIn-one/chipin-backend',
  'ChipIn-one/chipin-knowledge-base',
];

const META = 'ChipIn-one/.github';
const KB = 'ChipIn-one/chipin-knowledge-base';

function readText(url, description) {
  assert.ok(fs.existsSync(url), `${description} must exist`);
  return fs.readFileSync(url, 'utf8');
}

function workspace() {
  return parseYamlSubset(readText(workspaceUrl, 'ChipIn workspace'));
}

function workspaceById() {
  return new Map(workspace().projects.map(record => [record.id, record]));
}

function markdownLinks(text) {
  return [...text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)]
    .map(([, label, target]) => ({ label, target }))
    .filter(({ target }) => target);
}

function relativeMarkdownLinks(text) {
  return markdownLinks(text)
    .map(({ label, target }) => ({ label, target: target.split('#', 1)[0] }))
    .filter(({ target }) => target && !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target));
}

function headingAnchors(text) {
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(([, heading]) => heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')));
}

function section(text, heading) {
  const start = text.indexOf(`## ${heading}`);
  assert.ok(start >= 0, `section "${heading}" must exist`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

function filesUnder(directoryUrl) {
  return fs.readdirSync(directoryUrl, { withFileTypes: true }).flatMap(entry => {
    const entryUrl = new URL(entry.name, directoryUrl);
    return entry.isDirectory() ? filesUnder(new URL(`${entry.name}/`, directoryUrl)) : [entryUrl];
  });
}

function managedBlock() {
  const agents = readText(agentsUrl, 'AGENTS.md');
  const startMarker = '<!-- ai-workflow:agents-routing:start -->';
  const endMarker = '<!-- ai-workflow:agents-routing:end -->';
  const start = agents.indexOf(startMarker);
  const end = agents.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, 'AGENTS.md must have a managed routing block start marker');
  assert.ok(end > start, 'AGENTS.md must have a managed routing block end marker');
  return agents.slice(start, end + endMarker.length);
}

test('ChipIn workspace contains exactly the four registered repositories', () => {
  assert.deepEqual(
    workspace().projects.map(({ id }) => id).sort(),
    [...repositories].sort(),
  );
});

test('workspace repositories and integration branches match workflow-registry.yaml', () => {
  const registry = loadRegistry();
  const byId = workspaceById();
  const routed = registry.repositories.filter(profile =>
    profile.capabilities.agentRouting === 'required' && repositories.includes(profile.repository));
  assert.deepEqual(routed.map(({ repository }) => repository).sort(), [...repositories].sort(),
    'every workspace repository must be an agentRouting: required registry repository');

  for (const profile of routed) {
    const record = byId.get(profile.repository);
    assert.ok(record, `workspace record ${profile.repository} must exist`);
    assert.equal(record.repository, profile.repository);
    assert.equal(record.integrationBranch, profile.branches.integration,
      `${profile.repository} integrationBranch must match the registry`);
    for (const dependency of record.contextDependencies ?? []) {
      const dependencyProfile = registry.repositories.find(({ repository }) => repository === dependency.repository);
      assert.ok(dependencyProfile, `${dependency.repository} must be a registry repository`);
      assert.equal(dependency.integrationBranch, dependencyProfile.branches.integration,
        `${record.id} dependency ${dependency.repository} must use the registry integration branch`);
    }
  }
});

test('every workspace record is managed; read-only exists only on context dependencies', () => {
  for (const record of workspace().projects) {
    assert.equal(record.access, 'managed', `${record.id} must be managed`);
    assert.equal(record.status, 'active');
    if ('contextPath' in record) assert.equal(record.contextPath, '.ai/context.md', `${record.id} contextPath is optional; when set it is .ai/context.md`);
    for (const dependency of record.contextDependencies ?? []) {
      assert.equal(dependency.access, 'read-only', `${record.id} dependency ${dependency.repository} must be read-only`);
    }
  }
});

test('frontend, backend and knowledge base declare the .github admission tooling and canon dependency', () => {
  const byId = workspaceById();
  assert.equal(byId.get(META).contextDependencies, undefined, '.github needs no dependency on itself');

  for (const id of repositories.filter(id => id !== META)) {
    const dependencies = byId.get(id).contextDependencies ?? [];
    const meta = dependencies.find(({ repository }) => repository === META);
    assert.ok(meta, `${id} must declare ${META} as a context dependency`);
    assert.equal(meta.integrationBranch, 'master');
    assert.equal(meta.access, 'read-only');
    assert.match(meta.purpose ?? '', /admission/i, `${id} .github dependency purpose must name admission tooling`);
    assert.match(meta.purpose ?? '', /canon/i, `${id} .github dependency purpose must name the canon`);
  }

  for (const id of ['ChipIn-one/chipin-frontend', 'ChipIn-one/chipin-backend']) {
    assert.ok(byId.get(id).contextDependencies.some(({ repository }) => repository === KB),
      `${id} must keep the knowledge base dependency`);
  }
});

test('project index is for humans and its access, branch and dependency columns match workspace.yaml', () => {
  const projectIndex = readText(projectIndexUrl, 'project index');
  assert.match(projectIndex, /for humans/i);
  assert.match(projectIndex, /workspace\.yaml`?\]\([^)]*\) is normative/i);

  for (const record of workspace().projects) {
    const row = projectIndex.split(/\r?\n/).find(line => line.startsWith(`| [${record.id}](`));
    assert.ok(row, `project index must include ${record.id}`);
    const cells = row.split('|').slice(1, -1).map(cell => cell.trim());
    assert.equal(cells[1], record.access, `${record.id} access column`);
    assert.equal(cells[2], record.status, `${record.id} status column`);
    assert.equal(cells[3], `\`${record.integrationBranch}\``, `${record.id} branch column`);
    const contextFile = record.contextPath ?? 'AGENTS.md';
    assert.ok(
      cells[4].includes(`[${contextFile}](https://github.com/${record.id}/blob/${record.integrationBranch}/${contextFile})`),
      `${record.id} must link its ${contextFile} on ${record.integrationBranch}`,
    );
    const dependencies = record.contextDependencies ?? [];
    if (dependencies.length === 0) assert.equal(cells[5], '—', `${record.id} has no dependencies`);
    for (const dependency of dependencies) {
      assert.ok(
        cells[5].includes(`[${dependency.repository}](https://github.com/${dependency.repository}/tree/${dependency.integrationBranch}) (\`${dependency.integrationBranch}\`)`),
        `${record.id} dependency column must list ${dependency.repository} on ${dependency.integrationBranch}`,
      );
    }
    assert.equal((cells[5].match(/\]\(https:/g) ?? []).length, dependencies.length,
      `${record.id} dependency column must list exactly the declared dependencies`);
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

test('canon contains no personal workflow, path, or workspace script dependency', () => {
  assert.ok(fs.existsSync(workflowRoot), 'canonical workflow directory must exist');

  for (const fileUrl of filesUnder(workflowRoot)) {
    assert.doesNotMatch(
      fs.readFileSync(fileUrl, 'utf8'),
      forbiddenWorkflowReferences,
      `${fileUrl.href} has a personal canon, personal path, or workspace-script dependency`,
    );
  }
});

test('FLOW.md alone spells out the mandatory reading order', () => {
  const flow = readText(flowUrl, 'canonical workflow FLOW.md');
  const order = section(flow, 'Reading order');
  const items = ['FLOW.md', 'workspace.yaml', 'roles/core.md', 'workflow-registry.yaml', 'AGENTS.md', '.ai/context.md', 'decisions', 'tasks', 'contextDependencies'];
  let previousIndex = -1;
  for (const item of items) {
    const index = order.indexOf(item, previousIndex + 1);
    assert.ok(index > previousIndex, `${item} must follow the canonical reading order`);
    previousIndex = index;
  }
  const mandatory = order.split(/\r?\n/).filter(line => /^\d+\./.test(line)).join('\n');
  assert.doesNotMatch(mandatory, /README\.md|projects\/index\.md|roles\/workflow\.md/,
    'README, project index and role index are reference only, not mandatory reads');

  const readme = readText(readmeUrl, 'workflow README');
  const howToRead = section(readme, 'How to read');
  assert.ok(relativeMarkdownLinks(howToRead).some(({ target }) => target === 'FLOW.md'), 'README How to read must point at FLOW.md');
  assert.doesNotMatch(howToRead, /^\d+\./m, 'README must not restate the reading order');
  assert.match(howToRead, /reference/i);
});

test('FLOW.md states precedence and fails closed when the canon is unavailable', () => {
  const precedence = section(readText(flowUrl, 'FLOW.md'), 'Precedence and availability');
  assert.match(precedence, /canon wins for roles, gates(,)? and routing/i);
  assert.match(precedence, /repository's own docs win for product, engineering, build(,)? and deploy/i);
  assert.match(precedence, /real conflict[^.]*stop and report/i);
  assert.match(precedence, /cannot be read[^.]*stop/i);
  assert.match(precedence, /This covers [^\n]*`workflow-registry\.yaml`/);
  assert.match(precedence, /do not fall back to local copies/i);
});

test('FLOW.md maps task types to roles, tiers and publication authority and defaults to Planner', () => {
  const roles = section(readText(flowUrl, 'FLOW.md'), 'Roles and publication');
  assert.match(roles, /\| Task type \| Role \| Capability tier \| Publication authorized by \|/);
  for (const role of ['Planner', 'Architect', 'Executor', 'Reviewer', 'Auditor', 'Trusted Publisher']) {
    assert.match(roles, new RegExp(`\\| [^|\\n]*\\| \\[?${role}`), `role table must include ${role}`);
  }
  const rows = roles.split(/\r?\n/)
    .filter(line => line.startsWith('| ') && !/^\| (?:Task type|---)/.test(line))
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
  const byRole = new Map(rows.map(cells => [/\[([^\]]+)\]/.exec(cells[1])?.[1], cells[3]]));
  assert.equal(byRole.size, 6, 'role table must have exactly six role rows');
  for (const role of ['Planner', 'Architect', 'Reviewer', 'Auditor']) {
    assert.equal(byRole.get(role), 'not applicable', `${role} is read-only and never publishes`);
  }
  assert.equal(byRole.get('Executor'), 'n/a (hands off to Trusted Publisher)', 'Executor row must not name a publication authorizer');
  assert.match(byRole.get('Trusted Publisher'), /^human\b/, 'only a human authorizes the Trusted Publisher');
  assert.match(roles, /no role is assigned[^.]*Planner[^.]*read-only/i);
  assert.match(roles, /explicit human authorization naming the Trusted Publisher/i);
  assert.match(roles, /Only a human merges\./);
});

test('subagent rules are consistent between model tiers and Executor', () => {
  const models = readText(modelsUrl, 'models.md');
  const executor = readText(executorUrl, 'executor.md');
  assert.match(models, /Only an orchestrating session \(Planner at `deep` tier, started by a human\) may start subagents\./);
  assert.match(models, /Executor does not start subagents, and no subagent inherits Trusted Publisher authority\./);
  assert.doesNotMatch(models, /any role may start subagents|(?<!no )subagents? (?:may )?inherits?/i);
  assert.match(executor, /Executor does not start subagents/);
  assert.match(readText(publisherUrl, 'publisher.md'), /a subagent or Reviewer never holds it\./);
  assert.ok(relativeMarkdownLinks(executor).some(({ target }) => target === 'models.md'), 'executor.md must link models.md');
});

test('core invariants state the safety rules', () => {
  const core = readText(coreUrl, 'core.md');
  const rules = [
    /Only a human merges\./,
    /Executor does not commit, push, or publish without explicit human authorization/,
    /Never store secrets[^.]*in files, PR bodies, or Issue bodies/,
    /Never push directly to `master` or `develop`/,
    /Never force-push or bypass required checks/,
  ];
  for (const rule of rules) assert.match(core, rule);
});

test('admission semantics are stated once in core.md and referenced elsewhere', () => {
  const admission = section(readText(coreUrl, 'core.md'), 'Issue admission');
  assert.match(admission, /`required`[^\n]*INTAKE_COMPLETE[^\n]*blocks/);
  assert.match(admission, /`advisory`[^\n]*preflight[^\n]*report[^\n]*warn[^\n]*proceed/i);
  assert.match(admission, /`off`[^\n]*skip/i);

  const others = [
    [flowUrl, 'FLOW.md'],
    [agentsUrl, 'AGENTS.md'],
    ...fs.readdirSync(rolesRoot).filter(name => name !== 'core.md').map(name => [new URL(name, rolesRoot), `roles/${name}`]),
  ];
  for (const [url, description] of others) {
    const text = readText(url, description);
    assert.doesNotMatch(text, /admission (?:capability )?(?:is )?(?:on|enabled)\b/i, `${description} must not restate admission scope`);
    assert.doesNotMatch(text, /^\s*-?\s*`advisory`/m, `${description} must not restate admission semantics`);
    if (/admission/i.test(text)) {
      assert.ok(markdownLinks(text).some(({ target }) => /core\.md#issue-admission$/.test(target)),
        `${description} mentions admission and must link core.md#issue-admission`);
    }
  }
});

test('.github managed routing block starts at FLOW.md and stays small', () => {
  const block = managedBlock();
  const targets = markdownLinks(block).map(({ target }) => target);
  assert.equal(targets[0], flowCanonUrl, 'managed routing must start at FLOW.md');
  assert.ok(!targets.some(target => /README\.md|projects\/index\.md/.test(target)), 'managed routing must not mandate README or project index');
  assert.ok(targets.includes(`${flowCanonUrl}#precedence-and-availability`), 'managed routing must reference FLOW precedence');
  assert.ok(Buffer.byteLength(block) <= 700, 'managed routing block must stay small');

  for (const target of targets) {
    assert.ok(target.startsWith(`${canonBase}docs/workflow/`), `${target} must be an absolute organization canon link`);
    const [path, anchor] = target.slice(canonBase.length).split('#');
    const localUrl = new URL(`../${path}`, import.meta.url);
    assert.ok(fs.existsSync(localUrl), `${target} must map to existing local ${path}`);
    if (anchor) assert.ok(headingAnchors(fs.readFileSync(localUrl, 'utf8')).has(anchor), `${target} anchor must exist`);
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
    assert.doesNotMatch(
      readText(fileUrl, description),
      forbiddenWorkflowReferences,
      `${description} must not depend on a personal canon, personal path, or workspace script`,
    );
  }
});

test('onboarding routes through FLOW.md and has no dead template link', () => {
  const onboarding = readText(onboardingUrl, 'workflow onboarding guide');
  assert.ok(markdownLinks(onboarding).some(({ target }) => target === flowCanonUrl), 'onboarding must link FLOW.md');
  assert.doesNotMatch(onboarding, /templates\/ai-context\.md/);
});

test('canonical FLOW keeps legacy and pre-canon contexts non-authoritative', () => {
  const flow = readText(flowUrl, 'canonical workflow FLOW.md');
  assert.match(flow, /legacy\/pre-canon contexts are migration-only and never authoritative/i);
});

const restatementScope = () => [
  ...filesUnder(workflowRoot).filter(url => url.pathname.endsWith('.md')),
  agentsUrl,
  automationReadmeUrl,
];

test('no file outside the canon keeps the old read-only access wording for BE/KB', () => {
  const oldWording = /(?:\bBE\b|\bKB\b|backend|knowledge base)[^.\n]*\bread-only`?\s+(?:for|target|workspace|access)|(?:stays|remains)\s+`?read-only/i;
  for (const url of [...filesUnder(workflowRoot), agentsUrl, automationReadmeUrl]) {
    assert.doesNotMatch(fs.readFileSync(url, 'utf8'), oldWording, `${url.pathname} restates read-only repository access`);
  }
});

test('every relative link and heading anchor in the canon and AGENTS.md resolves', () => {
  for (const url of [...filesUnder(workflowRoot).filter(file => file.pathname.endsWith('.md')), agentsUrl]) {
    const text = fs.readFileSync(url, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const { target: raw } of markdownLinks(text)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(raw)) continue;
      const [path, anchor] = raw.split('#');
      const targetUrl = path ? new URL(path, url) : url;
      assert.ok(fs.existsSync(targetUrl), `${url.pathname}: link ${raw} must resolve`);
      if (anchor && targetUrl.pathname.endsWith('.md')) {
        assert.ok(headingAnchors(fs.readFileSync(targetUrl, 'utf8')).has(anchor), `${url.pathname}: anchor ${raw} must exist`);
      }
    }
  }
});

test('.github context records canon ownership and keeps review policy local', () => {
  const context = readText(contextUrl, '.ai/context.md');
  assert.match(context, /^- This repository owns the shared ChipIn AI workflow canon in `docs\/workflow\/`[^\n]*roles, routing, Issue admission semantics/m);
  assert.match(context, /^- Repository-specific code\/AI review policy stays local to `chipin-frontend` and `chipin-backend`/m);
});

test('only core.md states admission mode semantics', () => {
  for (const url of restatementScope()) {
    if (url.href === coreUrl.href) continue;
    const sentences = fs.readFileSync(url, 'utf8').split(/(?<=[.!?])\s+|\n/);
    for (const sentence of sentences) {
      if (/`advisory`|advisory (?:admission|preflight)|admission[^.]*\badvisory\b/i.test(sentence)) {
        assert.doesNotMatch(sentence, /\b(?:block\w*|proceed\w*|warn\w*|INTAKE_COMPLETE|report\w*)\b/i,
          `${url.pathname} restates admission semantics: ${sentence}`);
      }
    }
  }
});
