import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildIntakeArgs,
  parseRequestBody,
  pendingQueueItems,
  renderQueueComment,
  renderReceiptComment,
  validateRequestEvent,
} from './issue-intake-request.mjs';

const config = {
  organization: 'ChipIn-one',
  project: {
    number: 5,
    statusField: 'Status',
    statusValues: ['Backlog', 'Todo', 'In Progress', 'DEV', 'PROD', 'Done'],
  },
  issueFields: {
    Priority: { id: 1, options: ['P0', 'P1', 'P2', 'P3'] },
    Severity: { id: 2, options: ['Critical', 'Major', 'Minor'] },
    'Release scope': { id: 3, options: ['PRE-PROD', 'POST-PROD'] },
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
    releaseScope: 'POST-PROD',
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
    releaseScope: 'POST-PROD',
  })), {
    target: 'ChipIn-one/chipin-backend#146',
    issueType: 'Feature',
    priority: 'P2',
    releaseScope: 'POST-PROD',
    severity: 'none',
  });
});

test('rejects duplicate markers and unsupported payload keys', () => {
  assert.throws(
    () => parseRequestBody(body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
      releaseScope: 'POST-PROD',
    }) + '\n' + body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
      releaseScope: 'POST-PROD',
    })),
    /exactly one/,
  );
  assert.throws(
    () => parseRequestBody(body({
      target: 'ChipIn-one/chipin-frontend#308',
      issueType: 'Feature',
      priority: 'P2',
      releaseScope: 'POST-PROD',
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

test('durable queue preserves every pending snapshot even when multiple requests target the same issue', () => {
  const issue = { number: 100 };
  const queuedA = {
    schemaVersion: 1,
    requestIssue: 100,
    target: 'ChipIn-one/chipin-frontend#308',
    issueType: 'Feature',
    priority: 'P2',
    releaseScope: 'POST-PROD',
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
    releaseScope: 'POST-PROD',
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
    releaseScope: 'PRE-PROD',
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
    releaseScope: 'POST-PROD',
    severity: 'none',
  }, '/tmp/intake.json'), [
    'apply',
    'reconcile',
    'ChipIn-one/chipin-frontend#308',
    '--type',
    'Feature',
    '--priority',
    'P2',
    '--release-scope',
    'POST-PROD',
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
      releaseScope: 'POST-PROD',
      severity: 'none',
    },
    intake: {
      applied: ['issue-metadata', 'project-membership', 'status:Backlog'],
      receipt: {
        issueType: 'Feature',
        fields: {
          Priority: 'P2',
          Severity: null,
          'Release scope': 'POST-PROD',
        },
        project: { membershipCount: 1, status: 'Backlog' },
      },
    },
  });
  assert.match(comment, /Outcome: \*\*COMPLETE\*\*/);
  assert.match(comment, /Project #5: membership `1`, Status `Backlog`/);
  assert.match(comment, /issue-metadata/);
});
