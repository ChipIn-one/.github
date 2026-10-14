// Read-only GitHub transport routing for canonical ChipIn admission.
// This module never reads credential stores or extracts `gh` tokens.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export class PreflightError extends Error {
  constructor(code, { principal, transport, capability, remedy } = {}) {
    super(code);
    this.name = 'PreflightError';
    this.code = code;
    this.diagnostic = { code, principal: principal ?? 'unknown', transport: transport ?? 'unknown',
      capability: capability ?? 'canonical-issue-admission', remedy: remedy ?? 'Contact the admission routing owner.' };
  }
}

function error(code, transport, capability, remedy) {
  return new PreflightError(code, { principal: transport === 'gh' ? 'existing-gh-session' : 'approved-read-credential', transport, capability, remedy });
}

// The API adapter is intentionally restricted to REST GET and GraphQL query.
export class GhReadClient {
  constructor({ run = exec, timeoutMs = 20_000, maxBuffer = 4 * 1024 * 1024 } = {}) {
    this.run = run;
    this.timeoutMs = timeoutMs;
    this.maxBuffer = maxBuffer;
  }
  async call(args, capability) {
    try {
      const result = await this.run('gh', ['api', ...args], { timeout: this.timeoutMs, maxBuffer: this.maxBuffer });
      const value = JSON.parse(result.stdout);
      if (!value || typeof value !== 'object') throw Error('invalid JSON');
      return value;
    } catch (cause) {
      // Never forward stdout/stderr: gh can embed API response data and secrets.
      const status = cause?.code;
      if (status === 'ENOENT') throw error('AUTH_UNAVAILABLE', 'gh', capability, 'Use an already-authorized gh session or the trusted producer route.');
      if (String(cause?.stderr ?? '').includes('HTTP 404')) throw error('NOT_FOUND', 'gh', capability, 'Canonical optional resource absent.');
      if (String(cause?.stderr ?? '').includes('HTTP 401') || String(cause?.stderr ?? '').includes('HTTP 403')) {
        throw error('PERMISSION_DENIED', 'gh', capability, 'Approved principal must have org Issue Fields, native Issue and Project #5 read access.');
      }
      throw error('TRANSPORT_ERROR', 'gh', capability, 'Check the existing gh session and network; do not provision a new secret in Executor.');
    }
  }
  async request(path, { method = 'GET', body, allow404 = false } = {}) {
    if (method !== 'GET' || body !== undefined || !/^\/(repos|orgs)\/[A-Za-z0-9_.\-/]+(?:\?.*)?$/.test(path)) {
      throw error('READ_ONLY_VIOLATION', 'gh', 'REST GET', 'Mutation and unsupported API routes are forbidden.');
    }
    try { return await this.call([path, '--method', 'GET'], path.split('?')[0]); }
    catch (e) { if (allow404 && e.code === 'NOT_FOUND') return null; throw e; }
  }
  async listAll(path) {
    const items = [];
    const separator = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 100; page++) {
      const chunk = await this.request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(chunk)) throw error('SCHEMA_UNREADABLE', 'gh', 'REST pagination', 'Check native/org API readability.');
      items.push(...chunk);
      if (chunk.length < 100) return items;
    }
    throw error('PAGINATION_LIMIT', 'gh', 'REST pagination', 'Resolve bounded pagination before proceeding.');
  }
  async graphql(query, variables = {}) {
    if (!/^\s*query\s+[\w]+\s*\(/.test(query) || /\bmutation\b/i.test(query)) {
      throw error('READ_ONLY_VIOLATION', 'gh', 'GraphQL query', 'Only pinned canonical read queries are accepted.');
    }
    const args = ['graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key)) throw error('INVALID_REQUEST', 'gh', 'GraphQL variables', 'Use canonical query variables.');
      if (value == null) continue;
      if (typeof value === 'number' && Number.isInteger(value)) args.push('-F', `${key}=${value}`);
      else if (typeof value === 'string') args.push('-f', `${key}=${value}`);
      else throw error('INVALID_REQUEST', 'gh', 'GraphQL variables', 'Unsupported GraphQL variable type.');
    }
    const payload = await this.call(args, 'organization Project #5 GraphQL');
    if (payload.errors?.length || !payload.data) throw error('PROJECT_UNREADABLE', 'gh', 'organization Project #5 GraphQL', 'Check approved Project read rights and canonical schema.');
    return payload.data;
  }
}

// Deterministic priority. A present but unauthorized explicit credential is not silently
// downgraded to a different principal; absence falls through to existing gh auth.
export function selectDirectTransport({ token, makeTokenClient, makeGhClient = () => new GhReadClient() } = {}) {
  if (typeof token === 'string' && token.length) {
    if (!makeTokenClient) throw error('INVALID_REQUEST', 'token', 'client factory', 'Inject the canonical GitHubClient constructor.');
    return { transport: 'token', principal: 'approved-read-credential', client: makeTokenClient(token) };
  }
  return { transport: 'gh', principal: 'existing-gh-session', client: makeGhClient() };
}

export function safeAdmissionDiagnostics(blockers, principal, transport) {
  const values = Array.isArray(blockers) ? blockers : [];
  return values.map(b => {
    const s = String(b);
    const code = /401|403|permission|forbidden/i.test(s) ? 'PERMISSION_DENIED'
      : /Organization schema unreadable|Issue field .*missing|Issue Type .*missing/i.test(s) ? 'SCHEMA_UNREADABLE'
      : /Project.*unreadable|Project .*unavailable/i.test(s) ? 'PROJECT_UNREADABLE'
      : /STALE|revision changed|read-back failed/i.test(s) ? 'STALE_REVISION'
      : /Native Issue unreadable/i.test(s) ? 'NATIVE_ISSUE_UNREADABLE'
      : 'INVALID_METADATA';
    return { code, principal, transport, capability: code === 'PROJECT_UNREADABLE' ? 'Project #5' : 'canonical admission',
      remedy: code === 'STALE_REVISION' ? 'Obtain a fresh full canonical read-back.'
        : code === 'INVALID_METADATA' ? 'Use canonical issue-intake owner; Executor must not repair metadata.'
        : 'Confirm existing principal can read org Issue Fields, native Issue and Project #5.' };
  });
}

export async function retryTransient(task, { maxAttempts = 3, maxTotalMs = 30_000,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 ||
      !Number.isInteger(maxTotalMs) || maxTotalMs < 1 || maxTotalMs > 30_000) {
    throw new PreflightError('INVALID_RETRY_BUDGET');
  }
  const deadline = now() + maxTotalMs;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await task(); }
    catch (err) {
      if (err?.code !== 'TRANSPORT_ERROR') throw err;
      const remaining = deadline - now();
      if (attempt === maxAttempts || remaining <= 0) throw new PreflightError('RETRY_EXHAUSTED', {
        principal: 'approved-read-credential', transport: 'read-only', capability: 'canonical API reads',
        remedy: 'Check network/transport availability and start a new bounded preflight.' });
      await pause(Math.min(250 * attempt, remaining));
    }
  }
}
