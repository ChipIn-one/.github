import assert from 'node:assert/strict';
import test from 'node:test';

import { readAdmission, verifyAdmission } from './issue-admission.mjs';
import { run as runIntake } from './issue-intake.mjs';
import { safeAdmissionDiagnostics } from './issue-admission-transport.mjs';
import {
  BLOCKED_BY_DEPENDENCY, COMMENT_MARKER, GitHubNativeStore, appendDeclarations, declare, dependencyBlockers,
  main, nativeEdges, normalizeIssue, parseDeclarations, parseIssueRef, planIssue, reconcile, renderComment,
} from './relationships.mjs';

const FE = 'ChipIn-one/chipin-frontend';
const BE = 'ChipIn-one/chipin-backend';
const KB = 'ChipIn-one/chipin-knowledge-base';
const META = 'ChipIn-one/.github';
const OUT = 'ChipIn-one/chipin-notifications'; // not in the registry

// In-memory GitHub: the store interface the planner uses. Edges are kept once, as GitHub does.
class MemoryStore {
  constructor() { this.issues = new Map(); this.blockedBy = new Set(); this.relates = new Set(); this.parents = new Map();
    this.comments = new Map(); this.calls = []; this.dropWrites = false; this.failAdd = null; this.nextId = 1; this.mutateBodyOnRead = null; }
  add(ref, { state = 'open', body = '' } = {}) {
    const { repository, number } = parseIssueRef(ref);
    this.issues.set(ref, { id: `N${this.nextId++}`, ref, repository, number, state, body });
    return ref;
  }
  view(ref) {
    const base = this.issues.get(ref);
    if (!base) return null;
    const asRef = r => ({ id: this.issues.get(r).id, ref: r, state: this.issues.get(r).state });
    const lists = { blockedBy: [], blocking: [], relatesTo: [] };
    for (const key of this.blockedBy) {
      const [issue, blocker] = key.split('>');
      if (issue === ref) lists.blockedBy.push(asRef(blocker));
      if (blocker === ref) lists.blocking.push(asRef(issue));
    }
    for (const key of this.relates) {
      const [a, b] = key.split('<>');
      if (a === ref) lists.relatesTo.push(asRef(b));
      if (b === ref) lists.relatesTo.push(asRef(a));
    }
    return { ...base, updatedAt: 't', ...lists, parent: this.parents.has(ref) ? asRef(this.parents.get(ref)) : null, truncated: false };
  }
  async fetchIssue(ref) { this.calls.push(['fetch', ref]); return this.view(ref); }
  async listOpen(repository) { return [...this.issues.keys()].filter(r => this.issues.get(r).repository === repository && this.issues.get(r).state === 'open').map(r => this.view(r)); }
  async addEdge(edge) {
    this.calls.push(['add', edge.key]);
    if (this.failAdd && this.failAdd(edge)) throw new Error('boom');
    if (this.dropWrites) return;
    if (edge.type === 'blocked_by') this.blockedBy.add(`${edge.issue}>${edge.blocker}`);
    else if (edge.type === 'relates_to') this.relates.add(`${edge.a}<>${edge.b}`);
    else this.parents.set(edge.child, edge.parent);
  }
  async readBody(ref) {
    if (this.mutateBodyOnRead) { this.issues.get(ref).body += this.mutateBodyOnRead; this.mutateBodyOnRead = null; }
    return { body: this.issues.get(ref).body, state: this.issues.get(ref).state };
  }
  async writeBody(ref, body) { this.calls.push(['body', ref]); this.issues.get(ref).body = body; }
  async upsertComment(ref, text) {
    this.calls.push(['comment', ref]);
    const had = this.comments.has(ref);
    this.comments.set(ref, text);
    return had ? 'updated' : 'created';
  }
  async hasComment(ref) { return this.comments.has(ref); }
  writes() { return this.calls.filter(c => ['add', 'body', 'comment'].includes(c[0])); }
  adds() { return this.calls.filter(c => c[0] === 'add'); }
}
const deps = (...lines) => `## Problem\nx\n\n## Dependencies\n\n${lines.join('\n')}\n\n## References\n\nBlocked by: ${FE}#999\n`;
const find = (receipt, ref) => receipt.issues.find(e => e.issue === ref);

test('declarations: strict lines inside ## Dependencies only', () => {
  const body = [
    '## Problem', 'Blocked by: ChipIn-one/chipin-backend#1', '',
    '## Dependencies', '',
    `Blocked by: ${BE}#143`, `- Relates to: ${BE}#157`, `* Blocks: ${FE}#7`, `Parent: ${KB}#40`,
    'Blocked by WS1 (docs skeleton). Relates to #15.', '```', `Blocked by: ${BE}#555`, '```', '',
    '## References', `Blocked by: ${BE}#2`,
  ].join('\n');
  const parsed = parseDeclarations(body);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.declarations, [
    { kind: 'blocked_by', target: `${BE}#143` }, { kind: 'relates_to', target: `${BE}#157` },
    { kind: 'blocks', target: `${FE}#7` }, { kind: 'parent', target: `${KB}#40` },
  ]);
});

test('declarations: malformed, duplicate, multi-target and URL forms are errors, not edges', () => {
  const parsed = parseDeclarations(`## Dependencies\nBlocked by: #123\nBlocked by: https://github.com/${BE}/issues/5\nBlocked by: ${BE}#1, ${BE}#2\nBlocks: ${FE}#3\nBlocks: ${FE}#3\nParent: ${KB}#1\nParent: ${KB}#2\n`);
  assert.equal(parsed.errors.filter(e => /Malformed/.test(e)).length, 3);
  assert.equal(parsed.errors.filter(e => /Duplicate/.test(e)).length, 1);
  assert.equal(parsed.errors.filter(e => /Multiple "Parent:"/.test(e)).length, 1);
  assert.match(parseDeclarations('## Dependencies\n\n## Dependencies\n').errors[0], /multiple/);
  assert.deepEqual(parseDeclarations('no sections').declarations, []);
  assert.throws(() => parseIssueRef('ChipIn-one/x#0'), /exactly owner\/repo#number/);
  assert.throws(() => parseIssueRef('other/x#1'), /exactly owner\/repo#number/);
});

test('appendDeclarations adds only missing lines, keeps everything else, is idempotent', () => {
  const body = `## Problem\nHello\n\n## Dependencies\n\nSome prose.\n\n## References\nref\n`;
  const once = appendDeclarations(body, [`Blocked by: ${BE}#1`]);
  assert.equal(once, `## Problem\nHello\n\n## Dependencies\n\nSome prose.\nBlocked by: ${BE}#1\n\n## References\nref\n`);
  assert.equal(appendDeclarations(once, [`Blocked by: ${BE}#1`]), once);
  assert.equal(appendDeclarations('Intro', [`Parent: ${KB}#1`]), `Intro\n\n## Dependencies\n\nParent: ${KB}#1\n`);
  assert.equal(appendDeclarations('', [`Parent: ${KB}#1`]), `## Dependencies\n\nParent: ${KB}#1\n`);
  assert.throws(() => appendDeclarations('## Dependencies\n## Dependencies\n', ['Parent: ' + KB + '#1']), /multiple/);
});

test('blocker gate: open or unreadable blockers fail; closed pass; only for relationships: required', () => {
  const snap = state => ({ relationsReadable: true, blockedBy: [{ repository: BE, number: 7, state }] });
  assert.deepEqual(dependencyBlockers(snap('closed'), FE), []);
  const open = dependencyBlockers(snap('open'), FE);
  assert.equal(open.length, 1);
  assert.match(open[0], new RegExp(`^${BLOCKED_BY_DEPENDENCY}: ${BE}#7 is open`));
  assert.equal(dependencyBlockers(snap(undefined), BE).length, 1);
  assert.equal(dependencyBlockers({ relationsReadable: true, blockedBy: [] }, KB).length, 0);
  assert.deepEqual(dependencyBlockers(snap('open'), OUT), []);
  assert.deepEqual(dependencyBlockers({ relationsReadable: false, blockedBy: [] }, FE), []);
  assert.equal(safeAdmissionDiagnostics(open, 'p', 't')[0].code, BLOCKED_BY_DEPENDENCY);
  assert.match(safeAdmissionDiagnostics(open, 'p', 't')[0].remedy, /Close the blocking Issue/);
});

// --- admission integration ---------------------------------------------------------------------
const config = {
  organization: 'ChipIn-one',
  project: { number: 5, statusField: 'Status', statusValues: ['Backlog', 'Todo', 'In Progress', 'Awaiting release', 'Done'] },
  issueFields: { Priority: { id: 1, options: ['P0', 'P1', 'P2', 'P3'] }, Severity: { id: 2, options: ['Critical', 'Major', 'Minor'] } },
  issueTypes: { Task: 10, Feature: 11, Bug: 12 },
};
const BODY = '## Problem\nTask has a defined problem with measurable user impact.\n\n## Outcome\nThe requested change is delivered and can be inspected.\n\n## Acceptance\n- [ ] The output is verified against requirements.';
const UPDATED_AT = new Date().toISOString(); // fixed: admission compares the revision across two reads
const snapshotWith = blockedBy => ({
  issue: { number: 71, node_id: 'ID', title: 'Complete durable task issue', body: BODY, updated_at: UPDATED_AT,
    repository_url: `https://api.github.com/repos/${FE}`, type: { name: 'Task' }, assignees: [{ login: 'syllik' }],
    html_url: 'x', state: 'open', state_reason: null, milestone: null },
  issueFieldValues: [{ issue_field_id: 1, single_select_option: { name: 'P1' } }],
  relationsReadable: true, blockedBy, blocking: [], parent: null, subIssues: [],
});
const projectSnapshot = () => ({
  id: 'P', fields: [
    { name: 'Priority', isIssueField: true, issueField: { fullDatabaseId: '1', name: 'Priority' } },
    { name: 'Severity', isIssueField: true, issueField: { fullDatabaseId: '2', name: 'Severity' } },
    { name: 'Status', isIssueField: false, options: config.project.statusValues.map(name => ({ name })) }],
  items: [{ id: 'I', repository: FE, number: 71, status: 'Todo' }],
});
const admit = blockedBy => readAdmission({ client: {}, config, repository: FE, number: 71, selectedOwner: null, overrides: {
  readOrgSchema: async () => [], readProjectSnapshot: async () => projectSnapshot(), readIssueSnapshot: async () => snapshotWith(blockedBy) } });

test('admission fails with BLOCKED_BY_DEPENDENCY while a blocker is open and passes once it is closed', async () => {
  const blocked = await admit([{ repository: BE, number: 143, state: 'open' }]);
  assert.equal(blocked.receipt.status, 'BLOCKED');
  assert.match(blocked.blockers.join('\n'), /BLOCKED_BY_DEPENDENCY: ChipIn-one\/chipin-backend#143 is open/);
  const clear = await admit([{ repository: BE, number: 143, state: 'closed' }]);
  assert.equal(clear.receipt.status, 'INTAKE_COMPLETE');
  assert.equal((await admit([])).receipt.status, 'INTAKE_COMPLETE');
});

test('intake completeness (verifyAdmission without the execution gate) ignores open blockers', () => {
  const result = verifyAdmission({ config, repository: FE, number: 71, snapshot: snapshotWith([{ repository: BE, number: 1, state: 'open' }]), project: projectSnapshot() });
  assert.equal(result.receipt.status, 'INTAKE_COMPLETE');
});

// --- reconcile ---------------------------------------------------------------------------------
test('reconcile adds declared edges of every kind, directions are correct, rerun writes nothing', async () => {
  const s = new MemoryStore();
  const fe = s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`, `Relates to: ${BE}#3`, `Parent: ${KB}#4`, `Blocks: ${FE}#5`) });
  const be2 = s.add(`${BE}#2`); const be3 = s.add(`${BE}#3`); const kb4 = s.add(`${KB}#4`); const fe5 = s.add(`${FE}#5`);
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.equal(receipt.outcome, 'OK');
  assert.ok(s.blockedBy.has(`${fe}>${be2}`), 'FE blocked by BE');
  assert.ok(s.blockedBy.has(`${fe5}>${fe}`), 'Blocks: makes the target blocked by the declaring Issue');
  assert.equal(s.relates.size, 1);
  assert.equal(s.parents.get(fe), kb4);
  assert.equal(find(receipt, fe).status, 'APPLIED');
  assert.ok(be3);
  const before = s.writes().length;
  const second = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.equal(s.writes().length, before, 'second run performs 0 writes');
  assert.equal(find(second, fe).status, 'CLEAN');
});

test('plan mode never writes; apply of a clean registry is a no-op', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`) }); s.add(`${BE}#2`);
  const plan = await reconcile({ store: s, mode: 'plan' });
  assert.equal(find(plan, `${FE}#1`).status, 'PLANNED');
  assert.deepEqual(find(plan, `${FE}#1`).add, [`blocked_by|${FE}#1|${BE}#2`]);
  assert.equal(s.writes().length, 0);
});

test('native edges without a declaration are kept and written back as lines, never removed', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: '## Problem\nx\n' }); s.add(`${BE}#2`, { body: '## Problem\ny\n' });
  s.blockedBy.add(`${FE}#1>${BE}#2`);
  s.add(`${KB}#9`, { body: '' }); s.parents.set(`${FE}#1`, `${KB}#9`);
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.match(s.issues.get(`${FE}#1`).body, /## Dependencies\n\nBlocked by: ChipIn-one\/chipin-backend#2\nParent: ChipIn-one\/chipin-knowledge-base#9\n$/);
  assert.match(s.issues.get(`${BE}#2`).body, /Blocks: ChipIn-one\/chipin-frontend#1/);
  assert.equal(s.blockedBy.size, 1);
  assert.equal(s.parents.size, 1);
  assert.deepEqual(find(receipt, `${FE}#1`).textAppended.sort(), [`Blocked by: ${BE}#2`, `Parent: ${KB}#9`]);
  const again = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.equal(find(again, `${FE}#1`).status, 'CLEAN');
});

test('text sync can be disabled', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: 'x' }); s.add(`${BE}#2`); s.blockedBy.add(`${FE}#1>${BE}#2`);
  await reconcile({ store: s, mode: 'apply', notify: false, writeText: false });
  assert.equal(s.issues.get(`${FE}#1`).body, 'x');
});

test('negative: missing target, self-link, unregistered target, closed target', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#404`) });
  s.add(`${FE}#2`, { body: deps(`Blocked by: ${FE}#2`) });
  s.add(`${FE}#3`, { body: deps(`Relates to: ${OUT}#1`) }); s.add(`${OUT}#1`);
  s.add(`${FE}#4`, { body: deps(`Blocked by: ${BE}#5`) }); s.add(`${BE}#5`, { state: 'closed' });
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.match(find(receipt, `${FE}#1`).blockers[0], /does not exist/);
  assert.match(find(receipt, `${FE}#2`).blockers[0], /Self-reference/);
  assert.match(find(receipt, `${FE}#3`).blockers[0], /outside the registry/);
  assert.match(find(receipt, `${FE}#4`).blockers[0], /Closed target/);
  for (const n of [1, 2, 3, 4]) assert.equal(find(receipt, `${FE}#${n}`).status, 'BLOCKED');
  assert.equal(s.adds().length, 0, 'no partial writes');
  assert.equal(receipt.outcome, 'ATTENTION');
});

test('negative: duplicate declaration blocks all edges of that Issue', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`, `Relates to: ${BE}#3`, `Blocked by: ${BE}#2`) }); s.add(`${BE}#2`); s.add(`${BE}#3`);
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.match(find(receipt, `${FE}#1`).blockers[0], /Duplicate/);
  assert.equal(s.adds().length, 0);
});

test('negative: cycles — direct reversal, contradictory declarations, transitive', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`) }); s.add(`${BE}#2`);
  s.blockedBy.add(`${BE}#2>${FE}#1`); // BE#2 is already blocked by FE#1 natively
  s.add(`${FE}#3`, { body: deps(`Blocked by: ${BE}#4`, `Blocks: ${BE}#4`) }); s.add(`${BE}#4`);
  s.add(`${FE}#5`, { body: deps(`Blocked by: ${BE}#6`) }); s.add(`${BE}#6`); s.add(`${KB}#7`);
  s.blockedBy.add(`${BE}#6>${KB}#7`); s.blockedBy.add(`${KB}#7>${FE}#5`);
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  for (const n of [1, 3, 5]) {
    assert.equal(find(receipt, `${FE}#${n}`).status, 'BLOCKED');
    assert.match(find(receipt, `${FE}#${n}`).blockers[0], /Cycle/);
  }
  assert.equal(s.adds().length, 0);
  assert.ok(!s.blockedBy.has(`${FE}#1>${BE}#2`), 'reversal is never written');
});

test('negative: conflicting parent is never re-parented; parent cycle blocks', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Parent: ${KB}#2`) }); s.add(`${KB}#2`); s.add(`${KB}#3`);
  s.parents.set(`${FE}#1`, `${KB}#3`);
  s.add(`${KB}#4`, { body: deps(`Parent: ${FE}#5`) }); s.add(`${FE}#5`); s.parents.set(`${FE}#5`, `${KB}#4`);
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.match(find(receipt, `${FE}#1`).blockers[0], /Conflicting parent/);
  assert.match(find(receipt, `${KB}#4`).blockers[0], /Cycle/);
  assert.equal(s.parents.get(`${FE}#1`), `${KB}#3`);
  assert.equal(s.adds().length, 0);
});

test('read-back mismatch and write failure surface as FAILED, with no silent success', async () => {
  const dropped = new MemoryStore();
  dropped.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`) }); dropped.add(`${BE}#2`);
  dropped.dropWrites = true;
  const receipt = await reconcile({ store: dropped, mode: 'apply', notify: false });
  assert.equal(find(receipt, `${FE}#1`).status, 'FAILED');
  assert.match(find(receipt, `${FE}#1`).blockers[0], /READBACK_MISMATCH/);
  assert.equal(receipt.outcome, 'FAILED');

  const failing = new MemoryStore();
  failing.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`) }); failing.add(`${BE}#2`);
  failing.failAdd = () => true;
  const failed = await reconcile({ store: failing, mode: 'apply', notify: false });
  assert.match(find(failed, `${FE}#1`).blockers[0], /Write failed/);
  assert.equal(failed.outcome, 'FAILED');
});

test('stale body is never overwritten by text sync', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: 'x' }); s.add(`${BE}#2`); s.blockedBy.add(`${FE}#1>${BE}#2`);
  s.mutateBodyOnRead = '\nhuman edit';
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.match(find(receipt, `${FE}#1`).textSkipped, /STALE_TEXT/);
  assert.equal(s.issues.get(`${FE}#1`).body, 'x\nhuman edit');
});

test('blocked Issues get exactly one upserted comment; resolved afterwards; clean Issues get none', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#404`) }); s.add(`${FE}#2`, { body: 'plain' });
  await reconcile({ store: s, mode: 'apply' });
  await reconcile({ store: s, mode: 'apply' });
  assert.equal(s.calls.filter(c => c[0] === 'comment').length, 2, 'upsert, not append, one comment slot per Issue');
  assert.equal(s.comments.size, 1);
  assert.ok(s.comments.get(`${FE}#1`).startsWith(COMMENT_MARKER));
  s.issues.get(`${FE}#1`).body = 'plain';
  await reconcile({ store: s, mode: 'apply' });
  assert.match(s.comments.get(`${FE}#1`), /Resolved/);
  assert.match(renderComment(`${FE}#1`, ['x']), /never removes, inverts or re-parents/);
});

test('reconcile never closes Issues or touches Status: the store has no such operation', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`) }); s.add(`${BE}#2`);
  await reconcile({ store: s, mode: 'apply', notify: false });
  assert.equal(s.issues.get(`${FE}#1`).state, 'open');
  assert.deepEqual([...new Set(s.calls.map(c => c[0]))].sort(), ['add', 'body', 'fetch'].filter(k => s.calls.some(c => c[0] === k)));
  s.issues.get(`${BE}#2`).state = 'closed';
  const afterClose = await reconcile({ store: s, mode: 'apply', notify: false });
  assert.equal(s.issues.get(`${FE}#1`).state, 'open', 'closing a blocker changes nothing on the blocked Issue');
  assert.equal(find(afterClose, `${FE}#1`).status, 'CLEAN');
});

test('unreadable repository listing is a failure, not a clean result', async () => {
  const s = new MemoryStore();
  s.listOpen = async () => { throw new Error('403'); };
  const receipt = await reconcile({ store: s, mode: 'plan', repositories: [FE] });
  assert.equal(receipt.outcome, 'FAILED');
  assert.equal(receipt.issues[0].status, 'UNREADABLE');
});

test('truncated native relationships block instead of guessing', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: 'x' });
  const node = { ...s.view(`${FE}#1`), truncated: true };
  const plan = await planIssue(node, { get: async () => null });
  assert.match(plan.blockers[0], /exceed/);
  const normalized = normalizeIssue({ id: 'A', number: 1, state: 'OPEN', repository: { nameWithOwner: FE }, blockedBy: { totalCount: 60, nodes: [] } });
  assert.equal(normalized.truncated, true);
});

test('declare: validates first, writes edges then the lines, reads back', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: '## Problem\nx\n' }); s.add(`${BE}#2`);
  const planned = await declare({ store: s, issue: `${FE}#1`, additions: [{ kind: 'blocked_by', target: `${BE}#2` }], apply: false });
  assert.deepEqual(planned.add, [`blocked_by|${FE}#1|${BE}#2`]);
  assert.equal(s.writes().length, 0);
  const done = await declare({ store: s, issue: `${FE}#1`, additions: [{ kind: 'blocked_by', target: `${BE}#2` }], apply: true });
  assert.deepEqual(done.blockers, []);
  assert.equal(done.bodyUpdated, true);
  assert.ok(s.blockedBy.has(`${FE}#1>${BE}#2`));
  assert.match(s.issues.get(`${FE}#1`).body, /Blocked by: ChipIn-one\/chipin-backend#2/);
  const bad = await declare({ store: s, issue: `${FE}#1`, additions: [{ kind: 'blocked_by', target: `${BE}#404` }], apply: true });
  assert.match(bad.blockers[0], /does not exist/);
  assert.equal(s.issues.get(`${FE}#1`).body.includes('#404'), false, 'blocked declare writes no lines');
});

// --- native store over GraphQL ------------------------------------------------------------------
test('GitHubNativeStore: reads normalized Issues and sends correctly oriented mutations', async () => {
  const calls = [];
  const node = (number, extra = {}) => ({ id: `ID${number}`, number, state: 'OPEN', body: 'b', updatedAt: 't', repository: { nameWithOwner: FE },
    blockedBy: { totalCount: 1, nodes: [{ id: 'B1', number: 9, state: 'CLOSED', repository: { nameWithOwner: BE } }] },
    blocking: { totalCount: 0, nodes: [] }, relatesTo: { totalCount: 0, nodes: [] }, parent: null, ...extra });
  const client = {
    graphql: async (query, variables) => {
      calls.push({ query, variables });
      if (/RelList/.test(query)) {
        return variables.after ? { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [node(2)] } } }
          : { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node(1)] } } };
      }
      return { repository: { issue: node(variables.number) } };
    },
  };
  const store = new GitHubNativeStore(client);
  const open = await store.listOpen(FE);
  assert.deepEqual(open.map(i => i.ref), [`${FE}#1`, `${FE}#2`]);
  assert.deepEqual(open[0].blockedBy, [{ id: 'B1', ref: `${BE}#9`, state: 'closed' }]);
  assert.deepEqual(nativeEdges(open[0]).map(e => e.key), [`blocked_by|${FE}#1|${BE}#9`]);
  const one = await store.fetchIssue(`${FE}#7`);
  assert.equal(one.number, 7);
  assert.deepEqual(calls.at(-1).variables, { owner: 'ChipIn-one', name: 'chipin-frontend', number: 7 });

  const ids = { [`${FE}#1`]: 'A', [`${BE}#2`]: 'B', [`${KB}#3`]: 'K' };
  await store.addEdge({ type: 'blocked_by', issue: `${FE}#1`, blocker: `${BE}#2` }, ids);
  assert.match(calls.at(-1).query, /addBlockedBy\(input: \{ issueId: \$a, blockingIssueId: \$b \}\)/);
  assert.deepEqual(calls.at(-1).variables, { a: 'A', b: 'B' });
  await store.addEdge({ type: 'parent', child: `${FE}#1`, parent: `${KB}#3` }, ids);
  assert.match(calls.at(-1).query, /addSubIssue\(input: \{ issueId: \$a, subIssueId: \$b, replaceParent: false \}\)/);
  assert.deepEqual(calls.at(-1).variables, { a: 'K', b: 'A' }, 'issueId is the parent, subIssueId the child');
  await store.addEdge({ type: 'relates_to', a: `${BE}#2`, b: `${FE}#1` }, ids);
  assert.match(calls.at(-1).query, /addRelatesTo/);
  assert.equal(calls.every(c => !/remove|delete/i.test(c.query)), true, 'no removal mutation is ever issued');
});

test('GitHubNativeStore retries transient failures only', async () => {
  let attempts = 0;
  const store = new GitHubNativeStore({ graphql: async () => { attempts += 1; if (attempts < 3) throw new Error('GraphQL -> 502'); return { repository: { issue: null } }; } }, { pause: async () => {} });
  assert.equal(await store.fetchIssue(`${FE}#1`), null);
  assert.equal(attempts, 3);
  let denied = 0;
  const strict = new GitHubNativeStore({ graphql: async () => { denied += 1; throw new Error('GraphQL -> 403 forbidden'); } }, { pause: async () => {} });
  await assert.rejects(strict.fetchIssue(`${FE}#1`), /403/);
  assert.equal(denied, 1);
});

test('GitHubNativeStore comments: one marker comment is updated in place', async () => {
  const requests = [];
  const client = {
    listAll: async () => [{ id: 11, body: `${COMMENT_MARKER}\nold` }],
    request: async (path, options) => { requests.push([path, options?.method]); return {}; },
  };
  const store = new GitHubNativeStore(client);
  assert.equal(await store.upsertComment(`${FE}#1`, `${COMMENT_MARKER}\nnew`), 'updated');
  assert.deepEqual(requests, [[`/repos/${FE}/issues/comments/11`, 'PATCH']]);
  assert.equal(await store.hasComment(`${FE}#1`), true);
});

// --- CLI and intake --------------------------------------------------------------------------------
test('CLI: apply needs explicit activation; plan prints a receipt and sets no failure exit', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Blocked by: ${BE}#2`) }); s.add(`${BE}#2`);
  const saved = process.exitCode;
  await assert.rejects(main(['reconcile', '--apply'], {}, { store: s }), /NOT_ACTIVATED/);
  await assert.rejects(main(['reconcile', '--apply', '--activate', 'relationships-v1'], {}, { store: s }), /NOT_ACTIVATED/);
  let written = null;
  const receipt = await main(['reconcile', '--repository', FE, '--output', 'r.json'], {}, { store: s, writeFile: async (p, text) => { written = [p, JSON.parse(text)]; } });
  assert.equal(receipt.mode, 'plan');
  assert.equal(written[1].issues[0].status, 'PLANNED');
  assert.equal(s.writes().length, 0);
  await assert.rejects(main(['reconcile', '--wat'], {}, { store: s }), /unknown argument/);
  await assert.rejects(main(['declare'], {}, { store: s }), /needs --issue/);
  const applied = await main(['reconcile', '--repository', FE, '--apply', '--activate', 'relationships-v1', '--output', 'r.json'],
    { CHIPIN_RELATIONSHIPS_WRITE: '1' }, { store: s, writeFile: async () => {} });
  assert.equal(applied.outcome, 'OK');
  assert.ok(s.blockedBy.has(`${FE}#1>${BE}#2`));
  process.exitCode = saved;
});

test('intake: relationship flags are create-only and refs are validated', async () => {
  await assert.rejects(runIntake(['plan', 'reconcile', `${FE}#1`, '--type', 'Task', '--priority', 'P1', '--blocked-by', `${BE}#2`], {}, {}), /only with create/);
  await assert.rejects(runIntake(['plan', 'create', FE, '--type', 'Task', '--priority', 'P1', '--parent', 'nope'], {}, {}), /exactly owner\/repo#number/);
});

test('META repository can be a relationship target (relationships: required) for process epics', async () => {
  const s = new MemoryStore();
  s.add(`${FE}#1`, { body: deps(`Parent: ${META}#149`) }); s.add(`${META}#149`);
  const receipt = await reconcile({ store: s, mode: 'apply', notify: false, repositories: [FE] });
  assert.equal(find(receipt, `${FE}#1`).status, 'APPLIED');
  assert.equal(s.parents.get(`${FE}#1`), `${META}#149`);
});
