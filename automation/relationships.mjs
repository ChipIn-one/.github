#!/usr/bin/env node
// Native Issue relationship contract: declarations -> add-only reconcile -> read-back, plus the
// read-only blocker gate. Spec: docs/workflow/relationships.md. Single writer of native edges.
//
// Invariants: edges are only ever ADDED (never removed, inverted or re-parented); an Issue whose
// plan has any blocker gets no writes at all; every write is read back; Issues are never closed
// and Project Status is never touched.
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { GitHubClient } from './github-metadata.mjs';
import { getRepositoryProfile, listRepositories, loadRegistry } from './registry.mjs';

export const RELATIONSHIPS_CONTRACT = 'chipin-relationships/v1';
export const BLOCKED_BY_DEPENDENCY = 'BLOCKED_BY_DEPENDENCY';
export const COMMENT_MARKER = '<!-- chipin:relationships:v1 -->';
export const ACTIVATION = 'relationships-v1';

const REF = /^(ChipIn-one\/[A-Za-z0-9._-]+)#([1-9]\d*)$/;
const DECLARATION = /^(?:[-*]\s+)?(Blocked by|Blocks|Relates to|Parent):\s*(.*?)\s*$/i;
const KIND_OF = { 'blocked by': 'blocked_by', blocks: 'blocks', 'relates to': 'relates_to', parent: 'parent' };
const LABEL_OF = { blocked_by: 'Blocked by', blocks: 'Blocks', relates_to: 'Relates to', parent: 'Parent' };
const MAX_GRAPH_NODES = 200;
const MAX_CONNECTION = 50;

export class RelationshipError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'RelationshipError';
    this.code = code;
  }
}

export function parseIssueRef(value) {
  const match = REF.exec(String(value ?? '').trim());
  if (!match) throw new RelationshipError('INVALID_REF', `"${value}" is not exactly owner/repo#number`);
  return { repository: match[1], number: Number(match[2]), canonical: `${match[1]}#${match[2]}` };
}

// ---------------------------------------------------------------------------
// Declarations in the "## Dependencies" section
// ---------------------------------------------------------------------------

const HEADING = /^#{1,6}\s+(.*?)\s*#*\s*$/;

function locateSection(lines) {
  const starts = [];
  lines.forEach((line, i) => { if (/^#{2,3}\s+Dependencies\s*$/i.test(line)) starts.push(i); });
  if (starts.length > 1) return { error: 'multiple "## Dependencies" sections' };
  if (!starts.length) return { start: -1, end: -1 };
  let end = lines.length;
  let fence = false;
  for (let i = starts[0] + 1; i < lines.length; i += 1) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    else if (!fence && HEADING.test(lines[i])) { end = i; break; }
  }
  return { start: starts[0], end };
}

export function parseDeclarations(body) {
  const lines = String(body ?? '').split(/\r?\n/);
  const section = locateSection(lines);
  const result = { declarations: [], errors: [] };
  if (section.error) { result.errors.push(section.error); return result; }
  if (section.start < 0) return result;
  const seen = new Set();
  let fence = false;
  for (let i = section.start + 1; i < section.end; i += 1) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const match = DECLARATION.exec(line.trim());
    if (!match) continue;
    const kind = KIND_OF[match[1].toLowerCase()];
    let target;
    try { target = parseIssueRef(match[2]); }
    catch { result.errors.push(`Malformed declaration "${line.trim()}": target must be exactly one owner/repo#number`); continue; }
    const key = `${kind}|${target.canonical}`;
    if (seen.has(key)) { result.errors.push(`Duplicate declaration "${LABEL_OF[kind]}: ${target.canonical}"`); continue; }
    seen.add(key);
    result.declarations.push({ kind, target: target.canonical });
  }
  if (result.declarations.filter(d => d.kind === 'parent').length > 1) {
    result.errors.push('Multiple "Parent:" declarations; an Issue has at most one parent');
  }
  return result;
}

// The body without its well-formed declaration lines: every line inside the single "## Dependencies"
// section (outside code fences) that parseDeclarations reads as a declaration with a valid target in a
// registry repository is dropped; every other byte stays. Malformed declarations and targets outside the
// registry stay (they are not relationship data the automation writes). Returns
// null when the section is ambiguous (several "## Dependencies" headings), so callers can fail closed.
// Used by the completion scope rule (.github#223): a body revision that differs only in these lines is a
// relationship edit (intake/reconciler mirror), not a scope change.
export function stripDeclarationLines(body, registry = loadRegistry()) {
  const lines = String(body ?? '').split(/\r?\n/);
  const section = locateSection(lines);
  if (section.error) return null;
  if (section.start < 0) return lines.join('\n');
  const kept = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (i <= section.start || i >= section.end) { kept.push(line); return; }
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; kept.push(line); return; }
    const match = fence ? null : DECLARATION.exec(line.trim());
    if (match) {
      let target = null;
      try { target = parseIssueRef(match[2]); } catch { /* malformed: keep the line */ }
      if (target && getRepositoryProfile(target.repository, registry) !== null) return;
    }
    kept.push(line);
  });
  return kept.join('\n');
}

export const renderDeclaration = (kind, target) => `${LABEL_OF[kind]}: ${target}`;

// Adds missing declaration lines to "## Dependencies" (creating it at the end); nothing else changes.
export function appendDeclarations(body, additions) {
  const text = String(body ?? '');
  const existing = new Set(parseDeclarations(text).declarations.map(d => renderDeclaration(d.kind, d.target)));
  const fresh = additions.filter(a => !existing.has(a));
  if (!fresh.length) return text;
  const lines = text.split(/\r?\n/);
  const section = locateSection(lines);
  if (section.error) throw new RelationshipError('AMBIGUOUS_BODY', section.error);
  if (section.start < 0) {
    return `${text.replace(/\s+$/, '')}${text.trim() ? '\n\n' : ''}## Dependencies\n\n${fresh.join('\n')}\n`;
  }
  let at = section.end;
  while (at > section.start + 1 && lines[at - 1].trim() === '') at -= 1;
  lines.splice(at, 0, ...fresh);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

const blockedEdge = (issue, blocker) => ({ type: 'blocked_by', issue, blocker, key: `blocked_by|${issue}|${blocker}` });
const relatesEdge = (x, y) => {
  const [a, b] = [x, y].sort();
  return { type: 'relates_to', a, b, key: `relates_to|${a}|${b}` };
};
const parentEdge = (child, parent) => ({ type: 'parent', child, parent, key: `parent|${child}|${parent}` });

export function declaredEdges(self, declarations) {
  return declarations.map(({ kind, target }) => {
    if (kind === 'blocked_by') return blockedEdge(self, target);
    if (kind === 'blocks') return blockedEdge(target, self);
    if (kind === 'relates_to') return relatesEdge(self, target);
    return parentEdge(self, target);
  });
}

export function nativeEdges(node) {
  return [
    ...node.blockedBy.map(x => blockedEdge(node.ref, x.ref)),
    ...node.blocking.map(x => blockedEdge(x.ref, node.ref)),
    ...node.relatesTo.map(x => relatesEdge(node.ref, x.ref)),
    ...(node.parent ? [parentEdge(node.ref, node.parent.ref)] : []),
  ];
}

// Declaration line that expresses `edge` from the point of view of `self` (null if self is not an end).
function lineFor(edge, self) {
  if (edge.type === 'blocked_by') {
    if (edge.issue === self) return renderDeclaration('blocked_by', edge.blocker);
    if (edge.blocker === self) return renderDeclaration('blocks', edge.issue);
  } else if (edge.type === 'relates_to') {
    if (edge.a === self) return renderDeclaration('relates_to', edge.b);
    if (edge.b === self) return renderDeclaration('relates_to', edge.a);
  } else if (edge.child === self) {
    return renderDeclaration('parent', edge.parent);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Blocker gate (read-only)
// ---------------------------------------------------------------------------

// Admission blockers for a snapshot of `repository` (relationships: required). Any blocker whose
// state is not positively `closed` blocks, including unreadable ones.
export function dependencyBlockers(snapshot, repository, registry = loadRegistry()) {
  const profile = getRepositoryProfile(repository, registry);
  if (profile?.capabilities.relationships !== 'required') return [];
  if (snapshot?.relationsReadable !== true) return [];
  return (snapshot.blockedBy ?? [])
    .filter(item => item?.state !== 'closed')
    .map(item => `${BLOCKED_BY_DEPENDENCY}: ${item?.repository ?? 'unknown'}#${item?.number ?? '?'} is ${item?.state ?? 'unreadable'}; close it or have a human remove the native edge.`);
}

// ---------------------------------------------------------------------------
// Native store (GraphQL) — everything the planner needs, behind a small interface
// ---------------------------------------------------------------------------

const ISSUE_FIELDS = `
  id number state body updatedAt repository { nameWithOwner }
  blockedBy(first: ${MAX_CONNECTION}) { totalCount nodes { id number state repository { nameWithOwner } } }
  blocking(first: ${MAX_CONNECTION}) { totalCount nodes { id number state repository { nameWithOwner } } }
  relatesTo(first: ${MAX_CONNECTION}) { totalCount nodes { id number state repository { nameWithOwner } } }
  parent { id number state repository { nameWithOwner } }`;
const ONE_QUERY = `query Rel($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { issue(number: $number) { ${ISSUE_FIELDS} } } }`;
const LIST_QUERY = `query RelList($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 50, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${ISSUE_FIELDS} } } } }`;
const MUTATIONS = {
  blocked_by: 'mutation($a: ID!, $b: ID!) { addBlockedBy(input: { issueId: $a, blockingIssueId: $b }) { issue { id } } }',
  relates_to: 'mutation($a: ID!, $b: ID!) { addRelatesTo(input: { issueId: $a, relatedIssueId: $b }) { issue { id } } }',
  parent: 'mutation($a: ID!, $b: ID!) { addSubIssue(input: { issueId: $a, subIssueId: $b, replaceParent: false }) { issue { id } } }',
};

const toRef = node => (node ? { id: node.id, ref: `${node.repository.nameWithOwner}#${node.number}`, state: String(node.state).toLowerCase() } : null);

export function normalizeIssue(node) {
  if (!node) return null;
  const connections = ['blockedBy', 'blocking', 'relatesTo'];
  const truncated = connections.some(name => (node[name]?.totalCount ?? 0) > (node[name]?.nodes?.length ?? 0));
  return {
    id: node.id,
    ref: `${node.repository.nameWithOwner}#${node.number}`,
    repository: node.repository.nameWithOwner,
    number: node.number,
    state: String(node.state).toLowerCase(),
    body: node.body ?? '',
    updatedAt: node.updatedAt ?? null,
    blockedBy: (node.blockedBy?.nodes ?? []).filter(Boolean).map(toRef),
    blocking: (node.blocking?.nodes ?? []).filter(Boolean).map(toRef),
    relatesTo: (node.relatesTo?.nodes ?? []).filter(Boolean).map(toRef),
    parent: toRef(node.parent),
    truncated,
  };
}

const TRANSIENT = /\b(502|503|504|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timeout|timed out|rate limit|secondary)\b/i;
async function retrying(task, { attempts = 3, pause = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  for (let i = 1; ; i += 1) {
    try { return await task(); }
    catch (error) {
      if (i >= attempts || !TRANSIENT.test(String(error?.message))) throw error;
      await pause(500 * i);
    }
  }
}

export class GitHubNativeStore {
  constructor(client, { pause } = {}) { this.client = client; this.pause = pause; }
  async fetchIssue(ref) {
    const { repository, number } = parseIssueRef(ref);
    const [owner, name] = repository.split('/');
    const data = await retrying(() => this.client.graphql(ONE_QUERY, { owner, name, number }), { pause: this.pause });
    return normalizeIssue(data?.repository?.issue ?? null);
  }
  async listOpen(repository) {
    const [owner, name] = repository.split('/');
    const issues = [];
    let after = null;
    for (;;) {
      const data = await retrying(() => this.client.graphql(LIST_QUERY, { owner, name, after }), { pause: this.pause });
      const page = data?.repository?.issues;
      if (!page?.pageInfo || !Array.isArray(page.nodes)) throw new RelationshipError('UNREADABLE', `open Issues of ${repository}`);
      issues.push(...page.nodes.filter(Boolean).map(normalizeIssue));
      if (!page.pageInfo.hasNextPage) return issues;
      after = page.pageInfo.endCursor;
    }
  }
  async addEdge(edge, ids) {
    const variables = edge.type === 'blocked_by' ? { a: ids[edge.issue], b: ids[edge.blocker] }
      : edge.type === 'relates_to' ? { a: ids[edge.a], b: ids[edge.b] }
      : { a: ids[edge.parent], b: ids[edge.child] };
    await retrying(() => this.client.graphql(MUTATIONS[edge.type], variables), { pause: this.pause });
  }
  async readBody(ref) {
    const { repository, number } = parseIssueRef(ref);
    const issue = await this.client.request(`/repos/${repository}/issues/${number}`);
    return { body: issue?.body ?? '', state: issue?.state ?? null };
  }
  async writeBody(ref, body) {
    const { repository, number } = parseIssueRef(ref);
    await this.client.request(`/repos/${repository}/issues/${number}`, { method: 'PATCH', body: { body } });
  }
  async upsertComment(ref, text) {
    const { repository, number } = parseIssueRef(ref);
    const comments = await this.client.listAll(`/repos/${repository}/issues/${number}/comments`);
    const own = comments.find(c => String(c?.body ?? '').startsWith(COMMENT_MARKER));
    if (own) {
      if (own.body !== text) await this.client.request(`/repos/${repository}/issues/comments/${own.id}`, { method: 'PATCH', body: { body: text } });
      return 'updated';
    }
    await this.client.request(`/repos/${repository}/issues/${number}/comments`, { method: 'POST', body: { body: text } });
    return 'created';
  }
  async hasComment(ref) {
    const { repository, number } = parseIssueRef(ref);
    const comments = await this.client.listAll(`/repos/${repository}/issues/${number}/comments`);
    return comments.some(c => String(c?.body ?? '').startsWith(COMMENT_MARKER));
  }
}

// Caches reads for one planning pass; `invalidate()` forces fresh reads (used for read-back).
class Reader {
  constructor(store) { this.store = store; this.cache = new Map(); }
  async get(ref) {
    if (!this.cache.has(ref)) this.cache.set(ref, await this.store.fetchIssue(ref));
    return this.cache.get(ref);
  }
  prime(node) { this.cache.set(node.ref, node); }
  invalidate() { this.cache.clear(); }
}

// ---------------------------------------------------------------------------
// Planning (pure over the store)
// ---------------------------------------------------------------------------

const inScope = (ref, registry) => {
  const profile = getRepositoryProfile(parseIssueRef(ref).repository, registry);
  return profile !== null && profile.capabilities.relationships === 'required';
};

// Does `from` reach `to` by following `follow(node) -> refs`, over native edges plus planned overlay?
async function reaches(reader, from, to, follow, overlay = new Map()) {
  const seen = new Set();
  const queue = [from];
  while (queue.length) {
    const ref = queue.shift();
    if (ref === to) return true;
    if (seen.has(ref)) continue;
    if (seen.size >= MAX_GRAPH_NODES) throw new RelationshipError('GRAPH_TOO_LARGE', `more than ${MAX_GRAPH_NODES} Issues to verify acyclicity from ${from}`);
    seen.add(ref);
    const node = await reader.get(ref);
    if (!node) continue;
    if (node.truncated) throw new RelationshipError('UNREADABLE', `relationships of ${ref} exceed ${MAX_CONNECTION} per kind`);
    queue.push(...follow(node), ...(overlay.get(ref) ?? []));
  }
  return false;
}

export async function planIssue(node, reader, registry = loadRegistry()) {
  const plan = { issue: node.ref, blockers: [], add: [], textLines: [], declared: [], bodyBase: node.body };
  const parsed = parseDeclarations(node.body);
  plan.blockers.push(...parsed.errors);
  plan.declared = parsed.declarations.map(d => renderDeclaration(d.kind, d.target));
  if (node.truncated) plan.blockers.push(`Native relationships of ${node.ref} exceed ${MAX_CONNECTION} per kind; cannot verify.`);

  const declared = declaredEdges(node.ref, parsed.declarations);
  const native = new Set(nativeEdges(node).map(e => e.key));
  const targets = new Map();
  const unusable = new Set();
  for (const { kind, target } of parsed.declarations) {
    if (target === node.ref) { plan.blockers.push(`Self-reference: ${LABEL_OF[kind]}: ${target}`); unusable.add(target); continue; }
    if (!inScope(target, registry)) { plan.blockers.push(`Target ${target} is outside the registry or has relationships off.`); unusable.add(target); continue; }
    let found;
    try { found = await reader.get(target); }
    catch (error) { plan.blockers.push(`Target ${target} is unreadable: ${error.message}`); unusable.add(target); continue; }
    if (!found) { plan.blockers.push(`Target ${target} does not exist or is not visible.`); unusable.add(target); continue; }
    targets.set(target, found);
  }

  const overlay = new Map(); // issue -> extra blockers added by this plan, so contradictory declarations form a cycle
  const parentOverlay = new Map();
  for (const edge of declared) {
    if (native.has(edge.key)) continue;
    const other = [edge.issue, edge.blocker, edge.a, edge.b, edge.child, edge.parent].find(r => r && r !== node.ref);
    if (!other || unusable.has(other)) continue;
    const target = targets.get(other);
    if (edge.type === 'blocked_by' && target.state !== 'open') {
      plan.blockers.push(`Closed target ${other}: a new blocked-by edge to a closed Issue is meaningless.`);
      continue;
    }
    try {
      if (edge.type === 'blocked_by') {
        // cycle: the blocker (transitively) already waits on the blocked issue
        if (await reaches(reader, edge.blocker, edge.issue, n => n.blockedBy.map(x => x.ref), overlay)) {
          plan.blockers.push(`Cycle: ${edge.issue} blocked by ${edge.blocker} would close a dependency loop or reverse an existing edge.`);
          continue;
        }
        overlay.set(edge.issue, [...(overlay.get(edge.issue) ?? []), edge.blocker]);
      } else if (edge.type === 'parent') {
        if (node.parent && node.parent.ref !== edge.parent) {
          plan.blockers.push(`Conflicting parent: ${node.ref} already has parent ${node.parent.ref}; re-parenting needs an explicit human correction.`);
          continue;
        }
        if (await reaches(reader, edge.parent, edge.child, n => (n.parent ? [n.parent.ref] : []), parentOverlay)) {
          plan.blockers.push(`Cycle: ${edge.child} cannot be a sub-issue of its own descendant ${edge.parent}.`);
          continue;
        }
        parentOverlay.set(edge.child, [edge.parent]);
      }
    } catch (error) { plan.blockers.push(`Cannot verify ${edge.key}: ${error.message}`); continue; }
    plan.add.push(edge);
  }
  if (plan.blockers.length) plan.add = []; // an Issue with any blocker gets no writes

  // native -> text: native edges that the body does not declare
  const declaredKeys = new Set(declared.map(e => e.key));
  const lines = new Set();
  for (const edge of nativeEdges(node)) {
    if (declaredKeys.has(edge.key)) continue;
    const line = lineFor(edge, node.ref);
    if (line) lines.add(line);
  }
  plan.textLines = [...lines];
  return plan;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export async function applyPlan(plan, node, { store, reader, writeText = true }) {
  const result = { added: [], textAppended: [], textSkipped: null, blockers: [] };
  if (plan.blockers.length) return result;
  if (plan.add.length) {
    const ids = {};
    for (const edge of plan.add) {
      for (const ref of [edge.issue, edge.blocker, edge.a, edge.b, edge.child, edge.parent].filter(Boolean)) {
        const found = ref === node.ref ? node : await reader.get(ref);
        if (!found?.id) { result.blockers.push(`Node id of ${ref} is unavailable; no relationship was written.`); return result; }
        ids[ref] = found.id;
      }
    }
    for (const edge of plan.add) {
      try { await store.addEdge(edge, ids); result.added.push(edge.key); }
      catch (error) { result.blockers.push(`Write failed for ${edge.key}: ${error.message}`); }
    }
    reader.invalidate();
    const after = await reader.get(node.ref);
    const present = new Set(nativeEdges(after).map(e => e.key));
    for (const edge of plan.add) {
      if (!present.has(edge.key)) result.blockers.push(`READBACK_MISMATCH: ${edge.key} is not present after the write.`);
    }
  }
  if (writeText && plan.textLines.length && !result.blockers.length) {
    const current = await store.readBody(node.ref);
    if (current.body !== plan.bodyBase) {
      result.textSkipped = 'STALE_TEXT: the Issue body changed since it was read; retried by the next run.';
    } else {
      const next = appendDeclarations(current.body, plan.textLines);
      if (next !== current.body) {
        await store.writeBody(node.ref, next);
        const verify = await store.readBody(node.ref);
        const have = new Set(parseDeclarations(verify.body).declarations.map(d => renderDeclaration(d.kind, d.target)));
        const missing = plan.textLines.filter(line => !have.has(line));
        if (missing.length) result.blockers.push(`READBACK_MISMATCH: declaration lines not present after body update: ${missing.join(', ')}`);
        else result.textAppended.push(...plan.textLines);
      }
    }
  }
  return result;
}

export function renderComment(ref, blockers) {
  if (!blockers.length) return `${COMMENT_MARKER}\n### Relationships\n\nResolved: the declared relationships of this Issue are consistent with native GitHub state.\n`;
  return `${COMMENT_MARKER}\n### Relationships — BLOCKED\n\nNo relationship was written for ${ref}. Fix the declaration in \`## Dependencies\` (or the conflicting native edge) and the next reconcile run will retry:\n\n${blockers.map(b => `- ${b}`).join('\n')}\n\nThe reconciler only adds edges; it never removes, inverts or re-parents them, never closes Issues and never changes Project Status.\n`;
}

export async function reconcile({ store, registry = loadRegistry(), mode = 'plan', repositories = null, writeText = true, notify = true, textOnly = false }) {
  const scope = (repositories ?? listRepositories({ capability: 'relationships' }, registry));
  const receipt = {
    schemaVersion: 1, contract: RELATIONSHIPS_CONTRACT, mode, generatedAt: new Date().toISOString(),
    standardVersion: registry.standardVersion, repositories: scope, issues: [],
    summary: { examined: 0, clean: 0, planned: 0, applied: 0, blocked: 0, failures: 0 },
  };
  for (const repository of scope) {
    const reader = new Reader(store);
    let open;
    try { open = await store.listOpen(repository); }
    catch (error) {
      receipt.summary.failures += 1;
      receipt.issues.push({ issue: repository, status: 'UNREADABLE', blockers: [error.message] });
      continue;
    }
    for (const node of open) reader.prime(node);
    for (const node of open) {
      receipt.summary.examined += 1;
      const entry = { issue: node.ref, status: 'CLEAN', declared: [], add: [], textLines: [], blockers: [] };
      receipt.issues.push(entry);
      try {
        const plan = await planIssue(node, reader, registry);
        if (textOnly) plan.add = [];
        entry.declared = plan.declared;
        entry.add = plan.add.map(e => e.key);
        entry.textLines = writeText ? plan.textLines : [];
        entry.blockers = [...plan.blockers];
        if (plan.blockers.length) entry.status = 'BLOCKED';
        else if (plan.add.length || (writeText && plan.textLines.length)) entry.status = 'PLANNED';
        if (mode === 'apply') {
          const applied = await applyPlan(plan, node, { store, reader, writeText });
          entry.added = applied.added;
          entry.textAppended = applied.textAppended;
          if (applied.textSkipped) entry.textSkipped = applied.textSkipped;
          if (applied.blockers.length) { entry.blockers.push(...applied.blockers); entry.status = 'FAILED'; }
          else if (entry.status === 'PLANNED') entry.status = 'APPLIED';
          if (notify && (entry.blockers.length || await store.hasComment(node.ref))) {
            await store.upsertComment(node.ref, renderComment(node.ref, entry.blockers));
          }
        }
      } catch (error) {
        entry.status = 'FAILED';
        entry.blockers.push(error.message);
      }
      const key = { CLEAN: 'clean', PLANNED: 'planned', APPLIED: 'applied', BLOCKED: 'blocked', FAILED: 'failures' }[entry.status];
      receipt.summary[key] += 1;
    }
  }
  // Edges just added make the other endpoints' bodies stale: mirror them in the same run so a rerun is a no-op.
  if (mode === 'apply' && writeText && !textOnly && receipt.issues.some(e => e.added?.length)) {
    const mirror = await reconcile({ store, registry, mode, repositories: scope, writeText, notify: false, textOnly: true });
    receipt.mirror = mirror.issues.filter(e => e.textAppended?.length || e.status === 'FAILED')
      .map(e => ({ issue: e.issue, status: e.status, textAppended: e.textAppended ?? [], blockers: e.blockers }));
    receipt.summary.failures += mirror.summary.failures;
  }
  receipt.outcome = receipt.summary.failures ? 'FAILED' : receipt.summary.blocked ? 'ATTENTION' : 'OK';
  return receipt;
}

// Declare edges for one Issue in one apply: validates everything first, writes edges, then the lines.
export async function declare({ store, registry = loadRegistry(), issue, additions, apply = false }) {
  const self = parseIssueRef(issue).canonical;
  const reader = new Reader(store);
  const node = await reader.get(self);
  if (!node) throw new RelationshipError('MISSING_ISSUE', `${self} does not exist or is not visible`);
  const lines = additions.map(({ kind, target }) => renderDeclaration(kind, parseIssueRef(target).canonical));
  const body = appendDeclarations(node.body, lines);
  const hypothetical = { ...node, body };
  const plan = await planIssue(hypothetical, reader, registry);
  const out = { schemaVersion: 1, contract: RELATIONSHIPS_CONTRACT, issue: self, mode: apply ? 'apply' : 'plan',
    lines, add: plan.add.map(e => e.key), blockers: [...plan.blockers], added: [], bodyUpdated: false };
  if (plan.blockers.length || !apply) return out;
  const applied = await applyPlan({ ...plan, textLines: [], bodyBase: node.body }, node, { store, reader, writeText: false });
  out.added = applied.added;
  out.blockers.push(...applied.blockers);
  if (out.blockers.length) return out;
  if (body !== node.body) {
    const current = await store.readBody(self);
    if (current.body !== node.body) { out.blockers.push('STALE_TEXT: the Issue body changed during declare; rerun.'); return out; }
    await store.writeBody(self, body);
    const verify = await store.readBody(self);
    const have = new Set(parseDeclarations(verify.body).declarations.map(d => renderDeclaration(d.kind, d.target)));
    const missing = lines.filter(line => !have.has(line));
    if (missing.length) out.blockers.push(`READBACK_MISMATCH: declaration lines not present: ${missing.join(', ')}`);
    else out.bodyUpdated = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { command: argv[0], issue: null, additions: [], apply: false, activate: null, output: null, repositories: [], textSync: true };
  const kinds = { '--blocked-by': 'blocked_by', '--blocks': 'blocks', '--relates-to': 'relates_to', '--parent': 'parent' };
  const rest = argv.slice(1);
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--apply') args.apply = true;
    else if (flag === '--no-text-sync') args.textSync = false;
    else if (kinds[flag]) args.additions.push({ kind: kinds[flag], target: rest[++i] });
    else if (flag === '--issue') args.issue = rest[++i];
    else if (flag === '--repository') args.repositories.push(rest[++i]);
    else if (flag === '--activate') args.activate = rest[++i];
    else if (flag === '--output') args.output = rest[++i];
    else throw new RelationshipError('USAGE', `unknown argument ${flag}`);
  }
  if (!['reconcile', 'declare'].includes(args.command)) throw new RelationshipError('USAGE', 'first argument must be reconcile or declare');
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env, overrides = {}) {
  const args = parseCliArgs(argv);
  if (args.apply && (args.activate !== ACTIVATION || env.CHIPIN_RELATIONSHIPS_WRITE !== '1')) {
    throw new RelationshipError('NOT_ACTIVATED', `apply requires --activate ${ACTIVATION} and CHIPIN_RELATIONSHIPS_WRITE=1`);
  }
  const store = overrides.store ?? new GitHubNativeStore(new GitHubClient(env.GITHUB_TOKEN));
  let result;
  if (args.command === 'reconcile') {
    result = await reconcile({ store, mode: args.apply ? 'apply' : 'plan', repositories: args.repositories.length ? args.repositories : null, writeText: args.textSync });
    process.exitCode = result.outcome === 'FAILED' ? 2 : 0;
    for (const entry of result.issues.filter(e => e.status === 'BLOCKED' || e.status === 'FAILED')) {
      process.stdout.write(`::warning title=Relationships ${entry.status}::${entry.issue}: ${entry.blockers.join(' | ').slice(0, 400)}\n`);
    }
  } else {
    if (!args.issue || !args.additions.length) throw new RelationshipError('USAGE', 'declare needs --issue and at least one edge flag');
    result = await declare({ store, issue: args.issue, additions: args.additions, apply: args.apply });
    process.exitCode = result.blockers.length ? 2 : 0;
  }
  const text = JSON.stringify(result, null, 2) + '\n';
  if (args.output) await (overrides.writeFile ?? writeFile)(args.output, text, { mode: 0o600 });
  else process.stdout.write(text);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`RELATIONSHIPS BLOCKED: ${error.message}\n`);
    process.exitCode = 2;
  });
}
