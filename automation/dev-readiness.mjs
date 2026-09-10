const INTEGRATION_BRANCHES = Object.freeze({
  'ChipIn-one/chipin-frontend': 'dev',
  'ChipIn-one/chipin-backend': 'develop',
  'ChipIn-one/chipin-knowledge-base': 'main',
});

const COMPLETE_SUBISSUE_STATES = new Set(['DEV', 'PROD', 'Done']);

function result(state, reason) {
  return { state, reason };
}

function hasUnreadableRelation(items = []) {
  return items.some((item) => item?.readable === false || !item?.state);
}

function blockerState(input) {
  if (hasUnreadableRelation(input.blockers)) {
    return result('BLOCKED_UNKNOWN', 'A blocking relationship is unreadable.');
  }
  if (input.blockers.some((blocker) => blocker.state !== 'closed')) {
    return result('NOT_READY', 'At least one required blocker is still open.');
  }
  return null;
}

function classifyDelivery(input) {
  if (input.deliveryClass === 'code' || input.deliveryClass === 'non-code') {
    return input.deliveryClass;
  }
  if (input.workKind === 'Bug' || input.workKind === 'Feature') {
    return 'code';
  }
  return null;
}

function evaluateComposite(input) {
  if (!input.requiredItems.length) {
    return result('BLOCKED_UNKNOWN', 'Composite parent has no readable required sub-issues.');
  }
  if (hasUnreadableRelation(input.requiredItems)) {
    return result('BLOCKED_UNKNOWN', 'A required sub-issue is unreadable.');
  }
  const complete = input.requiredItems.every(
    (item) => item.kind === 'subissue' && COMPLETE_SUBISSUE_STATES.has(item.state),
  );
  return complete
    ? result('READY_FOR_DEV', 'All required sub-issues are complete for DEV roll-up.')
    : result('NOT_READY', 'At least one required sub-issue is not complete.');
}

function evaluateCodeDelivery(input) {
  const expectedBranch = INTEGRATION_BRANCHES[input.repository];
  if (!expectedBranch) {
    return result('BLOCKED_UNKNOWN', 'Repository has no configured integration branch.');
  }
  if (!input.requiredItems.length) {
    return result('NOT_READY', 'No required implementation PR is recorded.');
  }
  if (hasUnreadableRelation(input.requiredItems)) {
    return result('BLOCKED_UNKNOWN', 'A required implementation relationship is unreadable.');
  }
  const allIntegrated = input.requiredItems.every(
    (item) => item.kind === 'pr' && item.state === 'merged' && item.baseBranch === expectedBranch,
  );
  return allIntegrated
    ? result('READY_FOR_DEV', `All required PRs are merged to ${expectedBranch}.`)
    : result('NOT_READY', `At least one required PR is not merged to ${expectedBranch}.`);
}

export function evaluateDevReadiness(rawInput) {
  const input = {
    requiredItems: [],
    blockers: [],
    metadataReadable: true,
    projectReadable: true,
    isCompositeParent: false,
    ...rawInput,
  };

  if (!input.metadataReadable || !input.projectReadable) {
    return result('BLOCKED_UNKNOWN', 'Required structured GitHub state is unreadable.');
  }

  if (!input.repository || !input.currentStatus || !input.workKind) {
    return result('BLOCKED_UNKNOWN', 'Required structured GitHub state is missing.');
  }

  const blocked = blockerState(input);
  const deliveryClass = classifyDelivery(input);
  let readiness;

  if (!deliveryClass) {
    readiness = result('BLOCKED_UNKNOWN', 'Task delivery class is ambiguous.');
  } else if (deliveryClass === 'non-code') {
    readiness = result('NOT_READY', 'Standalone non-code work terminates at Done manually, not DEV.');
  } else if (input.isCompositeParent) {
    readiness = blocked ?? evaluateComposite(input);
  } else {
    readiness = blocked ?? evaluateCodeDelivery(input);
  }

  if (input.currentStatus === 'DEV' && readiness.state !== 'READY_FOR_DEV') {
    return result('INCONSISTENT', `Current status is DEV but readiness recomputation is ${readiness.state}.`);
  }

  return readiness;
}

export { INTEGRATION_BRANCHES };
