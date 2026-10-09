import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildIntakeArgs,
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
