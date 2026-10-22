import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SUPPORTED_REPOSITORIES, readTaskIdentityMarker } from './development-link.mjs';
import { isSupportedIntakeRepository } from './issue-intake.mjs';
import { admissionRepositories, requiredOwner } from './issue-admission.mjs';
import {
  KIND_DEFAULTS, REGISTRY_PATH, RegistryError, getRepositoryProfile, integrationBranch,
  listRepositories, loadRegistry, main, parseYamlSubset, requireRepositoryProfile, validateRegistry,
} from './registry.mjs';

const FE = 'ChipIn-one/chipin-frontend';
const BE = 'ChipIn-one/chipin-backend';
const KB = 'ChipIn-one/chipin-knowledge-base';
const META = 'ChipIn-one/.github';
const NOTIF = 'ChipIn-one/chipin-notifications';
const PY = 'ChipIn-one/chipin-backend-python';
const SLACK = 'ChipIn-one/slack-rofls';

const record = (overrides = {}) => ({
  repository: 'ChipIn-one/example', kind: 'code', visibility: 'public', owner: 'syllik',
  branches: { default: 'main', integration: 'main' }, deploymentProfile: 'none',
  completion: 'production-merge', protection: 'unavailable', requiredChecks: [], release: { strategy: 'none' }, ...overrides,
});
const document = (repositories = [record()]) => ({
  schemaVersion: 1, standardVersion: 'v1', project: { number: 5, statuses: ['Backlog', 'Done'] }, repositories,
});
const rejects = (fn, code) => assert.throws(fn, error => error instanceof RegistryError && error.code === code,
  `expected ${code}`);

test('YAML subset: block and flow collections, comments, scalars', () => {
  const parsed = parseYamlSubset([
    '# header',
    'a: 1  # trailing',
    'b: [x y, "q # not comment", \'s\']',
    'c: { k: v, n: null, t: true, e: [] }',
    'list:',
    '  - name: one',
    '    deep:',
    '      - 7',
    '  - plain',
    'empty:',
    'tail: value',
  ].join('\n'));
  assert.deepEqual(parsed, {
    a: 1, b: ['x y', 'q # not comment', 's'], c: { k: 'v', n: null, t: true, e: [] },
    list: [{ name: 'one', deep: [7] }, 'plain'], empty: null, tail: 'value',
  });
});

test('YAML subset rejects what it does not understand instead of guessing', () => {
  rejects(() => parseYamlSubset(''), 'YAML_EMPTY');
  rejects(() => parseYamlSubset('a: 1\na: 2'), 'YAML_DUPLICATE_KEY');
  rejects(() => parseYamlSubset('a: { k: 1, k: 2 }'), 'YAML_DUPLICATE_KEY');
  rejects(() => parseYamlSubset('a:\n\tb: 1'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: &anchor 1'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: |\n  text'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: !tag 1'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: b: c'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: [1, 2'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: "open'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: [1] extra'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('---\na: 1'), 'YAML_UNSUPPORTED');
  rejects(() => parseYamlSubset('a: 1\n  b: 2'), 'YAML_INDENT');
  rejects(() => parseYamlSubset('just text'), 'YAML_SYNTAX');
});

test('workflow-registry.yaml matches the approved standard exactly', () => {
  const registry = loadRegistry();
  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.standardVersion, 'v1');
  assert.deepEqual(registry.project, { number: 5, statuses: ['Backlog', 'Todo', 'In Progress', 'Awaiting release', 'Done'] });
  assert.deepEqual(registry.repositories.map(profile => profile.repository), [FE, BE, KB, META, NOTIF]);

  assert.deepEqual(getRepositoryProfile(FE), {
    repository: FE, kind: 'code', visibility: 'public', owner: 'syllik',
    branches: { default: 'main', integration: 'dev', promotion: 'main' },
    deploymentProfile: 'production', completion: 'production-merge', protection: 'ruleset',
    requiredChecks: ['frontend-ci'],
    release: { strategy: 'semver-by-impact', trigger: 'promotion-merge', tagPrefix: 'v' },
    capabilities: { admission: 'required', developmentLink: 'required', prMetadata: 'required',
      relationships: 'required', completion: 'automatic', milestones: 'enabled',
      dependabot: 'required', agentRouting: 'required' },
  });
  assert.deepEqual(getRepositoryProfile(BE), {
    repository: BE, kind: 'code', visibility: 'private', owner: 'olegbal',
    branches: { default: 'develop', integration: 'develop', promotion: null },
    deploymentProfile: 'production', completion: 'manual', protection: 'unavailable',
    requiredChecks: ['Unit and integration tests'],
    release: { strategy: 'deploy-tag', trigger: 'production-deploy', tagPrefix: 'v' },
    capabilities: { admission: 'advisory', developmentLink: 'required', prMetadata: 'required',
      relationships: 'required', completion: 'manual', milestones: 'enabled',
      dependabot: 'required', agentRouting: 'required' },
  });
  assert.deepEqual(getRepositoryProfile(KB), {
    repository: KB, kind: 'docs', visibility: 'private', owner: null,
    branches: { default: 'master', integration: 'master', promotion: null },
    deploymentProfile: 'none', completion: 'integration-merge', protection: 'unavailable', requiredChecks: [],
    release: { strategy: 'none', trigger: null, tagPrefix: 'v' },
    capabilities: { admission: 'advisory', developmentLink: 'required', prMetadata: 'off',
      relationships: 'required', completion: 'automatic', milestones: 'off',
      dependabot: 'required', agentRouting: 'required' },
  });
  assert.deepEqual(getRepositoryProfile(META), {
    repository: META, kind: 'meta', visibility: 'public', owner: 'syllik',
    branches: { default: 'master', integration: 'master', promotion: null },
    deploymentProfile: 'none', completion: 'integration-merge', protection: 'ruleset',
    requiredChecks: ['evaluate-fixtures'],
    release: { strategy: 'semver-by-impact', trigger: 'integration-merge', tagPrefix: 'v' },
    capabilities: { admission: 'advisory', developmentLink: 'required', prMetadata: 'off',
      relationships: 'required', completion: 'automatic', milestones: 'off',
      dependabot: 'required', agentRouting: 'required' },
  });
  assert.deepEqual(getRepositoryProfile(NOTIF), {
    repository: NOTIF, kind: 'docs', visibility: 'private', owner: null,
    branches: { default: 'master', integration: 'master', promotion: null },
    deploymentProfile: 'none', completion: 'manual', protection: 'unavailable', requiredChecks: [],
    release: { strategy: 'none', trigger: null, tagPrefix: 'v' },
    capabilities: { admission: 'off', developmentLink: 'off', prMetadata: 'off',
      relationships: 'off', completion: 'manual', milestones: 'off',
      dependabot: 'off', agentRouting: 'off' },
  });
  // Owner decision 2026-10-21: these two stay outside the standard.
  assert.equal(getRepositoryProfile(PY), null);
  assert.equal(getRepositoryProfile(SLACK), null);
});

test('loaded registry is immutable and cached for the default path', () => {
  const registry = loadRegistry();
  assert.equal(loadRegistry(), registry);
  assert.throws(() => { registry.repositories[0].owner = 'someone'; }, TypeError);
  assert.throws(() => { registry.repositories[0].capabilities.admission = 'off'; }, TypeError);
  assert.throws(() => { registry.project.statuses.push('X'); }, TypeError);
});

test('unknown repository is null for lookup and fail-closed for require', () => {
  assert.equal(getRepositoryProfile(PY), null);
  assert.equal(getRepositoryProfile(undefined), null);
  rejects(() => requireRepositoryProfile(SLACK), 'UNKNOWN_REPOSITORY');
  rejects(() => integrationBranch(PY), 'UNKNOWN_REPOSITORY');
  assert.equal(getRepositoryProfile('chipin-one/CHIPIN-FRONTEND').repository, FE);
});

test('schema rejects unknown keys at every level and missing keys', () => {
  rejects(() => validateRegistry({ ...document(), extra: 1 }), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry({ ...document(), project: { number: 5, statuses: ['A'], extra: 1 } }), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry(document([record({ surprise: true })])), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry(document([record({ branches: { default: 'main', integration: 'main', x: 'y' } })])), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry(document([record({ capabilities: { teleport: 'required' } })])), 'REGISTRY_SCHEMA');
  const { owner, ...withoutOwner } = record();
  rejects(() => validateRegistry(document([withoutOwner])), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry(document([])), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry({ schemaVersion: 1, standardVersion: 'v1', repositories: [] }), 'REGISTRY_SCHEMA');
});

test('schema rejects invalid values', () => {
  rejects(() => validateRegistry({ ...document(), schemaVersion: 2 }), 'REGISTRY_VALUE');
  rejects(() => validateRegistry({ ...document(), standardVersion: '1.0' }), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ capabilities: { admission: 'sometimes' } })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ capabilities: { prMetadata: 'advisory' } })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ kind: 'service' })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ protection: 'maybe' })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ repository: 'other-org/repo' })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ owner: 'not a login' })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ owner: null })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ requiredChecks: ['a', 'a'] })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ branches: { default: '', integration: 'main' } })])), 'REGISTRY_VALUE');
  rejects(() => validateRegistry({ ...document(), project: { number: 0, statuses: ['A'] } }), 'REGISTRY_VALUE');
  rejects(() => validateRegistry({ ...document(), project: { number: 5, statuses: ['A', 'A'] } }), 'REGISTRY_VALUE');
  // `automatic` needs a strategy the completion engine implements (automation/completion.mjs)
  rejects(() => validateRegistry(document([record({ completion: 'manual', capabilities: { completion: 'automatic' } })])),
    'REGISTRY_VALUE');
  rejects(() => validateRegistry(document([record({ completion: 'deployment-receipt', capabilities: { completion: 'automatic' } })])),
    'REGISTRY_VALUE');
  for (const completion of ['production-merge', 'integration-merge']) {
    const ok = validateRegistry(document([record({ completion, capabilities: { completion: 'automatic' } })]));
    assert.equal(ok.repositories[0].capabilities.completion, 'automatic');
  }
  assert.equal(validateRegistry(document([record({ completion: 'deployment-receipt', capabilities: { completion: 'manual' } })]))
    .repositories[0].completion, 'deployment-receipt');
});

test('owner may be null only for docs repositories', () => {
  const docs = validateRegistry(document([record({ kind: 'docs', owner: null })]));
  assert.equal(docs.repositories[0].owner, null);
});

test('duplicate repository is rejected case-insensitively', () => {
  rejects(() => validateRegistry(document([record(), record({ repository: 'ChipIn-one/EXAMPLE' })])), 'REGISTRY_DUPLICATE');
});

test('capabilities default by kind and the record overrides the default', () => {
  const [code, docs, meta, override] = validateRegistry(document([
    record({ repository: 'ChipIn-one/a' }),
    record({ repository: 'ChipIn-one/b', kind: 'docs' }),
    record({ repository: 'ChipIn-one/c', kind: 'meta' }),
    record({ repository: 'ChipIn-one/d', capabilities: { admission: 'advisory', milestones: 'off' } }),
  ])).repositories;
  assert.deepEqual(code.capabilities, KIND_DEFAULTS.code);
  assert.equal(docs.capabilities.prMetadata, 'off');
  assert.equal(docs.capabilities.milestones, 'off');
  assert.equal(docs.capabilities.admission, 'required');
  assert.equal(meta.capabilities.prMetadata, 'off');
  assert.equal(meta.capabilities.milestones, 'enabled');
  assert.equal(override.capabilities.admission, 'advisory');
  assert.equal(override.capabilities.milestones, 'off');
  assert.equal(override.capabilities.prMetadata, 'required');
});

test('loadRegistry reports an unreadable file as a registry error', () => {
  rejects(() => loadRegistry({ path: '/nonexistent/workflow-registry.yaml' }), 'REGISTRY_UNREADABLE');
});

test('listRepositories filters by kind and capability', () => {
  assert.deepEqual(listRepositories({ kinds: ['code', 'docs'], capability: 'developmentLink' }), [FE, BE, KB]);
  assert.deepEqual(listRepositories({ kinds: ['code', 'docs', 'meta'], capability: 'developmentLink' }), [FE, BE, KB, META]);
  assert.deepEqual(listRepositories({ capability: 'milestones', values: ['enabled'] }), [FE, BE]);
  assert.deepEqual(listRepositories({ capability: 'prMetadata' }), [FE, BE]);
  assert.deepEqual(listRepositories({ capability: 'admission', values: ['advisory'] }), [BE, KB, META]);
  assert.deepEqual(listRepositories({ kinds: ['meta'] }), [META]);
  rejects(() => listRepositories({ capability: 'nope' }), 'REGISTRY_VALUE');
});

test('admission and intake scope is the registry: every repository with admission on, owner from its record', async () => {
  const taskRepositories = listRepositories({ kinds: ['code', 'docs', 'meta'], capability: 'developmentLink' });
  assert.deepEqual([...SUPPORTED_REPOSITORIES], taskRepositories);
  assert.deepEqual(taskRepositories, [FE, BE, KB, META], 'chipin-notifications is registered with every task capability off; .github PRs are linked since #179');
  assert.deepEqual(listRepositories({ capability: 'admission' }), [FE, BE, KB, META]);
  assert.deepEqual(admissionRepositories(), [FE, BE, KB, META]);
  for (const repository of [FE, BE, KB, META]) assert.equal(isSupportedIntakeRepository(repository), true);
  assert.equal(isSupportedIntakeRepository(NOTIF), false, 'admission off');
  assert.equal(isSupportedIntakeRepository('ChipIn-one/Chipin-Frontend'), false, 'exact spelling only (GitHub would resolve the mis-cased name)');
  assert.equal(isSupportedIntakeRepository('ChipIn-one/slack-rofls'), false, 'unregistered');

  for (const repository of [FE, BE, KB, META]) {
    const { owner } = getRepositoryProfile(repository);
    assert.equal(requiredOwner(repository, owner === null ? 'syllik' : null), owner ?? 'syllik');
  }
  assert.equal(requiredOwner(META), 'syllik');
  assert.throws(() => requiredOwner(NOTIF), /Unsupported admission repository/);
  assert.throws(() => requiredOwner('ChipIn-one/slack-rofls'), /Unsupported admission repository/);

  const migration = JSON.parse(await readFile(new URL('./metadata-migration.config.json', import.meta.url), 'utf8'));
  assert.equal(migration.project.number, loadRegistry().project.number);
  assert.deepEqual(migration.project.statusValues, [...loadRegistry().project.statuses]);
});

test('consumers resolve the same behavior from the registry as the old literals', () => {
  assert.deepEqual([...SUPPORTED_REPOSITORIES].sort(), [META, BE, FE, KB]);
  assert.equal(integrationBranch(FE), 'dev');
  assert.equal(integrationBranch(BE), 'develop');
  assert.equal(integrationBranch(KB), 'master');
  for (const repository of [FE, BE, KB, META]) {
    assert.equal(readTaskIdentityMarker(`Task identity: ${repository}#12`).repository, repository);
  }
  assert.throws(() => readTaskIdentityMarker(`Task identity: ${NOTIF}#12`), /./);
  assert.throws(() => readTaskIdentityMarker('Task identity: ChipIn-one/chipin-frontendX#12'), /./);
});

test('CLI validates the real registry and fails closed on a broken file', async () => {
  const out = []; const err = [];
  const stdout = { write: text => out.push(text) };
  const stderr = { write: text => err.push(text) };
  assert.equal(main(['--validate'], stdout, stderr), 0);
  assert.match(out.join(''), /^REGISTRY OK: 5 repositories, standard v1/);

  const dir = await mkdtemp(join(tmpdir(), 'registry-test-'));
  const broken = join(dir, 'broken.yaml');
  const real = await readFile(REGISTRY_PATH, 'utf8');
  await writeFile(broken, real.replace('owner: olegbal', 'owner: olegbal\n    surprise: 1'));
  assert.equal(main(['--validate', '--file', broken], stdout, stderr), 1);
  assert.match(err.join(''), /REGISTRY INVALID: REGISTRY_SCHEMA: repositories\[1\]: unknown key "surprise"/);

  assert.equal(main([], stdout, stderr), 2);
  assert.equal(main(['--validate', '--file'], stdout, stderr), 2);
  assert.equal(main(['--validate', '--bogus'], stdout, stderr), 2);
});

test('release block: strategy and trigger must agree and fit the repository', () => {
  const ok = (release, extra = {}) => validateRegistry(document([record({ branches: { default: 'main', integration: 'dev', promotion: 'main' }, deploymentProfile: 'production', release, ...extra })])).repositories[0].release;
  assert.deepEqual(ok({ strategy: 'semver-by-impact', trigger: 'promotion-merge' }), { strategy: 'semver-by-impact', trigger: 'promotion-merge', tagPrefix: 'v' });
  assert.deepEqual(ok({ strategy: 'semver-by-impact', trigger: 'integration-merge', tagPrefix: 'rel' }), { strategy: 'semver-by-impact', trigger: 'integration-merge', tagPrefix: 'rel' });
  assert.deepEqual(ok({ strategy: 'deploy-tag', trigger: 'production-deploy' }), { strategy: 'deploy-tag', trigger: 'production-deploy', tagPrefix: 'v' });
  assert.deepEqual(ok({ strategy: 'none' }), { strategy: 'none', trigger: null, tagPrefix: 'v' });
  rejects(() => ok({ strategy: 'none', trigger: 'promotion-merge' }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'deploy-tag', trigger: 'promotion-merge' }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'semver-by-impact', trigger: 'production-deploy' }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'semver-by-impact' }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'calver', trigger: 'promotion-merge' }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'semver-by-impact', trigger: 'promotion-merge', tagPrefix: 'V1' }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'none', surprise: 1 }), 'REGISTRY_SCHEMA');
  rejects(() => validateRegistry(document([record({ release: undefined })])), 'REGISTRY_SCHEMA');
  const { release, ...withoutRelease } = record();
  rejects(() => validateRegistry(document([withoutRelease])), 'REGISTRY_SCHEMA');
  rejects(() => ok({ strategy: 'semver-by-impact', trigger: 'promotion-merge' }, { branches: { default: 'main', integration: 'main' } }), 'REGISTRY_VALUE');
  rejects(() => ok({ strategy: 'deploy-tag', trigger: 'production-deploy' }, { deploymentProfile: 'staging' }), 'REGISTRY_VALUE');
});

test('release decisions of 2026-10-21 are recorded for every registered repository', () => {
  const by = Object.fromEntries(loadRegistry().repositories.map(p => [p.repository, p.release]));
  assert.deepEqual(by[FE], { strategy: 'semver-by-impact', trigger: 'promotion-merge', tagPrefix: 'v' });
  assert.deepEqual(by[BE], { strategy: 'deploy-tag', trigger: 'production-deploy', tagPrefix: 'v' });
  assert.deepEqual(by[META], { strategy: 'semver-by-impact', trigger: 'integration-merge', tagPrefix: 'v' });
  assert.equal(by[KB].strategy, 'none');
  assert.equal(by[NOTIF].strategy, 'none');
  assert.deepEqual(listRepositories({ kinds: ['docs'] }), [KB, NOTIF]);
});
