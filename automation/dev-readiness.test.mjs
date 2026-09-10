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

test('open blocker already at DEV no longer blocks integration readiness', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
    blockers: [{ state: 'open', projectStatus: 'DEV' }],
  });
  assert.equal(result.state, 'READY_FOR_DEV');
});

test('unsupported blocker state fails closed even when Project status is DEV', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
    blockers: [{ state: 'archived', projectStatus: 'DEV' }],
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
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

test('reopened required work after PROD is inconsistent', () => {
  const result = evaluateDevReadiness({
    ...base,
    currentStatus: 'PROD',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'open', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'INCONSISTENT');
});

test('already DEV delivery does not propose another DEV transition', () => {
  const result = evaluateDevReadiness({
    ...base,
    currentStatus: 'DEV',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'NOT_READY');
});

test('PROD delivery never proposes a DEV transition', () => {
  const result = evaluateDevReadiness({
    ...base,
    currentStatus: 'PROD',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'NOT_READY');
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

test('unknown Project status fails closed', () => {
  const result = evaluateDevReadiness({
    ...base,
    currentStatus: 'Unknown status',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('unknown work kind fails closed even with explicit delivery class', () => {
  const result = evaluateDevReadiness({
    ...base,
    workKind: 'Incident',
    deliveryClass: 'code',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('unsupported delivery class fails closed', () => {
  const result = evaluateDevReadiness({
    ...base,
    deliveryClass: 'mixed',
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('null required items fail closed instead of throwing', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: null,
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('null blockers fail closed instead of throwing', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
    blockers: null,
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('omitted blockers fail closed instead of assuming an empty successful read', () => {
  const result = evaluateDevReadiness({
    repository: 'ChipIn-one/chipin-frontend',
    currentStatus: 'In Progress',
    workKind: 'Feature',
    requiredItems: [{ kind: 'pr', state: 'merged', baseBranch: 'dev' }],
    metadataReadable: true,
    projectReadable: true,
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('omitted required items fail closed instead of assuming an empty successful read', () => {
  const result = evaluateDevReadiness({
    repository: 'ChipIn-one/chipin-frontend',
    currentStatus: 'In Progress',
    workKind: 'Feature',
    blockers: [],
    metadataReadable: true,
    projectReadable: true,
  });
  assert.equal(result.state, 'BLOCKED_UNKNOWN');
});

test('required merged PR without base branch fails closed', () => {
  const result = evaluateDevReadiness({
    ...base,
    repository: 'ChipIn-one/chipin-frontend',
    requiredItems: [{ kind: 'pr', state: 'merged' }],
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
