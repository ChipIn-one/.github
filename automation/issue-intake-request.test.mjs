import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildIntakeArgs,
  drainQueue,
  intakeStatus,
  parseRequestBody,
  pendingQueueItems,
  renderQueueComment,
  renderReceiptComment,
  validateQueuedRequest,
  validateRequestEvent,
} from './issue-intake-request.mjs';

const config = {
  organization: 'ChipIn-one',
  project: {
    number: 5,
    statusField: 'Status',
    statusValues: ['Backlog', 'Todo', 'In Progress'],
  },
  issueFields: {
    Priority: { id: 1, options: ['P0', 'P1', 'P2', 'P3'] },
    Severity: { id: 2, options: ['Critical', 'Major', 'Minor'] },
  },
  issueTypes: { Task: 10, Feature: 11, Bug: 12 },
};

function body(request) {
  return [
    '<!-- chipin-issue-intake-request:v1',
    JSON.stringify(request),
    '-->',
  ].join('\n');
}

function event(overrides = {}) {
  const request = overrides.request ?? {
    target: 'ChipIn-one/chipin-frontend#308',
    issueType: 'Feature',
    priority: 'P2',
    severity: 'none',
  };
  return {
    repository: { full_name: overrides.repository ?? 'ChipIn-one/.github' },
    issue: {
      number: 100,
      html_url: 'https://github.com/ChipIn-one/.github/issues/100',
      user: { login: overrides.actor ?? 'syllik' },
      title: overrides.title ?? '[issue-intake] ChipIn-one/chipin-frontend#308',
      body: overrides.body ?? body(request),
    },
    sender: { login: overrides.sender ?? overrides.actor ?? 'syllik' },
  };
}

test('parses one exact hidden JSON request marker', () => {
  assert.deepEqual(parseRequestBody(body({
    target: 'ChipIn-one/chipin-backend#146',
    issueType: 'Feature',
    priority: 'P2',
  })), {
    target: 'ChipIn-one/chipin-backend#146',
    issueType: 'Feature',
    priority: 'P2',
    severity: 'none',
  });
});

test('rejects duplicate markers, retired releaseScope, and unsupported payload keys', () => {
  assert.throws(
    () => parseRequestBody(body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
    }) + '\n' + body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
    })),
    /exactly one/,
  );
  assert.throws(
    () => parseRequestBody(body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
      releaseScope: 'POST-PROD',
    })),
    /Unsupported intake request keys: releaseScope/,
  );
  assert.throws(
    () => parseRequestBody(body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
      command: 'rm -rf /',
    })),
    /Unsupported intake request keys/,
  );
});

test('trusted exact request validates without guessing classification', () => {
  const result = validateRequestEvent({ event: event(), config });
  assert.equal(result.valid, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.actor, 'syllik');
  assert.equal(result.request.target, 'ChipIn-one/chipin-frontend#308');
  assert.equal(result.request.severity, 'none');
  assert.equal(Object.hasOwn(result.request, 'releaseScope'), false);
});

test('untrusted author fails closed', () => {
  const result = validateRequestEvent({
    event: event({ actor: 'external-user' }),
    config,
  });
  assert.equal(result.valid, false);
  assert.match(result.blockers.join('\n'), /not trusted/);
});

test('untrusted edit/reopen trigger actor fails closed even when original author is trusted', () => {
  const result = validateRequestEvent({
    event: event({ actor: 'syllik', sender: 'external-collaborator' }),
    config,
  });
  assert.equal(result.valid, false);
  assert.match(result.blockers.join('\n'), /trigger actor external-collaborator is not trusted/);
});

test('bridge and manual finalizer share one serialized canonical-write drain after durable enqueue', async () => {
  const [bridge, manual] = await Promise.all([
    readFile(new URL('../.github/workflows/issue-intake-connector-bridge.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.github/workflows/issue-metadata-finalize.yml', import.meta.url), 'utf8'),
  ]);
  for (const workflow of [bridge, manual]) {
    assert.match(workflow, /group: canonical-issue-intake-writes/);
    assert.match(workflow, /issue-intake-request\.mjs drain/);
  }
  assert.match(bridge, /Persist durable queue record/);
  assert.doesNotMatch(bridge, /issue-intake-request\.mjs apply/);
  assert.match(manual, /Create durable control issue/);
  assert.doesNotMatch(manual, /issue-intake\.mjs apply reconcile/);
});

test('legacy queued v1 request with retired releaseScope fails closed', () => {
  const result = validateQueuedRequest(config, {
    schemaVersion: 1,
    requestIssue: 100,
    requestIssueUrl: 'https://github.com/ChipIn-one/.github/issues/100',
    actor: 'syllik',
    triggerActor: 'syllik',
    target: 'ChipIn-one/chipin-frontend#308',
    issueType: 'Feature',
    priority: 'P2',
    severity: 'none',
    releaseScope: 'POST-PROD',
  });
  assert.equal(result.valid, false);
  assert.match(result.blockers.join('\n'), /Unsupported queued intake request keys: releaseScope/);
  assert.equal(Object.hasOwn(result.request, 'releaseScope'), false);
});

test('durable queue preserves every pending snapshot even when multiple requests target the same issue', () => {
  const issue = { number: 100 };
  const queuedA = {
    schemaVersion: 1,
    requestIssue: 100,
    target: 'ChipIn-one/chipin-frontend#308',
    issueType: 'Feature',
    priority: 'P2',
    severity: 'none',
  };
  const queuedB = { ...queuedA, priority: 'P1' };
  const comments = [
    { id: 10, user: { login: 'github-actions[bot]' }, body: renderQueueComment(queuedA) },
    { id: 11, user: { login: 'github-actions[bot]' }, body: renderQueueComment(queuedB) },
    {
      id: 12,
      user: { login: 'github-actions[bot]' },
      body: renderReceiptComment({ status: 'complete', blockers: [], request: queuedA, intake: null }, 10),
    },
  ];
  assert.deepEqual(
    pendingQueueItems(issue, comments).map((entry) => entry.id),
    [11],
  );
});

test('unsupported target repository fails before canonical intake', () => {
  const request = {
    target: 'other-org/other-repo#1',
    issueType: 'Task',
    priority: 'P3',
    severity: 'none',
  };
  const result = validateRequestEvent({
    event: event({
      request,
      title: '[issue-intake] other-org/other-repo#1',
    }),
    config,
  });
  assert.equal(result.valid, false);
  assert.match(result.blockers.join('\n'), /outside canonical ChipIn intake scope/);
});

test('title must exactly identify the same target as the payload', () => {
  const result = validateRequestEvent({
    event: event({ title: '[issue-intake] ChipIn-one/chipin-frontend#999' }),
    config,
  });
  assert.equal(result.valid, false);
  assert.match(result.blockers.join('\n'), /must exactly match/);
});

test('Bug request requires explicit Severity through canonical classifier', () => {
  const request = {
    target: 'ChipIn-one/chipin-backend#146',
    issueType: 'Bug',
    priority: 'P1',
    severity: 'none',
  };
  const result = validateRequestEvent({
    event: event({
      request,
      title: '[issue-intake] ChipIn-one/chipin-backend#146',
    }),
    config,
  });
  assert.equal(result.valid, false);
  assert.match(result.blockers.join('\n'), /Severity is required for Bug/);
});

test('builds canonical reconcile argv without shell interpolation', () => {
  assert.deepEqual(buildIntakeArgs({
    target: 'ChipIn-one/chipin-frontend#308',
    issueType: 'Feature',
    priority: 'P2',
    severity: 'none',
  }, '/tmp/intake.json'), [
    'apply',
    'reconcile',
    'ChipIn-one/chipin-frontend#308',
    '--type',
    'Feature',
    '--priority',
    'P2',
    '--severity',
    'none',
    '--activate',
    'issue-intake-v1',
    '--output',
    '/tmp/intake.json',
  ]);
});

test('rendered success comment contains canonical read-back', () => {
  const comment = renderReceiptComment({
    status: 'complete',
    blockers: [],
    request: {
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
      severity: 'none',
    },
    intake: {
      applied: ['issue-metadata', 'project-membership', 'status:Backlog'],
      receipt: {
        issueType: 'Feature',
        fields: {
          Priority: 'P2',
          Severity: null,
        },
        milestone: 'POST RELEASE 1.1',
        project: { membershipCount: 1, status: 'Backlog' },
      },
    },
  });
  assert.match(comment, /Outcome: \*\*COMPLETE\*\*/);
  assert.match(comment, /Milestone `POST RELEASE 1\.1`/);
  assert.match(comment, /Project #5: membership `1`, Status `Backlog`/);
  assert.match(comment, /issue-metadata/);
});

test('KB owner travels through validated bridge queue into canonical writer', () => {
  const request = {
    target: 'ChipIn-one/chipin-knowledge-base#33',
    issueType: 'Task',
    priority: 'P2',
    severity: 'none',
    owner: 'syllik',
  };
  const parsed = parseRequestBody(body(request));
  assert.equal(parsed.owner, 'syllik');
  const validated = validateQueuedRequest(config, {
    ...request,
    schemaVersion: 1,
    requestIssue: 100,
    requestIssueUrl: 'https://github.com/ChipIn-one/.github/issues/100',
    actor: 'syllik',
    triggerActor: 'syllik',
  });
  assert.equal(validated.valid, true);
  assert.equal(validated.request.owner, 'syllik');
  const args = buildIntakeArgs(validated.request, 'receipt.json');
  assert.equal(args[args.indexOf('--owner') + 1], 'syllik');
  const noOwner = validateQueuedRequest(config, { ...request, owner: undefined });
  assert.equal(noOwner.valid, false);
  assert.match(noOwner.blockers.join('\n'), /explicitly selected/);
  const wrongFixedOwner = validateQueuedRequest(config, { ...request, target: 'ChipIn-one/chipin-backend#168' });
  assert.match(wrongFixedOwner.blockers.join('\n'), /Owner policy conflict/);
});

test('a pending read-back is a distinct retryable bridge status, not a blocker', () => {
  const target = 'ChipIn-one/chipin-frontend#466';
  const pending = { issue: target, action: 'pending-readback', blockers: [], receipt: null, pending: { code: 'PROJECT_MEMBERSHIP_READBACK_PENDING', detail: 'listing lag' } };
  let blockers = [];
  assert.equal(intakeStatus(pending, target, blockers), 'pending');
  assert.deepEqual(blockers, []);

  blockers = [];
  assert.equal(intakeStatus({ ...pending, issue: 'ChipIn-one/chipin-frontend#1' }, target, blockers), 'blocked');
  assert.equal(blockers.length, 1);

  blockers = [];
  assert.equal(intakeStatus({ issue: target, action: 'complete', receipt: { status: 'INTAKE_COMPLETE' } }, target, blockers), 'complete');
  blockers = [];
  assert.equal(intakeStatus({ issue: target, action: 'incomplete', blockers: ['x'] }, target, ['x']), 'blocked');

  const comment = renderReceiptComment({
    status: 'pending',
    blockers: [],
    request: { target, issueType: 'Task', priority: 'P2', severity: 'none' },
    intake: { applied: ['issue-metadata', 'project-membership'], receipt: null },
    pending: pending.pending,
  }, 42);
  assert.match(comment, /Outcome: \*\*PENDING\*\*/);
  assert.match(comment, /PROJECT_MEMBERSHIP_READBACK_PENDING/);
  assert.match(comment, /next drain retries it automatically/);
  assert.doesNotMatch(comment, /edit\/reopen this request to retry/);
  assert.match(comment, /"status":"pending"/);

  const queued = { schemaVersion: 1, requestIssue: 100, target, issueType: 'Task', priority: 'P2', severity: 'none' };
  const comments = [
    { id: 10, user: { login: 'github-actions[bot]' }, body: renderQueueComment(queued) },
    { id: 11, user: { login: 'github-actions[bot]' }, body: comment.replace('"queueCommentId":42', '"queueCommentId":10') },
  ];
  assert.deepEqual(pendingQueueItems({ number: 100 }, comments).map((entry) => [entry.id, entry.pendingRetries]), [[10, 1]]);
  const blockedComments = [
    comments[0],
    { id: 12, user: { login: 'github-actions[bot]' }, body: renderReceiptComment({ status: 'blocked', blockers: ['x'], request: queued, intake: null }, 10) },
  ];
  assert.deepEqual(pendingQueueItems({ number: 100 }, blockedComments), []);
});

test('drain keeps a pending control Issue open, closes the others, and reports outcome pending without attention', async () => {
  const target = 'ChipIn-one/chipin-frontend#466';
  const queuedPending = { schemaVersion: 1, requestIssue: 140, target, issueType: 'Task', priority: 'P2', severity: 'none' };
  const queuedDone = { ...queuedPending, requestIssue: 141, target: 'ChipIn-one/chipin-frontend#467' };
  const calls = [];
  const queueClient = {
    listAll: async (path) => {
      calls.push(path);
      if (path.startsWith('/repos/ChipIn-one/.github/issues?')) {
        return [
          { number: 140, title: '[issue-intake] ' + target, html_url: 'u140' },
          { number: 141, title: '[issue-intake] ChipIn-one/chipin-frontend#467', html_url: 'u141' },
          { number: 142, title: 'unrelated', html_url: 'u142' },
        ];
      }
      if (path.endsWith('/issues/140/comments')) return [{ id: 10, user: { login: 'github-actions[bot]' }, body: renderQueueComment(queuedPending) }];
      if (path.endsWith('/issues/141/comments')) return [{ id: 20, user: { login: 'github-actions[bot]' }, body: renderQueueComment(queuedDone) }];
      throw new Error('unexpected ' + path);
    },
    request: async (path, options) => { calls.push(path + ' ' + options.method + ' ' + JSON.stringify(options.body)); return {}; },
  };
  const intakeRunner = async (argv) => {
    const issue = argv[2];
    if (issue === target) return { issue, action: 'pending-readback', blockers: [], receipt: null, applied: ['project-membership'], pending: { code: 'PROJECT_MEMBERSHIP_READBACK_PENDING', detail: 'lag' } };
    return { issue, action: 'complete', blockers: [], applied: [], receipt: { status: 'INTAKE_COMPLETE', fields: {}, project: { membershipCount: 1, status: 'Backlog' } } };
  };

  const summary = await drainQueue({ config, queueClient, writeToken: 'w', intakeRunner, state: 'open' });
  assert.equal(summary.outcome, 'pending');
  assert.deepEqual(summary.entries.map((entry) => [entry.requestIssue, entry.status]), [[140, 'pending'], [141, 'complete']]);
  assert.ok(calls[0].includes('state=open'));
  assert.ok(!calls.some((call) => call.startsWith('/repos/ChipIn-one/.github/issues/140 PATCH')), 'pending Issue must stay open');
  assert.ok(calls.some((call) => call.startsWith('/repos/ChipIn-one/.github/issues/141 PATCH')), 'completed Issue is closed');
  const pendingComment = calls.find((call) => call.startsWith('/repos/ChipIn-one/.github/issues/140/comments POST'));
  assert.match(pendingComment, /PENDING/);

  await assert.rejects(drainQueue({ config, queueClient, writeToken: 'w', intakeRunner, state: 'closed' }), /Drain state must be all or open/);
});

test('scheduled retry drain exists, is serialized with the writers and scans open control Issues only', async () => {
  const workflow = await readFile(new URL('../.github/workflows/issue-intake-drain-retry.yml', import.meta.url), 'utf8');
  assert.match(workflow, /^  schedule:$/m);
  assert.match(workflow, /group: canonical-issue-intake-writes/);
  assert.match(workflow, /issue-intake-request\.mjs drain/);
  assert.match(workflow, /--state open/);
  assert.doesNotMatch(workflow, /issue-intake\.mjs apply/);
});

test('a request still pending after MAX_PENDING_RETRIES results is reported BLOCKED and its control Issue closed', async () => {
  const target = 'ChipIn-one/chipin-frontend#466';
  const queued = { schemaVersion: 1, requestIssue: 140, target, issueType: 'Task', priority: 'P2', severity: 'none' };
  const pendingReceipt = { status: 'pending', blockers: [], request: queued, intake: { applied: [], receipt: null }, pending: { code: 'PROJECT_MEMBERSHIP_READBACK_PENDING', detail: 'lag' } };
  const comments = (count) => [
    { id: 10, user: { login: 'github-actions[bot]' }, body: renderQueueComment(queued) },
    ...Array.from({ length: count }, (_, index) => ({ id: 11 + index, user: { login: 'github-actions[bot]' }, body: renderReceiptComment(pendingReceipt, 10) })),
  ];
  const makeClient = (count) => {
    const calls = [];
    return { calls, client: {
      listAll: async (path) => {
        if (path.startsWith('/repos/ChipIn-one/.github/issues?')) return [{ number: 140, title: '[issue-intake] ' + target, html_url: 'u' }];
        if (path.endsWith('/issues/140/comments')) return comments(count);
        throw new Error('unexpected ' + path);
      },
      request: async (path, options) => { calls.push(path + ' ' + options.method + ' ' + JSON.stringify(options.body)); return {}; },
    } };
  };
  const stillPending = async (argv) => ({ issue: argv[2], action: 'pending-readback', blockers: [], receipt: null, applied: [], pending: { code: 'PROJECT_MEMBERSHIP_READBACK_PENDING', detail: 'lag' } });

  const fifth = makeClient(5);
  const summaryPending = await drainQueue({ config, queueClient: fifth.client, writeToken: 'w', intakeRunner: stillPending, state: 'open' });
  assert.equal(summaryPending.outcome, 'pending');
  assert.ok(!fifth.calls.some((call) => call.includes('/issues/140 PATCH')), 'still retrying: Issue stays open');

  const sixth = makeClient(6);
  const summaryBlocked = await drainQueue({ config, queueClient: sixth.client, writeToken: 'w', intakeRunner: stillPending, state: 'open' });
  assert.equal(summaryBlocked.outcome, 'attention-required');
  assert.match(summaryBlocked.entries[0].blockers.join(' '), /still pending after 6 retries/);
  assert.ok(sixth.calls.some((call) => call.includes('/issues/140 PATCH')), 'blocked: Issue is closed');
  assert.match(sixth.calls.find((call) => call.includes('/comments POST')), /BLOCKED/);

  // a run that completes after earlier PENDING results closes the Issue normally
  const completes = makeClient(2);
  const summaryComplete = await drainQueue({ config, queueClient: completes.client, writeToken: 'w', state: 'open',
    intakeRunner: async (argv) => ({ issue: argv[2], action: 'complete', blockers: [], applied: [], receipt: { status: 'INTAKE_COMPLETE', fields: {}, project: { membershipCount: 1, status: 'Backlog' } } }) });
  assert.equal(summaryComplete.outcome, 'complete');
  assert.ok(completes.calls.some((call) => call.includes('/issues/140 PATCH')));
});
