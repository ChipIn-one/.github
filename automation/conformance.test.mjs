import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GitHubConformanceSource, GitHubConformanceStore, audit, checkCallers, checkDependabot, checkIntake, checkMergedPastRed,
  checkPins, checkProjectPullRequests, checkProtection, checkRouting, extractPins, main, parseMarker, renderIssue,
  renderSummary, sortTags, touchesCapability, upsertIssues,
} from './conformance.mjs';
import { getRepositoryProfile, loadRegistry } from './registry.mjs';

const FE = 'ChipIn-one/chipin-frontend';
const BE = 'ChipIn-one/chipin-backend';
const KB = 'ChipIn-one/chipin-knowledge-base';
const META = 'ChipIn-one/.github';
const NOTIF = 'ChipIn-one/chipin-notifications';
const V1 = 'a'.repeat(40);
const V11 = 'b'.repeat(40);
const profile = name => getRepositoryProfile(name);
const uses = (name, sha, comment = '') => `        uses: ChipIn-one/.github/automation/${name}@${sha}${comment ? ` # ${comment}` : ''}`;
const workflow = (...lines) => ({ path: '.github/workflows/x.yml', text: lines.join('\n') });
const checks = findings => findings.map(f => f.check);

// ---------------------------------------------------------------------------------------------------
test('pins are extracted with action name, ref and version comment', () => {
  const pins = extractPins([workflow(uses('issue-admission-action', V1, 'v1.0.0'), uses('pr-metadata-action', 'main'),
    '        uses: ChipIn-one/.github/.github/workflows/pr-gate.yml@' + V1 + ' # v1.0.0', '        uses: actions/checkout@v7')]);
  assert.deepEqual(pins.map(p => [p.name, p.ref.slice(0, 4), p.comment]), [['issue-admission-action', 'aaaa', 'v1.0.0'], ['pr-metadata-action', 'main', ''], ['pr-gate', 'aaaa', 'v1.0.0']]);
});

test('caller presence follows the registry capabilities', () => {
  const none = checkCallers(profile(BE), []);
  assert.deepEqual(checks(none), Array(none.length).fill('CALLER_MISSING'));
  assert.equal(none.length, 4, 'admission, developmentLink, prMetadata and milestones are missing for BE');
  const pins = extractPins([workflow(uses('issue-admission-action', V1), uses('development-link-action', V1), uses('create-milestone-action', V1))]);
  const be = checkCallers(profile(BE), pins);
  assert.equal(be.length, 1);
  assert.match(be[0].message, /prMetadata/);
  assert.deepEqual(checkCallers(profile(META), []), [], 'meta repositories host the actions');
  const kbPins = extractPins([workflow(uses('development-link-action', V1))]);
  const kb = checkCallers(profile(KB), kbPins);
  assert.equal(kb.length, 1, 'KB admission is covered by the development-link action; completion (integration-merge) still needs its caller');
  assert.match(kb[0].message, /completion is automatic but no workflow uses completion-action/);
  const kbComplete = extractPins([workflow(uses('development-link-action', V1), uses('completion-action', V1))]);
  assert.deepEqual(checkCallers(profile(KB), kbComplete), [], 'KB with development-link and completion callers conforms');
  // production-merge keeps the frontend action; the generic action does not satisfy it
  const feWrong = checkCallers(profile(FE), extractPins([workflow(uses('issue-admission-action', V1), uses('development-link-action', V1),
    uses('pr-metadata-action', V1), uses('create-milestone-action', V1), uses('completion-action', V1))]));
  assert.deepEqual(checks(feWrong), ['CALLER_MISSING']);
  assert.match(feWrong[0].message, /frontend-production-completion-action/);
  const gate = extractPins([{ path: 'p', text: `    uses: ChipIn-one/.github/.github/workflows/pr-gate.yml@${V1} # v1.0.0` }]);
  assert.deepEqual(checks(checkCallers(profile(BE), gate)), ['CALLER_MISSING'], 'pr-gate covers admission, link and metadata; BE milestones still needed');
});

test('capability-aware change filter ignores tests and docs', () => {
  assert.equal(touchesCapability('create-milestone-action', ['automation/pr-metadata.mjs']), false);
  assert.equal(touchesCapability('create-milestone-action', ['automation/create-milestone.mjs']), true);
  assert.equal(touchesCapability('issue-admission-action', ['automation/issue-admission.test.mjs', 'docs/x.md']), false);
  assert.equal(touchesCapability('development-link-action', ['automation/relationships.mjs']), true);
  assert.equal(touchesCapability('frontend-production-completion-action', ['automation/pr-metadata.mjs']), false);
  assert.equal(touchesCapability('completion-action', ['automation/completion.mjs']), true);
  assert.equal(touchesCapability('completion-action', ['automation/frontend-production-completion-policy.mjs']), true);
  assert.equal(touchesCapability('completion-action', ['workflow-registry.yaml']), true);
  assert.equal(touchesCapability('completion-action', ['automation/completion.test.mjs', 'docs/workflow/completion.md']), false);
  assert.equal(touchesCapability('completion-action', ['automation/release.mjs']), false);
});

const source = (over = {}) => ({
  compare: async () => ({ status: 'ahead', files: ['automation/issue-admission.mjs'] }),
  ...over,
});
const tags = sortTags([{ name: 'v1.0.0', sha: V1 }, { name: 'v1.1.0', sha: V11 }, { name: 'nightly', sha: 'c'.repeat(40) }, { name: 'v1.10.0', sha: 'd'.repeat(40) }]);

test('tags sort by semantic version and ignore non-release tags', () => {
  assert.deepEqual(tags.map(t => t.name), ['v1.10.0', 'v1.1.0', 'v1.0.0']);
});

test('pin freshness: current, stale, not-affecting, unpinned, no comment, mismatched, diverged, unknown', async () => {
  const latest = tags.slice(1); // v1.1.0 latest
  const run = async (lines, src = source()) => checkPins(profile(FE), extractPins([workflow(...lines)]), src, latest);
  assert.deepEqual(await run([uses('issue-admission-action', V11, 'v1.1.0')]), []);
  assert.deepEqual(checks(await run([uses('issue-admission-action', V1, 'v1.0.0')])), ['PIN_STALE']);
  assert.deepEqual(checks(await run([uses('create-milestone-action', V1, 'v1.0.0')])), ['PIN_BEHIND'], 'newer tag does not touch milestones');
  assert.deepEqual(checks(await run([uses('issue-admission-action', 'main')])), ['PIN_NOT_SHA']);
  assert.deepEqual(checks(await run([uses('issue-admission-action', V11)])), ['PIN_NO_VERSION']);
  assert.deepEqual(checks(await run([uses('issue-admission-action', V11, 'v1.0.0')])), ['PIN_VERSION_MISMATCH']);
  assert.deepEqual(checks(await run([uses('issue-admission-action', 'e'.repeat(40), 'v1.0.0')], source({ compare: async () => ({ status: 'diverged', files: [] }) }))), ['PIN_UNTAGGED_SHA', 'PIN_STALE']);
  assert.deepEqual(checks(await run([uses('issue-admission-action', 'e'.repeat(40), 'v1.1.0')], source({ compare: async () => { throw new Error('404'); } }))), ['PIN_UNTAGGED_SHA', 'PIN_UNKNOWN']);
  assert.deepEqual(checks(await run([uses('issue-admission-action', 'e'.repeat(40))], source({ compare: async () => ({ status: 'behind', files: [] }) }))), ['PIN_NO_VERSION', 'PIN_AHEAD_OF_TAG']);
  const dup = await run([uses('issue-admission-action', V1, 'v1.0.0'), uses('issue-admission-action', V1, 'v1.0.0')]);
  assert.equal(dup.length, 1, 'the same stale pin is reported once');
});

test('dependabot: missing, no github-actions, wrong target, correct', () => {
  const fe = profile(FE);
  assert.deepEqual(checks(checkDependabot(fe, null)), ['DEPENDABOT_MISSING']);
  assert.deepEqual(checks(checkDependabot(fe, "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n")), ['DEPENDABOT_NO_ACTIONS']);
  assert.deepEqual(checks(checkDependabot(fe, "version: 2\nupdates:\n  - package-ecosystem: 'github-actions'\n    directory: '/'\n")), ['DEPENDABOT_TARGET'], 'default branch main is not the integration branch dev');
  assert.deepEqual(checks(checkDependabot(fe, "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    target-branch: 'main'\n  - package-ecosystem: 'github-actions'\n    target-branch: 'dev'\n")), []);
  assert.deepEqual(checkDependabot(profile(BE), "updates:\n  - package-ecosystem: 'github-actions'\n    target-branch: 'develop'\n"), []);
  assert.deepEqual(checkDependabot(profile(BE), "updates:\n  - package-ecosystem: \"github-actions\"\n"), [], 'develop is both default and integration');
});

test('routing block and .ai/context.md', () => {
  assert.deepEqual(checks(checkRouting(profile(BE), 'plain', null)), ['ROUTING_BLOCK_MISSING', 'AI_CONTEXT_MISSING']);
  assert.deepEqual(checks(checkRouting(profile(BE), null, 'x')), ['ROUTING_BLOCK_MISSING']);
  assert.deepEqual(checkRouting(profile(FE), '<!-- ai-workflow:agents-routing:start -->', '# ctx'), []);
});

test('protection: unavailable is a note, stale registry is drift, checks must be enforced', () => {
  const na = { state: 'unavailable' };
  assert.deepEqual(checkProtection(profile(BE), na, na).map(f => [f.check, f.severity]), [['PROTECTION_UNAVAILABLE', 'note']]);
  assert.deepEqual(checks(checkProtection(profile(BE), { state: 'ok', rules: [], requiredChecks: [] }, na)), ['PROTECTION_REGISTRY_STALE']);
  assert.deepEqual(checks(checkProtection(profile(KB), na, { state: 'unprotected' })), ['PROTECTION_REGISTRY_STALE']);
  const meta = { state: 'ok', rules: ['pull_request', 'required_status_checks'], requiredChecks: ['evaluate-fixtures'] };
  assert.deepEqual(checkProtection(profile(META), meta, { state: 'unprotected' }), []);
  assert.deepEqual(checks(checkProtection(profile(META), { ...meta, requiredChecks: [] }, { state: 'unprotected' })), ['REQUIRED_CHECKS_MISSING']);
  assert.deepEqual(checks(checkProtection(profile(META), { state: 'ok', rules: ['required_status_checks'], requiredChecks: ['evaluate-fixtures'] }, { state: 'unprotected' })), ['RULESET_NO_PULL_REQUEST']);
  const fe = checkProtection(profile(FE), { state: 'ok', rules: [], requiredChecks: [] }, { state: 'ok', requiredChecks: ['frontend-ci'] });
  assert.deepEqual(fe.map(f => [f.check, f.severity]), [['PROTECTION_MECHANISM', 'note']], 'classic protection satisfies the required check');
  assert.deepEqual(checks(checkProtection(profile(META), { state: 'ok', rules: [], requiredChecks: [] }, { state: 'unprotected' }).filter(f => f.severity === 'drift')), ['REQUIRED_CHECKS_MISSING']);
  assert.deepEqual(checkProtection(profile(META), { state: 'unreadable' }, { state: 'unreadable' }).map(f => f.check), ['PROTECTION_UNVERIFIABLE']);
  assert.deepEqual(checkProtection(profile(META), na, na).map(f => f.check), ['PROTECTION_MISSING']);
});

test('protection: an unreadable mechanism turns missing required checks into a note, not drift', () => {
  const empty = { state: 'ok', rules: [], requiredChecks: [] };
  const fe = checkProtection(profile(FE), empty, { state: 'unreadable' });
  assert.deepEqual(fe.map(f => [f.check, f.severity]), [['PROTECTION_UNVERIFIABLE', 'note']]);
  assert.match(fe[0].message, /classic branch protection/);
  assert.deepEqual(checkProtection(profile(FE), { state: 'unreadable' }, { state: 'ok', requiredChecks: [] }).map(f => f.check), ['PROTECTION_UNVERIFIABLE']);
  assert.deepEqual(checkProtection(profile(FE), empty, { state: 'ok', requiredChecks: [] }).map(f => f.check), ['REQUIRED_CHECKS_MISSING', 'PROTECTION_MECHANISM'], 'both readable and still missing: real drift');
});

test('audit: a token without checks:read downgrades only the red-check verification, other read failures stay UNREADABLE', async () => {
  const denied = await audit({ source: fakeSource({ checkRuns: async () => { throw new Error('GET x -> 403: {"message":"Resource not accessible by personal access token"}'); } }), repositories: [BE] });
  assert.equal(denied.repositories[0].status, 'DRIFT');
  assert.ok(denied.repositories[0].notes.some(n => n.check === 'CHECKS_UNVERIFIABLE'));
  assert.ok(!checks(denied.repositories[0].findings).includes('MERGED_PAST_RED_CHECK'));
  const broken = await audit({ source: fakeSource({ checkRuns: async () => { throw new Error('GET x -> 500: boom'); } }), repositories: [BE] });
  assert.equal(broken.repositories[0].status, 'UNREADABLE');
});

test('project pull requests, intake gaps (note only), closed with open PRs, merged past red', () => {
  assert.deepEqual(checkProjectPullRequests(profile(FE), [{ repository: BE, number: 1 }]), []);
  const prs = checkProjectPullRequests(profile(FE), Array.from({ length: 12 }, (_, i) => ({ repository: FE, number: i + 1 })));
  assert.equal(prs[0].severity, 'drift');
  assert.match(prs[0].message, /12 pull request/);
  assert.deepEqual(checkIntake(profile(FE), [{ type: 'Task', priority: 'P2', projectCount: 1 }]), []);
  const gaps = checkIntake(profile(FE), [{ type: null, priority: null, projectCount: 0 }, { type: 'Task', priority: 'P1', projectCount: 2 }]);
  assert.equal(gaps[0].severity, 'note');
  assert.match(gaps[0].message, /without Type 1, without Priority 1, without Project #5 1, duplicate Project #5 items 1/);
  assert.deepEqual(checkMergedPastRed(profile(FE), [{ number: 1, failed: ['frontend-ci'] }]), [], 'only for protection: unavailable');
  assert.deepEqual(checkMergedPastRed(profile(KB), [{ number: 1, failed: ['x'] }]), [], 'KB has no required checks');
  const red = checkMergedPastRed(profile(BE), [{ number: 7, failed: [] }, { number: 9, failed: ['Unit and integration tests'] }]);
  assert.equal(red[0].check, 'MERGED_PAST_RED_CHECK');
  assert.match(red[0].message, /PR #9/);
});

// --- full audit over a fake source ----------------------------------------------------------------------
function fakeSource(over = {}) {
  const files = {
    [`${META}:AGENTS.md`]: '<!-- ai-workflow:agents-routing:start -->', [`${META}:.ai/context.md`]: 'c', [`${META}:.github/dependabot.yml`]: "updates:\n  - package-ecosystem: 'github-actions'\n",
    [`${FE}:AGENTS.md`]: '<!-- ai-workflow:agents-routing:start -->', [`${FE}:.ai/context.md`]: 'c',
    [`${FE}:.github/dependabot.yml`]: "updates:\n  - package-ecosystem: 'github-actions'\n    target-branch: 'dev'\n",
  };
  const wf = {
    [FE]: [workflow(uses('issue-admission-action', V1, 'v1.0.0'), uses('development-link-action', V1, 'v1.0.0'), uses('pr-metadata-action', V1, 'v1.0.0'), uses('create-milestone-action', V1, 'v1.0.0'), uses('frontend-production-completion-action', V1, 'v1.0.0'))],
    [BE]: [workflow(uses('issue-admission-action', 'f'.repeat(40)), uses('development-link-action', 'f'.repeat(40)), uses('create-milestone-action', 'f'.repeat(40)))],
    [KB]: [workflow(uses('development-link-action', 'f'.repeat(40)))],
    [META]: [],
    [NOTIF]: [],
  };
  const na = { state: 'unavailable' };
  return {
    tags: async () => [{ name: 'v1.0.0', sha: V1 }],
    projectPullRequests: async () => [],
    workflowFiles: async repo => wf[repo],
    repoFile: async (repo, path) => files[`${repo}:${path}`] ?? null,
    compare: async () => ({ status: 'diverged', files: [] }),
    branchRules: async repo => (repo === META ? { state: 'ok', rules: ['pull_request', 'required_status_checks'], requiredChecks: ['evaluate-fixtures'] } : repo === FE ? { state: 'ok', rules: [], requiredChecks: [] } : na),
    classicProtection: async repo => (repo === FE ? { state: 'ok', requiredChecks: ['frontend-ci'] } : repo === META ? { state: 'unprotected' } : na),
    openIssues: async () => [],
    closedIssuesWithOpenPrs: async () => [],
    mergedPullRequests: async () => [{ number: 5, mergedAt: new Date().toISOString(), headSha: 'h' }],
    checkRuns: async () => [{ name: 'Unit and integration tests', conclusion: 'success' }],
    orgRepositories: async () => [{ fullName: FE, archived: false }, { fullName: 'ChipIn-one/chipin-backend-python', archived: false }, { fullName: NOTIF, archived: false }, { fullName: 'ChipIn-one/old', archived: true }],
    ...over,
  };
}

test('audit: .github and FE conform; BE and KB show the expected drift; unregistered repos are listed only', async () => {
  const report = await audit({ source: fakeSource() });
  const by = name => report.repositories.find(r => r.repository === name);
  assert.equal(by(META).status, 'CONFORMANT');
  assert.equal(by(FE).status, 'CONFORMANT');
  assert.deepEqual(by(FE).notes.map(n => n.check), ['PROTECTION_MECHANISM']);
  assert.equal(by(BE).status, 'DRIFT');
  assert.ok(checks(by(BE).findings).includes('DEPENDABOT_MISSING'));
  assert.ok(checks(by(BE).findings).includes('ROUTING_BLOCK_MISSING'));
  assert.ok(checks(by(BE).findings).includes('CALLER_MISSING'));
  assert.ok(checks(by(BE).findings).includes('PIN_STALE'));
  assert.equal(by(KB).status, 'DRIFT');
  assert.ok(checks(by(KB).findings).includes('DEPENDABOT_MISSING'));
  assert.deepEqual(report.unregistered, ['ChipIn-one/chipin-backend-python']);
  assert.deepEqual(report.summary, { repositories: 5, conformant: 3, drift: 2, unreadable: 0, unregistered: 1 });
  assert.equal(by(NOTIF).status, 'CONFORMANT', 'every capability is off, protection is unavailable on the plan');
  assert.match(renderSummary(report), /UNREGISTERED \(no action\)\n- ChipIn-one\/chipin-backend-python/);
});

test('audit: merge past a red required check is drift for protection-unavailable repositories', async () => {
  const report = await audit({ source: fakeSource({ checkRuns: async () => [{ name: 'Unit and integration tests', conclusion: 'failure' }] }), repositories: [BE] });
  assert.ok(checks(report.repositories[0].findings).includes('MERGED_PAST_RED_CHECK'));
  assert.deepEqual(report.unregistered, [], 'subset runs do not report unregistered repositories');
});

test('audit: any read failure makes the repository UNREADABLE with no findings', async () => {
  const report = await audit({ source: fakeSource({ repoFile: async () => { throw new Error('403 forbidden'); } }), repositories: [BE, META] });
  assert.deepEqual(report.repositories.map(r => r.status), ['UNREADABLE', 'UNREADABLE']);
  assert.deepEqual(report.repositories[0].findings, []);
  assert.match(report.repositories[0].error, /403/);
  const shared = await audit({ source: fakeSource({ tags: async () => { throw new Error('boom'); } }) });
  assert.equal(shared.summary.unreadable, 5);
});

// --- drift Issues ------------------------------------------------------------------------------------------
class FakeStore {
  constructor(issues = []) { this.issues = issues; this.calls = []; this.n = 500; }
  async listDriftIssues() { return this.issues; }
  async create(args) { this.calls.push(['create', args.repository, args.owner]); const number = this.n++; this.issues.push({ number, state: 'open', body: args.body }); return { number }; }
  async update(number, body) { this.calls.push(['update', number]); this.issues.find(i => i.number === number).body = body; }
  async closeCompleted(number) { this.calls.push(['close', number]); this.issues.find(i => i.number === number).state = 'closed'; }
}

test('drift Issue: marker, shape, owner fallback for KB, no duplicates on rerun, close at zero drift', async () => {
  const report = await audit({ source: fakeSource() });
  const store = new FakeStore();
  const plan = await upsertIssues({ report, store, apply: false });
  assert.deepEqual(plan.actions.filter(a => a.action === 'create').map(a => a.repository), [BE, KB]);
  assert.equal(store.calls.length, 0, 'plan writes nothing');
  const first = await upsertIssues({ report, store, apply: true });
  assert.deepEqual(first.actions.filter(a => a.action === 'created').length, 2);
  assert.deepEqual(store.calls.map(c => c.slice(0, 3)), [['create', BE, 'olegbal'], ['create', KB, 'syllik']], 'KB has no registry owner: falls back to the .github owner');
  assert.equal(parseMarker(store.issues[0].body), BE);
  assert.match(store.issues[0].body, /^Conformance: ChipIn-one\/chipin-backend\n\n## Problem/);
  assert.match(store.issues[0].body, /## Acceptance\n\n- \[ \] /);
  const again = await upsertIssues({ report, store, apply: true });
  assert.deepEqual(again.actions.map(a => a.action), ['unchanged', 'unchanged', 'unchanged', 'unchanged', 'unchanged']);
  assert.equal(store.issues.length, 2);
  const later = { ...report, repositories: report.repositories.map(r => ({ ...r, checkedAt: 'later' })) };
  assert.equal((await upsertIssues({ report: later, store, apply: true })).actions.every(a => a.action === 'unchanged'), true, 'a new audit time alone does not rewrite the Issue');
  const clean = { ...report, repositories: report.repositories.map(r => ({ ...r, status: 'CONFORMANT', findings: [] })) };
  const closed = await upsertIssues({ report: clean, store, apply: true });
  assert.deepEqual(closed.actions.filter(a => a.action === 'closed').map(a => a.repository), [BE, KB]);
  assert.ok(store.issues.every(i => i.state === 'closed'));
});

test('drift Issue: changed findings update the body; unreadable never touches anything; duplicates are reported', async () => {
  const report = await audit({ source: fakeSource() });
  const store = new FakeStore();
  await upsertIssues({ report, store, apply: true });
  const changed = { ...report, repositories: report.repositories.map(r => (r.repository === BE ? { ...r, findings: r.findings.slice(1) } : r)) };
  const result = await upsertIssues({ report: changed, store, apply: true });
  assert.equal(result.actions.find(a => a.repository === BE).action, 'updated');
  const unreadable = { ...report, repositories: report.repositories.map(r => ({ ...r, status: 'UNREADABLE', findings: [] })) };
  const before = store.calls.length;
  const skipped = await upsertIssues({ report: unreadable, store, apply: true });
  assert.ok(skipped.actions.every(a => a.action === 'skipped-unreadable'));
  assert.equal(store.calls.length, before, 'an unreadable audit never closes or edits an Issue');
  store.issues.push({ number: 999, state: 'open', body: store.issues[0].body });
  const dup = await upsertIssues({ report, store, apply: false });
  assert.deepEqual(dup.duplicates, [{ repository: BE, number: 999 }]);
  assert.equal(renderIssue(report.repositories.find(r => r.repository === BE), 'olegbal').includes('owner: olegbal'), true);
});

// --- GitHub-backed source and store over a fake client ---------------------------------------------------------
test('GitHubConformanceSource maps API answers and classifies protection errors', async () => {
  const answers = new Map();
  const client = {
    request: async (path, options) => {
      for (const [prefix, value] of answers) if (path.startsWith(prefix)) { if (value instanceof Error) throw value; return value; }
      if (options?.allow404) return null;
      throw new Error(`unexpected ${path}`);
    },
    listAll: async () => [{ name: 'v1.0.0', commit: { sha: V1 } }],
    graphql: async () => ({}),
  };
  const src = new GitHubConformanceSource(client);
  answers.set('/repos/R/contents/f.yml', { type: 'file', encoding: 'base64', content: Buffer.from('hello').toString('base64') });
  assert.equal(await src.repoFile('R', 'f.yml', 'dev'), 'hello');
  assert.equal(await src.repoFile('R', 'missing', 'dev'), null);
  assert.deepEqual(await src.tags(), [{ name: 'v1.0.0', sha: V1 }]);
  answers.set(`/repos/R/rules/branches/b`, [{ type: 'pull_request' }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }]);
  assert.deepEqual(await src.branchRules('R', 'b'), { state: 'ok', rules: ['pull_request', 'required_status_checks'], requiredChecks: ['ci'] });
  answers.set('/repos/R/rules/branches/b', new Error('GET x -> 403: {"message":"Upgrade to GitHub Pro or make this repository public"}'));
  assert.equal((await src.branchRules('R', 'b')).state, 'unavailable');
  answers.set('/repos/R/rules/branches/b', new Error('GET x -> 403: {"message":"Resource not accessible"}'));
  assert.equal((await src.branchRules('R', 'b')).state, 'unreadable');
  answers.set('/repos/R/branches/b/protection', new Error('GET x -> 404: {"message":"Branch not protected"}'));
  assert.equal((await src.classicProtection('R', 'b')).state, 'unprotected');
  answers.set('/repos/R/branches/b/protection', { required_status_checks: { contexts: ['a'], checks: [{ context: 'b' }] } });
  assert.deepEqual(await src.classicProtection('R', 'b'), { state: 'ok', requiredChecks: ['a', 'b'] });
});

test('GitHubConformanceSource.checkRuns falls back to Actions jobs when a PAT cannot read check runs', async () => {
  const calls = [];
  const client = {
    request: async path => {
      calls.push(path);
      if (path.includes('/check-runs')) throw new Error('GET x -> 403: {"message":"Resource not accessible by personal access token"}');
      if (path.includes('/actions/runs?head_sha=abc')) return { workflow_runs: [{ id: 1 }, { id: 2 }] };
      if (path.includes('/actions/runs/1/jobs')) return { jobs: [{ name: 'Unit and integration tests', conclusion: 'failure' }] };
      if (path.includes('/actions/runs/2/jobs')) return { jobs: [{ name: 'reconcile', conclusion: 'success' }] };
      throw new Error(`unexpected ${path}`);
    },
  };
  assert.deepEqual(await new GitHubConformanceSource(client).checkRuns('R', 'abc'), [
    { name: 'Unit and integration tests', conclusion: 'failure' }, { name: 'reconcile', conclusion: 'success' }]);
  assert.equal(calls.length, 4);
  const ok = new GitHubConformanceSource({ request: async () => ({ check_runs: [{ name: 'a', conclusion: 'success' }] }) });
  assert.deepEqual(await ok.checkRuns('R', 'abc'), [{ name: 'a', conclusion: 'success' }]);
  const broken = new GitHubConformanceSource({ request: async () => { throw new Error('GET x -> 500: boom'); } });
  await assert.rejects(broken.checkRuns('R', 'abc'), /500/);
  const denied = new GitHubConformanceSource({ request: async () => { throw new Error('GET x -> 403: nope'); } });
  await assert.rejects(denied.checkRuns('R', 'abc'), /403/);
});

test('GitHubConformanceStore: creates Task/P2 with Project Backlog; closes completed with Project Done', async () => {
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push([options.method ?? 'GET', path, options.body]);
      if (options.method === 'POST' && path.endsWith('/issues')) return { number: 200, node_id: 'N200' };
      if (options.method === 'PATCH') return { node_id: 'N200' };
      if (path.endsWith('/issues/200')) return { type: { name: 'Task' } };
      return {};
    },
    graphql: async query => {
      calls.push(['GQL', query]);
      if (query.includes('projectV2(number')) return { organization: { projectV2: { id: 'P', field: { id: 'F', options: [{ id: 'o1', name: 'Backlog' }, { id: 'o2', name: 'Done' }] } } } };
      if (query.includes('addProjectV2ItemById')) return { addProjectV2ItemById: { item: { id: 'I1' } } };
      if (query.includes('projectItems')) return { repository: { issue: { projectItems: { nodes: [{ id: 'I9', project: { number: 5 } }] } } } };
      return {};
    },
  };
  const store = new GitHubConformanceStore(client, { project: { number: 5 }, issueFields: { Priority: { id: 46621432 } } });
  const made = await store.create({ title: 't', body: 'b', owner: 'olegbal' });
  assert.equal(made.number, 200);
  const post = calls.find(c => c[0] === 'POST');
  assert.deepEqual(post[2], { title: 't', body: 'b', assignees: ['olegbal'], type: 'Task', issue_field_values: [{ field_id: 46621432, value: 'P2' }] });
  assert.ok(calls.some(c => c[0] === 'GQL' && c[1].includes('addProjectV2ItemById')));
  await store.closeCompleted(200, 'done');
  const patch = calls.filter(c => c[0] === 'PATCH').pop();
  assert.deepEqual(patch[2], { state: 'closed', state_reason: 'completed' });
  assert.ok(calls.filter(c => c[0] === 'GQL' && c[1].includes('updateProjectV2ItemFieldValue')).length >= 2);
});

test('CLI: audit writes per-repository artifacts; upsert apply needs activation', async () => {
  const written = new Map();
  const writeFile = async (p, text) => written.set(p, text);
  const saved = process.exitCode;
  const report = await main(['audit', '--dir', 'out', '--output', 'report.json', '--summary', 's.md'], {}, { source: fakeSource(), writeFile });
  assert.equal(report.summary.drift, 2);
  assert.deepEqual([...written.keys()].sort(), ['out/conformance-chipin-backend.json', 'out/conformance-chipin-frontend.json', 'out/conformance-chipin-knowledge-base.json', 'out/conformance-chipin-notifications.json', 'out/conformance-dot-github.json', 'report.json', 's.md']);
  await assert.rejects(main(['upsert', '--apply', '--report', 'report.json'], {}, { store: new FakeStore(), readFile: async () => written.get('report.json') }), /requires --activate/);
  const store = new FakeStore();
  const result = await main(['upsert', '--apply', '--activate', 'conformance-v1', '--report', 'report.json', '--output', 'u.json'], { CHIPIN_CONFORMANCE_WRITE: '1' }, { store, readFile: async () => written.get('report.json'), writeFile });
  assert.equal(result.actions.filter(a => a.action === 'created').length, 2);
  await assert.rejects(main(['nope'], {}, {}), /audit or upsert/);
  process.exitCode = saved;
});

test('the real registry yields a profile for each audited repository', () => {
  assert.equal(loadRegistry().repositories.length, 5);
});
