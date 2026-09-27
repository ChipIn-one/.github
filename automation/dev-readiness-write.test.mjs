import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertWriteActivation,
  buildDevTransitionPlan,
  resolveDevCoordinates,
  scanPreflightBlockers,
  verifyAppliedDev,
  writeDevStatus,
} from './dev-readiness-write.mjs';

const config = {
  project: {
    number: 5,
    statusField: 'Status',
    statusValues: ['Backlog', 'Todo', 'In Progress', 'DEV', 'PROD', 'Done'],
  },
};

function context(status = 'In Progress') {
  const item = { id: 'PVTI_item', repository: 'ChipIn-one/chipin-backend', number: 9, status };
  return {
    project: {
      id: 'PVT_project',
      fields: [{
        id: 'PVTSSF_status',
        name: 'Status',
        isIssueField: false,
        options: [
          { id: 'opt_todo', name: 'Todo' },
          { id: 'opt_progress', name: 'In Progress' },
          { id: 'opt_dev', name: 'DEV' },
          { id: 'opt_prod', name: 'PROD' },
          { id: 'opt_done', name: 'Done' },
        ],
      }],
      items: [item],
    },
    projectIndex: new Map([['ChipIn-one/chipin-backend#9', item]]),
    schemaBlockers: [],
  };
}

function evaluation({
  status = 'In Progress',
  state = 'READY_FOR_DEV',
  reason = 'All required PRs are merged to develop.',
  readErrors = [],
  adapterBlockers = [],
} = {}) {
  return {
    issue: 'ChipIn-one/chipin-backend#9',
    projectStatus: status,
    decision: { state, reason },
    readErrors,
    adapterBlockers,
  };
}

test('apply requires two explicit activation signals', () => {
  assert.doesNotThrow(() => assertWriteActivation({ mode: 'plan', activate: null, env: {} }));
  assert.throws(
    () => assertWriteActivation({ mode: 'apply', activate: 'dev-status-v1', env: {} }),
    /DEV writes are disabled/,
  );
  assert.throws(
    () => assertWriteActivation({ mode: 'apply', activate: null, env: { CHIPIN_DEV_WRITE: '1' } }),
    /DEV writes are disabled/,
  );
  assert.doesNotThrow(
    () => assertWriteActivation({
      mode: 'apply',
      activate: 'dev-status-v1',
      env: { CHIPIN_DEV_WRITE: '1' },
    }),
  );
});

test('scheduled scan preflight fails closed when Project or schema is unreadable', () => {
  assert.deepEqual(scanPreflightBlockers(context()), []);

  const schemaFailure = context();
  schemaFailure.project = null;
  schemaFailure.schemaBlockers = ['Project #5 unreadable: forbidden'];
  assert.deepEqual(
    scanPreflightBlockers(schemaFailure),
    ['Project #5 unreadable: forbidden', 'Project snapshot is unreadable.'],
  );

  const malformed = context();
  malformed.project = { ...malformed.project, items: null };
  assert.deepEqual(scanPreflightBlockers(malformed), ['Project item collection is unreadable.']);
});

test('READY_FOR_DEV pre-DEV item produces the only allowed write plan', () => {
  const plan = buildDevTransitionPlan({
    config,
    liveContext: context('In Progress'),
    evaluation: evaluation(),
  });
  assert.equal(plan.action, 'write');
  assert.equal(plan.from, 'In Progress');
  assert.equal(plan.to, 'DEV');
  assert.equal(plan.projectId, 'PVT_project');
  assert.equal(plan.itemId, 'PVTI_item');
  assert.equal(plan.fieldId, 'PVTSSF_status');
  assert.equal(plan.optionId, 'opt_dev');
  assert.deepEqual(plan.blockers, []);
});

test('NOT_READY, BLOCKED_UNKNOWN and INCONSISTENT never produce writes', () => {
  for (const state of ['NOT_READY', 'BLOCKED_UNKNOWN', 'INCONSISTENT']) {
    const plan = buildDevTransitionPlan({
      config,
      liveContext: context('In Progress'),
      evaluation: evaluation({ state, reason: state }),
    });
    assert.equal(plan.action, 'blocked', state);
    assert.match(plan.blockers.join('\n'), /not READY_FOR_DEV/);
  }
});

test('read failures and adapter blockers fail closed even with READY_FOR_DEV', () => {
  const readFailure = buildDevTransitionPlan({
    config,
    liveContext: context(),
    evaluation: evaluation({ readErrors: ['forbidden'] }),
  });
  assert.equal(readFailure.action, 'blocked');
  assert.match(readFailure.blockers.join('\n'), /Read failure/);

  const adapterFailure = buildDevTransitionPlan({
    config,
    liveContext: context(),
    evaluation: evaluation({ adapterBlockers: ['schema drift'] }),
  });
  assert.equal(adapterFailure.action, 'blocked');
  assert.match(adapterFailure.blockers.join('\n'), /Adapter blocker/);
});

test('PROD and Done are immutable manual terminal states for DEV automation', () => {
  for (const status of ['PROD', 'Done']) {
    const plan = buildDevTransitionPlan({
      config,
      liveContext: context(status),
      evaluation: evaluation({ status }),
    });
    assert.equal(plan.action, 'blocked');
    assert.match(plan.blockers.join('\n'), /manual and must never be changed/);
  }
});

test('clean already-DEV state is idempotent and never writes', () => {
  const plan = buildDevTransitionPlan({
    config,
    liveContext: context('DEV'),
    evaluation: evaluation({
      status: 'DEV',
      state: 'NOT_READY',
      reason: 'Current status is already DEV; no DEV transition is allowed.',
    }),
  });
  assert.equal(plan.action, 'noop');
  assert.equal(plan.from, 'DEV');
  assert.equal(plan.to, 'DEV');
  assert.deepEqual(plan.blockers, []);
});

test('inconsistent DEV state is blocked, never regressed', () => {
  const plan = buildDevTransitionPlan({
    config,
    liveContext: context('DEV'),
    evaluation: evaluation({
      status: 'DEV',
      state: 'INCONSISTENT',
      reason: 'Current status is DEV but readiness recomputation is NOT_READY.',
    }),
  });
  assert.equal(plan.action, 'blocked');
  assert.match(plan.blockers.join('\n'), /not a clean idempotent no-op/);
});

test('writer requires exact Project, item, Status field and DEV option node ids', () => {
  const bad = context();
  bad.project.id = null;
  bad.project.fields[0].options = [{ id: 'x', name: 'Todo' }];
  bad.projectIndex.get('ChipIn-one/chipin-backend#9').id = null;
  const coordinates = resolveDevCoordinates({
    config,
    liveContext: bad,
    evaluation: evaluation(),
  });
  assert.match(coordinates.blockers.join('\n'), /Project node id is unreadable/);
  assert.match(coordinates.blockers.join('\n'), /Project item node id is unreadable/);
  assert.match(coordinates.blockers.join('\n'), /DEV Status option is missing or ambiguous/);
});

test('mutation is exactly one Project Status single-select update', async () => {
  const calls = [];
  const client = {
    async graphql(query, variables) {
      calls.push({ query, variables });
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_item' } } };
    },
  };
  const plan = buildDevTransitionPlan({
    config,
    liveContext: context(),
    evaluation: evaluation(),
  });
  await writeDevStatus(client, plan);
  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /updateProjectV2ItemFieldValue/);
  assert.match(calls[0].query, /singleSelectOptionId/);
  assert.doesNotMatch(calls[0].query, /updateIssue|deleteProject|addProject/);
  assert.deepEqual(calls[0].variables, {
    projectId: 'PVT_project',
    itemId: 'PVTI_item',
    fieldId: 'PVTSSF_status',
    optionId: 'opt_dev',
  });
});

test('write helper rejects blocked and malformed plans without calling GitHub', async () => {
  let calls = 0;
  const client = { async graphql() { calls += 1; } };
  await assert.rejects(() => writeDevStatus(client, { action: 'blocked' }), /non-write plan/);
  await assert.rejects(
    () => writeDevStatus(client, { action: 'write', projectId: 'p', itemId: 'i', fieldId: 'f', optionId: null }),
    /unreadable optionId/,
  );
  assert.equal(calls, 0);
});

test('post-write verification accepts only clean already-DEV read-back', () => {
  assert.deepEqual(verifyAppliedDev(evaluation({
    status: 'DEV',
    state: 'NOT_READY',
    reason: 'Current status is already DEV; no DEV transition is allowed.',
  })), []);

  assert.match(verifyAppliedDev(evaluation({
    status: 'DEV',
    state: 'INCONSISTENT',
    reason: 'Current status is DEV but readiness recomputation is NOT_READY.',
  })).join('\n'), /expected clean already-DEV no-op/);

  assert.match(verifyAppliedDev(evaluation({
    status: 'In Progress',
    state: 'READY_FOR_DEV',
  })).join('\n'), /expected DEV/);
});
