import assert from 'node:assert/strict';
import test from 'node:test';

import { readAdmission, verifyAdmission } from './issue-admission.mjs';
import { blockerProjectStatus, readIssueSnapshot } from './github-metadata.mjs';
import { run as runIntake } from './issue-intake.mjs';
import { safeAdmissionDiagnostics } from './issue-admission-transport.mjs';
import {
  BLOCKED_BY_DEPENDENCY, COMMENT_MARKER, GitHubNativeStore, appendDeclarations, declare, dependencyBlockers,
  main, nativeEdges, normalizeIssue, parseDeclarations, parseIssueRef, planIssue, reconcile, renderComment,
  stripDeclarationLines,
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
  assert.match(safeAdmissionDiagnostics(open, 'p', 't')[0].remedy, /closed or open with Project #5 Status Awaiting release\/Done/);
  assert.match(safeAdmissionDiagnostics(open, 'p', 't')[0].remedy, /Executor must not edit relationships/);
});

// .github#307: an open blocker whose Project #5 Status is Awaiting release or Done is satisfied.
const blocker = (state, projectStatus, projectStatusError = null) => ({ repository: FE, number: 490, state, projectStatus, projectStatusError });
const gate = (...items) => dependencyBlockers({ relationsReadable: true, blockedBy: items }, FE);

test('blocker gate (.github#307): closed passes whatever its Project Status', () => {
  assert.deepEqual(gate(blocker('closed', 'Done')), []);
  assert.deepEqual(gate(blocker('closed', null, 'unreadable: x')), []);
  assert.deepEqual(gate(blocker('closed', 'Todo')), []);
});

test('blocker gate (.github#307): open + Awaiting release or Done passes', () => {
  assert.deepEqual(gate(blocker('open', 'Awaiting release')), []);
  assert.deepEqual(gate(blocker('open', 'Done')), []);
});

test('blocker gate (.github#307): open + Todo / In Progress / Backlog blocks with the Status in the diagnostic', () => {
  for (const status of ['Todo', 'In Progress', 'Backlog', 'awaiting release', 'Awaiting Release ']) {
    const [line, ...rest] = gate(blocker('open', status));
    assert.equal(rest.length, 0);
    assert.equal(line, `${BLOCKED_BY_DEPENDENCY}: ${FE}#490 is open (Project #5 Status: ${status}); it must be closed or in Awaiting release/Done, or a human removes the native edge.`);
  }
});

test('blocker gate (.github#307): open without a Project #5 item, or with several, blocks', () => {
  assert.deepEqual(gate(blocker('open', null, 'no Project #5 item')),
    [`${BLOCKED_BY_DEPENDENCY}: ${FE}#490 is open (no Project #5 item); it must be closed or in Awaiting release/Done, or a human removes the native edge.`]);
  assert.match(gate(blocker('open', null, '2 Project #5 items'))[0], /is open \(2 Project #5 items\)/);
});

test('blocker gate (.github#307): open with unreadable Status blocks; only a denied read names the token scope', () => {
  const [denied] = gate(blocker('open', null, 'unreadable: Projects read denied'));
  assert.match(denied, /^BLOCKED_BY_DEPENDENCY: ChipIn-one\/chipin-frontend#490 is open and its Project #5 Status is unreadable: Projects read denied;/);
  assert.match(denied, /lacks Projects read \(classic read:project, or fine-grained organization Projects: read\)/);
  const [other] = gate(blocker('open', null, 'unreadable: blocker Project read failed'));
  assert.match(other, /is open and its Project #5 Status is unreadable: blocker Project read failed; it must be closed/);
  assert.doesNotMatch(other, /Projects read \(/);
  // Empty Status: its own reason, no token hint, still blocks.
  assert.deepEqual(gate(blocker('open', null, 'Project #5 Status is empty')),
    [`${BLOCKED_BY_DEPENDENCY}: ${FE}#490 is open (Project #5 Status is empty); it must be closed or in Awaiting release/Done, or a human removes the native edge.`]);
  // A snapshot without the Status fields (older producer) or an error that hides a passing Status still blocks.
  assert.match(gate({ repository: FE, number: 490, state: 'open' })[0], /Project #5 Status is unreadable: Project #5 Status was not read/);
  assert.equal(gate(blocker('open', 'Done', 'unreadable: x')).length, 1);
  // Unreadable or unknown native state still blocks regardless of Status.
  assert.match(gate(blocker(undefined, 'Done'))[0], /#490 is unreadable;/);
  assert.match(gate(blocker('OPEN', 'Done'))[0], /#490 is OPEN;/);
  assert.equal(safeAdmissionDiagnostics([denied], 'p', 't')[0].code, BLOCKED_BY_DEPENDENCY);
});

test('blocker gate (.github#307): mixed blockers report only the unsatisfied ones', () => {
  const lines = dependencyBlockers({ relationsReadable: true, blockedBy: [
    { repository: FE, number: 489, state: 'closed', projectStatus: 'Done', projectStatusError: null },
    { repository: FE, number: 490, state: 'open', projectStatus: 'Awaiting release', projectStatusError: null },
    { repository: BE, number: 7, state: 'open', projectStatus: 'In Progress', projectStatusError: null },
  ] }, FE);
  assert.deepEqual(lines, [`${BLOCKED_BY_DEPENDENCY}: ${BE}#7 is open (Project #5 Status: In Progress); it must be closed or in Awaiting release/Done, or a human removes the native edge.`]);
});

// --- blocker Project Status read (github-metadata readIssueSnapshot) --------------------------
const ORG_OWNER = { __typename: 'Organization', login: 'ChipIn-one' };
const item = (status, owner = ORG_OWNER, number = 5) => ({ id: 'PVTI', project: { number, owner },
  fieldValueByName: status === undefined ? null : { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: status } });
const projectItems = (...nodes) => ({ totalCount: nodes.length, nodes });

test('blockerProjectStatus: exactly one org Project #5 item with a Status', () => {
  assert.deepEqual(blockerProjectStatus({ projectItems: projectItems(item('Awaiting release')) }, 5, 'ChipIn-one'), { projectStatus: 'Awaiting release', projectStatusError: null });
  assert.deepEqual(blockerProjectStatus({ projectItems: projectItems(item('Todo', ORG_OWNER, 3), item('Done')) }, 5, 'ChipIn-one'), { projectStatus: 'Done', projectStatusError: null });
});

test('blockerProjectStatus: other-owner same-numbered Projects never count (.github#218)', () => {
  const user = { __typename: 'User', login: 'ChipIn-one' };
  const otherOrg = { __typename: 'Organization', login: 'Elsewhere' };
  assert.deepEqual(blockerProjectStatus({ projectItems: projectItems(item('Done', user), item('Done', otherOrg)) }, 5, 'ChipIn-one'),
    { projectStatus: null, projectStatusError: 'no Project #5 item' });
  assert.deepEqual(blockerProjectStatus({ projectItems: projectItems(item('Done', otherOrg), item('Todo')) }, 5, 'ChipIn-one'),
    { projectStatus: 'Todo', projectStatusError: null });
});

test('blockerProjectStatus: missing, truncated, ambiguous or unreadable reads fail closed', () => {
  const read = node => blockerProjectStatus(node, 5, 'ChipIn-one');
  assert.deepEqual(read({ projectItems: projectItems() }), { projectStatus: null, projectStatusError: 'no Project #5 item' });
  assert.deepEqual(read({ projectItems: projectItems(item('Done'), item('Done')) }), { projectStatus: null, projectStatusError: '2 Project #5 items' });
  assert.deepEqual(read({}), { projectStatus: null, projectStatusError: 'unreadable: projectItems missing' });
  assert.deepEqual(read({ projectItems: null }), { projectStatus: null, projectStatusError: 'unreadable: projectItems missing' });
  assert.deepEqual(read({ projectItems: { totalCount: 21, nodes: [item('Done')] } }), { projectStatus: null, projectStatusError: 'unreadable: projectItems incomplete: read 1 of 21' });
  assert.deepEqual(read({ projectItems: projectItems(item('Done', null)) }), { projectStatus: null, projectStatusError: 'unreadable: Project #5 owner is unreadable' });
  assert.deepEqual(read({ projectItems: projectItems(item(undefined)) }), { projectStatus: null, projectStatusError: 'Project #5 Status is empty' });
  assert.deepEqual(read({ projectItems: projectItems({ ...item('x'), fieldValueByName: { __typename: 'ProjectV2ItemFieldTextValue' } }) }),
    { projectStatus: null, projectStatusError: 'unreadable: Status value is not a single-select option' });
});

function snapshotClient({ blockedBy = [], graphql }) {
  const calls = { graphql: 0 };
  return {
    calls,
    async request(path) {
      if (path.endsWith('/parent')) return null;
      return { number: 493, state: 'open', repository_url: `https://api.github.com/repos/${FE}` };
    },
    async listAll(path) { return path.endsWith('/dependencies/blocked_by') ? blockedBy : []; },
    async graphql(query, variables) { calls.graphql += 1; return graphql(query, variables); },
  };
}
const restBlocker = (repository, number, state) => ({ repository_url: `https://api.github.com/repos/${repository}`, number, state });
const gqlBlocker = (repository, number, items) => ({ number, repository: { nameWithOwner: repository }, projectItems: items });

const gqlAnswer = (...nodes) => () => ({ repository: { issue: { number: 493, blockedBy: { totalCount: nodes.length, nodes } } } });

test('readIssueSnapshot: one GraphQL read attaches each open blocker\'s Project #5 Status; none without open blockers', async () => {
  const none = snapshotClient({ graphql: () => { throw new Error('must not be called'); } });
  assert.deepEqual((await readIssueSnapshot(none, FE, 493)).blockedBy, []);
  assert.equal(none.calls.graphql, 0);

  let seen;
  const client = snapshotClient({
    blockedBy: [restBlocker(FE, 490, 'open'), restBlocker(FE, 489, 'closed'), restBlocker(BE, 7, 'open')],
    graphql: (query, variables) => {
      seen = { query, variables };
      return gqlAnswer(gqlBlocker(FE, 490, projectItems(item('Awaiting release'))), gqlBlocker(FE, 489, projectItems(item('Done'))),
        gqlBlocker(BE, 7, projectItems(item('Todo'))))();
    },
  });
  const snapshot = await readIssueSnapshot(client, FE, 493);
  assert.equal(client.calls.graphql, 1);
  assert.deepEqual(seen.variables, { owner: 'ChipIn-one', repo: 'chipin-frontend', number: 493 });
  assert.match(seen.query, /blockedBy\(first: 50\)[\s\S]*projectItems\(first: 20, includeArchived: false\)[\s\S]*fieldValueByName\(name: "Status"\)/);
  assert.doesNotMatch(seen.query, /includeArchived: true/, 'an archived blocker item counts as no item');
  assert.deepEqual(snapshot.blockedBy, [
    { repository: FE, number: 490, state: 'open', projectStatus: 'Awaiting release', projectStatusError: null },
    { repository: FE, number: 489, state: 'closed', projectStatus: null, projectStatusError: null },
    { repository: BE, number: 7, state: 'open', projectStatus: 'Todo', projectStatusError: null },
  ]);
  assert.deepEqual(dependencyBlockers(snapshot, FE), [`${BLOCKED_BY_DEPENDENCY}: ${BE}#7 is open (Project #5 Status: Todo); it must be closed or in Awaiting release/Done, or a human removes the native edge.`]);
});

test('readIssueSnapshot: closed-only blockers need no GraphQL read and carry no Status', async () => {
  const client = snapshotClient({ blockedBy: [restBlocker(FE, 489, 'closed')], graphql: () => { throw new Error('must not be called'); } });
  const snapshot = await readIssueSnapshot(client, FE, 493);
  assert.equal(client.calls.graphql, 0);
  assert.deepEqual(snapshot.blockedBy, [{ repository: FE, number: 489, state: 'closed', projectStatus: null, projectStatusError: null }]);
  assert.deepEqual(dependencyBlockers(snapshot, FE), []);
});

test('readIssueSnapshot: transient blocker Project read failures are rethrown, never dependency blockers', async () => {
  const rest = [restBlocker(FE, 490, 'open')];
  const transportError = Object.assign(new Error('TRANSPORT_ERROR'), { code: 'TRANSPORT_ERROR' });
  for (const failure of [new Error('GraphQL -> 502: <html>bad gateway</html>'), new Error('GraphQL -> 429: slow down'), transportError,
    Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), new Error('You have exceeded a secondary rate limit')]) {
    await assert.rejects(readIssueSnapshot(snapshotClient({ blockedBy: rest, graphql: () => { throw failure; } }), FE, 493), error => error === failure);
  }
  // Through readAdmission the rethrow is the existing fail-closed, retried "Native Issue unreadable" path.
  const result = await readAdmission({ client: snapshotClient({ blockedBy: rest, graphql: () => { throw transportError; } }), config, repository: FE, number: 493,
    overrides: { readOrgSchema: async () => [], readProjectSnapshot: async () => projectSnapshot() } });
  assert.equal(result.receipt.status, 'BLOCKED');
  assert.ok(result.blockers.includes('Native Issue unreadable: TRANSPORT_ERROR'));
  assert.ok(!result.blockers.some(line => line.startsWith(BLOCKED_BY_DEPENDENCY)));
});

test('readIssueSnapshot: denied, malformed or mismatched blocker Project reads mark open blockers unreadable with stable reasons', async () => {
  const rest = [restBlocker(FE, 490, 'open'), restBlocker(FE, 489, 'closed')];
  const read = graphql => readIssueSnapshot(snapshotClient({ blockedBy: rest, graphql }), FE, 493);
  const reasons = snapshot => snapshot.blockedBy.map(b => b.projectStatusError);
  for (const message of ['GraphQL -> 403: {"message":"Resource not accessible by integration"}', 'Resource not accessible by personal access token',
    "Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project']",
    'GraphQL -> 401: Bad credentials']) {
    const denied = await read(() => { throw new Error(message); });
    assert.deepEqual(reasons(denied), ['unreadable: Projects read denied', null]);
    assert.equal(denied.relationsReadable, true);
    const lines = dependencyBlockers(denied, FE);
    assert.equal(lines.length, 1, 'the closed blocker still passes');
    assert.match(lines[0], /#490 is open and its Project #5 Status is unreadable: Projects read denied; the admission token lacks Projects read/);
    assert.doesNotMatch(lines[0], /Resource not accessible|Bad credentials|scopes/, 'no raw error body in the diagnostic');
  }
  assert.deepEqual(reasons(await read(() => { throw Object.assign(new Error('PERMISSION_DENIED'), { code: 'PERMISSION_DENIED' }); })), ['unreadable: Projects read denied', null]);
  assert.deepEqual(reasons(await read(() => { throw new Error('Field "blockedBy" doesn\'t exist on type "Issue"'); })), ['unreadable: blocker Project read failed', null]);
  assert.deepEqual(reasons(await read(() => ({ repository: { issue: { number: 1, blockedBy: { totalCount: 0, nodes: [] } } } }))), ['unreadable: Issue identity mismatch in blocker Project read', null]);
  assert.deepEqual(reasons(await read(() => ({ repository: { issue: { number: 493 } } }))), ['unreadable: blockedBy missing in blocker Project read', null]);
  // totalCount mismatch with the REST blocker list (or a truncated GraphQL page) fails the open blockers closed.
  assert.deepEqual(reasons(await read(gqlAnswer(gqlBlocker(FE, 490, projectItems(item('Done')))))), ['unreadable: blockedBy count mismatch: GraphQL 1 of 1, REST 2', null]);
  assert.deepEqual(reasons(await read(() => ({ repository: { issue: { number: 493, blockedBy: { totalCount: 2, nodes: [gqlBlocker(FE, 490, projectItems(item('Done')))] } } } }))),
    ['unreadable: blockedBy count mismatch: GraphQL 1 of 2, REST 2', null]);
  // Join: equal counts but a different ref, or a null repository on either side, is unreadable.
  assert.deepEqual(reasons(await read(gqlAnswer(gqlBlocker(FE, 491, projectItems(item('Done'))), gqlBlocker(FE, 489, projectItems(item('Done')))))),
    ['unreadable: blocker missing from GraphQL blockedBy read', null]);
  assert.deepEqual(reasons(await read(gqlAnswer({ number: 490, repository: null, projectItems: projectItems(item('Done')) }, gqlBlocker(FE, 489, projectItems(item('Done')))))),
    ['unreadable: blocker missing from GraphQL blockedBy read', null]);
  const nullRest = await readIssueSnapshot(snapshotClient({ blockedBy: [{ repository_url: null, number: 490, state: 'open' }],
    graphql: gqlAnswer({ number: 490, repository: { nameWithOwner: null }, projectItems: projectItems(item('Done')) }) }), FE, 493);
  assert.deepEqual(reasons(nullRest), ['unreadable: blocker missing from GraphQL blockedBy read']);
  assert.equal(dependencyBlockers(nullRest, FE).length, 1);
  const otherProject = await read(gqlAnswer(gqlBlocker(FE, 490, projectItems(item('Done', { __typename: 'User', login: 'syllik' }))), gqlBlocker(FE, 489, projectItems(item('Done')))));
  assert.match(dependencyBlockers(otherProject, FE)[0], /#490 is open \(no Project #5 item\)/);
  // An archived item is not returned with includeArchived: false, so the fixture is an empty connection.
  assert.match(dependencyBlockers(await read(gqlAnswer(gqlBlocker(FE, 490, projectItems()), gqlBlocker(FE, 489, projectItems()))), FE)[0], /#490 is open \(no Project #5 item\)/);
  const empty = await read(gqlAnswer(gqlBlocker(FE, 490, projectItems(item(undefined))), gqlBlocker(FE, 489, projectItems(item('Done')))));
  assert.deepEqual(reasons(empty), ['Project #5 Status is empty', null]);
});

test('readAdmission forwards config Project number/organization to readIssueSnapshot', async () => {
  const seen = [];
  await readAdmission({ client: {}, config: { ...config, organization: 'Org-X', project: { ...config.project, number: 9 } }, repository: FE, number: 71,
    overrides: { readOrgSchema: async () => [], readProjectSnapshot: async () => projectSnapshot(),
      readIssueSnapshot: async (...args) => { seen.push(args.slice(1)); return snapshotWith([]); } } });
  assert.ok(seen.length >= 1);
  for (const args of seen) assert.deepEqual(args, [FE, 71, { projectNumber: 9, organization: 'Org-X' }]);
});

test('admission revision: an open blocker\'s Status is part of it; closed-only blockers read twice give the same one', async () => {
  const revisionWith = projectStatus => verifyAdmission({ config, repository: FE, number: 71, project: projectSnapshot(),
    snapshot: snapshotWith([{ repository: BE, number: 7, state: 'open', projectStatus, projectStatusError: null }]) }).receipt.revision;
  assert.notEqual(revisionWith('Awaiting release'), revisionWith('Done'));
  assert.notEqual(revisionWith('Todo'), revisionWith('Awaiting release'));

  const client = snapshotClient({ blockedBy: [restBlocker(BE, 7, 'closed')], graphql: () => { throw new Error('must not be called'); } });
  const revisions = [];
  for (let i = 0; i < 2; i++) {
    const native = await readIssueSnapshot(client, FE, 71);
    revisions.push(verifyAdmission({ config, repository: FE, number: 71, project: projectSnapshot(), snapshot: { ...snapshotWith(native.blockedBy) } }).receipt.revision);
  }
  assert.equal(revisions[0], revisions[1]);
  assert.equal(client.calls.graphql, 0);
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
  const released = await admit([{ repository: BE, number: 143, state: 'open', projectStatus: 'Awaiting release', projectStatusError: null }]);
  assert.equal(released.receipt.status, 'INTAKE_COMPLETE');
  const todo = await admit([{ repository: BE, number: 143, state: 'open', projectStatus: 'Todo', projectStatusError: null }]);
  assert.match(todo.blockers.join('\n'), /BLOCKED_BY_DEPENDENCY: ChipIn-one\/chipin-backend#143 is open \(Project #5 Status: Todo\)/);
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

test('stripDeclarationLines drops exactly the well-formed declarations of ## Dependencies (#223)', () => {
  const body = '## Outcome\n\nParent: ChipIn-one/.github#1\n\n## Dependencies\n\nParent: ChipIn-one/.github#177\n'
    + '- Blocks: ChipIn-one/.github#5\nRelates to: see #9\n```\nRelates to: ChipIn-one/.github#6\n```\nnote\n\n## References\n';
  assert.equal(stripDeclarationLines(body),
    '## Outcome\n\nParent: ChipIn-one/.github#1\n\n## Dependencies\n\n'
    + 'Relates to: see #9\n```\nRelates to: ChipIn-one/.github#6\n```\nnote\n\n## References\n');
  assert.equal(stripDeclarationLines('no section\r\nParent: ChipIn-one/.github#1'), 'no section\nParent: ChipIn-one/.github#1');
  assert.equal(stripDeclarationLines('## Dependencies\n\n## Dependencies\n'), null);
  // a well-formed ref to a repository outside the registry is text, not relationship data
  assert.equal(stripDeclarationLines('## Dependencies\n\nRelates to: ChipIn-one/not-in-registry#3\nParent: ChipIn-one/.github#177\n'),
    '## Dependencies\n\nRelates to: ChipIn-one/not-in-registry#3\n');
  // what the intake/reconciler mirror writes (appendDeclarations) projects back to the same body
  const base = '## Outcome\n\nx\n\n## Dependencies\n\nParent: ChipIn-one/.github#177\n\n## References\n\n- y\n';
  const mirrored = appendDeclarations(base, ['Relates to: ChipIn-one/.github#221', 'Blocks: ChipIn-one/.github#222']);
  assert.notEqual(mirrored, base);
  assert.equal(stripDeclarationLines(mirrored), stripDeclarationLines(base));
});
