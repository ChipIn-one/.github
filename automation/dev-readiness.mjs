const INTEGRATION_BRANCHES = Object.freeze({
  'ChipIn-one/chipin-frontend': 'dev',
  'ChipIn-one/chipin-backend': 'develop',
  'ChipIn-one/chipin-knowledge-base': 'main',
});

const KNOWN_PROJECT_STATUSES = new Set([
  'Backlog',
  'Todo',
  'In Progress',
  'DEV',
  'PROD',
  'Done',
]);

const KNOWN_WORK_KINDS = new Set(['Task', 'Feature', 'Bug']);
const KNOWN_DELIVERY_CLASSES = new Set(['code', 'non-code']);
const COMPLETE_DEPENDENCY_STATUSES = new Set(['DEV', 'PROD', 'Done']);

function result(state, reason) {
  return { state, reason };
}

function hasUnreadableRelation(items) {
  return items.some((item) => item?.readable === false || !item?.state);
}

function blockerState(input) {
  if (hasUnreadableRelation(input.blockers)) {
    return result('BLOCKED_UNKNOWN', 'A blocking relationship is unreadable.');
  }

  for (const blocker of input.blockers) {
    if (blocker.state === 'closed') {
      continue;
    }

    if (
      blocker.projectStatus !== undefined
      && !KNOWN_PROJECT_STATUSES.has(blocker.projectStatus)
    ) {
      return result('BLOCKED_UNKNOWN', 'A blocker has an unknown Project status.');
    }

    if (COMPLETE_DEPENDENCY_STATUSES.has(blocker.projectStatus)) {
      continue;
    }

    return result('NOT_READY', 'At least one required blocker is not integrated yet.');
  }

  return null;
}

function classifyDelivery(input) {
  if (input.deliveryClass !== undefined) {
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
    (item) => item.kind === 'subissue' && COMPLETE_DEPENDENCY_STATUSES.has(item.state),
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
  const source = rawInput ?? {};
  const blockersRead = Object.hasOwn(source, 'blockers');
  const input = {
    requiredItems: [],
    blockers: [],
    metadataReadable: false,
    projectReadable: false,
    isCompositeParent: false,
    ...source,
  };

  if (!input.metadataReadable || !input.projectReadable) {
    return result('BLOCKED_UNKNOWN', 'Required structured GitHub state is unreadable.');
  }

  if (!input.repository || !input.currentStatus || !input.workKind) {
    return result('BLOCKED_UNKNOWN', 'Required structured GitHub state is missing.');
  }

  if (!blockersRead) {
    return result('BLOCKED_UNKNOWN', 'Blocking relationships were not read explicitly.');
  }

  if (!Array.isArray(input.requiredItems) || !Array.isArray(input.blockers)) {
    return result('BLOCKED_UNKNOWN', 'Required relationship collections are unreadable.');
  }

  if (!KNOWN_PROJECT_STATUSES.has(input.currentStatus)) {
    return result('BLOCKED_UNKNOWN', 'Project status is unknown.');
  }

  if (!KNOWN_WORK_KINDS.has(input.workKind)) {
    return result('BLOCKED_UNKNOWN', 'Work kind is unknown.');
  }

  if (
    input.deliveryClass !== undefined
    && !KNOWN_DELIVERY_CLASSES.has(input.deliveryClass)
  ) {
    return result('BLOCKED_UNKNOWN', 'Delivery class is unknown.');
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

  if (input.currentStatus === 'DEV' || input.currentStatus === 'PROD') {
    if (readiness.state !== 'READY_FOR_DEV') {
      return result(
        'INCONSISTENT',
        `Current status is ${input.currentStatus} but readiness recomputation is ${readiness.state}.`,
      );
    }
    return result('NOT_READY', `Current status is already ${input.currentStatus}; no DEV transition is allowed.`);
  }

  if (input.currentStatus === 'Done') {
    return result('NOT_READY', 'Current status is Done; DEV automation must not change a manual terminal state.');
  }

  return readiness;
}

export {
  INTEGRATION_BRANCHES,
  KNOWN_PROJECT_STATUSES,
  KNOWN_WORK_KINDS,
};
