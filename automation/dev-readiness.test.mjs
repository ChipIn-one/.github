import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDevReadiness } from './dev-readiness.mjs';

const base = {
  currentStatus: 'In Progress',
  workKind: 'Feature',
  requiredItems: [],
  blockers: [],
  metadataReadable: true,
  projectReadable: true,
};

test('standalone frontend delivery is ready when its required PR is merged to dev', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'READY_FOR_DEV');
});

test('backend delivery is not ready when required PR targets the wrong branch', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-backend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'main' }],
  });
  assert.equal(result.state, 'NOT_READY');
});

test('composite parent waits for any incomplete required sub-issue', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-knowledge-base',
    isCompositeParent: true,
    requiredItems: [
      { kind: 'subissue', state: 'DEV' },
      { kind: 'subissue', state: 'In Progress' },
    ],
  });
  assert.equal(result.state, 'NOT_READY');
});

test('open blocker prevents DEV readiness', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
    blockers: [{ state: 'open' }],
  });
  assert.equal(result.state, 'NOT_READY');
});

test('unreadable structured metadata fails closed', () => {
  const result = evaluateDevReadiness({ ...base, metadataReadable: false });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('reopened required work after DEV is inconsistent', () => {
  const result = evaluateDevReadiness({
    ...base,
    currentStatus: 'DEV',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'open', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'INCONSISTENT');
});

test('standalone non-code task never auto-transitions to DEV', () => {
  const result = evaluateDevReadiness({
    ...base,
    workKind: 'Task',
    deliveryClass: 'non-code',
    repository: 'ChipIn-one/chipin-knowledge-base',
  });
  assert.equal(result.state, 'NOT_READY');
});

test('ambiguous Task fails closed', () => {
  const result = evaluateDevReadiness({
    ...base,
    workKind: 'Task',
    repository: 'ChipIn-one/chipin-frontend',
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('missing readability flags fail closed', () => {
  const result = evaluateDevReadiness({
    repository: 'ChipIn-one/chipin-frontend',
    currentStatus: 'In Progress',
    workKind: 'Feature',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});
