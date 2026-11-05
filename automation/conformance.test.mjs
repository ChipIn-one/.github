import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  GitHubConformanceSource, GitHubConformanceStore, RELEASE_TAGS_CHECKED, audit, checkCallers, checkRelease, checkCompletionCaller, checkCompletionSweep, checkDependabot, checkIntake, checkMergedPastRed,
  checkPins, checkProjectPullRequests, checkClosedBeforeProduction, closedBeforeProductionCandidates, CLOSED_SCAN_MAX_PAGES, CLOSED_SCAN_PAGE_SIZE, checkProtection, checkRouting, extractPins, extractRoutingBlock, loadContextPaths, main, parseMarker, renderIssue,
  completionSweepCovers, readReleaseFacts, releaseBranchOf, renderSummary, sortTags, touchesCapability, upsertIssues, workflowTriggers,
} from './conformance.mjs';
import { getRepositoryProfile, loadRegistry, validateRegistry } from './registry.mjs';

const FE = 'ChipIn-one/chipin-frontend';
const BE = 'ChipIn-one/chipin-backend';
const KB = 'ChipIn-one/chipin-knowledge-base';
const META = 'ChipIn-one/.github';
const NOTIF = 'ChipIn-one/chipin-notifications';
const V1 = 'a'.repeat(40);
const V11 = 'b'.repeat(40);
const profile = name => getRepositoryProfile(name);
const uses = (name, sha, comment = '') => `        uses: ChipIn-one/.github/automation/${name}@${sha}${comment ? ` # ${comment}` : ''}`;
const releaseUses = (sha, comment = '') => `    uses: ChipIn-one/.github/.github/workflows/release.yml@${sha}${comment ? ` # ${comment}` : ''}`;
const workflow = (...lines) => ({ path: '.github/workflows/x.yml', text: lines.join('\n') });
const checks = findings => findings.map(f => f.check);
const ROUTING_START = '<!-- ai-workflow:agents-routing:start -->';
const ROUTING_END = '<!-- ai-workflow:agents-routing:end -->';
const ROUTING = `${ROUTING_START}\nChipIn AI routing: start at the organization canon [FLOW.md](https://github.com/ChipIn-one/.github/blob/master/docs/workflow/FLOW.md). If the canon cannot be read, stop.\n${ROUTING_END}`;
const CANON = { state: 'ok', block: ROUTING };
const CTX = '.ai/context.md';
// the frontend dev/main record from before the canonical-master cutover (.github#216), rollback target of chipin-frontend#497
const legacyFrontend = () => ({ ...profile(FE), branches: Object.freeze({ default: 'main', integration: 'dev', promotion: 'main' }),
  completion: 'production-merge', completionRunner: 'repository', capabilities: Object.freeze({ ...profile(FE).capabilities, completion: 'automatic' }) });

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
  // production-merge (the dev/main rollback record) keeps the frontend action; the generic action does not satisfy it
  const feBase = [uses('issue-admission-action', V1), uses('development-link-action', V1), uses('pr-metadata-action', V1), uses('create-milestone-action', V1)];
  const feWrong = checkCallers(legacyFrontend(), extractPins([workflow(...feBase, uses('completion-action', V1))]));
  assert.deepEqual(checks(feWrong), ['CALLER_MISSING']);
  assert.match(feWrong[0].message, /frontend-production-completion-action/);
  // the live frontend record (.github#217): completion automatic, run only by the org sweep, so no completion caller
  // is required (checkCompletionSweep checks the sweep instead)
  assert.equal(profile(FE).capabilities.completion, 'automatic');
  assert.equal(profile(FE).completionRunner, 'org-sweep');
  assert.deepEqual(checkCallers(profile(FE), extractPins([workflow(...feBase)])), []);
  // the same record with the default runner still requires the repository caller
  const feRepositoryRunner = { ...profile(FE), completionRunner: 'repository' };
  assert.deepEqual(checks(checkCallers(feRepositoryRunner, extractPins([workflow(...feBase)]))), ['CALLER_MISSING']);
  const gate = extractPins([{ path: 'p', text: `    uses: ChipIn-one/.github/.github/workflows/pr-gate.yml@${V1} # v1.0.0` }]);
  assert.deepEqual(checks(checkCallers(profile(BE), gate)), ['CALLER_MISSING'], 'pr-gate covers admission, link and metadata; BE milestones still needed');
});

// a deployment-receipt record with the engine on and the default runner (a repository caller)
const receiptProfile = () => validateRegistry({
  schemaVersion: 1, standardVersion: 'v1', project: { number: 5, statuses: ['Backlog', 'Done'] },
  repositories: [{
    repository: FE, kind: 'code', visibility: 'public', owner: 'syllik', branches: { default: 'master', integration: 'master' },
    deploymentProfile: 'production', completion: 'deployment-receipt', productionEvidence: { environment: 'Production', creator: 'vercel[bot]' },
    protection: 'ruleset', requiredChecks: ['frontend-ci'], release: { strategy: 'deploy-tag', trigger: 'production-deploy', tagPrefix: 'v' },
  }],
}).repositories[0];
const receiptCaller = (on, path = '.github/workflows/completion.yml') => ({
  path, text: ['name: Completion', ...on, 'jobs:', '  completion:', '    steps:', uses('completion-action', V1, 'v1.0.0')].join('\n'),
});
const RECEIPT_ON = ['on:', '  deployment_status:', '  push:', '    branches: [master]', '  workflow_dispatch:'];

test('deployment-receipt: the shared completion-action is the caller, the frontend action does not satisfy it', () => {
  const receipt = receiptProfile();
  const base = [uses('issue-admission-action', V1), uses('development-link-action', V1), uses('pr-metadata-action', V1), uses('create-milestone-action', V1)];
  assert.deepEqual(checkCallers(receipt, extractPins([workflow(...base, uses('completion-action', V1))])), []);
  const wrong = checkCallers(receipt, extractPins([workflow(...base, uses('frontend-production-completion-action', V1))]));
  assert.deepEqual(checks(wrong), ['CALLER_MISSING']);
  assert.match(wrong[0].message, /completion is automatic but no workflow uses completion-action/);
});

test('deployment-receipt: the completion caller needs the deployment_status and push triggers', () => {
  const receipt = receiptProfile();
  const inspect = files => checkCompletionCaller(receipt, files, extractPins(files));
  assert.deepEqual(inspect([receiptCaller(RECEIPT_ON)]), []);
  assert.deepEqual(inspect([receiptCaller(['on: [push, deployment_status]'])]), [], 'flow form');
  const pushOnly = inspect([receiptCaller(['on:', '  push:', '    branches: [master]'])]);
  assert.deepEqual(pushOnly.map(f => [f.check, f.severity]), [['COMPLETION_TRIGGER_MISSING', 'drift']]);
  assert.match(pushOnly[0].message, /has no deployment_status trigger/);
  assert.match(pushOnly[0].remediation, /caller-completion-deployment-receipt\.yml/);
  const receiptOnly = inspect([receiptCaller(['on:', '  deployment_status:'])]);
  assert.match(receiptOnly[0].message, /has no push trigger/);
  assert.match(inspect([receiptCaller(['on: workflow_dispatch'])])[0].message, /no deployment_status or push trigger/);
  // a trigger in another workflow that does not run the completion action does not count
  const split = [receiptCaller(['on:', '  push:']), { path: '.github/workflows/other.yml', text: 'on:\n  deployment_status:\njobs: {}' }];
  assert.match(inspect(split)[0].message, /no deployment_status trigger/);
  // no caller at all is CALLER_MISSING's finding, not this one
  assert.deepEqual(inspect([]), []);
  // other strategies are not checked for these triggers
  for (const name of [KB, BE, META]) {
    assert.deepEqual(checkCompletionCaller(profile(name), [receiptCaller(['on: push'])], extractPins([receiptCaller(['on: push'])])), [], name);
  }
  // org-sweep (the live frontend record): a caller is optional, but one that exists must still have both triggers
  assert.deepEqual(checks(checkCompletionCaller(profile(FE), [receiptCaller(['on: push'])], extractPins([receiptCaller(['on: push'])]))),
    ['COMPLETION_TRIGGER_MISSING']);
  assert.deepEqual(checkCompletionCaller(profile(FE), [receiptCaller(RECEIPT_ON)], extractPins([receiptCaller(RECEIPT_ON)])), []);
  assert.deepEqual(checkCompletionCaller(profile(FE), [], []), []);
});

// the org sweep of this repository (.github/workflows/frontend-production-completion.yml), read from disk
const ORG_SWEEP = { path: '.github/workflows/frontend-production-completion.yml',
  text: readFileSync(new URL('../.github/workflows/frontend-production-completion.yml', import.meta.url), 'utf8') };

test('completionRunner org-sweep: no repository caller, but a scheduled org sweep must run the engine for the repository', () => {
  const fe = profile(FE);
  assert.ok(completionSweepCovers(ORG_SWEEP, FE), 'the live org sweep covers chipin-frontend');
  // the Production dispatch trigger (.github#228) sits next to the schedule; the schedule stays required
  assert.deepEqual(workflowTriggers(ORG_SWEEP.text), ['push', 'repository_dispatch', 'schedule']);
  assert.equal(completionSweepCovers(ORG_SWEEP, KB), false);
  assert.deepEqual(checkCompletionSweep(fe, [ORG_SWEEP]), []);
  const missing = checkCompletionSweep(fe, []);
  assert.deepEqual(missing.map(f => [f.check, f.severity]), [['COMPLETION_SWEEP_MISSING', 'drift']]);
  assert.match(missing[0].message, /no scheduled workflow in ChipIn-one\/\.github runs completion\.mjs --repository ChipIn-one\/chipin-frontend/);
  // without the schedule trigger, or for another repository, the workflow does not count
  const unscheduled = { ...ORG_SWEEP, text: ORG_SWEEP.text.replace(/^  schedule:\n    - cron: [^\n]*\n/m, '') };
  assert.notEqual(unscheduled.text, ORG_SWEEP.text);
  assert.deepEqual(checks(checkCompletionSweep(fe, [unscheduled])), ['COMPLETION_SWEEP_MISSING']);
  const other = { ...ORG_SWEEP, text: ORG_SWEEP.text.replace('--repository ChipIn-one/chipin-frontend', '--repository ChipIn-one/chipin-frontend-x') };
  assert.deepEqual(checks(checkCompletionSweep(fe, [other])), ['COMPLETION_SWEEP_MISSING']);
  // a commented-out run line does not count
  const commented = { ...ORG_SWEEP, text: ORG_SWEEP.text.replace(/^(\s*)run: node automation/m, '$1# run: node automation') };
  assert.deepEqual(checks(checkCompletionSweep(fe, [commented])), ['COMPLETION_SWEEP_MISSING']);
  const RUN = '        run: node automation/completion.mjs --repository ChipIn-one/chipin-frontend';
  const variant = (replace, by) => {
    const text = ORG_SWEEP.text.replace(replace, by);
    assert.notEqual(text, ORG_SWEEP.text, `variant applies: ${replace}`);
    return { ...ORG_SWEEP, text };
  };
  const covers = file => completionSweepCovers(file, FE);
  // M2: quoted repository and a trailing comment are accepted
  assert.ok(covers(variant(RUN, '        run: node automation/completion.mjs --repository "ChipIn-one/chipin-frontend"  # the FE sweep')));
  assert.ok(covers(variant(RUN, "        run: node automation/completion.mjs --repository 'ChipIn-one/chipin-frontend'")));
  assert.equal(covers(variant(RUN, '        run: node automation/completion.mjs --repository "ChipIn-one/chipin-frontend\'')), false, 'unbalanced quotes');
  // M1: the run line must be the step's own run key, not text inside a block scalar
  assert.equal(covers(variant(RUN, '        run: |\n          echo skipped\n          run: node automation/completion.mjs --repository ChipIn-one/chipin-frontend')), false);
  assert.equal(covers(variant(RUN, '        run: >-\n          node automation/completion.mjs --repository ChipIn-one/chipin-frontend')), false);
  assert.equal(covers(variant(RUN, '        with:\n          run: node automation/completion.mjs --repository ChipIn-one/chipin-frontend\n        run: echo noop')), false, 'nested key');
  // M1: a constant-false if on the step or the job disables the sweep
  for (const value of ['false', '${{ false }}', "'false'", '0']) {
    assert.equal(covers(variant(RUN, `        if: ${value}\n${RUN}`)), false, `step if ${value}`);
    assert.equal(covers(variant('    runs-on: ubuntu-latest', `    if: ${value}\n    runs-on: ubuntu-latest`)), false, `job if ${value}`);
  }
  assert.ok(covers(variant(RUN, `        if: github.event_name != 'pull_request'\n${RUN}`)), 'a real condition is kept');
  // M1: the sweep env must write, write Awaiting release and keep Project reconciliation on
  assert.equal(covers(variant('          CHIPIN_COMPLETION_WRITE: "1"\n', '')), false, 'no write');
  assert.equal(covers(variant('          CHIPIN_COMPLETION_WRITE: "1"', '          CHIPIN_COMPLETION_WRITE: "0"')), false);
  assert.equal(covers(variant('          CHIPIN_COMPLETION_AWAITING_RELEASE: "1"\n', '')), false, 'no Awaiting release');
  assert.equal(covers(variant('          CHIPIN_COMPLETION_AWAITING_RELEASE: "1"', '          CHIPIN_COMPLETION_AWAITING_RELEASE: "1"\n          CHIPIN_COMPLETION_PROJECT_RECONCILE: "0"')), false, 'reconcile off');
  assert.ok(covers(variant('          CHIPIN_COMPLETION_AWAITING_RELEASE: "1"', '          CHIPIN_COMPLETION_AWAITING_RELEASE: 1\n          CHIPIN_COMPLETION_PROJECT_RECONCILE: "1"')), 'unquoted and explicit on');
  // env may come from the job or the workflow level
  const stepEnv = /^        env:\n(?: {10}.*\n)+/m;
  const envBlock = ORG_SWEEP.text.match(stepEnv)[0];
  const jobLevel = variant(stepEnv, '').text.replace('    runs-on: ubuntu-latest', `    env:\n${envBlock.split('\n').slice(1).map(l => l.replace(/^ {10}/, '      ')).join('\n')}    runs-on: ubuntu-latest`);
  assert.ok(covers({ ...ORG_SWEEP, text: jobLevel }), 'job-level env');
  // every repository with the default runner (or the engine off) is not checked here
  for (const name of [BE, KB, META, NOTIF]) assert.deepEqual(checkCompletionSweep(profile(name), []), [], name);
  assert.deepEqual(checkCompletionSweep(receiptProfile(), []), []);
});

test('workflow triggers are read from the top-level on block only', () => {
  assert.deepEqual(workflowTriggers(['on:', '  # receipts', '  deployment_status:', '  push:', '    branches:', '      - master', 'jobs:', '  push:'].join('\n')),
    ['deployment_status', 'push']);
  assert.deepEqual(workflowTriggers('on: push\njobs: {}'), ['push']);
  assert.deepEqual(workflowTriggers('on: [push, deployment_status]  # both\n'), ['push', 'deployment_status']);
  assert.deepEqual(workflowTriggers('"on":\n    deployment_status: {}\n    push: {}\n'), ['deployment_status', 'push']);
  assert.deepEqual(workflowTriggers('name: x\njobs: {}'), []);
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
  // the reusable release workflow (pin name `release`) has its own entry, not the automation/ fallback
  assert.equal(touchesCapability('release', ['automation/conformance.mjs']), false);
  for (const file of ['.github/workflows/release.yml', 'automation/release.mjs', 'automation/release-action/action.yml', 'automation/github-metadata.mjs', 'automation/registry.mjs', 'workflow-registry.yaml']) {
    assert.equal(touchesCapability('release', [file]), true, file);
  }
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

test('pin freshness: a release.yml pin is stale only when the newer tag changes the release engine or workflow', async () => {
  const latest = tags.slice(1);
  const run = files => checkPins(profile(META), extractPins([workflow(releaseUses(V1, 'v1.0.0'))]), source({ compare: async () => ({ status: 'ahead', files }) }), latest);
  assert.deepEqual(checks(await run(['automation/conformance.mjs', 'docs/workflow/release.md'])), ['PIN_BEHIND'], 'an automation release that does not touch the engine');
  assert.deepEqual(checks(await run(['.github/workflows/release.yml'])), ['PIN_STALE']);
  assert.deepEqual(checks(await run(['automation/release.mjs'])), ['PIN_STALE']);
});

test('dependabot: missing, no github-actions, wrong target, correct', () => {
  const fe = legacyFrontend();
  assert.deepEqual(checks(checkDependabot(fe, null)), ['DEPENDABOT_MISSING']);
  assert.deepEqual(checks(checkDependabot(fe, "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    directory: '/'\n")), ['DEPENDABOT_NO_ACTIONS']);
  assert.deepEqual(checks(checkDependabot(fe, "version: 2\nupdates:\n  - package-ecosystem: 'github-actions'\n    directory: '/'\n")), ['DEPENDABOT_TARGET'], 'default branch main is not the integration branch dev');
  assert.deepEqual(checks(checkDependabot(fe, "version: 2\nupdates:\n  - package-ecosystem: 'npm'\n    target-branch: 'main'\n  - package-ecosystem: 'github-actions'\n    target-branch: 'dev'\n")), []);
  // the live frontend record (.github#216): master is default and integration; a leftover dev target is drift
  assert.deepEqual(checkDependabot(profile(FE), "updates:\n  - package-ecosystem: 'github-actions'\n"), []);
  assert.deepEqual(checkDependabot(profile(FE), "updates:\n  - package-ecosystem: 'github-actions'\n    target-branch: 'master'\n"), []);
  assert.deepEqual(checks(checkDependabot(profile(FE), "updates:\n  - package-ecosystem: 'github-actions'\n    target-branch: 'dev'\n")), ['DEPENDABOT_TARGET']);
  assert.deepEqual(checkDependabot(profile(BE), "updates:\n  - package-ecosystem: 'github-actions'\n    target-branch: 'develop'\n"), []);
  assert.deepEqual(checkDependabot(profile(BE), "updates:\n  - package-ecosystem: \"github-actions\"\n"), [], 'develop is both default and integration');
});

test('routing block and .ai/context.md', () => {
  assert.deepEqual(checks(checkRouting(profile(BE), 'plain', null, CANON, CTX)), ['ROUTING_BLOCK_MISSING', 'AI_CONTEXT_MISSING']);
  assert.deepEqual(checks(checkRouting(profile(BE), null, 'x', CANON, CTX)), ['ROUTING_BLOCK_MISSING']);
  assert.deepEqual(checkRouting(profile(FE), `# FE\n\n${ROUTING}\nlocal rules\n`, '# ctx', CANON, CTX), []);
  assert.deepEqual(checkRouting(profile(NOTIF), null, null, CANON, CTX), [], 'agentRouting: off');
});

test('contextPath is optional: AI_CONTEXT_MISSING only when the record declares it (.github#252)', () => {
  const agents = `# FE\n${ROUTING}\n`;
  assert.deepEqual(checkRouting(profile(FE), agents, null, CANON), [], 'no contextPath, no .ai/context.md: AGENTS.md is the only context file');
  assert.deepEqual(checkRouting(profile(FE), agents, null, CANON, null), []);
  const missing = checkRouting(profile(FE), agents, null, CANON, CTX);
  assert.deepEqual(checks(missing), ['AI_CONTEXT_MISSING'], 'declared contextPath with a missing file is still drift');
  assert.match(missing[0].message, /\.ai\/context\.md is missing on master/);
  assert.deepEqual(checks(checkRouting(profile(FE), agents, 'x\u200B', CANON)), [], 'an undeclared context file is not inspected');
  const paths = loadContextPaths({ text: 'schemaVersion: 1\nprojects:\n  - id: a/x\n    repository: a/x\n    contextPath: .ai/context.md\n  - id: a/y\n    repository: a/y\n' });
  assert.deepEqual([...paths], [['a/x', '.ai/context.md']]);
  assert.equal(loadContextPaths().has(FE), false, 'chipin-frontend declares no contextPath (chipin-frontend#517)');
  for (const repository of [META, BE, KB]) assert.equal(loadContextPaths().get(repository), CTX, repository);
});

test('audit: a record without contextPath is CONFORMANT without .ai/context.md and the file is not read (.github#252)', async () => {
  const base = fakeSource();
  const reads = [];
  const repoFile = async (repo, path, ref) => { reads.push(`${repo}:${path}`); return repo === FE && path === CTX ? null : base.repoFile(repo, path, ref); };
  const clean = await audit({ source: fakeSource({ repoFile }), repositories: [FE] });
  assert.equal(clean.repositories[0].status, 'CONFORMANT');
  assert.equal(reads.includes(`${FE}:${CTX}`), false);
  const declared = await audit({ source: fakeSource({ repoFile }), repositories: [FE], contextPaths: new Map([[FE, CTX]]) });
  assert.equal(declared.repositories[0].status, 'DRIFT');
  assert.deepEqual(checks(declared.repositories[0].findings), ['AI_CONTEXT_MISSING']);
});

test('routing block: exactly one start and one end marker (.github#250)', () => {
  assert.deepEqual(extractRoutingBlock(`x\n${ROUTING}\ny`), { state: 'ok', block: ROUTING });
  assert.deepEqual(extractRoutingBlock('no block'), { state: 'missing' });
  assert.deepEqual(extractRoutingBlock(null), { state: 'missing' });
  assert.deepEqual(extractRoutingBlock(`${ROUTING_START}\ntext`), { state: 'unterminated' });
  // an end marker before the start marker does not close the block
  assert.deepEqual(extractRoutingBlock(`${ROUTING_END}\n${ROUTING_START}\ntext`), { state: 'unterminated' });
  assert.deepEqual(checks(checkRouting(profile(FE), `${ROUTING_END}\n${ROUTING_START}\ntext`, 'c', CANON, CTX)), ['ROUTING_BLOCK_UNTERMINATED']);
  // a correct block followed by a second, edited one
  const twice = `${ROUTING}\n\n${ROUTING.replace('stop.', 'continue.')}`;
  assert.deepEqual(extractRoutingBlock(twice), { state: 'duplicated' });
  assert.deepEqual(extractRoutingBlock(`${ROUTING_START}\n${ROUTING}`), { state: 'duplicated' });
  assert.deepEqual(extractRoutingBlock(`${ROUTING}\n${ROUTING_END}`), { state: 'duplicated' });
  const dup = checkRouting(profile(FE), twice, 'c', CANON, CTX);
  assert.deepEqual(dup.map(f => [f.check, f.severity]), [['ROUTING_BLOCK_DUPLICATED', 'drift']]);
});

test('routing block: compared byte-for-byte with the .github@master block (.github#250)', () => {
  const stale = checkRouting(profile(FE), ROUTING.replace('FLOW.md)', 'FLOW.md) and README.md'), 'c', CANON, CTX);
  assert.deepEqual(checks(stale), ['ROUTING_BLOCK_STALE']);
  assert.equal(stale[0].severity, 'drift');
  assert.deepEqual(checks(checkRouting(profile(FE), ROUTING.replace(/\n/g, '\r\n'), 'c', CANON, CTX)), ['ROUTING_BLOCK_STALE']);
  assert.deepEqual(checks(checkRouting(profile(FE), ROUTING.replace('stop.', 'stop. '), 'c', CANON, CTX)), ['ROUTING_BLOCK_STALE']);
  assert.deepEqual(checks(checkRouting(profile(FE), `${ROUTING_START}\nChipIn AI routing`, 'c', CANON, CTX)), ['ROUTING_BLOCK_UNTERMINATED']);
});

test('routing: zero-width and bidi characters in AGENTS.md or .ai/context.md are drift', () => {
  const hidden = ['\u200B', '\u200D', '\u200F', '\u202A', '\u202E', '\u2060', '\u2064', '\u2066', '\u2067', '\u2068', '\u2069', '\u061C', '\uFEFF'];
  const name = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase()}`;
  for (const ch of hidden) {
    const found = checkRouting(profile(FE), `${ROUTING}\nlocal${ch} rules\n`, 'c', CANON, CTX);
    assert.deepEqual(found.map(f => [f.check, f.severity]), [['ROUTING_HIDDEN_CHARACTERS', 'drift']], `AGENTS.md ${name(ch)}`);
    assert.deepEqual(checks(checkRouting(profile(FE), ROUTING, `- repo${ch}\n`, CANON, CTX)), ['ROUTING_HIDDEN_CHARACTERS'], `.ai/context.md ${name(ch)}`);
  }
  assert.match(checkRouting(profile(FE), `${ROUTING}\n\u2066x`, 'y\u061C', CANON, CTX)[0].message, /AGENTS\.md, \.ai\/context\.md/);
  assert.deepEqual(checks(checkRouting(profile(FE), ROUTING.replace('stop.', 'stop.\u202E'), 'c', CANON, CTX)), ['ROUTING_BLOCK_STALE', 'ROUTING_HIDDEN_CHARACTERS']);
  // neighbours of the ranges and ordinary non-ASCII text are fine
  for (const ch of ['\u200A', '\u2010', '\u2029', '\u202F', '\u2065', '\u206A', '\u061B', '\u061D', '\uFEFE']) {
    assert.deepEqual(checkRouting(profile(FE), `${ROUTING}\nx${ch}\n`, `y${ch}`, CANON, CTX), [], name(ch));
  }
  assert.deepEqual(checkRouting(profile(FE), `${ROUTING}\nкириллица — тире\n`, 'c', CANON, CTX), [], 'ordinary non-ASCII text is fine');
});

test('routing: URLs inside the managed block must be ChipIn-one on github.com or raw.githubusercontent.com', () => {
  const withUrl = url => ROUTING.replace('If the canon', `See ${url}. If the canon`);
  for (const url of ['https://github.com/ChipIn-one/.github/blob/master/AGENTS.md', 'https://raw.githubusercontent.com/ChipIn-one/.github/master/AGENTS.md',
    'https://github.com/ChipIn-one/.github/blob/master/docs/workflow/FLOW.md#precedence-and-availability']) {
    assert.deepEqual(checkRouting(profile(FE), withUrl(url), 'c', { state: 'ok', block: withUrl(url) }, CTX), [], url);
  }
  for (const url of ['https://example.com/FLOW.md', 'http://github.com/ChipIn-one/.github', 'https://github.com/other-org/x', 'github.com/ChipIn-one/.github',
    'https://gist.github.com/ChipIn-one/x', 'ftp://ChipIn-one.example/x', 'https://github.com.evil.example/ChipIn-one/x', 'git@evil.example:x',
    // dot segments leave the ChipIn-one prefix once resolved
    'https://github.com/ChipIn-one/../syllik/x', 'https://github.com/ChipIn-one/.github/../../syllik/x', 'https://github.com/ChipIn-one/./x',
    'https://github.com/ChipIn-one/%2e%2e/syllik/x', 'https://github.com/ChipIn-one/..', 'https://raw.githubusercontent.com/ChipIn-one/..%2Fsyllik/x',
    // protocol-relative
    '//evil.example/x', '//github.com/ChipIn-one/.github']) {
    // the canon itself carries the URL: the .github record (and every copy) is drift
    const found = checkRouting(profile(FE), withUrl(url), 'c', { state: 'ok', block: withUrl(url) }, CTX);
    assert.deepEqual(checks(found).filter(c => c !== 'ROUTING_PERSONAL_CANON'), ['ROUTING_BLOCK_FOREIGN_URL'], url);
  }
});

test('routing: links to the personal syllik canon in AGENTS.md or .ai/context.md are drift', () => {
  const variants = ['https://github.com/syllik/ai-workflow/blob/HEAD/FLOW.md', 'github.com/syllik/ai-workflow', 'git@github.com:syllik/ai-workflow.git',
    'https://api.github.com/repos/syllik/ai-workflow/contents/FLOW.md', 'https://gist.github.com/syllik/abc', 'https://syllik.github.io/ai-workflow/',
    'HTTPS://GitHub.com/Syllik/ai-workflow', 'raw.githubusercontent.com/SYLLIK/ai-workflow/HEAD/FLOW.md', 'www.github.com/syllik', 'SYLLIK.GITHUB.IO'];
  for (const link of variants) {
    assert.deepEqual(checks(checkRouting(profile(BE), `${ROUTING}\n1. Read ${link}\n`, 'c', CANON, CTX)), ['ROUTING_PERSONAL_CANON'], `AGENTS.md: ${link}`);
    assert.deepEqual(checks(checkRouting(profile(BE), ROUTING, `- canon: ${link}\n`, CANON, CTX)), ['ROUTING_PERSONAL_CANON'], `.ai/context.md: ${link}`);
  }
  const found = checkRouting(profile(BE), `${ROUTING}\nhttps://github.com/syllik/a\n`, 'see github.com/syllik/b and syllik.github.io', CANON, CTX);
  assert.match(found[0].message, /AGENTS\.md: 1, \.ai\/context\.md: 2/);
  const inBlock = ROUTING.replace('https://github.com/ChipIn-one/.github/blob/master/docs/workflow/FLOW.md)', 'https://raw.githubusercontent.com/syllik/ai-workflow/HEAD/FLOW.md)');
  assert.deepEqual(checks(checkRouting(profile(BE), inBlock, 'c', CANON, CTX)), ['ROUTING_BLOCK_STALE', 'ROUTING_BLOCK_FOREIGN_URL', 'ROUTING_PERSONAL_CANON']);
  // the login alone, or a longer name, is not a link to the personal canon
  for (const text of ['Owner: syllik/olegbal', 'https://github.com/syllikov/x', 'https://github.com/ChipIn-one/syllik', 'mysyllik.github.io',
    'https://github.com/notsyllik/x', 'github.com/notsyllik/', 'syllik-x', 'https://github.com/syllik-x/y', 'syllik-x.github.io', 'git@github.com:a-syllik/x']) {
    assert.deepEqual(checkRouting(profile(BE), `${ROUTING}\n${text}\n`, text, CANON, CTX), [], text);
  }
});

test('routing: a canon without one readable block is a note, never drift', () => {
  for (const canon of [{ state: 'missing' }, { state: 'unterminated' }, { state: 'duplicated' }, undefined]) {
    const found = checkRouting(profile(FE), ROUTING.replace('stop.', 'halt.'), 'c', canon, CTX);
    assert.deepEqual(found.map(f => [f.check, f.severity]), [['ROUTING_CANON_UNREADABLE', 'note']]);
  }
  assert.deepEqual(checks(checkRouting(profile(FE), null, 'c', { state: 'missing' }, CTX)), ['ROUTING_BLOCK_MISSING', 'ROUTING_CANON_UNREADABLE']);
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
    [`${META}:AGENTS.md`]: `${ROUTING}\nmeta rules\n`, [`${META}:.ai/context.md`]: 'c', [`${META}:.github/dependabot.yml`]: "updates:\n  - package-ecosystem: 'github-actions'\n",
    [`${FE}:AGENTS.md`]: `# FE\n${ROUTING}\n`, [`${FE}:.ai/context.md`]: 'c',
    [`${FE}:.github/dependabot.yml`]: "updates:\n  - package-ecosystem: 'github-actions'\n    target-branch: 'master'\n",
  };
  const wf = {
    [FE]: [workflow('on: [deployment_status]', uses('issue-admission-action', V1, 'v1.0.0'), uses('development-link-action', V1, 'v1.0.0'), uses('pr-metadata-action', V1, 'v1.0.0'), uses('create-milestone-action', V1, 'v1.0.0'), uses('frontend-production-completion-action', V1, 'v1.0.0'), releaseUses(V1, 'v1.0.0'))],
    [BE]: [workflow(uses('issue-admission-action', 'f'.repeat(40)), uses('development-link-action', 'f'.repeat(40)), uses('create-milestone-action', 'f'.repeat(40)))],
    [KB]: [workflow(uses('development-link-action', 'f'.repeat(40)))],
    [META]: [ORG_SWEEP, { path: '.github/workflows/release-on-master.yml', text: `on:\n  push:\n    branches: [master]\n${releaseUses(V1, 'v1.0.0')}` }],
    [NOTIF]: [],
  };
  const na = { state: 'unavailable' };
  return {
    tags: async () => [{ name: 'v1.0.0', sha: V1 }],
    projectPullRequests: async () => [],
    workflowFiles: async repo => wf[repo],
    repoFile: async (repo, path) => files[`${repo}:${path}`] ?? null,
    compare: async () => ({ status: 'diverged', files: [] }),
    // release flow: FE and .github are tagged with a Release on the branch history; BE has no tag yet
    versionTags: async repo => (repo === BE ? [] : [{ name: 'v1.0.0', sha: V1 }]),
    branchStatus: async () => 'ahead',
    release: async () => ({ draft: false }),
    branchRules: async repo => (repo === META ? { state: 'ok', rules: ['pull_request', 'required_status_checks'], requiredChecks: ['evaluate-fixtures'] } : repo === FE ? { state: 'ok', rules: [], requiredChecks: [] } : na),
    classicProtection: async repo => (repo === FE ? { state: 'ok', requiredChecks: ['frontend-ci'] } : repo === META ? { state: 'unprotected' } : na),
    openIssues: async () => [],
    closedIssuesWithOpenPrs: async () => [],
    recentlyClosedIssues: async () => ({ issues: [], truncated: false }),
    productionContainment: async () => { throw new Error('production evidence must not be read without a candidate'); },
    mergedPullRequests: async () => [{ number: 5, mergedAt: new Date().toISOString(), headSha: 'h' }],
    checkRuns: async () => [{ name: 'Unit and integration tests', conclusion: 'success' }],
    orgRepositories: async () => [{ fullName: FE, archived: false }, { fullName: 'ChipIn-one/chipin-backend-python', archived: false }, { fullName: NOTIF, archived: false }, { fullName: 'ChipIn-one/old', archived: true }],
    ...over,
  };
}

test('audit: the canon routing block is read once from .github on its integration branch (.github#250)', async () => {
  const reads = [];
  const base = fakeSource();
  const report = await audit({ source: fakeSource({ repoFile: async (repo, path, ref) => { reads.push(`${repo}:${path}@${ref}`); return base.repoFile(repo, path, ref); } }) });
  assert.equal(reads.filter(r => r === `${META}:AGENTS.md@master`).length, 2, 'once as the canon, once as the .github record');
  assert.equal(report.repositories.find(r => r.repository === FE).status, 'CONFORMANT');
  const stale = await audit({ source: fakeSource({ repoFile: async (repo, path, ref) => (repo === FE && path === 'AGENTS.md' ? ROUTING.replace('stop.', 'halt.') : base.repoFile(repo, path, ref)) }), repositories: [FE] });
  assert.equal(stale.repositories[0].status, 'DRIFT');
  assert.deepEqual(checks(stale.repositories[0].findings), ['ROUTING_BLOCK_STALE']);
  const audited = await audit({ source: fakeSource({ repoFile: async () => { throw new Error('unused'); } }), repositories: [NOTIF] });
  assert.equal(audited.repositories[0].status, 'CONFORMANT', 'no routing record audited: the canon is not read');
});

test('audit: a canon read with no routing block is a note on every routing record', async () => {
  const base = fakeSource();
  const noBlock = await audit({ source: fakeSource({ repoFile: async (repo, path, ref) => (repo === META && path === 'AGENTS.md' ? 'no block' : base.repoFile(repo, path, ref)) }), repositories: [FE] });
  assert.equal(noBlock.repositories[0].status, 'CONFORMANT');
  assert.ok(checks(noBlock.repositories[0].notes).includes('ROUTING_CANON_UNREADABLE'));
});

test('audit: a failed canon read makes routing records UNREADABLE and never closes their drift Issues', async () => {
  const base = fakeSource();
  const staleFe = (repo, path, ref) => (repo === FE && path === 'AGENTS.md' ? ROUTING.replace('stop.', 'halt.') : base.repoFile(repo, path, ref));
  const drift = await audit({ source: fakeSource({ repoFile: async (...a) => staleFe(...a) }), repositories: [FE, NOTIF] });
  assert.deepEqual(checks(drift.repositories[0].findings), ['ROUTING_BLOCK_STALE']);
  const store = new FakeStore();
  await upsertIssues({ report: drift, store, apply: true });
  assert.equal(store.issues.length, 1);
  let first = true;
  const failing = await audit({ source: fakeSource({ repoFile: async (repo, path, ref) => {
    if (repo === META && path === 'AGENTS.md' && first) { first = false; throw new Error('GET x -> 502'); }
    return staleFe(repo, path, ref);
  } }), repositories: [FE, NOTIF] });
  const fe = failing.repositories.find(r => r.repository === FE);
  assert.equal(fe.status, 'UNREADABLE');
  assert.deepEqual(fe.findings, []);
  assert.match(fe.error, /routing canon unreadable: GET x -> 502/);
  assert.equal(failing.repositories.find(r => r.repository === NOTIF).status, 'CONFORMANT', 'agentRouting: off is not affected');
  const result = await upsertIssues({ report: failing, store, apply: true });
  assert.equal(result.actions.find(a => a.repository === FE).action, 'skipped-unreadable');
  assert.equal(store.issues[0].state, 'open');
});

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
  assert.ok(checks(by(BE).findings).includes('RELEASE_CALLER_MISSING'), 'deploy-tag without a release caller');
  assert.ok(checks(by(BE).notes).includes('RELEASE_NO_TAGS'));
  assert.deepEqual(by(KB).notes.map(n => n.check).filter(c => c.startsWith('RELEASE_')), ['RELEASE_UNVERSIONED']);
  assert.ok(by(NOTIF).notes.some(n => n.check === 'RELEASE_UNVERSIONED'), 'none is a note, never drift');
  assert.equal(by(KB).status, 'DRIFT');
  assert.ok(checks(by(KB).findings).includes('DEPENDABOT_MISSING'));
  assert.deepEqual(report.unregistered, ['ChipIn-one/chipin-backend-python']);
  assert.deepEqual(report.summary, { repositories: 5, conformant: 3, drift: 2, unreadable: 0, unregistered: 1 });
  assert.equal(by(NOTIF).status, 'CONFORMANT', 'every capability is off, protection is unavailable on the plan');
  assert.match(renderSummary(report), /UNREGISTERED \(no action\)\n- ChipIn-one\/chipin-backend-python/);
});

test('audit: org-sweep record conforms only while the org sweep runs it; the shared read follows the audited records', async () => {
  const noSweep = await audit({ source: fakeSource({ workflowFiles: async repo => (repo === META ? [] : (await fakeSource().workflowFiles(repo))) }), repositories: [FE] });
  assert.equal(noSweep.repositories[0].status, 'DRIFT');
  assert.deepEqual(checks(noSweep.repositories[0].findings), ['COMPLETION_SWEEP_MISSING']);
  // M3: a subset without org-sweep records never reads the shared workflows (the live registry has FE on org-sweep)
  const reads = [];
  await audit({ source: fakeSource({ workflowFiles: async repo => { reads.push(repo); return []; } }), repositories: [BE] });
  assert.deepEqual(reads, [BE]);
  // M3: a failed shared read makes only the org-sweep records UNREADABLE
  const failing = fakeSource();
  const broken = await audit({ source: { ...failing, workflowFiles: async (repo, ref) => { if (repo === META) throw new Error('GET workflows -> 502'); return failing.workflowFiles(repo, ref); } }, repositories: [FE, BE] });
  const by = name => broken.repositories.find(r => r.repository === name);
  assert.equal(by(FE).status, 'UNREADABLE');
  assert.match(by(FE).error, /org sweep workflows unreadable: GET workflows -> 502/);
  assert.equal(by(BE).status, 'DRIFT', 'BE is audited normally');
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

// --- release flow (.github#174) ---------------------------------------------------------------------------
const releaseFacts = (tags, { status = 'ahead', released = tags.map(t => t.name) } = {}) => ({
  tags, latestStatus: tags.length ? status : null, releases: new Map(tags.slice(0, RELEASE_TAGS_CHECKED).map(t => [t.name, released.includes(t.name) ? { draft: false } : null])),
});
// .github: push to master; FE: deployment_status (release-on-production.yml); the test helper passes the caller files
const pushCaller = { path: '.github/workflows/release-on-master.yml', text: `on:\n  push:\n    branches: [master]\njobs:\n  release:\n${releaseUses(V1, 'v1.0.0')}` };
const deployCaller = { path: '.github/workflows/release-on-production.yml', text: `on:\n  deployment_status:\njobs:\n  release:\n${releaseUses(V1, 'v1.0.0')}` };
const callerFiles = [pushCaller, deployCaller];
const caller = extractPins(callerFiles);

test('release: none is reported as intentionally unversioned, never drift, and reads nothing', async () => {
  for (const name of [KB, NOTIF]) {
    const result = checkRelease(profile(name), [], releaseFacts([]));
    assert.deepEqual(result.map(f => [f.check, f.severity]), [['RELEASE_UNVERSIONED', 'note']]);
  }
  const unread = { versionTags: async () => { throw new Error('unused'); } };
  assert.deepEqual((await readReleaseFacts(profile(KB), unread)).tags, []);
});

test('release: a strategy other than none needs a caller of the reusable release workflow (.github, FE, BE)', () => {
  const tagged = releaseFacts([{ name: 'v1.9.2', sha: V1 }]);
  assert.deepEqual(checkRelease(profile(META), caller, tagged, callerFiles), [], '.github: release-on-master.yml calls release.yml');
  for (const name of [META, FE, BE]) {
    const missing = checkRelease(profile(name), [], tagged);
    assert.deepEqual(missing.map(f => [f.check, f.severity]), [['RELEASE_CALLER_MISSING', 'drift']], name);
  }
  assert.match(checkRelease(profile(META), [], tagged)[0].remediation, /caller-release-integration\.yml/);
  assert.match(checkRelease(profile(BE), [], tagged)[0].remediation, /deployment_status workflow .*release-on-production\.yml.* or a job after the successful deploy in the deploy workflow/);
  // a shared action or another reusable workflow is not a release caller
  const other = extractPins([workflow(uses('completion-action', V1, 'v1.0.0'), `    uses: ChipIn-one/.github/.github/workflows/pr-gate.yml@${V1} # v1.0.0`)]);
  assert.deepEqual(checks(checkRelease(profile(FE), other, tagged)), ['RELEASE_CALLER_MISSING']);
  assert.deepEqual(checkRelease(profile(FE), caller, tagged, callerFiles), []);
});

test('release: no tags is a note; the latest tag must be on the release branch history', () => {
  assert.deepEqual(checkRelease(profile(BE), caller, releaseFacts([]), callerFiles).map(f => [f.check, f.severity]), [['RELEASE_NO_TAGS', 'note']]);
  const tags = [{ name: 'v1.0.8', sha: V11 }, { name: 'v1.0.7', sha: V1 }];
  assert.deepEqual(checkRelease(profile(FE), caller, releaseFacts(tags, { status: 'identical' }), callerFiles), []);
  for (const status of ['diverged', 'behind']) {
    const off = checkRelease(profile(FE), caller, releaseFacts(tags, { status }), callerFiles);
    assert.deepEqual(off.map(f => [f.check, f.severity]), [['RELEASE_TAG_OFF_BRANCH', 'drift']]);
    assert.match(off[0].message, new RegExp(`v1\\.0\\.8 \\(bbbbbbb\\) is not on the history of master \\(compare status ${status}\\)`));
  }
  assert.equal(releaseBranchOf(profile(BE)), 'develop');
  assert.equal(releaseBranchOf(legacyFrontend()), 'dev', 'deploy-tag and integration-merge use the integration branch');
  assert.equal(releaseBranchOf({ ...legacyFrontend(), release: { strategy: 'semver-by-impact', trigger: 'promotion-merge', tagPrefix: 'v' } }), 'main');
});

test('release: each of the newest tags needs a published GitHub Release', () => {
  const tags = ['v1.0.6', 'v1.0.5', 'v1.0.4', 'v1.0.3', 'v1.0.2', 'v1.0.1'].map(name => ({ name, sha: V1 }));
  const facts = releaseFacts(tags, { released: ['v1.0.6', 'v1.0.4', 'v1.0.3'] });
  facts.releases.set('v1.0.3', { draft: true });
  const missing = checkRelease(profile(META), caller, facts, callerFiles);
  assert.deepEqual(checks(missing), ['RELEASE_MISSING']);
  assert.match(missing[0].message, /: v1\.0\.5, v1\.0\.3, v1\.0\.2\.$/, 'a draft is not published; v1.0.1 is outside the newest five');
});

test('release facts: tags sorted by version with the registry prefix, one compare, Releases of the newest tags only', async () => {
  const reads = [];
  const names = ['v1.10.0', 'v1.9.0', 'v1.2.0', 'v1.1.0', 'v1.0.1', 'v1.0.0', 'vnext'];
  const source = {
    versionTags: async (repo, prefix) => { reads.push(['tags', repo, prefix]); return names.map((name, i) => ({ name, sha: String(i).repeat(40) })).reverse(); },
    branchStatus: async (repo, sha, branch) => { reads.push(['compare', repo, sha.slice(0, 1), branch]); return 'ahead'; },
    release: async (repo, tag) => { reads.push(['release', tag]); return { draft: false }; },
  };
  const facts = await readReleaseFacts(profile(META), source);
  assert.deepEqual(facts.tags.map(t => t.name), names.slice(0, 6));
  assert.deepEqual(reads.slice(0, 2), [['tags', META, 'v'], ['compare', META, '0', 'master']]);
  assert.deepEqual(reads.slice(2).map(r => r[1]), names.slice(0, RELEASE_TAGS_CHECKED));
});

test('audit: release drift per repository from the registry release block', async () => {
  const base = fakeSource();
  const report = await audit({ source: fakeSource({
    workflowFiles: async repo => (repo === FE ? [workflow(uses('issue-admission-action', V1, 'v1.0.0'), uses('development-link-action', V1, 'v1.0.0'), uses('pr-metadata-action', V1, 'v1.0.0'), uses('create-milestone-action', V1, 'v1.0.0'))] : base.workflowFiles(repo)),
    branchStatus: async repo => (repo === FE ? 'diverged' : 'ahead'),
    release: async (repo, tag) => (repo === META ? null : { draft: false, tag }),
  }) });
  const by = name => report.repositories.find(r => r.repository === name);
  assert.deepEqual(checks(by(FE).findings), ['RELEASE_CALLER_MISSING', 'RELEASE_TAG_OFF_BRANCH']);
  assert.deepEqual(checks(by(META).findings), ['RELEASE_MISSING']);
  const failing = await audit({ source: fakeSource({ release: async () => { throw new Error('GET releases -> 502'); } }), repositories: [FE, KB] });
  assert.equal(failing.repositories[0].status, 'UNREADABLE', 'a failed release read is never silent conformance');
  assert.notEqual(failing.repositories[1].status, 'UNREADABLE', 'none reads no release state');
});

test('GitHubConformanceSource release reads: tags and Releases through the release engine store, compare status only', async () => {
  const calls = [];
  const client = {
    request: async (path, options) => {
      calls.push(path);
      if (path.startsWith('/repos/R/x/compare/')) return { status: 'ahead', commits: [] };
      if (path === '/repos/R/x/releases/tags/v1.0.0') return { id: 1, tag_name: 'v1.0.0', draft: false };
      if (path === '/repos/R/x/git/tags/' + V11) return { object: { type: 'commit', sha: V1 } };
      if (path === '/repos/R/x/git/matching-refs/tags/v') return [{ ref: 'refs/tags/v1.0.0', object: { type: 'commit', sha: V1 } }, { ref: 'refs/tags/v1.0.1', object: { type: 'tag', sha: V11 } }];
      if (options?.allow404) return null;
      throw new Error(`unexpected ${path}`);
    },
    listAll: async path => { throw new Error(`matching-refs must not be paginated: ${path}`); },
  };
  const src = new GitHubConformanceSource(client);
  assert.deepEqual(await src.versionTags('R/x', 'v'), [{ name: 'v1.0.0', sha: V1 }, { name: 'v1.0.1', sha: V1 }], 'annotated tags are dereferenced');
  assert.equal(await src.branchStatus('R/x', V1, 'master'), 'ahead');
  assert.equal((await src.release('R/x', 'v1.0.0')).draft, false);
  assert.equal(await src.release('R/x', 'v9.9.9'), null);
  assert.ok(calls.includes('/repos/R/x/git/matching-refs/tags/v'));
  assert.ok(calls.includes(`/repos/R/x/compare/${V1}...master?per_page=1`));
  await assert.rejects(new GitHubConformanceSource({ request: async () => ({}) }).branchStatus('R/x', V1, 'master'), /unreadable/);
  // a compare 404 (orphan tag commit, missing branch) is a status, other errors stay errors
  const compare404 = new GitHubConformanceSource({ request: async (path, options) => { assert.equal(options?.allow404, true); return null; } });
  assert.equal(await compare404.branchStatus('R/x', V1, 'gone'), 'not-found');
  await assert.rejects(new GitHubConformanceSource({ request: async () => { throw new Error('GET compare -> 502'); } }).branchStatus('R/x', V1, 'master'), /502/);
});

test('release: a compare 404 is RELEASE_TAG_OFF_BRANCH drift, not an unreadable repository', async () => {
  const off = checkRelease(profile(FE), caller, releaseFacts([{ name: 'v1.0.10', sha: V11 }], { status: 'not-found' }), callerFiles);
  assert.deepEqual(off.map(f => [f.check, f.severity]), [['RELEASE_TAG_OFF_BRANCH', 'drift']]);
  assert.match(off[0].remediation, /compare returned 404/);
  const report = await audit({ source: fakeSource({ branchStatus: async repo => (repo === FE ? 'not-found' : 'ahead') }), repositories: [FE] });
  assert.equal(report.repositories[0].status, 'DRIFT');
  assert.ok(checks(report.repositories[0].findings).includes('RELEASE_TAG_OFF_BRANCH'));
});

test('release: the release caller must run on the trigger the registry declares', () => {
  const tagged = releaseFacts([{ name: 'v1.9.2', sha: V1 }]);
  const file = (path, on) => ({ path, text: `on:${on.startsWith('[') ? ' ' : '\n'}${on}\njobs:\n  release:\n${releaseUses(V1, 'v1.0.0')}` });
  const run = (name, files) => checkRelease(profile(name), extractPins(files), tagged, files);
  // integration-merge (.github) needs push
  assert.deepEqual(run(META, [file('.github/workflows/r.yml', '  push:\n    branches: [master]')]), []);
  const dispatchOnly = run(META, [file('.github/workflows/r.yml', '  workflow_dispatch:')]);
  assert.deepEqual(dispatchOnly.map(f => [f.check, f.severity]), [['RELEASE_TRIGGER_MISSING', 'drift']]);
  assert.match(dispatchOnly[0].message, /integration-merge .*\.github\/workflows\/r\.yml.* no push trigger \(has: workflow_dispatch\)/);
  assert.equal(checks(run(META, [{ path: '.github/workflows/r.yml', text: releaseUses(V1, 'v1.0.0') }]))[0], 'RELEASE_TRIGGER_MISSING', 'no on: block');
  // promotion-merge needs push as well
  const promotion = { ...profile(META), release: { strategy: 'semver-by-impact', trigger: 'promotion-merge', tagPrefix: 'v' } };
  assert.deepEqual(checks(checkRelease(promotion, extractPins([file('a.yml', '  pull_request:')]), tagged, [file('a.yml', '  pull_request:')])), ['RELEASE_TRIGGER_MISSING']);
  // production-deploy: deployment_status (FE), workflow_run, or a job in the workflow_dispatch deploy workflow (BE)
  for (const on of ['  deployment_status:', '  workflow_run:\n    workflows: [Deploy Production]', '  workflow_dispatch:', '[workflow_dispatch]']) {
    assert.deepEqual(run(BE, [file('.github/workflows/deploy.yml', on)]), [], on);
  }
  assert.deepEqual(checks(run(FE, [file('.github/workflows/r.yml', '  push:')])), ['RELEASE_TRIGGER_MISSING']);
  // the trigger is read from the file that calls release.yml, not from another workflow
  const elsewhere = [{ path: 'other.yml', text: 'on:\n  deployment_status:\n' }, file('.github/workflows/r.yml', '  push:')];
  assert.deepEqual(checks(checkRelease(profile(FE), extractPins(elsewhere), tagged, elsewhere)), ['RELEASE_TRIGGER_MISSING']);
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

test('Project #5 PR scan re-reads phantom empty pages and fails closed when one persists (#221)', async () => {
  const node = (n, type = 'PullRequest') => ({ content: { __typename: type, number: n, repository: { nameWithOwner: 'ChipIn-one/chipin-frontend' } } });
  const pages = {
    root: { totalCount: 3, pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node(1), node(2, 'Issue')] },
    c1: { totalCount: 3, pageInfo: { hasNextPage: false, endCursor: 'c2' }, nodes: [node(3)] },
  };
  const phantom = { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  let phantoms = 2;
  const calls = [];
  const flaky = { graphql: async (_q, { a }) => {
    const key = a ?? 'root'; calls.push(key);
    if (key === 'c1' && phantoms-- > 0) return { organization: { projectV2: { items: phantom } } };
    return { organization: { projectV2: { items: pages[key] } } };
  } };
  const pageRetry = { retryDelaysMs: [0, 0], wait: async () => {} };
  const src = new GitHubConformanceSource(flaky, loadRegistry(), { pageRetry });
  assert.deepEqual((await src.projectPullRequests()).map(r => r.number), [1, 3]);
  assert.deepEqual(calls, ['root', 'c1', 'c1', 'c1']);
  const stuck = { graphql: async (_q, { a }) => ({ organization: { projectV2: { items: a ? phantom : pages.root } } }) };
  await assert.rejects(new GitHubConformanceSource(stuck, loadRegistry(), { pageRetry }).projectPullRequests(),
    e => e.code === 'PROJECT_ITEMS_PHANTOM' && /page stayed empty after 2 retries/.test(e.message));
  let firstCalls = 0;
  const phantomFirst = { graphql: async (_q, { a }) => {
    if (!a && firstCalls++ === 0) return { organization: { projectV2: { items: phantom } } };
    return { organization: { projectV2: { items: pages[a ?? 'root'] } } };
  } };
  assert.deepEqual((await new GitHubConformanceSource(phantomFirst, loadRegistry(), { pageRetry }).projectPullRequests()).map(r => r.number), [1, 3]);
  assert.equal(firstCalls, 2);
  const empty = { graphql: async () => ({ organization: { projectV2: { items: phantom } } }) };
  await assert.rejects(new GitHubConformanceSource(empty, loadRegistry(), { pageRetry }).projectPullRequests(),
    e => e.code === 'PROJECT_ITEMS_PHANTOM' && /first page stayed empty/.test(e.message));
});

// --- CLOSED_BEFORE_PRODUCTION (.github#181) -------------------------------------------------------------
const M1 = '1'.repeat(40);
const M2 = '2'.repeat(40);
const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
const SINCE = new Date(Date.now() - 30 * 86_400_000).toISOString();
const closedIssue = (number, { closedBy = 'syllik', merge = M1, base = 'master', closedAt = RECENT, stateReason = 'COMPLETED', repository = FE, headRepository = repository, mergedAt = RECENT } = {}) => ({
  number, closedAt, stateReason, closedBy,
  linkedPullRequests: [{ number: number + 1000, repository, headRepository, mergedAt, baseRefName: base, mergeCommitSha: merge }],
});
const inProduction = (...shas) => async () => ({ label: 'a valid Production receipt by vercel[bot]', contains: async pr => shas.includes(pr.mergeCommitSha) });
const scanOf = (issues, truncated = false) => ({ since: SINCE, issues, truncated });

test('CLOSED_BEFORE_PRODUCTION: a human close before the merge reached production is a note with remediation', async () => {
  const findings = await checkClosedBeforeProduction(profile(FE), scanOf([closedIssue(464, { merge: M2 }), closedIssue(470)]), inProduction(M1));
  assert.deepEqual(findings.map(f => [f.check, f.severity]), [['CLOSED_BEFORE_PRODUCTION', 'note']]);
  assert.match(findings[0].message, /^1 Issue\(s\) closed as completed/);
  assert.match(findings[0].message, /#464 \(closed \d{4}-\d{2}-\d{2} by syllik; PR #1464 2222222 not in production\)/);
  assert.doesNotMatch(findings[0].message, /#470/);
  assert.match(findings[0].remediation, /^Leave the Issue closed/);
  assert.match(findings[0].remediation, /fresh linked PR/);
});

test('CLOSED_BEFORE_PRODUCTION: an engine close is ignored and evidence is not read', async () => {
  let read = 0;
  const findings = await checkClosedBeforeProduction(profile(FE), scanOf([closedIssue(1, { closedBy: 'github-actions', merge: M2 })]),
    async () => { read += 1; return { label: 'x', contains: async () => false }; });
  assert.deepEqual(findings, []);
  assert.equal(read, 0);
});

test('CLOSED_BEFORE_PRODUCTION: a PR already in production, outside the window, not completed, not merged into the integration branch, from a fork or without a merge commit is ignored', async () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const issues = [closedIssue(1), closedIssue(2, { merge: M2, closedAt: old }), closedIssue(3, { merge: M2, stateReason: 'NOT_PLANNED' }),
    closedIssue(4, { merge: M2, base: 'feature' }), closedIssue(5, { merge: M2, mergedAt: null }), closedIssue(6, { merge: M2, repository: KB }),
    closedIssue(7, { merge: M2, headRepository: 'someone/chipin-frontend' }), closedIssue(8, { merge: null })];
  assert.deepEqual(closedBeforeProductionCandidates(profile(FE), issues, SINCE).map(r => r.number), [1]);
  assert.deepEqual(await checkClosedBeforeProduction(profile(FE), scanOf(issues), inProduction(M1)), []);
});

test('CLOSED_BEFORE_PRODUCTION: integration-merge and manual repositories are not checked', async () => {
  for (const name of [META, KB, BE]) {
    assert.deepEqual(await checkClosedBeforeProduction(profile(name), scanOf([closedIssue(1, { merge: M2, base: profile(name).branches.integration, repository: name })]), inProduction()), [], name);
  }
  const report = await audit({ source: fakeSource({ recentlyClosedIssues: async () => { throw new Error('must not be read'); } }), repositories: [META, KB] });
  assert.ok(report.repositories.every(r => r.status !== 'UNREADABLE'));
});

test('CLOSED_BEFORE_PRODUCTION: production-merge (dev/main record) uses the integration branch for candidates', async () => {
  const findings = await checkClosedBeforeProduction(legacyFrontend(), scanOf([closedIssue(9, { base: 'dev' }), closedIssue(10, { base: 'main', merge: M2 })]), inProduction());
  assert.match(findings[0].message, /^1 Issue\(s\).*merged into dev .*#9 /);
});

test('CLOSED_BEFORE_PRODUCTION: a full scan window is a note; the audit reports the finding as a note only', async () => {
  const note = await checkClosedBeforeProduction(profile(FE), scanOf([], true), inProduction());
  assert.deepEqual(note.map(f => [f.check, f.severity]), [['CLOSED_BEFORE_PRODUCTION_WINDOW_FULL', 'note']]);
  assert.match(note[0].message, new RegExp(`More than ${CLOSED_SCAN_PAGE_SIZE * CLOSED_SCAN_MAX_PAGES} Issues`));
  const report = await audit({ source: fakeSource({ recentlyClosedIssues: async () => ({ issues: [closedIssue(464, { merge: M2 })], truncated: false }), productionContainment: inProduction(M1) }), repositories: [FE] });
  assert.equal(report.repositories[0].status, 'CONFORMANT');
  assert.ok(checks(report.repositories[0].notes).includes('CLOSED_BEFORE_PRODUCTION'));
});

test('CLOSED_BEFORE_PRODUCTION: a 403 or no valid receipt is the note UNVERIFIABLE and never hides drift', async () => {
  const candidate = async () => ({ issues: [closedIssue(464, { merge: M2 })], truncated: false });
  const forbidden = await audit({ source: fakeSource({ recentlyClosedIssues: candidate,
    productionContainment: async () => { throw new Error('Deployments of ChipIn-one/chipin-frontend are unreadable: GET x -> 403'); } }), repositories: [FE] });
  assert.equal(forbidden.repositories[0].status, 'CONFORMANT');
  const note = forbidden.repositories[0].notes.find(n => n.check === 'CLOSED_BEFORE_PRODUCTION_UNVERIFIABLE');
  assert.match(note.message, /^1 Issue\(s\) .* could not be checked .*403/);
  assert.match(note.remediation, /Deployments: Read-only/);
  const base = fakeSource();
  const drift = await audit({ source: fakeSource({ recentlyClosedIssues: candidate,
    productionContainment: async () => ({ label: 'x', contains: async () => { throw Object.assign(new Error('no valid Production receipt'), { code: 'CLOSED_BEFORE_PRODUCTION_UNVERIFIABLE' }); } }),
    repoFile: async (repo, path, ref) => (repo === FE && path === 'AGENTS.md' ? ROUTING.replace('stop.', 'halt.') : base.repoFile(repo, path, ref)) }), repositories: [FE] });
  assert.equal(drift.repositories[0].status, 'DRIFT', 'the drift of the repository stays visible');
  assert.deepEqual(checks(drift.repositories[0].findings), ['ROUTING_BLOCK_STALE']);
  assert.ok(checks(drift.repositories[0].notes).includes('CLOSED_BEFORE_PRODUCTION_UNVERIFIABLE'));
});

test('CLOSED_BEFORE_PRODUCTION: other unreadable closes or production evidence make the repository UNREADABLE, never clean', async () => {
  const evidence = await audit({ source: fakeSource({ recentlyClosedIssues: async () => ({ issues: [closedIssue(464, { merge: M2 })], truncated: false }),
    productionContainment: async () => { throw new Error('Deployments of ChipIn-one/chipin-frontend are unreadable: GET x -> 502'); } }), repositories: [FE] });
  assert.equal(evidence.repositories[0].status, 'UNREADABLE');
  assert.match(evidence.repositories[0].error, /CLOSED_BEFORE_PRODUCTION unreadable: Deployments .* 502/);
  const containment = await audit({ source: fakeSource({ recentlyClosedIssues: async () => ({ issues: [closedIssue(464, { merge: M2 })], truncated: false }),
    productionContainment: async () => ({ label: 'x', contains: async () => { throw new Error('GET compare -> 502'); } }) }), repositories: [FE] });
  assert.equal(containment.repositories[0].status, 'UNREADABLE');
  const closes = await audit({ source: fakeSource({ recentlyClosedIssues: async () => { throw new Error('GraphQL -> 502'); } }), repositories: [FE] });
  assert.equal(closes.repositories[0].status, 'UNREADABLE');
  assert.match(closes.repositories[0].error, /CLOSED_BEFORE_PRODUCTION unreadable: GraphQL -> 502/);
});

test('GitHubConformanceSource: closed-Issue scan is bounded and fails closed on incomplete linkage', async () => {
  const node = (number, total = 1) => ({ number, closedAt: RECENT, stateReason: 'COMPLETED', timelineItems: { nodes: [{ actor: { login: 'syllik' } }] },
    closedByPullRequestsReferences: { totalCount: total, nodes: [{ number: 5, mergedAt: RECENT, baseRefName: 'master', repository: { nameWithOwner: FE }, headRepository: { nameWithOwner: FE }, mergeCommit: { oid: M1 } }] } });
  const calls = [];
  const client = { graphql: async (query, vars) => { calls.push(vars); return { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: `c${calls.length}` }, nodes: [node(calls.length)] } } }; } };
  const scan = await new GitHubConformanceSource(client).recentlyClosedIssues(FE, SINCE, { pageSize: 1, maxPages: 2 });
  assert.equal(scan.truncated, true);
  assert.deepEqual(scan.issues.map(i => [i.number, i.closedBy, i.linkedPullRequests[0].mergeCommitSha]), [[1, 'syllik', M1], [2, 'syllik', M1]]);
  assert.deepEqual(calls.map(v => [v.s, v.a]), [[SINCE, null], [SINCE, 'c1']]);
  const partial = { graphql: async () => ({ repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [node(1, 2)] } } }) };
  const partialScan = await new GitHubConformanceSource(partial).recentlyClosedIssues(FE, SINCE);
  assert.equal(partialScan.issues[0].linkageIncomplete, true);
  assert.throws(() => closedBeforeProductionCandidates(profile(FE), partialScan.issues, SINCE), /incomplete/, 'a candidate with partial linkage fails closed');
  const notCandidates = [{ ...partialScan.issues[0], stateReason: 'NOT_PLANNED' }, { ...partialScan.issues[0], closedBy: 'github-actions' }];
  assert.deepEqual(closedBeforeProductionCandidates(profile(FE), notCandidates, SINCE), [], 'the bound applies only to candidates');
  const keyword = { graphql: async () => ({ repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ ...node(1), timelineItems: { nodes: [{ actor: { login: 'syllik' }, closer: { __typename: 'PullRequest', number: 5 } }] } }] } } }) };
  const keywordScan = await new GitHubConformanceSource(keyword).recentlyClosedIssues(FE, SINCE);
  assert.equal(closedBeforeProductionCandidates(profile(FE), keywordScan.issues, SINCE)[0].closedBy, 'syllik via the closing keyword of PR #5');
  const noCursor = { graphql: async () => ({ repository: { issues: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [node(1)] } } }) };
  await assert.rejects(new GitHubConformanceSource(noCursor).recentlyClosedIssues(FE, SINCE), /cursor is missing/);
  const fork = { graphql: async () => ({ repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ ...node(1), closedByPullRequestsReferences: { totalCount: 1, nodes: [{ number: 5, mergedAt: RECENT, baseRefName: 'master', repository: { nameWithOwner: FE }, headRepository: { nameWithOwner: 'someone/fork' }, mergeCommit: null }] } }] } } }) };
  const forked = await new GitHubConformanceSource(fork).recentlyClosedIssues(FE, SINCE);
  assert.deepEqual(forked.issues[0].linkedPullRequests[0], { number: 5, repository: FE, headRepository: 'someone/fork', mergedAt: RECENT, baseRefName: 'master', mergeCommitSha: null });
  assert.deepEqual(closedBeforeProductionCandidates(profile(FE), forked.issues, SINCE), [], 'fork PR and missing merge commit are not candidates');
});

test('GitHubConformanceSource: production containment reuses the completion receipt rules', async () => {
  const head = 'f'.repeat(40);
  const receipt = M2;
  const responses = (statusState) => async path => {
    if (path === `/repos/${FE}/commits/heads/master`) return { sha: head };
    if (path.startsWith(`/repos/${FE}/deployments?environment=Production`)) return [{ id: 7, sha: receipt, environment: 'Production', creator: { login: 'vercel[bot]' }, created_at: RECENT }];
    if (path.startsWith(`/repos/${FE}/deployments/7/statuses`)) return [{ id: 1, state: statusState, creator: { login: 'vercel[bot]' }, created_at: RECENT }];
    const compare = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
    if (compare) return compare[2] === head || compare[1] === M1 ? { status: 'ahead', merge_base_commit: { sha: compare[1] } } : { status: 'diverged', merge_base_commit: { sha: '0'.repeat(40) } };
    throw new Error(`unexpected ${path}`);
  };
  const ok = await new GitHubConformanceSource({ request: responses('success') }).productionContainment(profile(FE));
  assert.equal(await ok.contains({ mergeCommitSha: M1, mergedAt: RECENT }), true);
  assert.equal(await ok.contains({ mergeCommitSha: '3'.repeat(40), mergedAt: RECENT }), false);
  const none = await new GitHubConformanceSource({ request: responses('failure') }).productionContainment(profile(FE));
  await assert.rejects(none.contains({ mergeCommitSha: M1, mergedAt: RECENT }), e => /no valid Production receipt/.test(e.message) && e.code === 'CLOSED_BEFORE_PRODUCTION_UNVERIFIABLE');
  await assert.rejects(new GitHubConformanceSource({ request: async () => { throw new Error('GET x -> 403'); } }).productionContainment(profile(FE)), /403/);
});

test('GitHubConformanceSource: production-merge containment uses merged dev -> main release PR heads, as the engine does', async () => {
  const releaseHead = '9'.repeat(40);
  const mainHead = '8'.repeat(40);
  const before = new Date(Date.now() - 5 * 86_400_000).toISOString();
  const client = {
    listAll: async path => {
      assert.match(path, /\/pulls\?state=closed&base=main/);
      return [
        { number: 474, merged_at: RECENT, base: { ref: 'main' }, head: { ref: 'dev', sha: releaseHead, repo: { full_name: FE } } },
        { number: 475, merged_at: RECENT, base: { ref: 'main' }, head: { ref: 'hotfix', sha: mainHead, repo: { full_name: FE } } },
      ];
    },
    request: async path => {
      if (path.includes('/commits/')) throw new Error('the promotion head is not evidence');
      const compare = /\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path);
      assert.equal(compare[2], releaseHead, 'only the dev -> main release PR head is compared');
      return compare[1] === M1 ? { status: 'ahead', merge_base_commit: { sha: M1 } } : { status: 'diverged', merge_base_commit: { sha: '0'.repeat(40) } };
    },
  };
  const evidence = await new GitHubConformanceSource(client).productionContainment(legacyFrontend());
  assert.equal(await evidence.contains({ mergeCommitSha: M1, mergedAt: before }), true);
  assert.equal(await evidence.contains({ mergeCommitSha: M2, mergedAt: before }), false);
  assert.equal(await evidence.contains({ mergeCommitSha: M1, mergedAt: new Date().toISOString() }), false, 'a release merged before the PR is not evidence');
  const other = { ...legacyFrontend(), branches: Object.freeze({ default: 'main', integration: 'develop', promotion: 'release' }) };
  const skipped = await new GitHubConformanceSource(client).productionContainment(other);
  assert.match(skipped.skipped, /implemented for dev -> main/);
  const findings = await checkClosedBeforeProduction({ ...other }, scanOf([closedIssue(1, { base: 'develop' })]), async () => skipped);
  assert.deepEqual(findings.map(f => [f.check, f.severity]), [['CLOSED_BEFORE_PRODUCTION_SKIPPED', 'note']]);
});
