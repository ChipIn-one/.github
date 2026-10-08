import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluateIssueForCompletion } from "./frontend-production-completion-policy.mjs";
import {
  closeIssueAsCompleted,
  compareContainsCommit,
  readProductionReleases,
  readRequiredRelationships,
  reconcileOpenDoneProjectStatus,
  runCompletionSweep,
} from "./frontend-production-completion.mjs";

const repository = "ChipIn-one/chipin-frontend";

function linkedPr({
  number = 10,
  mergedAt = "2026-10-01T10:00:00Z",
  mergeCommitSha = "1111111111111111111111111111111111111111",
  baseRefName = "dev",
  headRefName = "feat/issue-1-work",
  headRepository = repository,
  prRepository = repository,
} = {}) {
  return {
    number,
    state: "MERGED",
    mergedAt,
    mergeCommitSha,
    baseRefName,
    headRefName,
    headRepository,
    repository: prRepository,
  };
}

function issue({
  number = 1,
  state = "OPEN",
  updatedAt = "2026-10-07T10:00:00Z",
  lastEditedAt = null,
  reopenedAt = null,
  linkedBranchCount = 0,
  linkedPullRequests = [linkedPr()],
  linkedPullRequestTotalCount = linkedPullRequests.length,
  requiredRelationshipsReadable = true,
  blockedBy = [],
  subIssues = [],
  milestone = null,
} = {}) {
  return {
    number,
    state,
    updatedAt,
    lastEditedAt,
    reopenedAt,
    linkedBranchCount,
    linkedPullRequests,
    linkedPullRequestTotalCount,
    requiredRelationshipsReadable,
    blockedBy,
    subIssues,
    milestone,
  };
}

function release({
  number = 20,
  mergedAt = "2026-10-02T10:00:00Z",
  headSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
} = {}) {
  return { number, mergedAt, headSha };
}

test("keeps a dev-only implementation Issue open", async () => {
  const decision = await evaluateIssueForCompletion(issue(), {
    repository,
    releases: [],
    containsCommit: async () => false,
  });

  assert.equal(decision.action, "leave-open");
  assert.equal(decision.code, "awaiting-production");
});

test("closes only after implementation is contained by a merged dev-to-main release", async () => {
  const decision = await evaluateIssueForCompletion(issue(), {
    repository,
    releases: [release()],
    containsCommit: async (commitSha, releaseHeadSha) => (
      commitSha === "1111111111111111111111111111111111111111"
      && releaseHeadSha === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ),
  });

  assert.equal(decision.action, "close-completed");
  assert.match(decision.detail, /release PR #20/u);
});

test("multiple linked implementation PRs stay open until every change reaches production", async () => {
  const first = linkedPr({
    number: 10,
    mergeCommitSha: "1111111111111111111111111111111111111111",
  });
  const second = linkedPr({
    number: 11,
    mergedAt: "2026-10-03T10:00:00Z",
    mergeCommitSha: "2222222222222222222222222222222222222222",
  });
  const target = issue({ linkedPullRequests: [first, second] });
  const releases = [
    release({ number: 20, headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    release({
      number: 21,
      mergedAt: "2026-10-04T10:00:00Z",
      headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }),
  ];

  const blocked = await evaluateIssueForCompletion(target, {
    repository,
    releases,
    containsCommit: async (commitSha, releaseHeadSha) => (
      commitSha === first.mergeCommitSha
      && releaseHeadSha === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    ),
  });
  assert.equal(blocked.code, "awaiting-production");

  const complete = await evaluateIssueForCompletion(target, {
    repository,
    releases,
    containsCommit: async (commitSha, releaseHeadSha) => (
      (commitSha === first.mergeCommitSha
        && releaseHeadSha === "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
      || (commitSha === second.mergeCommitSha
        && releaseHeadSha === "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
    ),
  });
  assert.equal(complete.action, "close-completed");
});

test("missing or ambiguous Development evidence blocks completion", async () => {
  const missing = await evaluateIssueForCompletion(issue({
    linkedPullRequests: [],
    linkedPullRequestTotalCount: 0,
  }), { repository, releases: [], containsCommit: async () => false });
  assert.equal(missing.code, "missing-development");
  assert.match(missing.detail, /Development/u);

  const incomplete = await evaluateIssueForCompletion(issue({
    linkedPullRequests: [linkedPr()],
    linkedPullRequestTotalCount: 2,
  }), { repository, releases: [], containsCommit: async () => false });
  assert.equal(incomplete.code, "ambiguous-development");

  const pendingBranch = await evaluateIssueForCompletion(issue({
    linkedBranchCount: 1,
    linkedPullRequests: [],
    linkedPullRequestTotalCount: 0,
  }), { repository, releases: [], containsCommit: async () => false });
  assert.equal(pendingBranch.code, "development-branch-pending");

  const crossRepository = await evaluateIssueForCompletion(issue({
    linkedPullRequests: [linkedPr({ prRepository: "ChipIn-one/chipin-backend" })],
  }), { repository, releases: [release()], containsCommit: async () => true });
  assert.equal(crossRepository.code, "ambiguous-development");
});

test("required native relationships fail closed while unfinished or unreadable", async () => {
  const unreadable = await evaluateIssueForCompletion(issue({
    requiredRelationshipsReadable: false,
  }), {
    repository,
    releases: [release()],
    containsCommit: async () => true,
  });
  assert.equal(unreadable.code, "required-relationships-unreadable");

  const openSubIssue = await evaluateIssueForCompletion(issue({
    subIssues: [{ repository, number: 99, state: "open", stateReason: null }],
  }), {
    repository,
    releases: [release()],
    containsCommit: async () => true,
  });
  assert.equal(openSubIssue.code, "required-sub-issue-incomplete");
  assert.match(openSubIssue.detail, /#99/u);

  const cancelledSubIssue = await evaluateIssueForCompletion(issue({
    subIssues: [{ repository, number: 98, state: "closed", stateReason: "not_planned" }],
  }), {
    repository,
    releases: [release()],
    containsCommit: async () => true,
  });
  assert.equal(cancelledSubIssue.code, "required-sub-issue-incomplete");
  assert.match(cancelledSubIssue.detail, /closed\/not_planned/u);

  const missingReasonSubIssue = await evaluateIssueForCompletion(issue({
    subIssues: [{ repository, number: 97, state: "closed", stateReason: null }],
  }), {
    repository,
    releases: [release()],
    containsCommit: async () => true,
  });
  assert.equal(missingReasonSubIssue.code, "required-sub-issue-incomplete");

  const openBlocker = await evaluateIssueForCompletion(issue({
    blockedBy: [{ repository, number: 77, state: "open" }],
  }), {
    repository,
    releases: [release()],
    containsCommit: async () => true,
  });
  assert.equal(openBlocker.code, "blocked-by-open-issue");
  assert.match(openBlocker.detail, /#77/u);

  const finishedRelationships = await evaluateIssueForCompletion(issue({
    subIssues: [{ repository, number: 99, state: "closed", stateReason: "completed" }],
    blockedBy: [{ repository, number: 77, state: "closed" }],
  }), {
    repository,
    releases: [release()],
    containsCommit: async () => true,
  });
  assert.equal(finishedRelationships.action, "close-completed");
});

test("reopened or edited scope requires fresh implementation evidence", async () => {
  const oldPr = linkedPr({
    number: 10,
    mergedAt: "2026-10-01T10:00:00Z",
    mergeCommitSha: "1111111111111111111111111111111111111111",
  });
  const reopened = issue({
    reopenedAt: "2026-10-05T10:00:00Z",
    linkedPullRequests: [oldPr],
  });

  const stale = await evaluateIssueForCompletion(reopened, {
    repository,
    releases: [release({
      number: 20,
      mergedAt: "2026-10-02T10:00:00Z",
    })],
    containsCommit: async () => true,
  });
  assert.equal(stale.code, "scope-changed-after-implementation");

  const newPr = linkedPr({
    number: 12,
    mergedAt: "2026-10-06T10:00:00Z",
    mergeCommitSha: "3333333333333333333333333333333333333333",
  });
  const refreshed = await evaluateIssueForCompletion(issue({
    reopenedAt: "2026-10-05T10:00:00Z",
    lastEditedAt: "2026-10-05T11:00:00Z",
    linkedPullRequests: [oldPr, newPr],
  }), {
    repository,
    releases: [release({
      number: 22,
      mergedAt: "2026-10-06T12:00:00Z",
      headSha: "cccccccccccccccccccccccccccccccccccccccc",
    })],
    containsCommit: async () => true,
  });
  assert.equal(refreshed.action, "close-completed");
});

test("milestone presence does not gate production completion", async () => {
  for (const milestone of [null, { title: "POST RELEASE 1.1" }]) {
    const decision = await evaluateIssueForCompletion(issue({ milestone }), {
      repository,
      releases: [release()],
      containsCommit: async () => true,
    });
    assert.equal(decision.action, "close-completed");
  }
});

test("canonical linked dev-to-main PR is itself production evidence", async () => {
  const releasePr = linkedPr({
    number: 30,
    baseRefName: "main",
    headRefName: "dev",
    headRepository: repository,
  });
  const decision = await evaluateIssueForCompletion(issue({
    linkedPullRequests: [releasePr],
  }), { repository, releases: [], containsCommit: async () => false });

  assert.equal(decision.action, "close-completed");
});

test("manual closure and stale snapshots are never overwritten or reopened", async () => {
  const closedCalls = [];
  const closedClient = {
    request: async (path, options = {}) => {
      closedCalls.push({ path, options });
      return { state: "closed", state_reason: "not_planned" };
    },
  };
  const alreadyClosed = await closeIssueAsCompleted(closedClient, issue(), repository);
  assert.equal(alreadyClosed.mutated, false);
  assert.equal(alreadyClosed.code, "already-closed");
  assert.equal(closedCalls.length, 1);

  const staleCalls = [];
  const staleClient = {
    request: async (path, options = {}) => {
      staleCalls.push({ path, options });
      return { state: "open", updated_at: "2026-10-07T11:00:00Z" };
    },
  };
  const stale = await closeIssueAsCompleted(staleClient, issue(), repository);
  assert.equal(stale.mutated, false);
  assert.equal(stale.code, "stale-snapshot");
  assert.equal(staleCalls.length, 1);
});

test("completion write is idempotent and uses only closed/completed", async () => {
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (options.method === "PATCH") {
        return { state: "closed", state_reason: "completed" };
      }
      return { state: "open", updated_at: "2026-10-07T10:00:00Z" };
    },
  };

  const result = await closeIssueAsCompleted(client, issue(), repository);
  assert.equal(result.mutated, true);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.body, {
    state: "closed",
    state_reason: "completed",
  });
});

test("required relationship reads normalize native sub-issues and blockers", async () => {
  const client = {
    listAll: async (path) => {
      if (path.endsWith("/dependencies/blocked_by")) {
        return [{
          number: 7,
          state: "open",
          state_reason: null,
          repository_url: "https://api.github.com/repos/ChipIn-one/chipin-frontend",
        }];
      }
      if (path.endsWith("/sub_issues")) {
        return [{
          number: 8,
          state: "closed",
          state_reason: "completed",
          repository_url: "https://api.github.com/repos/ChipIn-one/chipin-frontend",
        }];
      }
      throw new Error("unexpected relationship path");
    },
  };

  const relationships = await readRequiredRelationships(client, repository, 1);
  assert.equal(relationships.requiredRelationshipsReadable, true);
  assert.deepEqual(relationships.blockedBy, [{
    repository,
    number: 7,
    state: "open",
    stateReason: null,
  }]);
  assert.deepEqual(relationships.subIssues, [{
    repository,
    number: 8,
    state: "closed",
    stateReason: "completed",
  }]);
});

test("reopened open Issue cannot remain in derived Done", async () => {
  let status = "Done";
  const calls = [];
  const client = {
    request: async (path) => {
      calls.push({ kind: "request", path });
      return { state: "open" };
    },
    graphql: async (query, variables) => {
      if (query.includes("query FrontendCompletionProjectItem")) {
        calls.push({ kind: "read-status", variables });
        return {
          node: {
            id: "PVTI_issue_1",
            fieldValueByName: status ? { name: status } : null,
          },
        };
      }
      if (query.includes("mutation SetFrontendCompletionStatus")) {
        calls.push({ kind: "set-status", variables });
        assert.equal(variables.optionId, "option-in-progress");
        status = "In Progress";
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_issue_1" } } };
      }
      throw new Error("unexpected GraphQL operation");
    },
  };
  const project = {
    id: "PVT_project_5",
    fields: [{
      id: "PVTF_status",
      name: "Status",
      isIssueField: false,
      options: [
        { id: "option-in-progress", name: "In Progress" },
        { id: "option-done", name: "Done" },
      ],
    }],
    items: [{ id: "PVTI_issue_1", repository, number: 1, status: "Done" }],
  };

  const result = await reconcileOpenDoneProjectStatus(client, issue({ reopenedAt: "2026-10-05T10:00:00Z" }), project);
  assert.equal(result.mutated, true);
  assert.equal(result.code, "project-status-reactivated");
  assert.equal(status, "In Progress");
  assert.equal(calls.filter((call) => call.kind === "set-status").length, 1);
});

test("project normalization never turns a closed not-planned Issue into Done", async () => {
  let mutationCount = 0;
  const client = {
    request: async () => ({ state: "closed", state_reason: "not_planned" }),
    graphql: async (query) => {
      if (query.includes("query FrontendCompletionProjectItem")) {
        return { node: { id: "PVTI_issue_1", fieldValueByName: { name: "Done" } } };
      }
      mutationCount += 1;
      throw new Error("status mutation must not run for a closed Issue");
    },
  };
  const project = {
    id: "PVT_project_5",
    fields: [{
      id: "PVTF_status",
      name: "Status",
      isIssueField: false,
      options: [{ id: "option-in-progress", name: "In Progress" }],
    }],
    items: [{ id: "PVTI_issue_1", repository, number: 1, status: "Done" }],
  };

  const result = await reconcileOpenDoneProjectStatus(client, issue(), project);
  assert.equal(result.mutated, false);
  assert.equal(result.code, "issue-no-longer-open");
  assert.equal(mutationCount, 0);
});

test("privileged completion workflow runs only from trusted master events and cannot dispatch branch code", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/frontend-production-completion.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /^  push:$/m);
  assert.match(workflow, /^    branches:\n      - master$/m);
  assert.match(workflow, /^  schedule:$/m);
  assert.doesNotMatch(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /CHIPIN_ISSUE_WRITE_TOKEN/u);
});

test("repository-local completion skips Project access and still closes production-complete Issues", async () => {
  let patched = false;
  const mergeCommitSha = "1111111111111111111111111111111111111111";
  const releaseHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const client = {
    graphql: async (query) => {
      if (!query.includes("query FrontendCompletionCandidates")) {
        throw new Error("Project GraphQL must not run in repository-local mode");
      }
      return {
        repository: {
          issues: {
            totalCount: 1,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [{
              number: 1,
              title: "Production-complete",
              url: "https://github.com/ChipIn-one/chipin-frontend/issues/1",
              state: "OPEN",
              updatedAt: "2026-10-07T10:00:00Z",
              lastEditedAt: null,
              linkedBranches: { totalCount: 0 },
              timelineItems: { nodes: [] },
              closedByPullRequestsReferences: {
                totalCount: 1,
                nodes: [{
                  number: 10,
                  url: "https://github.com/ChipIn-one/chipin-frontend/pull/10",
                  state: "MERGED",
                  mergedAt: "2026-10-01T10:00:00Z",
                  baseRefName: "dev",
                  headRefName: "feat/issue-1-work",
                  headRefOid: "2222222222222222222222222222222222222222",
                  repository: { nameWithOwner: repository },
                  headRepository: { nameWithOwner: repository },
                  mergeCommit: { oid: mergeCommitSha },
                }],
              },
            }],
          },
        },
      };
    },
    listAll: async (path) => {
      if (path.includes("/pulls?state=closed&base=main")) {
        return [{
          number: 20,
          merged_at: "2026-10-02T10:00:00Z",
          base: { ref: "main" },
          head: { ref: "dev", sha: releaseHeadSha, repo: { full_name: repository } },
          html_url: "https://github.com/ChipIn-one/chipin-frontend/pull/20",
        }];
      }
      if (path.endsWith("/dependencies/blocked_by") || path.endsWith("/sub_issues")) return [];
      throw new Error("Unexpected list path: " + path);
    },
    request: async (path, options = {}) => {
      if (path.includes("/compare/")) {
        return { status: "ahead", merge_base_commit: { sha: mergeCommitSha } };
      }
      if (path.endsWith("/issues/1") && (options.method ?? "GET") === "GET") {
        return { state: "open", updated_at: "2026-10-07T10:00:00Z" };
      }
      if (path.endsWith("/issues/1") && options.method === "PATCH") {
        patched = true;
        assert.deepEqual(options.body, { state: "closed", state_reason: "completed" });
        return { state: "closed", state_reason: "completed" };
      }
      throw new Error("Unexpected request path: " + path);
    },
  };

  const results = await runCompletionSweep(client, repository, { reconcileProjectStatus: false });

  assert.equal(patched, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].decision.code, "closed-completed");
});

test("repository-local composite action uses only the caller repository token and disables Project reconciliation", async () => {
  const action = await readFile(
    new URL("./frontend-production-completion-action/action.yml", import.meta.url),
    "utf8",
  );
  assert.match(action, /CHIPIN_FRONTEND_COMPLETION_PROJECT_RECONCILE: "0"/u);
  assert.match(action, /GITHUB_REPOSITORY/u);
  assert.match(action, /ChipIn-one\/chipin-frontend/u);
  assert.match(action, /frontend-production-completion\.mjs/u);
});

test("production release discovery ignores non-canonical main merges", async () => {
  const client = {
    listAll: async () => [
      {
        number: 20,
        merged_at: "2026-10-02T10:00:00Z",
        base: { ref: "main" },
        head: {
          ref: "dev",
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          repo: { full_name: repository },
        },
        html_url: "https://github.com/ChipIn-one/chipin-frontend/pull/20",
      },
      {
        number: 21,
        merged_at: "2026-10-03T10:00:00Z",
        base: { ref: "main" },
        head: {
          ref: "hotfix",
          sha: "cccccccccccccccccccccccccccccccccccccccc",
          repo: { full_name: repository },
        },
      },
      {
        number: 22,
        merged_at: "2026-10-04T10:00:00Z",
        base: { ref: "main" },
        head: {
          ref: "dev",
          sha: "dddddddddddddddddddddddddddddddddddddddd",
          repo: { full_name: "fork/chipin-frontend" },
        },
      },
    ],
  };

  const releases = await readProductionReleases(client, repository);
  assert.deepEqual(releases.map((item) => item.number), [20]);
});

test("commit containment accepts only an ancestor comparison", async () => {
  const commit = "1111111111111111111111111111111111111111";
  const head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const acceptedClient = {
    request: async () => ({
      status: "ahead",
      merge_base_commit: { sha: commit },
    }),
  };
  assert.equal(await compareContainsCommit(acceptedClient, repository, commit, head), true);

  const rejectedClient = {
    request: async () => ({
      status: "diverged",
      merge_base_commit: { sha: "2222222222222222222222222222222222222222" },
    }),
  };
  assert.equal(await compareContainsCommit(rejectedClient, repository, commit, head), false);
});
