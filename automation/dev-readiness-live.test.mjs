import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalMetadata,
  deliveryClassFor,
  evaluateLiveIssue,
  indexProjectItems,
  normalizeDevelopment,
  parseIssueRef,
  readDevelopmentSnapshot,
} from './dev-readiness-live.mjs';

const config = {
  organization: 'ChipIn-one',
  project: { number: 5, statusField: 'Status', statusValues: ['Backlog', 'Todo', 'In Progress', 'DEV', 'PROD', 'Done'] },
  issueFields: {
    Priority: { id: 1, dataType: 'single_select', options: ['P0', 'P1', 'P2', 'P3'] },
    Severity: { id: 2, dataType: 'single_select', options: ['Critical', 'Major', 'Minor'] },
    'Release scope': { id: 3, dataType: 'single_select', options: ['PRE-PROD', 'POST-PROD'] },
  },
  issueTypes: { Task: 10, Bug: 11, Feature: 12 },
};

function issueSnapshot({ type = 'Feature', typeId = 12, priority = 'P1', scope = 'PRE-PROD', blockedBy = [], parent = null, subIssues = [] } = {}) {
  return {
    issue: { type: type ? { id: typeId, name: type } : null, labels: [{ name: 'P1' }], body: 'References: https://github.com/example/repo/pull/1' },
    issueFieldValues: [
      ...(priority ? [{ issue_field_id: 1, single_select_option: { name: priority } }] : []),
      ...(scope ? [{ issue_field_id: 3, single_select_option: { name: scope } }] : []),
    ],
    blockedBy,
    blocking: [],
    parent,
    subIssues,
    relationsReadable: true,
  };
}

function pr({ state = 'MERGED', merged = true, baseRefName = 'dev', repository = 'ChipIn-one/chipin-frontend', number = 200, mergeSha = 'abc' } = {}) {
  return {
    number,
    state,
    merged,
    baseRefName,
    headRefName: `feature/${number}`,
    mergeCommit: mergeSha ? { oid: mergeSha } : null,
    repository: { nameWithOwner: repository },
    url: `https://github.com/${repository}/pull/${number}`,
  };
}

function liveContext(items, schemaBlockers = []) {
  const project = { totalCount: items.length, items };
  return { project, projectIndex: indexProjectItems(project).index, schemaBlockers };
}

function fakeClient({ snapshot = issueSnapshot(), pullRequests = [pr()], branches = [], compareStatus = 'behind', graphqlError = null } = {}) {
  return {
    async request(path, options = {}) {
      if (path.includes('/compare/')) return { status: compareStatus };
      if (path.endsWith('/parent')) {
        if (!snapshot.parent) return null;
        return snapshot.parent.repository_url ? snapshot.parent : {
          repository_url: `https://api.github.com/repos/${snapshot.parent.repository}`,
          number: snapshot.parent.number,
          state: snapshot.parent.state,
        };
      }
      if (/\/issues\/\d+$/.test(path)) return snapshot.issue;
      throw new Error(`Unexpected request ${path} ${JSON.stringify(options)}`);
    },
    async listAll(path) {
      if (path.endsWith('/issue-field-values')) return snapshot.issueFieldValues;
      const rawRelations = (items) => items.map((item) => item.repository_url ? item : ({
        repository_url: `https://api.github.com/repos/${item.repository}`,
        number: item.number,
        state: item.state,
      }));
      if (path.endsWith('/dependencies/blocked_by')) return rawRelations(snapshot.blockedBy);
      if (path.endsWith('/dependencies/blocking')) return rawRelations(snapshot.blocking);
      if (path.endsWith('/sub_issues')) return rawRelations(snapshot.subIssues);
      throw new Error(`Unexpected list ${path}`);
    },
    async graphql(query, variables) {
      if (graphqlError) throw new Error(graphqlError);
      if (query.includes('DevReadinessPullRequests')) {
        return { repository: { issue: { closedByPullRequestsReferences: {
          nodes: pullRequests,
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } };
      }
      if (query.includes('DevReadinessBranches')) {
        return { repository: { issue: { linkedBranches: {
          nodes: branches,
          pageInfo: { hasNextPage: false, endCursor: null },
        } } } };
      }
      throw new Error(`Unexpected GraphQL query with ${JSON.stringify(variables)}`);
    },
  };
}

test('issue identities are exact owner/repository#number values', () => {
  assert.deepEqual(parseIssueRef('ChipIn-one/chipin-frontend#164'), { repository: 'ChipIn-one/chipin-frontend', number: 164 });
  assert.throws(() => parseIssueRef('https://github.com/ChipIn-one/chipin-frontend/issues/164'), /Invalid issue identity/);\n  assert.throws(() => parseIssueRef('ChipIn-one/extra/chipin-frontend#164'), /Invalid issue identity/);
});

test('Project indexing exposes duplicate issue membership instead of overwriting it', () => {
  const indexed = indexProjectItems({ items: [
    { repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'Todo' },
    { repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'DEV' },
  ] });
  assert.deepEqual(indexed.duplicates, ['ChipIn-one/chipin-frontend#1']);
});

test('canonical metadata never falls back to legacy labels or References', () => {
  const metadata = canonicalMetadata(config, issueSnapshot({ priority: null }));
  assert.match(metadata.blockers.join('\n'), /Canonical Priority is missing/);
  assert.equal(metadata.fields.Priority, null);
});

test('Task delivery class is repository-aware and composite-aware', () => {
  assert.equal(deliveryClassFor({ repository: 'ChipIn-one/chipin-frontend', workKind: 'Task', isCompositeParent: false }), 'code');
  assert.equal(deliveryClassFor({ repository: 'ChipIn-one/chipin-knowledge-base', workKind: 'Task', isCompositeParent: false }), 'non-code');
  assert.equal(deliveryClassFor({ repository: 'ChipIn-one/chipin-knowledge-base', workKind: 'Task', isCompositeParent: true }), 'code');
});

test('Development pagination reads every PR page', async () => {
  let prCalls = 0;
  const client = {
    async graphql(query, variables) {
      if (query.includes('DevReadinessPullRequests')) {
        prCalls += 1;
        if (!variables.after) return { repository: { issue: { closedByPullRequestsReferences: { nodes: [pr({ number: 1 })], pageInfo: { hasNextPage: true, endCursor: 'next' } } } } };
        return { repository: { issue: { closedByPullRequestsReferences: { nodes: [pr({ number: 2 })], pageInfo: { hasNextPage: false, endCursor: null } } } } };
      }
      return { repository: { issue: { linkedBranches: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    },
  };
  const snapshot = await readDevelopmentSnapshot(client, 'ChipIn-one/chipin-frontend', 1);
  assert.equal(prCalls, 2);
  assert.deepEqual(snapshot.pullRequests.map((item) => item.number), [1, 2]);
});

test('stacked merged PR is integrated only when its merge SHA is reachable from the intended branch', async () => {
  const normalized = await normalizeDevelopment(
    fakeClient({ pullRequests: [], compareStatus: 'behind' }),
    'ChipIn-one/chipin-frontend',
    { pullRequests: [pr({ baseRefName: 'feature/base' })], branches: [] },
  );
  assert.equal(normalized.pullRequests[0].integration, 'stacked');
  assert.equal(normalized.pullRequests[0].baseBranch, 'dev');
});

test('representative live-shape adapter decisions cover READY_FOR_DEV and NOT_READY', async () => {
  const ctx = liveContext([{ repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'In Progress' }]);
  const ready = await evaluateLiveIssue(fakeClient(), config, ctx, 'ChipIn-one/chipin-frontend', 1);
  assert.equal(ready.decision.state, 'READY_FOR_DEV');

  const notReady = await evaluateLiveIssue(
    fakeClient({ pullRequests: [pr({ state: 'OPEN', merged: false })] }),
    config,
    ctx,
    'ChipIn-one/chipin-frontend',
    1,
  );
  assert.equal(notReady.decision.state, 'NOT_READY');
});

test('missing canonical metadata produces BLOCKED_UNKNOWN even when legacy label exists', async () => {
  const ctx = liveContext([{ repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'In Progress' }]);
  const result = await evaluateLiveIssue(
    fakeClient({ snapshot: issueSnapshot({ priority: null }) }),
    config,
    ctx,
    'ChipIn-one/chipin-frontend',
    1,
  );
  assert.equal(result.decision.state, 'BLOCKED_UNKNOWN');
  assert.match(result.adapterBlockers.join('\n'), /Canonical Priority is missing/);
});

test('DEV item with reopened implementation work is INCONSISTENT', async () => {
  const ctx = liveContext([{ repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'DEV' }]);
  const result = await evaluateLiveIssue(
    fakeClient({ pullRequests: [pr({ state: 'OPEN', merged: false })] }),
    config,
    ctx,
    'ChipIn-one/chipin-frontend',
    1,
  );
  assert.equal(result.decision.state, 'INCONSISTENT');
});

test('native blockers use Project integration state and plain References do not block', async () => {
  const snapshot = issueSnapshot({ blockedBy: [{ repository: 'ChipIn-one/chipin-backend', number: 9, state: 'open' }] });
  const ctx = liveContext([
    { repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'In Progress' },
    { repository: 'ChipIn-one/chipin-backend', number: 9, status: 'DEV' },
  ]);
  const result = await evaluateLiveIssue(fakeClient({ snapshot }), config, ctx, 'ChipIn-one/chipin-frontend', 1);
  assert.equal(result.decision.state, 'READY_FOR_DEV');
});

test('KB composite parent rolls up native sub-issue statuses', async () => {
  const snapshot = issueSnapshot({
    type: 'Task', typeId: 10,
    subIssues: [{ repository: 'ChipIn-one/chipin-frontend', number: 2, state: 'open' }],
  });
  const ctx = liveContext([
    { repository: 'ChipIn-one/chipin-knowledge-base', number: 1, status: 'Todo' },
    { repository: 'ChipIn-one/chipin-frontend', number: 2, status: 'DEV' },
  ]);
  const result = await evaluateLiveIssue(
    fakeClient({ snapshot, pullRequests: [] }),
    config,
    ctx,
    'ChipIn-one/chipin-knowledge-base',
    1,
  );
  assert.equal(result.decision.state, 'READY_FOR_DEV');
});

test('unreadable Development relationship fails closed', async () => {
  const ctx = liveContext([{ repository: 'ChipIn-one/chipin-frontend', number: 1, status: 'In Progress' }]);
  const result = await evaluateLiveIssue(
    fakeClient({ graphqlError: 'forbidden' }),
    config,
    ctx,
    'ChipIn-one/chipin-frontend',
    1,
  );
  assert.equal(result.decision.state, 'BLOCKED_UNKNOWN');
  assert.match(result.adapterBlockers.join('\n'), /Development relationships unreadable/);
});
