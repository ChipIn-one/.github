import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyRelease,
  bumpVersion,
  formatIncludedIssuesBlock,
  formatReleaseSummary,
  githubStore,
  maxImpact,
  parseArgs,
  parseVersionImpact,
  planRelease,
  readTaskIdentity,
  runRelease,
} from "./release.mjs";
import { getRepositoryProfile } from "./registry.mjs";

const FE = "ChipIn-one/chipin-frontend";
const ORG = "ChipIn-one/.github";
const feProfile = getRepositoryProfile(FE);
const orgProfile = getRepositoryProfile(ORG);

const sha = (letter) => letter.repeat(40);

/**
 * In-memory store. `graph` maps each commit to its parents; `branches` maps branch names to heads;
 * `tags` maps tag names to commits; `pulls` lists merged PRs with their merge commit.
 */
function fakeStore({ graph, branches = {}, tags = {}, pulls = [], releases = {} } = {}) {
  const writes = [];
  const ancestors = (head) => {
    const seen = new Set();
    const stack = [head];
    while (stack.length > 0) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      for (const parent of graph[current] ?? []) stack.push(parent);
    }
    return seen;
  };
  const resolve = (ref) => {
    if (branches[ref]) return branches[ref];
    if (graph[ref]) return ref;
    throw new Error("unknown ref " + ref);
  };
  const store = {
    writes,
    async resolveCommit(ref) { return resolve(ref); },
    async listVersionTags(prefix) {
      return Object.entries(tags).filter(([name]) => name.startsWith(prefix)).map(([name, commit]) => ({ name, sha: commit }));
    },
    async compare(base, head) {
      const baseSha = resolve(base);
      const headSha = resolve(head);
      if (baseSha === headSha) return { status: "identical", commits: [], totalCommits: 0 };
      const headAncestors = ancestors(headSha);
      const baseAncestors = ancestors(baseSha);
      if (headAncestors.has(baseSha)) {
        const commits = [...headAncestors].filter((commit) => !baseAncestors.has(commit)).sort().map((commit) => ({ sha: commit }));
        return { status: "ahead", commits, totalCommits: commits.length };
      }
      if (baseAncestors.has(headSha)) return { status: "behind", commits: [], totalCommits: 0 };
      return { status: "diverged", commits: [], totalCommits: 0 };
    },
    async listCommitPulls(commit) {
      return pulls.filter((pull) => pull.commits.includes(commit)).map((pull) => ({
        number: pull.number,
        title: pull.title ?? "PR " + pull.number,
        body: pull.body ?? "",
        url: "https://github.com/x/y/pull/" + pull.number,
        mergedAt: pull.mergedAt ?? "2026-10-01T00:00:00Z",
        baseRef: pull.baseRef ?? "dev",
        author: pull.author ?? null,
        mergeCommitSha: pull.mergeCommitSha ?? pull.commits[0],
      }));
    },
    async readTagRef(tag) { return tags[tag] ? { sha: tags[tag] } : null; },
    async readRelease(tag) { return releases[tag] ?? null; },
    async createTagRef(tag, commit) {
      writes.push({ kind: "tag", tag, sha: commit });
      tags[tag] = commit;
      return { sha: commit };
    },
    async createRelease({ tag, sha: commit, body }) {
      writes.push({ kind: "release", tag, sha: commit, body });
      releases[tag] = { id: writes.length, url: "https://github.com/x/y/releases/tag/" + tag, tagName: tag, draft: false };
      return releases[tag];
    },
  };
  return store;
}

// Frontend-like history: main has release merge commits; implementation PRs merged into dev.
//   t0 (tag v1.0.8) <- m1 (dev merge PR#10, patch) <- m2 (dev merge PR#11, none) <- r1 (main merge of release PR#20)
function frontendHistory({ impacts = { 10: "patch", 11: "none" }, bodies = {} } = {}) {
  const graph = {
    [sha("0")]: [],
    [sha("1")]: [sha("0")],
    [sha("2")]: [sha("1")],
    [sha("3")]: [sha("0"), sha("2")],
  };
  const body = (number, impact) => bodies[number] ?? (
    "Task identity: ChipIn-one/chipin-frontend#" + (number + 100) + "\n\n## Summary\n\nx\n\n## Tests\n\nx\n\n## Version impact\n\n"
    + impact + "\n\n## Dependencies\n\nnone\n"
  );
  return {
    graph,
    branches: { main: sha("3"), dev: sha("2") },
    tags: { "v1.0.8": sha("0") },
    pulls: [
      { number: 10, baseRef: "dev", commits: [sha("1")], mergedAt: "2026-10-01T10:00:00Z", body: body(10, impacts[10]) },
      { number: 11, baseRef: "dev", commits: [sha("2")], mergedAt: "2026-10-02T10:00:00Z", body: body(11, impacts[11]) },
      { number: 20, baseRef: "main", commits: [sha("1"), sha("2"), sha("3")], mergeCommitSha: sha("3"), mergedAt: "2026-10-03T10:00:00Z", body: "Included implementation PRs: ChipIn-one/chipin-frontend#10\n\n## Version impact\n\n- `none`\n" },
    ],
  };
}

test("version impact parsing accepts the real body formats and rejects everything else", () => {
  const cases = [
    ["## Version impact\n\nnone\n", "none"],
    ["## Version impact\n\n- `none`: agent-instruction file only.\n", "none"],
    ["## Version impact\n\npatch — 1.0.7 → 1.0.8. Only the two intended values.\n", "patch"],
    ["## Version impact\n\nPatch: `1.0.4` → `1.0.5` (logout fix).\n", "patch"],
    ["## Version impact\n\n`none` (documentation-only whitespace).\n", "none"],
    ["## Version impact\n\n* **minor** — new API\n", "minor"],
    ["## Version impact\r\n\r\nMAJOR\r\n\r\n## Dependencies\r\n", "major"],
    ["## Summary\n\nx\n\n## version IMPACT\n\n1. patch\n", "patch"],
  ];
  for (const [body, expected] of cases) {
    assert.equal(parseVersionImpact(body).impact, expected, body);
  }

  assert.equal(parseVersionImpact("## Summary\n\nnone\n").impact, null);
  assert.match(parseVersionImpact("## Summary\n\nnone\n").reason, /missing/u);
  assert.equal(parseVersionImpact("## Version impact\n\n\n## Dependencies\n\nnone\n").impact, null);
  assert.match(parseVersionImpact("## Version impact\n\n## Dependencies\n").reason, /empty/u);
  assert.equal(parseVersionImpact("## Version impact\n\nNone. Automation only.\n").impact, "none");
  assert.equal(parseVersionImpact("## Version impact\n\nShared composite action behaviour change only.\n").impact, null);
  assert.equal(parseVersionImpact("## Version impact\n\nnonexistent\n").impact, null);
  assert.equal(parseVersionImpact("## Version impact\n\nhotfix\n").impact, null);
  for (const ambiguous of ["minor/patch", "none → patch after review", "None of the above; minor", "patch (or minor?)"]) {
    const parsed = parseVersionImpact("## Version impact\n\n" + ambiguous + "\n");
    assert.equal(parsed.impact, null, ambiguous);
    assert.match(parsed.reason, /more than one impact keyword/u);
  }
  assert.equal(parseVersionImpact("## Version impact\n\npatch-level fix, nothing else\n").impact, "patch");
  assert.equal(parseVersionImpact(null).impact, null);
});

test("task identity is read only from exactly one canonical line", () => {
  assert.equal(readTaskIdentity("Task identity: ChipIn-one/chipin-frontend#464\n\n## Summary"), "ChipIn-one/chipin-frontend#464");
  assert.equal(readTaskIdentity("Task identity: ChipIn-one/.github#178\n"), "ChipIn-one/.github#178");
  assert.equal(readTaskIdentity("Task identity: ChipIn-one/a#1\nTask identity: ChipIn-one/a#2\n"), null);
  assert.equal(readTaskIdentity("Task identity: https://github.com/ChipIn-one/a/issues/1\n"), null);
  assert.equal(readTaskIdentity(""), null);
});

test("version computation: max impact, bump rules, major from 0.x rejected", () => {
  assert.equal(maxImpact(["none", "patch", "minor", "none"]), "minor");
  assert.equal(maxImpact(["none"]), "none");
  assert.equal(maxImpact([]), "none");
  assert.equal(maxImpact(["patch", "major"]), "major");
  assert.throws(() => maxImpact(["hotfix"]), /Unsupported version impact/u);

  assert.equal(bumpVersion("1.0.8", "patch"), "1.0.9");
  assert.equal(bumpVersion("1.0.8", "minor"), "1.1.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.equal(bumpVersion("1.0.8", "none"), "1.0.8");
  assert.throws(() => bumpVersion("0.9.1", "major"), (error) => error.code === "MAJOR_FROM_ZERO");
  assert.throws(() => bumpVersion("1.0", "patch"), (error) => error.code === "INVALID_VERSION");
  assert.throws(() => bumpVersion("01.0.0", "patch"), (error) => error.code === "INVALID_VERSION");
});

test("plan: frontend promotion merge collects implementation PRs since the previous tag and bumps by the maximum impact", async () => {
  const store = fakeStore(frontendHistory());
  const plan = await planRelease(store, { repository: FE, profile: feProfile, ref: "main" });

  assert.equal(plan.outcome, "PLANNED");
  assert.equal(plan.sha, sha("3"));
  assert.equal(plan.releaseBranch, "main");
  assert.equal(plan.previousTag, "v1.0.8");
  assert.deepEqual(plan.includedPullRequests.map((pull) => [pull.number, pull.impact, pull.taskIdentity]), [
    [10, "patch", "ChipIn-one/chipin-frontend#110"],
    [11, "none", "ChipIn-one/chipin-frontend#111"],
  ]);
  assert.deepEqual(plan.unattributedCommits, [], "the promotion merge commit is covered by the release PR, not unattributed");
  assert.deepEqual(plan.excludedPullRequests.map((pull) => [pull.number, pull.baseRef]), [[20, "main"]]);
  assert.equal(plan.impact, "patch");
  assert.equal(plan.version, "1.0.9");
  assert.equal(plan.tag, "v1.0.9");
  assert.equal(store.writes.length, 0);
});

test("plan: all none means no release; a missing or invalid impact blocks without guessing", async () => {
  const none = await planRelease(fakeStore(frontendHistory({ impacts: { 10: "none", 11: "none" } })), {
    repository: FE, profile: feProfile, ref: "main",
  });
  assert.equal(none.outcome, "NO_RELEASE");
  assert.equal(none.tag, null);
  assert.equal(none.impact, "none");

  await assert.rejects(
    planRelease(fakeStore(frontendHistory({ bodies: { 11: "## Summary\n\nno impact section\n" } })), {
      repository: FE, profile: feProfile, ref: "main",
    }),
    (error) => error.code === "INVALID_VERSION_IMPACT" && /#11 \(missing/u.test(error.message)
      && error.extra.includedPullRequests.length === 2,
  );

  await assert.rejects(
    planRelease(fakeStore(frontendHistory({ impacts: { 10: "patch", 11: "hotfix" } })), {
      repository: FE, profile: feProfile, ref: "main",
    }),
    (error) => error.code === "INVALID_VERSION_IMPACT" && /#11/u.test(error.message),
  );

  await assert.rejects(
    planRelease(fakeStore({ ...frontendHistory({ impacts: { 10: "major", 11: "none" } }), tags: { "v0.9.0": sha("0") } }), {
      repository: FE, profile: feProfile, ref: "main",
    }),
    (error) => error.code === "MAJOR_FROM_ZERO",
  );
});

test("plan: a commit outside the release branch, an unreachable tag and a missing first version block", async () => {
  const devAhead = frontendHistory();
  devAhead.graph[sha("e")] = [sha("2")];
  devAhead.branches.dev = sha("e");
  await assert.rejects(
    planRelease(fakeStore(devAhead), { repository: FE, profile: feProfile, ref: "dev" }),
    (error) => error.code === "COMMIT_NOT_ON_RELEASE_BRANCH" && /diverged/u.test(error.message),
  );
  // a commit that is a descendant of the branch head (not yet on the branch) compares as "behind"
  const beyondHead = frontendHistory();
  beyondHead.graph[sha("f")] = [sha("3")];
  await assert.rejects(
    planRelease(fakeStore(beyondHead), { repository: FE, profile: feProfile, ref: sha("f") }),
    (error) => error.code === "COMMIT_NOT_ON_RELEASE_BRANCH" && /behind/u.test(error.message),
  );

  const unreachable = frontendHistory();
  unreachable.graph[sha("9")] = [];
  unreachable.tags = { "v1.0.8": sha("9") };
  await assert.rejects(
    planRelease(fakeStore(unreachable), { repository: FE, profile: feProfile, ref: "main" }),
    (error) => error.code === "PREVIOUS_TAG_UNREACHABLE",
  );

  const untagged = frontendHistory();
  untagged.tags = {};
  await assert.rejects(
    planRelease(fakeStore(untagged), { repository: FE, profile: feProfile, ref: "main" }),
    (error) => error.code === "NO_PREVIOUS_TAG",
  );

  const first = await planRelease(fakeStore(frontendHistory({})), { repository: FE, profile: feProfile, ref: "main" })
    .catch(() => null);
  assert.ok(first);
  const initial = await planRelease(fakeStore(untagged), { repository: FE, profile: feProfile, ref: "main", initialVersion: "1.0.8" });
  assert.equal(initial.outcome, "PLANNED");
  assert.equal(initial.previousTag, null);
  assert.equal(initial.tag, "v1.0.8");
  assert.deepEqual(initial.includedPullRequests, []);

  await assert.rejects(
    planRelease(fakeStore(frontendHistory()), { repository: FE, profile: feProfile, ref: "main", initialVersion: "2.0.0" }),
    (error) => error.code === "INITIAL_VERSION_NOT_ALLOWED",
  );
  await assert.rejects(
    planRelease(fakeStore(untagged), { repository: FE, profile: feProfile, ref: "main", initialVersion: "v1.0.8" }),
    (error) => error.code === "INVALID_VERSION",
  );
  await assert.rejects(
    planRelease(fakeStore(frontendHistory()), { repository: "ChipIn-one/chipin-knowledge-base", profile: getRepositoryProfile("ChipIn-one/chipin-knowledge-base"), ref: "master" }),
    (error) => error.code === "RELEASE_DISABLED",
  );
});

test("plan: idempotency — an already tagged commit is a no-op, a tag on another commit blocks, a tag without Release is completed", async () => {
  const released = frontendHistory();
  released.tags = { "v1.0.8": sha("0"), "v1.0.9": sha("3") };
  released.releases = { "v1.0.9": { id: 1, url: "u", tagName: "v1.0.9", draft: false } };
  const already = await planRelease(fakeStore(released), { repository: FE, profile: feProfile, ref: "main" });
  assert.equal(already.outcome, "ALREADY_RELEASED");
  assert.equal(already.tag, "v1.0.9");
  const noop = await applyRelease(fakeStore(released), already);
  assert.equal(noop.outcome, "ALREADY_RELEASED");
  assert.deepEqual(noop.applied, { tag: false, release: false });

  // v1.0.9 exists on a side commit that is not an ancestor of main: it is skipped as "previous"
  // (v1.0.8 wins) and then collides with the computed version.
  const conflict = frontendHistory();
  conflict.graph[sha("e")] = [sha("0")];
  conflict.tags = { "v1.0.8": sha("0"), "v1.0.9": sha("e") };
  await assert.rejects(
    planRelease(fakeStore(conflict), { repository: FE, profile: feProfile, ref: "main" }),
    (error) => error.code === "TAG_CONFLICT" && error.message.includes(sha("e")),
  );

  // a tag on an intermediate commit of the release branch is a valid previous tag
  const intermediate = frontendHistory();
  intermediate.tags = { "v1.0.8": sha("0"), "v1.0.9": sha("1") };
  const fromIntermediate = await planRelease(fakeStore(intermediate), { repository: FE, profile: feProfile, ref: "main" });
  assert.equal(fromIntermediate.previousTag, "v1.0.9");
  assert.deepEqual(fromIntermediate.includedPullRequests.map((pull) => pull.number), [11]);
  assert.equal(fromIntermediate.outcome, "NO_RELEASE");

  const tagOnly = frontendHistory();
  tagOnly.tags = { "v1.0.8": sha("0"), "v1.0.9": sha("3") };
  const store = fakeStore(tagOnly);
  const missing = await planRelease(store, { repository: FE, profile: feProfile, ref: "main" });
  assert.equal(missing.outcome, "RELEASE_MISSING");
  // the inventory of the already tagged version comes from the next lower ancestor tag
  assert.equal(missing.inventoryBaseTag, "v1.0.8");
  assert.deepEqual(missing.includedPullRequests.map((pull) => pull.number), [10, 11]);
  const completed = await applyRelease(store, missing);
  assert.equal(completed.outcome, "RELEASED");
  assert.deepEqual(completed.applied, { tag: false, release: true });
  assert.deepEqual(store.writes.map((write) => write.kind), ["release"]);
  assert.match(store.writes[0].body, /- ChipIn-one\/chipin-frontend#110 \(#10\)/u);
});

test("apply: creates the tag on the exact commit, reads it back, then the Release with the Included Issues block", async () => {
  const store = fakeStore(frontendHistory());
  const plan = await planRelease(store, { repository: FE, profile: feProfile, ref: "main" });
  const result = await applyRelease(store, plan);

  assert.equal(result.outcome, "RELEASED");
  assert.deepEqual(result.applied, { tag: true, release: true });
  assert.deepEqual(store.writes.map((write) => [write.kind, write.tag, write.sha]), [
    ["tag", "v1.0.9", sha("3")],
    ["release", "v1.0.9", sha("3")],
  ]);
  assert.match(store.writes[1].body, /^## Included Issues\n\n- ChipIn-one\/chipin-frontend#110 \(#10\)\n- ChipIn-one\/chipin-frontend#111 \(#11\)\n$/u);

  const rerun = await applyRelease(store, await planRelease(store, { repository: FE, profile: feProfile, ref: "main" }));
  assert.equal(rerun.outcome, "ALREADY_RELEASED");
  assert.equal(store.writes.length, 2);

  await assert.rejects(applyRelease(store, { ...plan, outcome: "BLOCKED" }), (error) => error.code === "INVALID_PLAN");
});

test("apply: read-back failures and a tag that appears on another commit during apply fail closed", async () => {
  const history = frontendHistory();
  const store = fakeStore(history);
  const plan = await planRelease(store, { repository: FE, profile: feProfile, ref: "main" });

  const racing = { ...store, readTagRef: async () => ({ sha: sha("1") }) };
  await assert.rejects(applyRelease(racing, plan), (error) => error.code === "TAG_CONFLICT");
  assert.equal(store.writes.length, 0);

  let reads = 0;
  const badReadBack = {
    ...store,
    readTagRef: async () => (reads++ === 0 ? null : { sha: sha("2") }),
  };
  await assert.rejects(applyRelease(badReadBack, plan), (error) => error.code === "READBACK_MISMATCH");

  const draftRelease = fakeStore(frontendHistory());
  draftRelease.createRelease = async ({ tag }) => { draftRelease.writes.push({ kind: "release", tag }); return null; };
  draftRelease.readRelease = async () => null;
  await assert.rejects(
    applyRelease(draftRelease, await planRelease(draftRelease, { repository: FE, profile: feProfile, ref: "main" })),
    (error) => error.code === "READBACK_MISMATCH" && /published release/u.test(error.message),
  );
});

test("plan: .github integration merge counts PRs merged into master and reports direct commits as unattributed", async () => {
  const graph = {
    [sha("a")]: [],
    [sha("b")]: [sha("a")],
    [sha("c")]: [sha("b")],
    [sha("d")]: [sha("c")],
  };
  const store = fakeStore({
    graph,
    branches: { master: sha("d") },
    tags: { "v1.1.0": sha("a") },
    pulls: [
      { number: 191, baseRef: "master", commits: [sha("b")], mergedAt: "2026-10-21T13:07:21Z", body: "Task identity: ChipIn-one/.github#189\n\n## Version impact\n\nnone\n" },
      { number: 194, baseRef: "master", commits: [sha("d")], mergedAt: "2026-10-22T10:00:00Z", body: "Task identity: ChipIn-one/.github#178\n\n## Version impact\n\npatch (shared completion action)\n" },
    ],
  });
  const plan = await planRelease(store, { repository: ORG, profile: orgProfile, ref: "master" });
  assert.equal(plan.outcome, "PLANNED");
  assert.equal(plan.releaseBranch, "master");
  assert.equal(plan.version, "1.1.1");
  assert.deepEqual(plan.includedPullRequests.map((pull) => pull.number), [191, 194]);
  assert.deepEqual(plan.unattributedCommits, [sha("c")]);
  assert.match(formatReleaseSummary({ ...plan, mode: "plan" }), /without a merged pull request .*`ccccccc`/u);
  assert.match(formatIncludedIssuesBlock(plan.includedPullRequests), /- ChipIn-one\/.github#178 \(#194\)/u);
  assert.match(formatIncludedIssuesBlock([{ number: 5, taskIdentity: null }]), /none \(no included pull request carries/u);
  assert.match(formatIncludedIssuesBlock([{ number: 5, taskIdentity: null }]), /without a task identity: #5\./u);
});

test("plan: a PR merged into another base or outside the range is not counted; the highest ancestor tag wins", async () => {
  const history = frontendHistory();
  // a hotfix tag that is not an ancestor of main must be skipped, and v1.0.8 (ancestor) used
  history.graph[sha("e")] = [sha("0")];
  history.tags = { "v1.0.8": sha("0"), "v1.0.7": sha("0"), "v1.0.10": sha("e") };
  const plan = await planRelease(fakeStore(history), { repository: FE, profile: feProfile, ref: "main" });
  assert.equal(plan.previousTag, "v1.0.8");
  assert.equal(plan.version, "1.0.9");
  // the release PR (#20, base main) is never an included implementation PR
  assert.ok(!plan.includedPullRequests.some((pull) => pull.number === 20));
});

// .github-like history: master, tag v1.1.0 on a; PR#30 merged as b, PR#31 merged as c.
function orgHistory(pulls) {
  return {
    graph: { [sha("a")]: [], [sha("b")]: [sha("a")], [sha("c")]: [sha("b")] },
    branches: { master: sha("c") },
    tags: { "v1.1.0": sha("a") },
    pulls: pulls.map((pull, index) => ({
      baseRef: "master", commits: [index === 0 ? sha("b") : sha("c")], mergedAt: "2026-10-0" + (index + 1) + "T10:00:00Z", ...pull,
    })),
  };
}
const DEPENDABOT_BODY = "Bumps [actions/checkout](https://github.com/actions/checkout) from 4 to 5.\n\n---\n\n<details><summary>Dependabot commands</summary></details>\n";

test("plan: a dependabot[bot] PR without a Version impact section counts as none; an explicit section wins; others still block", async () => {
  // alone in range -> NO_RELEASE, receipt shows the derived default
  const alone = await runRelease(fakeStore(orgHistory([
    { number: 30, author: "dependabot[bot]", body: DEPENDABOT_BODY },
  ])), { mode: "plan", repository: ORG, profile: orgProfile, ref: sha("b"), initialVersion: null });
  assert.equal(alone.outcome, "NO_RELEASE");
  assert.equal(alone.impact, "none");
  assert.equal(alone.tag, null);
  assert.match(alone.detail, /all have Version impact none \(1 by dependabot default\)/u);
  assert.equal(parseVersionImpact("no section at all").missingSection, true);
  assert.equal(parseVersionImpact("## Version impact\n\n").missingSection, undefined);
  const [entry] = alone.includedPullRequests;
  assert.equal(entry.number, 30);
  assert.equal(entry.author, "dependabot[bot]");
  assert.equal(entry.impact, "none");
  assert.equal(entry.impactRaw, "dependabot-default");
  assert.equal(entry.impactReason, "dependabot[bot] without a Version impact section → none");
  assert.match(formatReleaseSummary(alone), /\| #30 \| none \(dependabot default\) \|/u);

  // does not raise the max next to a human patch PR
  const mixed = await planRelease(fakeStore(orgHistory([
    { number: 30, author: "dependabot[bot]", body: DEPENDABOT_BODY },
    { number: 31, author: "someone", body: "## Version impact\n\npatch\n" },
  ])), { repository: ORG, profile: orgProfile, ref: "master" });
  assert.equal(mixed.outcome, "PLANNED");
  assert.equal(mixed.impact, "patch");
  assert.equal(mixed.version, "1.1.1");

  // an explicit section on a Dependabot PR is parsed as for any PR
  const explicit = await planRelease(fakeStore(orgHistory([
    { number: 30, author: "dependabot[bot]", body: DEPENDABOT_BODY + "\n## Version impact\n\npatch\n" },
  ])), { repository: ORG, profile: orgProfile, ref: sha("b") });
  assert.equal(explicit.impact, "patch");
  assert.equal(explicit.includedPullRequests[0].impactRaw, "patch");
  assert.equal(explicit.includedPullRequests[0].impactReason, null);
  for (const bad of ["## Version impact\n\nhotfix\n", "## Version impact\n\n"]) {
    await assert.rejects(
      planRelease(fakeStore(orgHistory([{ number: 30, author: "dependabot[bot]", body: DEPENDABOT_BODY + "\n" + bad }])), {
        repository: ORG, profile: orgProfile, ref: sha("b"),
      }),
      (error) => error.code === "INVALID_VERSION_IMPACT" && /#30/u.test(error.message),
      bad,
    );
  }

  // a non-Dependabot PR (or an unknown author) without the section still blocks
  for (const author of ["someone", "dependabot", null]) {
    await assert.rejects(
      planRelease(fakeStore(orgHistory([{ number: 30, author, body: DEPENDABOT_BODY }])), {
        repository: ORG, profile: orgProfile, ref: sha("b"),
      }),
      (error) => error.code === "INVALID_VERSION_IMPACT" && /#30 \(missing/u.test(error.message),
      String(author),
    );
  }
});

test("runRelease turns a blocked plan into a BLOCKED receipt and keeps the included inventory", async () => {
  const receipt = await runRelease(fakeStore(frontendHistory({ bodies: { 10: "nothing" } })), {
    mode: "plan", repository: FE, profile: feProfile, ref: "main", initialVersion: null,
  });
  assert.equal(receipt.outcome, "BLOCKED");
  assert.equal(receipt.code, "INVALID_VERSION_IMPACT");
  assert.equal(receipt.includedPullRequests.length, 2);
  assert.equal(receipt.previousTag, "v1.0.8");
  // BLOCKED receipts carry the context resolved so far
  assert.equal(receipt.sha, sha("3"));
  assert.equal(receipt.releaseBranch, "main");
  assert.equal(receipt.strategy, "semver-by-impact");
  assert.match(formatReleaseSummary(receipt), /`BLOCKED` \(`INVALID_VERSION_IMPACT`\)/u);
  assert.match(formatReleaseSummary(receipt), /\| #10 \| invalid: missing/u);

  const ok = await runRelease(fakeStore(frontendHistory()), { mode: "plan", repository: FE, profile: feProfile, ref: "main", initialVersion: null });
  assert.equal(ok.mode, "plan");
  assert.equal(ok.outcome, "PLANNED");
  assert.ok(ok.generatedAt);
});

test("CLI arguments: mode, repository and ref are required; unknown flags fail", () => {
  assert.deepEqual(parseArgs(["plan", "--repository", FE, "--ref", "main"]), {
    mode: "plan", repository: FE, ref: "main", initialVersion: null, output: null, activate: null,
  });
  assert.equal(parseArgs(["apply", "--repository", FE, "--ref", "x", "--activate", "release-v1", "--initial-version", "1.0.0", "--output", "r.json"]).activate, "release-v1");
  assert.throws(() => parseArgs(["tag", "--repository", FE, "--ref", "main"]), /Usage/u);
  assert.throws(() => parseArgs(["plan", "--repository", FE]), /required/u);
  assert.throws(() => parseArgs(["plan", "--repository", FE, "--ref", "main", "--force"]), /Unknown argument/u);
});

test("GitHub store maps REST endpoints, paginates compare and resolves annotated tags", async () => {
  const calls = [];
  const client = {
    request: async (path, options = {}) => {
      calls.push({ path, options });
      if (path.endsWith("/commits/main")) return { sha: sha("3") };
      if (path.includes("/compare/" + sha("0") + "..." + sha("3") + "?per_page=100&page=1")) {
        return { status: "ahead", total_commits: 3, commits: [{ sha: sha("1") }, { sha: sha("2") }] };
      }
      if (path.includes("/compare/" + sha("0") + "..." + sha("3") + "?per_page=100&page=2")) {
        return { status: "ahead", total_commits: 3, commits: [{ sha: sha("3") }] };
      }
      if (path.endsWith("/git/tags/" + sha("f"))) return { object: { type: "commit", sha: sha("0") } };
      if (path.endsWith("/git/ref/tags/v1.0.9")) return null;
      if (path.endsWith("/releases/tags/v1.0.9")) return null;
      if (path.endsWith("/git/refs") && options.method === "POST") {
        assert.deepEqual(options.body, { ref: "refs/tags/v1.0.9", sha: sha("3") });
        return { object: { sha: sha("3") } };
      }
      if (path.endsWith("/releases") && options.method === "POST") {
        assert.equal(options.body.generate_release_notes, true);
        assert.equal(options.body.tag_name, "v1.0.9");
        assert.equal(options.body.target_commitish, sha("3"));
        assert.equal(options.body.draft, false);
        return { id: 7, html_url: "https://github.com/ChipIn-one/chipin-frontend/releases/tag/v1.0.9", tag_name: "v1.0.9" };
      }
      throw new Error("unexpected request " + path);
    },
    graphql: async (query, variables) => {
      calls.push({ query, variables });
      assert.match(query, /query ReleaseMergeCommit/u);
      if (variables.number === 11) return { repository: { pullRequest: { number: 11, mergeCommit: { oid: sha("2") } } } };
      return { repository: { pullRequest: { number: 13, mergeCommit: null } } };
    },
    listAll: async (path) => {
      calls.push({ path });
      if (path.endsWith("/git/matching-refs/tags/v")) {
        return [
          { ref: "refs/tags/v1.0.8", object: { type: "tag", sha: sha("f") } },
          { ref: "refs/tags/v1.0.7", object: { type: "commit", sha: sha("0") } },
        ];
      }
      if (path.endsWith("/commits/" + sha("1") + "/pulls")) {
        return [{ number: 10, title: "t", body: "b", html_url: "u", merged_at: "2026-10-01T10:00:00Z", base: { ref: "dev" }, user: { login: "dependabot[bot]" }, merge_commit_sha: sha("1") }];
      }
      if (path.endsWith("/commits/" + sha("2") + "/pulls")) {
        return [
          { number: 11, title: "t", body: "b", html_url: "u", merged_at: "2026-10-02T10:00:00Z", base: { ref: "dev" }, merge_commit_sha: null },
          { number: 12, title: "open", body: "", html_url: "u", merged_at: null, base: { ref: "dev" }, merge_commit_sha: null },
        ];
      }
      if (path.endsWith("/commits/" + sha("3") + "/pulls")) {
        return [{ number: 13, title: "t", body: "b", html_url: "u", merged_at: "2026-10-03T10:00:00Z", base: { ref: "dev" }, merge_commit_sha: null }];
      }
      throw new Error("unexpected list " + path);
    },
  };
  const store = githubStore(client, FE);
  assert.equal(await store.resolveCommit("main"), sha("3"));
  assert.deepEqual(await store.listVersionTags("v"), [{ name: "v1.0.8", sha: sha("0") }, { name: "v1.0.7", sha: sha("0") }]);
  const comparison = await store.compare(sha("0"), sha("3"));
  assert.equal(comparison.status, "ahead");
  assert.equal(comparison.totalCommits, 3);
  assert.deepEqual(comparison.commits.map((commit) => commit.sha), [sha("1"), sha("2"), sha("3")]);
  assert.deepEqual(await store.listCommitPulls(sha("1")), [{
    number: 10, title: "t", body: "b", url: "u", mergedAt: "2026-10-01T10:00:00Z", baseRef: "dev", author: "dependabot[bot]", mergeCommitSha: sha("1"),
  }]);
  assert.equal((await store.listCommitPulls(sha("2")))[0].author, null, "a pull without user maps to author null");
  assert.deepEqual((await store.listCommitPulls(sha("2"))).map((pull) => [pull.number, pull.mergeCommitSha]), [
    [11, sha("2")],
    [12, null],
  ]);
  await assert.rejects(store.listCommitPulls(sha("3")), (error) => error.code === "UNREADABLE_PULL");
  assert.equal(await store.readTagRef("v1.0.9"), null);
  assert.equal(await store.readRelease("v1.0.9"), null);
  assert.deepEqual(await store.createTagRef("v1.0.9", sha("3")), { sha: sha("3") });
  assert.equal((await store.createRelease({ tag: "v1.0.9", sha: sha("3"), body: "x" })).id, 7);
  assert.throws(() => githubStore(client, "bad"), (error) => error.code === "INVALID_REPOSITORY");

  const truncated = githubStore({
    request: async () => ({ status: "ahead", total_commits: 5, commits: [] }),
    listAll: async () => [],
  }, FE);
  await assert.rejects(truncated.compare("a", "b"), (error) => error.code === "UNREADABLE_COMPARE");
});

test("release-action, reusable workflow and caller templates: plan by default, apply only with explicit activation", async () => {
  const action = await readFile(new URL("./release-action/action.yml", import.meta.url), "utf8");
  assert.match(action, /release\.mjs/u);
  assert.match(action, /--activate release-v1/u);
  assert.match(action, /CHIPIN_RELEASE_WRITE/u);
  assert.match(action, /inputs\.apply/u);
  assert.doesNotMatch(action, /force/u);

  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  workflow_call:$/mu);
  // every action is pinned by SHA with its version comment
  for (const uses of workflow.match(/uses: [^\n]+/gu).filter((line) => !line.includes("./chipin-workflow"))) {
    assert.match(uses, /@[0-9a-f]{40} # v\d+\.\d+\.\d+$/u, uses);
  }
  assert.doesNotMatch(workflow, /^  push:$/mu);
  // the called workflow's own SHA/repository come from the job context, never from github.* (caller)
  assert.match(workflow, /ref: \$\{\{ job\.workflow_sha \}\}/u);
  assert.match(workflow, /repository: \$\{\{ job\.workflow_repository \}\}/u);
  assert.doesNotMatch(workflow, /github\.job_workflow_sha|github\.workflow_sha/u);
  // the `job` context is only available at step level: a job-level `env:` referencing it invalidates the file
  const jobLevelEnv = /^    env:\n((?:      .*\n)+)/mu.exec(workflow);
  assert.equal(jobLevelEnv, null, "release job must not declare a job-level env block (job.* is unavailable there)");
  assert.doesNotMatch(workflow, /^    env:[\s\S]*?\$\{\{ job\./mu);
  assert.match(workflow, /^        env:\n          WORKFLOW_REPOSITORY: \$\{\{ job\.workflow_repository \}\}\n          WORKFLOW_SHA: \$\{\{ job\.workflow_sha \}\}/mu);
  assert.match(workflow, /\[\[ "\$head" != "\$WORKFLOW_SHA" \]\]/u);
  // permissions are inherited from the caller (a called workflow can only downgrade them)
  assert.doesNotMatch(workflow, /^permissions:/mu);
  assert.match(workflow, /release-action/u);
  assert.match(workflow, /default: false/u);

  for (const file of ["caller-release-promotion.yml", "caller-release-integration.yml"]) {
    const template = await readFile(new URL("../templates/" + file, import.meta.url), "utf8");
    assert.match(template, /ChipIn-one\/\.github\/\.github\/workflows\/release\.yml@/u);
    assert.match(template, /contents: write/u);
    assert.match(template, /apply: true/u);
    assert.match(template, /group: release-\$\{\{ github\.repository \}\}/u);
    assert.match(template, /cancel-in-progress: false/u);
  }

  // this repository's own caller (#175) follows the integration template and pins a tag SHA
  const caller = await readFile(new URL("../.github/workflows/release-on-master.yml", import.meta.url), "utf8");
  // the trigger block is exactly one push to master: nothing else between `on:` and `permissions:`
  assert.match(caller, /^on:\n  push:\n    branches: \[master\][^\n]*\npermissions:/mu);
  assert.match(caller, /^permissions:\n  contents: write/mu);
  assert.match(caller, /uses: ChipIn-one\/\.github\/\.github\/workflows\/release\.yml@[0-9a-f]{40} +# v\d+\.\d+\.\d+$/mu);
  assert.match(caller, /apply: true/u);
  assert.match(caller, /token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/u);
  assert.match(caller, /group: release-\$\{\{ github\.repository \}\}/u);
  assert.match(caller, /cancel-in-progress: false/u);
  assert.match(caller, /if: github\.repository_owner == 'ChipIn-one'/u);
});

test("plan: commits in range without one included PR block instead of a silent no-release", async () => {
  // hotfix PR straight into main after the tag: excluded, nothing included -> BLOCKED
  const hotfix = {
    graph: { [sha("0")]: [], [sha("4")]: [sha("0")] },
    branches: { main: sha("4"), dev: sha("0") },
    tags: { "v1.0.8": sha("0") },
    pulls: [{ number: 30, baseRef: "main", commits: [sha("4")], mergedAt: "2026-10-05T10:00:00Z", body: "## Version impact\n\npatch\n" }],
  };
  await assert.rejects(
    planRelease(fakeStore(hotfix), { repository: FE, profile: feProfile, ref: "main" }),
    (error) => error.code === "NO_INCLUDED_PULL_REQUESTS" && /excluded, base main: #30/u.test(error.message)
      && error.extra.excludedPullRequests.length === 1 && error.extra.unattributedCommits.length === 0,
  );

  // squash-merged promotion: the dev PRs' merge commits are not in the range
  const squashed = {
    graph: { [sha("0")]: [], [sha("5")]: [sha("0")] },
    branches: { main: sha("5"), dev: sha("2") },
    tags: { "v1.0.8": sha("0") },
    pulls: [{ number: 20, baseRef: "main", commits: [sha("5")], mergeCommitSha: sha("5"), mergedAt: "2026-10-05T10:00:00Z", body: "## Version impact\n\nnone\n" }],
  };
  squashed.graph[sha("2")] = [sha("0")];
  await assert.rejects(
    planRelease(fakeStore(squashed), { repository: FE, profile: feProfile, ref: "main" }),
    (error) => error.code === "NO_INCLUDED_PULL_REQUESTS",
  );

  // direct pushes only
  const direct = {
    graph: { [sha("a")]: [], [sha("b")]: [sha("a")] },
    branches: { master: sha("b") },
    tags: { "v1.1.0": sha("a") },
    pulls: [],
  };
  const receipt = await runRelease(fakeStore(direct), { mode: "plan", repository: ORG, profile: orgProfile, ref: "master", initialVersion: null });
  assert.equal(receipt.outcome, "BLOCKED");
  assert.equal(receipt.code, "NO_INCLUDED_PULL_REQUESTS");
  assert.deepEqual(receipt.unattributedCommits, [sha("b")]);
  assert.match(formatReleaseSummary(receipt), /NO_INCLUDED_PULL_REQUESTS/u);
});

test("GitHub store memoizes merge-commit lookups per pull request", async () => {
  let graphqlCalls = 0;
  const client = {
    request: async () => { throw new Error("unexpected request"); },
    graphql: async (_query, variables) => {
      graphqlCalls += 1;
      return { repository: { pullRequest: { number: variables.number, mergeCommit: { oid: sha("2") } } } };
    },
    listAll: async () => [{ number: 11, title: "t", body: "b", html_url: "u", merged_at: "2026-10-02T10:00:00Z", base: { ref: "dev" }, merge_commit_sha: null }],
  };
  const store = githubStore(client, FE);
  await store.listCommitPulls(sha("1"));
  await store.listCommitPulls(sha("2"));
  assert.equal(graphqlCalls, 1);
});
