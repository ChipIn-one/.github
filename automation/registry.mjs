#!/usr/bin/env node
// Loader and strict validator for workflow-registry.yaml (spec: docs/workflow/README.md §2).
// No dependencies: the registry is read with a deliberately small YAML subset reader that
// rejects anything it does not understand instead of guessing.
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REGISTRY_PATH = fileURLToPath(new URL('../workflow-registry.yaml', import.meta.url));

export class RegistryError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RegistryError';
    this.code = code;
  }
}
const fail = (code, detail) => { throw new RegistryError(code, detail); };

// ---------------------------------------------------------------------------
// YAML subset reader
// ---------------------------------------------------------------------------

function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s[{,:]/.test(text[i - 1])) quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i);
    }
  }
  return text;
}

function parseScalar(raw, line) {
  const value = raw.trim();
  if (value === '' || value === '~' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (/^"[^"\\]*"$/.test(value) || /^'[^']*'$/.test(value)) return value.slice(1, -1);
  if (/^["']/.test(value)) fail('YAML_UNSUPPORTED', `line ${line}: malformed or escaped quoted scalar`);
  if (/^[&*!|>%@`]/.test(value)) fail('YAML_UNSUPPORTED', `line ${line}: unsupported scalar syntax "${value[0]}"`);
  if (/:(\s|$)/.test(value)) fail('YAML_UNSUPPORTED', `line ${line}: ambiguous plain scalar "${value}"`);
  return value;
}

function parseFlow(text, line) {
  let pos = 0;
  const skip = () => { while (pos < text.length && text[pos] === ' ') pos += 1; };
  const readScalar = stops => {
    skip();
    const start = pos;
    if (text[pos] === '"' || text[pos] === "'") {
      const quote = text[pos];
      pos += 1;
      while (pos < text.length && text[pos] !== quote) pos += 1;
      if (pos >= text.length) fail('YAML_UNSUPPORTED', `line ${line}: unterminated quoted scalar`);
      pos += 1;
      return parseScalar(text.slice(start, pos), line);
    }
    while (pos < text.length && !stops.includes(text[pos])) pos += 1;
    return parseScalar(text.slice(start, pos), line);
  };
  const readValue = () => {
    skip();
    if (text[pos] === '[') return readSequence();
    if (text[pos] === '{') return readMapping();
    return readScalar([',', ']', '}']);
  };
  function readSequence() {
    pos += 1;
    const items = [];
    skip();
    if (text[pos] === ']') { pos += 1; return items; }
    for (;;) {
      items.push(readValue());
      skip();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === ']') { pos += 1; return items; }
      fail('YAML_UNSUPPORTED', `line ${line}: malformed flow sequence`);
    }
  }
  function readMapping() {
    pos += 1;
    const map = {};
    skip();
    if (text[pos] === '}') { pos += 1; return map; }
    for (;;) {
      skip();
      const keyStart = pos;
      while (pos < text.length && text[pos] !== ':') pos += 1;
      if (text[pos] !== ':') fail('YAML_UNSUPPORTED', `line ${line}: flow mapping entry without ":"`);
      const key = parseScalar(text.slice(keyStart, pos), line);
      if (typeof key !== 'string' || key === '') fail('YAML_UNSUPPORTED', `line ${line}: invalid flow mapping key`);
      if (Object.hasOwn(map, key)) fail('YAML_DUPLICATE_KEY', `line ${line}: duplicate key "${key}"`);
      pos += 1;
      map[key] = readValue();
      skip();
      if (text[pos] === ',') { pos += 1; continue; }
      if (text[pos] === '}') { pos += 1; return map; }
      fail('YAML_UNSUPPORTED', `line ${line}: malformed flow mapping`);
    }
  }
  const result = readValue();
  skip();
  if (pos !== text.length) fail('YAML_UNSUPPORTED', `line ${line}: trailing content after flow collection`);
  return result;
}

function parseValue(raw, line) {
  const text = raw.trim();
  return text.startsWith('[') || text.startsWith('{') ? parseFlow(text, line) : parseScalar(text, line);
}

const KEY_LINE = /^(?:([A-Za-z_][\w.-]*)|"([^"]*)"|'([^']*)'):(?:\s+(.*))?$/;

export function parseYamlSubset(source) {
  const lines = [];
  String(source).split(/\r?\n/).forEach((rawLine, index) => {
    const lineNo = index + 1;
    if (/^\s*\t/.test(rawLine)) fail('YAML_UNSUPPORTED', `line ${lineNo}: tab indentation`);
    const body = stripComment(rawLine).replace(/\s+$/, '');
    if (body.trim() === '') return;
    if (/^---|^\.\.\./.test(body)) fail('YAML_UNSUPPORTED', `line ${lineNo}: document markers`);
    lines.push({ indent: body.length - body.trimStart().length, text: body.trimStart(), line: lineNo });
  });
  if (!lines.length) fail('YAML_EMPTY', 'registry file has no content');

  let cursor = 0;

  function parseBlock(indent) {
    const first = lines[cursor];
    if (first.indent !== indent) fail('YAML_INDENT', `line ${first.line}: unexpected indentation`);
    return first.text === '-' || first.text.startsWith('- ') ? parseSequence(indent) : parseMapping(indent);
  }

  function parseMapping(indent) {
    const map = {};
    while (cursor < lines.length && lines[cursor].indent === indent) {
      const entry = lines[cursor];
      if (entry.text === '-' || entry.text.startsWith('- ')) {
        fail('YAML_INDENT', `line ${entry.line}: sequence item inside a mapping at the same indent`);
      }
      const match = KEY_LINE.exec(entry.text);
      if (!match) fail('YAML_SYNTAX', `line ${entry.line}: expected "key: value"`);
      const key = match[1] ?? match[2] ?? match[3];
      if (Object.hasOwn(map, key)) fail('YAML_DUPLICATE_KEY', `line ${entry.line}: duplicate key "${key}"`);
      cursor += 1;
      const rest = match[4];
      if (rest !== undefined && rest.trim() !== '') {
        map[key] = parseValue(rest, entry.line);
      } else if (cursor < lines.length && lines[cursor].indent > indent) {
        map[key] = parseBlock(lines[cursor].indent);
      } else {
        map[key] = null;
      }
    }
    if (cursor < lines.length && lines[cursor].indent > indent) {
      fail('YAML_INDENT', `line ${lines[cursor].line}: unexpected indentation`);
    }
    return map;
  }

  function parseSequence(indent) {
    const items = [];
    while (cursor < lines.length && lines[cursor].indent === indent &&
           (lines[cursor].text === '-' || lines[cursor].text.startsWith('- '))) {
      const entry = lines[cursor];
      const rest = entry.text.slice(1).trimStart();
      if (rest === '') {
        cursor += 1;
        if (cursor < lines.length && lines[cursor].indent > indent) items.push(parseBlock(lines[cursor].indent));
        else items.push(null);
      } else if (KEY_LINE.test(rest) && !/^["'[{]/.test(rest)) {
        // "- key: value": the mapping continues on following lines at the key column.
        const keyIndent = indent + (entry.text.length - rest.length);
        lines[cursor] = { indent: keyIndent, text: rest, line: entry.line };
        items.push(parseMapping(keyIndent));
      } else {
        cursor += 1;
        items.push(parseValue(rest, entry.line));
      }
    }
    if (cursor < lines.length && lines[cursor].indent > indent) {
      fail('YAML_INDENT', `line ${lines[cursor].line}: unexpected indentation`);
    }
    return items;
  }

  const document = parseBlock(lines[0].indent);
  if (cursor < lines.length) fail('YAML_INDENT', `line ${lines[cursor].line}: unexpected content`);
  return document;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const KINDS = ['code', 'docs', 'meta'];
const VISIBILITY = ['public', 'private'];
const DEPLOYMENT_PROFILES = ['none', 'staging', 'production'];
const COMPLETION = ['production-merge', 'integration-merge', 'deployment-receipt', 'manual'];
// Strategies automation/completion.mjs implements; `capabilities.completion: automatic` needs one of them.
export const AUTOMATIC_COMPLETION_STRATEGIES = Object.freeze(['production-merge', 'integration-merge', 'deployment-receipt']);
// deployment-receipt reads its production evidence from GitHub Deployments; the record names which ones count.
const PRODUCTION_EVIDENCE_STRATEGY = 'deployment-receipt';
// Who runs the engine for an automatic record (.github#217): `repository` = a completion caller in the repository
// itself (templates/caller-completion-*.yml); `org-sweep` = only the org sweep in ChipIn-one/.github, which runs
// `completion.mjs --repository <it>` on a schedule (owner decision for chipin-frontend). Conformance reads it.
export const COMPLETION_RUNNERS = Object.freeze(['repository', 'org-sweep']);
const DEPLOYMENT_CREATOR = /^[a-z\d](?:[a-z\d-]{0,38})(?:\[bot\])?$/i;
const PROTECTION = ['ruleset', 'protection', 'unavailable'];
const RELEASE_STRATEGIES = ['semver-by-impact', 'deploy-tag', 'none'];
const RELEASE_TRIGGERS = ['promotion-merge', 'integration-merge', 'production-deploy'];
// strategy -> allowed triggers; `none` has no trigger.
const RELEASE_TRIGGERS_BY_STRATEGY = { 'semver-by-impact': ['promotion-merge', 'integration-merge'], 'deploy-tag': ['production-deploy'], none: [] };

export const CAPABILITY_VALUES = Object.freeze({
  admission: ['required', 'advisory', 'off'],
  developmentLink: ['required', 'advisory', 'off'],
  prMetadata: ['required', 'off'],
  relationships: ['required', 'off'],
  completion: ['automatic', 'manual'],
  milestones: ['enabled', 'off'],
  dependabot: ['required', 'off'],
  agentRouting: ['required', 'off'],
});

const CODE_DEFAULTS = Object.freeze({
  admission: 'required', developmentLink: 'required', prMetadata: 'required', relationships: 'required',
  completion: 'automatic', milestones: 'enabled', dependabot: 'required', agentRouting: 'required',
});
export const KIND_DEFAULTS = Object.freeze({
  code: CODE_DEFAULTS,
  docs: Object.freeze({ ...CODE_DEFAULTS, prMetadata: 'off', milestones: 'off' }),
  meta: Object.freeze({ ...CODE_DEFAULTS, prMetadata: 'off' }),
});

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const LOGIN = /^[a-z\d](?:[a-z\d-]{0,38})$/i;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REPOSITORY = /^ChipIn-one\/[A-Za-z0-9._-]+$/;

function assertKeys(where, object, required, optional = []) {
  if (!isPlainObject(object)) fail('REGISTRY_SCHEMA', `${where} must be a mapping`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail('REGISTRY_SCHEMA', `${where}: unknown key "${key}"`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) fail('REGISTRY_SCHEMA', `${where}: missing key "${key}"`);
  }
}
function assertEnum(where, value, allowed) {
  if (!allowed.includes(value)) fail('REGISTRY_VALUE', `${where}: "${value}" is not one of ${allowed.join(' | ')}`);
}
function assertString(where, value, pattern) {
  if (typeof value !== 'string' || value === '' || (pattern && !pattern.test(value))) {
    fail('REGISTRY_VALUE', `${where}: invalid value ${JSON.stringify(value)}`);
  }
}

function normalizeRepository(record, index) {
  const where = `repositories[${index}]`;
  assertKeys(where, record,
    ['repository', 'kind', 'visibility', 'owner', 'branches', 'deploymentProfile', 'completion', 'protection', 'requiredChecks', 'release'],
    ['capabilities', 'productionEvidence', 'completionRunner']);
  assertString(`${where}.repository`, record.repository, REPOSITORY);
  assertEnum(`${where}.kind`, record.kind, KINDS);
  assertEnum(`${where}.visibility`, record.visibility, VISIBILITY);
  if (record.owner === null) {
    if (record.kind !== 'docs') fail('REGISTRY_VALUE', `${where}.owner: null is allowed only for kind docs`);
  } else {
    assertString(`${where}.owner`, record.owner, LOGIN);
  }
  assertKeys(`${where}.branches`, record.branches, ['default', 'integration'], ['promotion']);
  for (const [name, branch] of Object.entries(record.branches)) assertString(`${where}.branches.${name}`, branch, BRANCH);
  assertEnum(`${where}.deploymentProfile`, record.deploymentProfile, DEPLOYMENT_PROFILES);
  assertEnum(`${where}.completion`, record.completion, COMPLETION);
  let productionEvidence = null;
  if (record.completion === PRODUCTION_EVIDENCE_STRATEGY) {
    if (!Object.hasOwn(record, 'productionEvidence')) {
      fail('REGISTRY_VALUE', `${where}: completion ${PRODUCTION_EVIDENCE_STRATEGY} needs productionEvidence { environment, creator }`);
    }
    assertKeys(`${where}.productionEvidence`, record.productionEvidence, ['environment', 'creator']);
    const { environment, creator } = record.productionEvidence;
    if (typeof environment !== 'string' || environment.trim() !== environment) {
      fail('REGISTRY_VALUE', `${where}.productionEvidence.environment: invalid value ${JSON.stringify(environment)}`);
    }
    assertString(`${where}.productionEvidence.environment`, environment);
    assertString(`${where}.productionEvidence.creator`, creator, DEPLOYMENT_CREATOR);
    if (record.deploymentProfile !== 'production') {
      fail('REGISTRY_VALUE', `${where}: completion ${PRODUCTION_EVIDENCE_STRATEGY} needs deploymentProfile production`);
    }
    productionEvidence = { environment, creator };
  } else if (Object.hasOwn(record, 'productionEvidence')) {
    fail('REGISTRY_VALUE', `${where}.productionEvidence: only completion ${PRODUCTION_EVIDENCE_STRATEGY} reads production evidence`);
  }
  assertEnum(`${where}.protection`, record.protection, PROTECTION);
  if (!Array.isArray(record.requiredChecks)) fail('REGISTRY_SCHEMA', `${where}.requiredChecks must be a sequence`);
  record.requiredChecks.forEach((check, i) => assertString(`${where}.requiredChecks[${i}]`, check));
  if (new Set(record.requiredChecks).size !== record.requiredChecks.length) {
    fail('REGISTRY_VALUE', `${where}.requiredChecks: duplicate check name`);
  }

  assertKeys(`${where}.release`, record.release, ['strategy'], ['trigger', 'tagPrefix']);
  assertEnum(`${where}.release.strategy`, record.release.strategy, RELEASE_STRATEGIES);
  const trigger = record.release.trigger ?? null;
  if (record.release.strategy === 'none') {
    if (trigger !== null) fail('REGISTRY_VALUE', `${where}.release: strategy none must not have a trigger`);
  } else {
    assertEnum(`${where}.release.trigger`, trigger, RELEASE_TRIGGERS);
    if (!RELEASE_TRIGGERS_BY_STRATEGY[record.release.strategy].includes(trigger)) {
      fail('REGISTRY_VALUE', `${where}.release: strategy ${record.release.strategy} cannot use trigger ${trigger}`);
    }
    if (trigger === 'promotion-merge' && !record.branches.promotion) fail('REGISTRY_VALUE', `${where}.release: promotion-merge needs branches.promotion`);
    if (trigger === 'production-deploy' && record.deploymentProfile !== 'production') fail('REGISTRY_VALUE', `${where}.release: production-deploy needs deploymentProfile production`);
  }
  const tagPrefix = record.release.tagPrefix ?? 'v';
  if (typeof tagPrefix !== 'string' || !/^[a-z]{0,8}$/.test(tagPrefix)) fail('REGISTRY_VALUE', `${where}.release.tagPrefix: invalid value ${JSON.stringify(tagPrefix)}`);

  const declared = record.capabilities ?? {};
  assertKeys(`${where}.capabilities`, declared, [], Object.keys(CAPABILITY_VALUES));
  const capabilities = { ...KIND_DEFAULTS[record.kind], ...declared };
  for (const [name, allowed] of Object.entries(CAPABILITY_VALUES)) {
    assertEnum(`${where}.capabilities.${name}`, capabilities[name], allowed);
  }
  if (capabilities.completion === 'automatic' && !AUTOMATIC_COMPLETION_STRATEGIES.includes(record.completion)) {
    fail('REGISTRY_VALUE', `${where}: capabilities.completion "automatic" contradicts completion "${record.completion}"`
      + ` (the completion engine implements ${AUTOMATIC_COMPLETION_STRATEGIES.join(' | ')})`);
  }
  const completionRunner = record.completionRunner ?? 'repository';
  assertEnum(`${where}.completionRunner`, completionRunner, COMPLETION_RUNNERS);
  if (completionRunner === 'org-sweep' && (record.kind === 'meta' || capabilities.completion !== 'automatic')) {
    fail('REGISTRY_VALUE', `${where}: completionRunner org-sweep needs capabilities.completion "automatic" on a code or docs repository`);
  }

  const deepFreeze = value => (value && typeof value === 'object' ? Object.freeze(value) : value);
  return Object.freeze({
    repository: record.repository,
    kind: record.kind,
    visibility: record.visibility,
    owner: record.owner,
    branches: deepFreeze({
      default: record.branches.default,
      integration: record.branches.integration,
      promotion: record.branches.promotion ?? null,
    }),
    deploymentProfile: record.deploymentProfile,
    completion: record.completion,
    completionRunner,
    // present only for deployment-receipt, so the other profiles keep their exact shape
    ...(productionEvidence ? { productionEvidence: deepFreeze(productionEvidence) } : {}),
    protection: record.protection,
    requiredChecks: deepFreeze([...record.requiredChecks]),
    release: deepFreeze({ strategy: record.release.strategy, trigger, tagPrefix }),
    capabilities: deepFreeze(capabilities),
  });
}

export function validateRegistry(document) {
  assertKeys('registry', document, ['schemaVersion', 'standardVersion', 'project', 'repositories']);
  if (document.schemaVersion !== 1) fail('REGISTRY_VALUE', `schemaVersion: expected 1, got ${JSON.stringify(document.schemaVersion)}`);
  assertString('standardVersion', document.standardVersion, /^v[1-9]\d*$/);
  assertKeys('project', document.project, ['number', 'statuses']);
  if (!Number.isInteger(document.project.number) || document.project.number <= 0) {
    fail('REGISTRY_VALUE', 'project.number must be a positive integer');
  }
  if (!Array.isArray(document.project.statuses) || !document.project.statuses.length) {
    fail('REGISTRY_SCHEMA', 'project.statuses must be a non-empty sequence');
  }
  document.project.statuses.forEach((status, i) => assertString(`project.statuses[${i}]`, status));
  if (new Set(document.project.statuses).size !== document.project.statuses.length) {
    fail('REGISTRY_VALUE', 'project.statuses: duplicate status');
  }
  if (!Array.isArray(document.repositories) || !document.repositories.length) {
    fail('REGISTRY_SCHEMA', 'repositories must be a non-empty sequence');
  }
  const seen = new Set();
  const repositories = document.repositories.map((record, index) => {
    const profile = normalizeRepository(record, index);
    if (seen.has(profile.repository.toLowerCase())) fail('REGISTRY_DUPLICATE', `repository "${profile.repository}" is listed twice`);
    seen.add(profile.repository.toLowerCase());
    return profile;
  });
  return Object.freeze({
    schemaVersion: 1,
    standardVersion: document.standardVersion,
    project: Object.freeze({ number: document.project.number, statuses: Object.freeze([...document.project.statuses]) }),
    repositories: Object.freeze(repositories),
  });
}

// ---------------------------------------------------------------------------
// Loading and queries
// ---------------------------------------------------------------------------

let cachedDefault = null;

export function loadRegistry({ path = REGISTRY_PATH, text = null } = {}) {
  const useCache = text === null && path === REGISTRY_PATH;
  if (useCache && cachedDefault) return cachedDefault;
  let source = text;
  if (source === null) {
    try { source = readFileSync(path, 'utf8'); }
    catch (error) { fail('REGISTRY_UNREADABLE', `${path}: ${error.code ?? error.message}`); }
  }
  const registry = validateRegistry(parseYamlSubset(source));
  if (useCache) cachedDefault = registry;
  return registry;
}

// Returns the profile, or null when the repository is not registered (fail closed at the caller).
export function getRepositoryProfile(fullName, registry = loadRegistry()) {
  if (typeof fullName !== 'string') return null;
  const wanted = fullName.toLowerCase();
  return registry.repositories.find(profile => profile.repository.toLowerCase() === wanted) ?? null;
}

export function requireRepositoryProfile(fullName, registry = loadRegistry()) {
  const profile = getRepositoryProfile(fullName, registry);
  if (!profile) fail('UNKNOWN_REPOSITORY', `${fullName} is not listed in workflow-registry.yaml`);
  return profile;
}

// Full names of registered repositories, optionally narrowed by kind and by a capability value list.
export function listRepositories({ kinds = null, capability = null, values = null } = {}, registry = loadRegistry()) {
  if (capability !== null && !Object.hasOwn(CAPABILITY_VALUES, capability)) {
    fail('REGISTRY_VALUE', `unknown capability "${capability}"`);
  }
  return registry.repositories
    .filter(profile => !kinds || kinds.includes(profile.kind))
    .filter(profile => capability === null || (values ?? CAPABILITY_VALUES[capability].filter(v => v !== 'off'))
      .includes(profile.capabilities[capability]))
    .map(profile => profile.repository);
}

export const integrationBranch = (fullName, registry) => requireRepositoryProfile(fullName, registry).branches.integration;

export function main(argv = process.argv.slice(2), stdout = process.stdout, stderr = process.stderr) {
  const validate = argv.includes('--validate');
  const fileIndex = argv.indexOf('--file');
  const unknown = argv.filter((arg, i) => arg !== '--validate' && arg !== '--file' && i !== fileIndex + 1);
  if (!validate || unknown.length || (fileIndex !== -1 && !argv[fileIndex + 1])) {
    stderr.write('usage: node automation/registry.mjs --validate [--file <path>]\n');
    return 2;
  }
  try {
    const registry = loadRegistry(fileIndex === -1 ? {} : { path: argv[fileIndex + 1] });
    stdout.write(`REGISTRY OK: ${registry.repositories.length} repositories, standard ${registry.standardVersion}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    stderr.write(`REGISTRY INVALID: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
