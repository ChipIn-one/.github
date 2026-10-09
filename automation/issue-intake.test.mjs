import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertFreshReceipt } from './issue-admission.mjs';
import {
  buildReconcilePlan,
  reserveCreateState,
  run,
  validateClassification,
  verifyFinalState,
} from './issue-intake.mjs';

const config = {
  organization: 'ChipIn-one',
  project: {
    number: 5,
    statusField: 'Status',
    statusValues: ['Backlog', 'Todo', 'In Progress', 'Done'],
  },
  issueFields: {
    Priority: { id: 1, options: ['P0', 'P1', 'P2', 'P3'] },
    Severity: { id: 2, options: ['Critical', 'Major', 'Minor'] },
  },
  issueTypes: { Task: 10, Bug: 11, Feature: 12 },
};

const DURABLE_BODY = '## Problem\nCurrent task behavior is incorrect and requires a concrete change.\n\n## Outcome\nDeliver a verifiable change with a stable outcome.\n\n## Acceptance\n- [ ] Verified result matches the specified behavior.\n';

const classification = {
  issueType: 'Bug',
  priority: 'P1',
  severity: 'Major',
};

function issueSnapshot({ type = null, priority = null, severity = null, state = 'open', stateReason = null } = {}) {
  const issueFieldValues = [];
  if (priority) issueFieldValues.push({ issue_field_id: 1, single_select_option: { name: priority } });
  if (severity) issueFieldValues.push({ issue_field_id: 2, single_select_option: { name: severity } });
  return {
    issue: {
      number: 999,
      repository_url: 'https://api.github.com/repos/ChipIn-one/chipin-frontend',
      title: 'Canonical intake test task',
      body: DURABLE_BODY,
      updated_at: '2026-10-09T12:00:00Z',
      assignees: [{ login: 'syllik' }],
      type: type ? { name: type } : null,
      node_id: 'ISSUE_NODE',
      html_url: 'https://github.com/ChipIn-one/chipin-frontend/issues/999',
      state,
      state_reason: stateReason,
    },
    issueFieldValues,
    blockedBy: [],
    blocking: [],
    parent: null,
    subIssues: [],
    relationsReadable: true,
  };
}

function project({ items = [] } = {}) {
  return {
    id: 'PROJECT',
    fields: [
      { name: 'Priority', isIssueField: true, issueField: { fullDatabaseId: '1', name: 'Priority' } },
      { name: 'Severity', isIssueField: true, issueField: { fullDatabaseId: '2', name: 'Severity' } },
      {
        id: 'STATUS_FIELD',
        name: 'Status',
        isIssueField: false,
        options: config.project.statusValues.map((name) => ({ id: 'STATUS_' + name, name })),
      },
    ],
    items,
  };
}

function fullIssue() {
  return issueSnapshot({ type: 'Bug', priority: 'P1', severity: 'Major' });
}

function argsFor(operation = 'reconcile', target = 'ChipIn-one/chipin-frontend#999') {
  return [
    'apply', operation, target,
    '--type', 'Bug',
    '--priority', 'P1',
    '--severity', 'Major',
    ...(operation === 'create' ? ['--body', DURABLE_BODY] : []),
    '--activate', 'issue-intake-v1',
  ];
}

async function withoutExitLeak(fn) {
  const before = process.exitCode;
  process.exitCode = undefined;
  try { return await fn(); }
  finally { process.exitCode = before; }
}

test('fully explicit intake writes missing metadata, membership and Status, then returns a receipt', async () => {
  let issueReads = 0;
  let projectReads = 0;
  let metadataWrites = 0;
  let membershipWrites = 0;
  let statusWrites = 0;
  const projects = [
    project(),
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: null }] }),
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' }] }),
  ];

  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readIssueSnapshot: async () => {
      issueReads += 1;
      return issueReads === 1 ? issueSnapshot() : fullIssue();
    },
    readProjectSnapshot: async () => projects[Math.min(projectReads++, projects.length - 1)],
    writeIssueMetadata: async () => { metadataWrites += 1; },
    addProjectMembership: async () => { membershipWrites += 1; return 'ITEM'; },
    initializeProjectStatus: async () => { statusWrites += 1; },
    projectMembershipReadDelayMs: 0,
    sleep: async () => {},
    writeFile: async () => {},
  }));

  assert.equal(result.action, 'complete');
  assert.deepEqual(result.blockers, []);
  assert.equal(metadataWrites, 1);
  assert.equal(membershipWrites, 1);
  assert.equal(statusWrites, 1);
  assert.equal(result.receipt.project.membershipCount, 1);
  assert.equal(result.receipt.project.status, 'Backlog');
  assert.equal(result.receipt.issueType, 'Bug');
  assert.equal(result.receipt.milestone, null);
});

test('project read-back tolerates indexing beyond the legacy six-read window and waits for Status', async () => {
  let issueReads = 0;
  let projectReads = 0;
  let membershipWrites = 0;
  let statusWrites = 0;
  let sleeps = 0;
  const delayedProjects = Array.from({ length: 6 }, () => project());
  const projects = [
    project(),
    ...delayedProjects,
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: null }] }),
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' }] }),
  ];

  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readIssueSnapshot: async () => {
      issueReads += 1;
      return issueReads === 1 ? issueSnapshot() : fullIssue();
    },
    readProjectSnapshot: async () => projects[Math.min(projectReads++, projects.length - 1)],
    writeIssueMetadata: async () => {},
    addProjectMembership: async () => { membershipWrites += 1; return 'ITEM'; },
    initializeProjectStatus: async (_client, _config, _project, itemId) => {
      statusWrites += 1;
      assert.equal(itemId, 'ITEM');
    },
    projectMembershipReadDelayMs: 0,
    sleep: async () => { sleeps += 1; },
    writeFile: async () => {},
  }));

  assert.equal(result.action, 'complete');
  assert.deepEqual(result.blockers, []);
  assert.equal(membershipWrites, 1);
  assert.equal(statusWrites, 1);
  assert.equal(sleeps, 6);
  assert.equal(result.receipt.project.membershipCount, 1);
  assert.equal(result.receipt.project.status, 'Backlog');
});


test('late Status initialization gets its own read-back after the final membership attempt', async () => {
  let issueReads = 0;
  let projectReads = 0;
  let statusWrites = 0;
  const projects = [
    project(),
    project(),
    project(),
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: null }] }),
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' }] }),
  ];

  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readIssueSnapshot: async () => {
      issueReads += 1;
      return issueReads === 1 ? issueSnapshot() : fullIssue();
    },
    readProjectSnapshot: async () => projects[Math.min(projectReads++, projects.length - 1)],
    writeIssueMetadata: async () => {},
    addProjectMembership: async () => 'ITEM',
    initializeProjectStatus: async () => { statusWrites += 1; },
    projectMembershipReadAttempts: 3,
    projectStatusReadAttempts: 1,
    projectMembershipReadDelayMs: 0,
    sleep: async () => {},
    writeFile: async () => {},
  }));

  assert.equal(result.action, 'complete');
  assert.deepEqual(result.blockers, []);
  assert.equal(statusWrites, 1);
  assert.equal(result.receipt.project.membershipCount, 1);
  assert.equal(result.receipt.project.status, 'Backlog');
});

test('stale Project snapshot never overwrites an existing human-owned Status', async () => {
  let issueReads = 0;
  let projectReads = 0;
  let membershipWrites = 0;
  let statusWrites = 0;
  const projects = [
    project(),
    project(),
    project(),
    project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'In Progress' }] }),
  ];

  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readIssueSnapshot: async () => {
      issueReads += 1;
      return issueReads === 1 ? issueSnapshot() : fullIssue();
    },
    readProjectSnapshot: async () => projects[Math.min(projectReads++, projects.length - 1)],
    writeIssueMetadata: async () => {},
    addProjectMembership: async () => { membershipWrites += 1; return 'ITEM'; },
    initializeProjectStatus: async () => { statusWrites += 1; },
    projectMembershipReadDelayMs: 0,
    sleep: async () => {},
    writeFile: async () => {},
  }));

  assert.equal(result.action, 'complete');
  assert.deepEqual(result.blockers, []);
  assert.equal(membershipWrites, 1);
  assert.equal(statusWrites, 0);
  assert.equal(result.receipt.project.membershipCount, 1);
  assert.equal(result.receipt.project.status, 'In Progress');
});

test('missing milestone is valid canonical intake and does not gate completion', () => {
  const { blockers, classification: checked } = validateClassification(config, {
    issueType: 'Feature',
    priority: 'P2',
    severity: 'none',
  });
  assert.deepEqual(blockers, []);
  assert.deepEqual(checked, { issueType: 'Feature', priority: 'P2', severity: null });
});

test('Done is accepted only as a mirror of closed/completed Issue state', () => {
  const doneProject = project({
    items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Done' }],
  });
  const completed = issueSnapshot({
    type: 'Bug', priority: 'P1', severity: 'Major',
    state: 'closed', stateReason: 'completed',
  });
  const plan = buildReconcilePlan({
    config, repository: 'ChipIn-one/chipin-frontend', number: 999,
    classification, snapshot: completed, project: doneProject,
  });
  assert.equal(plan.action, 'noop');
  assert.deepEqual(plan.blockers, []);

  const final = verifyFinalState({
    config, repository: 'ChipIn-one/chipin-frontend', number: 999,
    classification, snapshot: completed, project: doneProject,
  });
  assert.deepEqual(final.blockers, []);
  assert.equal(final.receipt.project.status, 'Done');
  assert.equal(final.receipt.contractVersion, 'chipin-terminal-reconciliation/v1');
  assert.equal(final.receipt.status, 'TERMINAL_RECONCILED');
  assert.throws(() => assertFreshReceipt(final.receipt, { issue: 'ChipIn-one/chipin-frontend#999' }),
    /INTAKE_COMPLETE/);
});

test('Done on an open or not-planned Issue fails closed', () => {
  const doneProject = project({
    items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Done' }],
  });
  const snapshots = [
    fullIssue(),
    issueSnapshot({ type: 'Bug', priority: 'P1', severity: 'Major', state: 'closed', stateReason: 'not_planned' }),
  ];
  for (const snapshot of snapshots) {
    const plan = buildReconcilePlan({
      config, repository: 'ChipIn-one/chipin-frontend', number: 999,
      classification, snapshot, project: doneProject,
    });
    assert.equal(plan.action, 'incomplete');
    assert.match(plan.blockers.join('\n'), /Project Status Done is derived from Issue closed\/completed/);
  }
});

test('retired DEV status still fails closed', () => {
  const legacyProject = project({
    items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'DEV' }],
  });
  const plan = buildReconcilePlan({
    config, repository: 'ChipIn-one/chipin-frontend', number: 999,
    classification, snapshot: fullIssue(), project: legacyProject,
  });
  assert.equal(plan.action, 'incomplete');
  assert.match(plan.blockers.join('\n'), /Project Status DEV is retired or unsupported/);
});

test('existing human values are preserved and mismatches block overwrite', () => {
  const same = buildReconcilePlan({
    config,
    repository: 'ChipIn-one/chipin-frontend',
    number: 999,
    classification,
    snapshot: fullIssue(),
    project: project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Todo' }] }),
  });
  assert.equal(same.action, 'noop');
  assert.deepEqual(same.operations, []);

  const conflict = buildReconcilePlan({
    config,
    repository: 'ChipIn-one/chipin-frontend',
    number: 999,
    classification,
    snapshot: issueSnapshot({ type: 'Bug', priority: 'P0', severity: 'Major' }),
    project: project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Todo' }] }),
  });
  assert.equal(conflict.action, 'incomplete');
  assert.match(conflict.blockers.join('\n'), /refusing to overwrite/);
});

test('Severity is type-specific: Bug requires it while Task can omit it', () => {
  assert.match(validateClassification(config, {
    issueType: 'Bug', priority: 'P1', severity: 'none',
  }).blockers.join('\n'), /Severity is required for Bug/);

  assert.deepEqual(validateClassification(config, {
    issueType: 'Task', priority: 'P2', severity: 'none',
  }).blockers, []);
});

test('missing membership is planned for add; duplicate membership is fail-closed', () => {
  const missing = buildReconcilePlan({
    config,
    repository: 'ChipIn-one/chipin-frontend',
    number: 999,
    classification,
    snapshot: fullIssue(),
    project: project(),
  });
  assert.equal(missing.operations.some((operation) => operation.kind === 'addProjectMembership'), true);

  const duplicate = buildReconcilePlan({
    config,
    repository: 'ChipIn-one/chipin-frontend',
    number: 999,
    classification,
    snapshot: fullIssue(),
    project: project({ items: [
      { id: 'A', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Todo' },
      { id: 'B', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Todo' },
    ] }),
  });
  assert.equal(duplicate.action, 'incomplete');
  assert.match(duplicate.blockers.join('\n'), /duplicate membership/);
});

test('retry after partial create uses persisted issue identity and never creates a duplicate issue', async () => {
  let createCalls = 0;
  let issueReads = 0;
  let projectReads = 0;
  const result = await withoutExitLeak(() => run([
    ...argsFor('create', 'ChipIn-one/chipin-frontend'),
    '--title', 'Retry-safe test',
    '--state', '/tmp/state.json',
  ], { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({
      project: project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' }] }),
      blockers: [],
    }),
    readCreateState: async () => ({
      issueRef: 'ChipIn-one/chipin-frontend#999',
      classification,
      title: 'Retry-safe test',
    }),
    createIssue: async () => { createCalls += 1; throw new Error('must not create'); },
    readIssueSnapshot: async () => { issueReads += 1; return fullIssue(); },
    readProjectSnapshot: async () => {
      projectReads += 1;
      return project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' }] });
    },
    writeFile: async () => {},
  }));
  assert.equal(createCalls, 0);
  assert.equal(result.action, 'complete');
  assert.equal(result.applied.includes('resume-existing-issue'), true);
  assert.ok(issueReads >= 2);
  assert.ok(projectReads >= 1);
});


test('create rejects colliding resolved state and output paths before any write or API call', async () => {
  let reserveCalls = 0;
  let createCalls = 0;

  await assert.rejects(
    () => withoutExitLeak(() => run([
      ...argsFor('create', 'ChipIn-one/chipin-frontend'),
      '--title', 'Path collision',
      '--state', './same-create.json',
      '--output', 'same-create.json',
    ], { CHIPIN_ISSUE_WRITE: '1' }, {
      config,
      client: {},
      reserveCreateState: async () => { reserveCalls += 1; },
      createIssue: async () => {
        createCalls += 1;
        return { number: 999 };
      },
      writeFile: async () => {},
    })),
    /--state and --output to resolve to different paths/,
  );

  assert.equal(reserveCalls, 0);
  assert.equal(createCalls, 0);
});

test('unwritable create checkpoint fails before the API create call', async () => {
  let createCalls = 0;
  const result = await withoutExitLeak(() => run([
    ...argsFor('create', 'ChipIn-one/chipin-frontend'),
    '--title', 'Checkpoint preflight test',
    '--state', '/unwritable/state.json',
  ], { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readCreateState: async () => null,
    reserveCreateState: async () => { throw new Error('EACCES checkpoint'); },
    createIssue: async () => {
      createCalls += 1;
      return { number: 999 };
    },
    writeFile: async () => {},
  }));

  assert.equal(createCalls, 0);
  assert.equal(result.action, 'incomplete');
  assert.match(result.blockers.join('\n'), /EACCES checkpoint/);
});

test('create reservation is exclusive across concurrent claimants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chipin-issue-intake-'));
  const statePath = join(directory, 'state.json');
  const value = {
    schemaVersion: 1,
    repository: 'ChipIn-one/chipin-frontend',
    classification,
    title: 'Concurrent create',
    phase: 'reserved-before-create',
  };

  try {
    const settled = await Promise.allSettled([
      reserveCreateState(statePath, value),
      reserveCreateState(statePath, value),
    ]);
    assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].reason?.code, 'EEXIST');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unreadable body file fails before checkpoint reservation or API create', async () => {
  let reserveCalls = 0;
  let createCalls = 0;
  const result = await withoutExitLeak(() => run([
    ...argsFor('create', 'ChipIn-one/chipin-frontend'),
    '--title', 'Unreadable body',
    '--body-file', '/missing/body.md',
    '--state', '/tmp/state.json',
  ], { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readCreateState: async () => null,
    readFile: async () => { throw new Error('ENOENT body'); },
    reserveCreateState: async () => { reserveCalls += 1; },
    createIssue: async () => {
      createCalls += 1;
      return { number: 999 };
    },
    writeFile: async () => {},
  }));

  assert.equal(reserveCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(result.action, 'incomplete');
  assert.match(result.blockers.join('\n'), /ENOENT body/);
});

test('reserved checkpoint without identity fails closed instead of creating a duplicate', async () => {
  let createCalls = 0;
  const result = await withoutExitLeak(() => run([
    ...argsFor('create', 'ChipIn-one/chipin-frontend'),
    '--title', 'Uncertain prior create',
    '--state', '/tmp/state.json',
  ], { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readCreateState: async () => ({
      schemaVersion: 1,
      repository: 'ChipIn-one/chipin-frontend',
      classification,
      title: 'Uncertain prior create',
      phase: 'reserved-before-create',
    }),
    createIssue: async () => {
      createCalls += 1;
      return { number: 999 };
    },
    writeFile: async () => {},
  }));

  assert.equal(createCalls, 0);
  assert.equal(result.action, 'incomplete');
  assert.match(result.blockers.join('\n'), /creation outcome is uncertain/);
});

test('API permission failure yields incomplete receipt and does not continue to Project writes', async () => {
  let projectWrites = 0;
  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readIssueSnapshot: async () => issueSnapshot(),
    writeIssueMetadata: async () => { throw new Error('403 Forbidden'); },
    addProjectMembership: async () => { projectWrites += 1; },
    initializeProjectStatus: async () => { projectWrites += 1; },
    writeFile: async () => {},
  }));
  assert.equal(result.action, 'incomplete');
  assert.match(result.blockers.join('\n'), /403 Forbidden/);
  assert.equal(projectWrites, 0);
});

test('read-back failure after a write is incomplete, never false success', async () => {
  let issueReads = 0;
  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config,
    client: {},
    readGlobalContext: async () => ({ project: project(), blockers: [] }),
    readIssueSnapshot: async () => {
      issueReads += 1;
      if (issueReads === 1) return issueSnapshot();
      throw new Error('simulated read-back outage');
    },
    writeIssueMetadata: async () => {},
    writeFile: async () => {},
  }));
  assert.equal(result.action, 'incomplete');
  assert.match(result.blockers.join('\n'), /read-back failed/);
});

test('final verification requires exactly one membership and a readable Status', () => {
  const result = verifyFinalState({
    config,
    repository: 'ChipIn-one/chipin-frontend',
    number: 999,
    classification,
    snapshot: fullIssue(),
    project: project({ items: [{ id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: null }] }),
  });
  assert.match(result.blockers.join('\n'), /Status is missing/);
});


test('agent entrypoint requires completed ChipIn intake after gh issue create', async () => {
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(agents, /`gh issue create` alone is not completion/);
  assert.match(agents, /automation\/issue-intake\.md/);
  assert.match(agents, /exactly one Project #5 membership with readable Status and read-back receipt/);
});

test('cancelled or unreadable Issues never plan canonical metadata or Project writes', () => {
  for (const [state, reason] of [['closed', 'not_planned'], ['closed', null], [null, null]]) {
    const snapshot = issueSnapshot({ state, stateReason: reason });
    snapshot.issue.assignees = [];
    const plan = buildReconcilePlan({
      config, repository: 'ChipIn-one/chipin-frontend', number: 999,
      classification, snapshot, project: project(),
    });
    assert.equal(plan.action, 'incomplete');
    assert.deepEqual(plan.operations, []);
    assert.match(plan.blockers.join(' '), /refusing all intake mutations/);
  }
});

test('closed/completed keeps its separate terminal Project Done reconciliation path', () => {
  const snapshot = issueSnapshot({
    type: 'Bug', priority: 'P1', severity: 'Major',
    state: 'closed', stateReason: 'completed',
  });
  const plan = buildReconcilePlan({
    config, repository: 'ChipIn-one/chipin-frontend', number: 999,
    classification, snapshot,
    project: project({ items: [{
      id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Done',
    }] }),
  });
  assert.deepEqual(plan.operations, []);
  assert.equal(plan.action, 'noop');
});

test('PR-shaped, mismatched and unreadable native Issue identities cannot plan writes', () => {
  const variants = [
    snapshot => { snapshot.issue.pull_request = { url: 'https://api.github.com/repos/ChipIn-one/chipin-frontend/pulls/999' }; },
    snapshot => { snapshot.issue.number = 1000; },
    snapshot => { snapshot.issue.repository_url = 'https://api.github.com/repos/ChipIn-one/chipin-backend'; },
    snapshot => { snapshot.issue.node_id = null; },
  ];
  for (const mutate of variants) {
    const snapshot = issueSnapshot();
    snapshot.issue.assignees = [];
    mutate(snapshot);
    const plan = buildReconcilePlan({
      config, repository: 'ChipIn-one/chipin-frontend', number: 999,
      classification, snapshot, project: project(),
    });
    assert.equal(plan.action, 'incomplete');
    assert.deepEqual(plan.operations, []);
    assert.match(plan.blockers.join(' '), /Native Issue identity.*PR-shaped/);
  }
});

test('final intake read-back revalidates native Issue and Project revision before INTAKE_COMPLETE', async () => {
  const stable = project({ items: [{
    id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog',
  }] });
  let issueReads = 0;
  let projectReads = 0;
  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config, client: {},
    readGlobalContext: async () => ({ project: stable, blockers: [] }),
    readIssueSnapshot: async () => { issueReads++; return fullIssue(); },
    readProjectSnapshot: async () => { projectReads++; return stable; },
    writeFile: async () => {},
  }));
  assert.equal(result.action, 'complete');
  assert.equal(result.receipt.status, 'INTAKE_COMPLETE');
  assert.equal(result.receipt.project.status, 'Backlog');
  assert.ok(issueReads >= 4, 'final confirmation must reread the native Issue');
  assert.ok(projectReads >= 2, 'final confirmation must reread Project #5');
});

test('Project Status change at final receipt boundary blocks stale INTAKE_COMPLETE', async () => {
  const original = project({ items: [{
    id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog',
  }] });
  const changed = project({ items: [{
    id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'In Progress',
  }] });
  let projectReads = 0;
  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config, client: {},
    readGlobalContext: async () => ({ project: original, blockers: [] }),
    readIssueSnapshot: async () => fullIssue(),
    readProjectSnapshot: async () => ++projectReads === 1 ? original : changed,
    writeFile: async () => {},
  }));
  assert.equal(result.action, 'incomplete');
  assert.equal(result.receipt.status, 'BLOCKED');
  assert.equal(result.receipt.project.status, 'In Progress');
  assert.ok(result.blockers.some(message => message.includes('STALE: native Issue/metadata/Project')));
});

test('late duplicate Project membership or missing final read denies writer completion', async () => {
  const original = project({ items: [{
    id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog',
  }] });
  const duplicate = project({ items: [
    { id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' },
    { id: 'ITEM2', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog' },
  ] });
  for (const failure of ['duplicate', 'unreadable']) {
    let projectReads = 0;
    const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
      config, client: {},
      readGlobalContext: async () => ({ project: original, blockers: [] }),
      readIssueSnapshot: async () => fullIssue(),
      readProjectSnapshot: async () => {
        if (++projectReads === 1) return original;
        if (failure === 'duplicate') return duplicate;
        throw new Error('Project #5 API 403');
      },
      writeFile: async () => {},
    }));
    assert.equal(result.action, 'incomplete');
    assert.notEqual(result.receipt?.status, 'INTAKE_COMPLETE');
    assert.match(result.blockers.join(' '), failure === 'duplicate' ? /membership count 2/ : /403/);
  }
});

test('Issue body drift after final Project read cannot admit older revision', async () => {
  const stable = project({ items: [{
    id: 'ITEM', repository: 'ChipIn-one/chipin-frontend', number: 999, status: 'Backlog',
  }] });
  let issueReads = 0;
  const result = await withoutExitLeak(() => run(argsFor(), { CHIPIN_ISSUE_WRITE: '1' }, {
    config, client: {},
    readGlobalContext: async () => ({ project: stable, blockers: [] }),
    readIssueSnapshot: async () => {
      const issue = fullIssue();
      if (++issueReads >= 4) issue.issue.body += '\\nExtra human-owned acceptance detail.';
      return issue;
    },
    readProjectSnapshot: async () => stable,
    writeFile: async () => {},
  }));
  assert.equal(result.action, 'incomplete');
  assert.equal(result.receipt.status, 'BLOCKED');
  assert.ok(result.blockers.some(message => message.includes('STALE: native Issue/metadata/Project')));
});
