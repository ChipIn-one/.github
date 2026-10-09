import assert from 'node:assert/strict';
import test from 'node:test';
import { ADMISSION_CONTRACT, assertFreshReceipt, readAdmission, requiredOwner, validateBody, verifyAdmission } from './issue-admission.mjs';
import { buildReconcilePlan, createIssue, verifyFinalState } from './issue-intake.mjs';

const config = {
  organization: 'ChipIn-one',
  project: { number: 5, statusField: 'Status', statusValues: ['Backlog', 'Todo', 'In Progress', 'Done'] },
  issueFields: { Priority: { id: 1, options: ['P0', 'P1', 'P2', 'P3'] },
    Severity: { id: 2, options: ['Critical', 'Major', 'Minor'] } },
  issueTypes: { Task: 10, Feature: 11, Bug: 12 },
};
const BODY = '## Problem\nTask has a defined problem with measurable user impact.\n\n## Outcome\nThe requested change is delivered and can be inspected.\n\n## Acceptance\n- [ ] The output is verified against requirements.';
const FE = 'ChipIn-one/chipin-frontend', BE = 'ChipIn-one/chipin-backend', KB = 'ChipIn-one/chipin-knowledge-base';
const now = () => new Date().toISOString();
function snapshot(repo = FE, type = 'Task', owners = ['syllik']) {
  return {
    issue: {
      number: 71, node_id: 'ISSUE_ID', title: 'Complete durable task issue',
      body: BODY, updated_at: now(), repository_url: 'https://api.github.com/repos/' + repo,
      type: type ? { name: type } : null, assignees: owners.map(login => ({ login })),
      html_url: 'https://github.com/' + repo + '/issues/71', state: 'open', state_reason: null, milestone: null,
    },
    issueFieldValues: [
      { issue_field_id: 1, single_select_option: { name: 'P1' } },
      ...(type === 'Bug' ? [{ issue_field_id: 2, single_select_option: { name: 'Major' } }] : []),
    ],
    relationsReadable: true, blockedBy: [], blocking: [], parent: null, subIssues: [],
  };
}
function project(repo = FE, status = 'Backlog', times = 1) {
  return {
    id: 'PROJECT_ID',
    fields: [
      { name: 'Priority', isIssueField: true, issueField: { fullDatabaseId: '1', name: 'Priority' } },
      { name: 'Severity', isIssueField: true, issueField: { fullDatabaseId: '2', name: 'Severity' } },
      { name: 'Status', isIssueField: false, options: config.project.statusValues.map(name => ({ name })) },
    ],
    items: Array.from({ length: times }, (_, i) => ({ id: 'ITEM_' + i, repository: repo, number: 71, status })),
  };
}
function check(repo = FE, snap = snapshot(repo), proj = project(repo), selectedOwner = null, more = {}) {
  return verifyAdmission({ config, repository: repo, number: 71, snapshot: snap, project: proj, selectedOwner, ...more });
}
test('FE and BE positive exact owner admission and versioned receipt', () => {
  for (const [repo, owner] of [[FE, 'syllik'], [BE, 'olegbal']]) {
    const receipt = check(repo, snapshot(repo, 'Task', [owner, 'another-human']), project(repo)).receipt;
    assert.equal(receipt.status, 'INTAKE_COMPLETE');
    assert.equal(receipt.contractVersion, ADMISSION_CONTRACT);
    assert.ok(receipt.revision.length === 64);
    assert.deepEqual(receipt.assignees, [owner, 'another-human']);
    assertFreshReceipt(receipt, { issue: repo + '#71', revision: receipt.revision });
  }
});
test('FE/BE missing required native owner never admits, but writer adds without deleting humans', () => {
  for (const [repo, owner] of [[FE, 'syllik'], [BE, 'olegbal']]) {
    const snap = snapshot(repo, 'Task', ['another-human']);
    assert.match(check(repo, snap, project(repo)).blockers.join('\n'), new RegExp(owner + ' is missing'));
    const plan = buildReconcilePlan({ config, repository: repo, number: 71,
      classification: { issueType: 'Task', priority: 'P1', severity: null }, snapshot: snap, project: project(repo) });
    assert.deepEqual(plan.operations, [{ kind: 'addAssignee', login: owner }]);
    assert.equal(plan.blockers.length, 0);
    assert.throws(() => requiredOwner(repo, 'incorrect'), /Owner policy conflict/);
  }
});
test('KB owner must be selected explicitly; unsupported/malformed owner blocks', () => {
  assert.match(check(KB, snapshot(KB, 'Task', ['owner1']), project(KB)).blockers.join('\n'), /explicitly selected/);
  assert.equal(check(KB, snapshot(KB, 'Task', ['owner1']), project(KB), 'owner1').blockers.length, 0);
  assert.match(check(KB, snapshot(KB, 'Task', ['someone']), project(KB), 'owner1').blockers.join('\n'), /owner1 is missing/);
  assert.throws(() => requiredOwner(KB, ''), /explicitly selected/);
});
test('missing Type/Priority/Bug Severity or invalid body fails read-back', () => {
  const missingType = snapshot(); missingType.issue.type = null;
  assert.match(check(FE, missingType).blockers.join('\n'), /Issue Type/);
  const noPriority = snapshot(); noPriority.issueFieldValues = [];
  assert.match(check(FE, noPriority).blockers.join('\n'), /Priority/);
  const noSeverity = snapshot(FE, 'Bug'); noSeverity.issueFieldValues.pop();
  assert.match(check(FE, noSeverity).blockers.join('\n'), /Severity/);
  assert.ok(validateBody('TODO', 'soon').length);
  const noAcceptance = snapshot(); noAcceptance.issue.body = '## Problem\nThere is a specific failure described here.\n## Outcome\nThe desired result is specifically described.';
  assert.match(check(FE, noAcceptance).blockers.join('\n'), /acceptance/);
});
test('closed cancelled/completed native Issues never authorize fresh work', () => {
  for (const [reason, status] of [['not_planned', 'Todo'], ['completed', 'Done']]) {
    const snap = snapshot();
    snap.issue.state = 'closed';
    snap.issue.state_reason = reason;
    const result = check(FE, snap, project(FE, status));
    assert.equal(result.receipt.status, 'BLOCKED');
    assert.match(result.blockers.join('\\n'), /Native Issue must be open/);
    assert.throws(() => assertFreshReceipt(result.receipt, { issue: FE + '#71' }), /INTAKE_COMPLETE/);
  }
  const unreadable = snapshot();
  unreadable.issue.state = undefined;
  assert.match(check(FE, unreadable).blockers.join('\\n'), /Native Issue must be open/);
});

test('duplicate Project items, invalid Status, stale/conflicting revision block', () => {
  assert.match(check(FE, snapshot(), project(FE, 'Backlog', 2)).blockers.join('\n'), /membership count 2/);
  assert.match(check(FE, snapshot(), project(FE, null)).blockers.join('\n'), /Status/);
  assert.match(check(FE, snapshot(), project(FE, 'DEV')).blockers.join('\n'), /Status/);
  assert.match(check(FE, snapshot(), project(FE, 'Backlog'), null, { expectedRevision: 'old' }).blockers.join('\n'), /STALE/);
  assert.match(check(FE, snapshot(), project(FE, 'Backlog'), null, { checkedAt: '2020-01-01T00:00:00Z' }).blockers.join('\n'), /STALE/);
});
test('Milestone is optional; human metadata conflicts are not overwritten', () => {
  const snap = snapshot(); snap.issue.milestone = { number: 8, title: '1.2 Telegram TMA' };
  assert.equal(check(FE, snap).receipt.milestone, '1.2 Telegram TMA');
  snap.issueFieldValues[0].single_select_option.name = 'P0';
  const plan = buildReconcilePlan({ config, repository: FE, number: 71,
    classification: { issueType: 'Task', priority: 'P1', severity: null }, snapshot: snap, project: project() });
  assert.match(plan.blockers.join('\n'), /human value/);
});
test('writer create request includes native owner and read-back remains authority', async () => {
  let posted;
  await createIssue({ request: async (_path, options) => { posted = options.body; return { number: 71 }; } },
    config, BE, { issueType: 'Task', priority: 'P1', severity: null }, { title: 'Task with clear title', body: BODY });
  assert.deepEqual(posted.assignees, ['olegbal']);
  assert.equal(posted.issue_field_values[0].value, 'P1');
});
test('queued, legacy, foreign and stale receipts never authorize handoff', () => {
  const valid = check().receipt;
  for (const receipt of [{ status: 'QUEUED' }, { status: 'complete' }, { ...valid, issue: BE + '#71' },
    { ...valid, checkedAt: '2020-01-01T00:00:00Z' }, { ...valid, status: 'BLOCKED' }]) {
    assert.throws(() => assertFreshReceipt(receipt, { issue: FE + '#71' }));
  }
});
test('fresh reader blocks an Issue changed between API reads', async () => {
  const first = snapshot();
  let calls = 0;
  const output = await readAdmission({ client: {}, config, repository: FE, number: 71, overrides: {
    readOrgSchema: async () => [],
    readProjectSnapshot: async () => project(),
    readIssueSnapshot: async () => {
      calls++;
      if (calls === 1) return first;
      return { ...first, issue: { ...first.issue, body: BODY + '\nEdited after first read' } };
    },
  } });
  assert.equal(output.receipt.status, 'BLOCKED');
  assert.match(output.blockers.join('\n'), /STALE/);
});
test('final writer receipt is only complete after positive final read-back', () => {
  const r = verifyFinalState({ config, repository: FE, number: 71,
    classification: { issueType: 'Task', priority: 'P1', severity: null },
    snapshot: snapshot(), project: project() });
  assert.deepEqual(r.blockers, []);
  assert.equal(r.receipt.status, 'INTAKE_COMPLETE');
});

test('full final read-back rejects Issue Fields, Project Status and native relationship drift', async () => {
  const baseline = snapshot();
  const cases = [
    {
      name: 'Priority changed without Issue updated_at changing',
      lateIssue: {
        ...baseline,
        issueFieldValues: [{ issue_field_id: 1, single_select_option: { name: 'P2' } }],
      },
      lateProject: project(),
    },
    {
      name: 'Project Status changed without Issue updated_at changing',
      lateIssue: baseline,
      lateProject: project(FE, 'Todo'),
    },
    {
      name: 'native dependency changed without Issue updated_at changing',
      lateIssue: {
        ...baseline,
        blockedBy: [{ repository: BE, number: 91, state: 'open' }],
      },
      lateProject: project(),
    },
    {
      name: 'Project membership became ambiguous',
      lateIssue: baseline,
      lateProject: project(FE, 'Backlog', 2),
    },
  ];
  for (const { name, lateIssue, lateProject } of cases) {
    let issueReads = 0;
    let projectReads = 0;
    const result = await readAdmission({
      client: {}, config, repository: FE, number: 71, overrides: {
        readOrgSchema: async () => [],
        readIssueSnapshot: async () => (++issueReads === 1 ? baseline : lateIssue),
        readProjectSnapshot: async () => (++projectReads === 1 ? project() : lateProject),
      },
    });
    assert.equal(issueReads, 2, name + ': native Issue must be read twice');
    assert.equal(projectReads, 2, name + ': Project must be read twice');
    assert.equal(result.receipt.status, 'BLOCKED', name);
    assert.match(result.blockers.join('\n'), /STALE/, name);
  }
});

test('second Project read failures cannot reuse an earlier positive snapshot', async () => {
  let projectReads = 0;
  const result = await readAdmission({
    client: {}, config, repository: FE, number: 71, overrides: {
      readOrgSchema: async () => [],
      readIssueSnapshot: async () => snapshot(),
      readProjectSnapshot: async () => {
        if (++projectReads === 2) throw new Error('Project permission revoked');
        return project();
      },
    },
  });
  assert.equal(projectReads, 2);
  assert.equal(result.receipt.status, 'BLOCKED');
  assert.match(result.blockers.join('\n'), /Second canonical read-back failed: Project permission revoked/);
});
