// Release engine: version from `## Version impact` of the PRs merged since the previous tag,
// then a git tag and a GitHub Release on the exact release commit (docs/workflow/release.md).
//
//   node automation/release.mjs plan  --repository ChipIn-one/.github --ref master [--initial-version 1.0.0] [--output receipt.json]
//   CHIPIN_RELEASE_WRITE=1 node automation/release.mjs apply --repository ... --ref <sha> --activate release-v1 [--output receipt.json]
//
// `plan` never writes. `apply` needs the activation flag and the env switch, creates the tag ref first,
// reads it back, then creates the Release and reads it back. A rerun on an already released commit is a
// no-op (`ALREADY_RELEASED`); a tag that exists on another commit, a missing or invalid impact line, an
// unreachable previous tag or a commit outside the release branch end as `BLOCKED` (exit 1), never guessed.
// The one derived default: a `dependabot[bot]` PR without the section counts as `none` for a `github_actions`
// bump and `patch` for any other ecosystem, read from its head branch (resolvePullImpact).

import fs from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { GitHubClient } from "./github-metadata.mjs";
import { requireRepositoryProfile } from "./registry.mjs";

export const RELEASE_CONTRACT = "chipin-release/v1";
export const RELEASE_ACTIVATION = "release-v1";
export const VERSION_IMPACTS = Object.freeze(["none", "patch", "minor", "major"]);
const IMPACT_RANK = Object.freeze({ none: 0, patch: 1, minor: 2, major: 3 });
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const TASK_IDENTITY_PATTERN = /^Task identity:\s*(ChipIn-one\/[A-Za-z0-9_.-]+#\d+)\s*$/mu;
const MAX_COMPARE_PAGES = 10;
const MERGE_COMMIT_QUERY = [
  "query ReleaseMergeCommit($owner: String!, $repo: String!, $number: Int!) {",
  "  repository(owner: $owner, name: $repo) { pullRequest(number: $number) { number mergeCommit { oid } } }",
  "}",
].join("\n");

export class ReleaseBlocked extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

function blocked(code, message, extra) {
  return new ReleaseBlocked(code, message, extra);
}

// ---------------------------------------------------------------------------------------------
// Pure helpers

export function parseSemVer(version) {
  const match = typeof version === "string" ? SEMVER_PATTERN.exec(version) : null;
  if (!match) throw blocked("INVALID_VERSION", "Invalid SemVer: " + JSON.stringify(version));
  const [major, minor, patch] = match.slice(1).map(Number);
  return { major, minor, patch };
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  return (a.major - b.major) || (a.minor - b.minor) || (a.patch - b.patch);
}

export function bumpVersion(version, impact) {
  const parsed = parseSemVer(version);
  if (!VERSION_IMPACTS.includes(impact)) throw blocked("INVALID_IMPACT", "Unsupported version impact: " + impact);
  if (impact === "none") return version;
  if (impact === "patch") return parsed.major + "." + parsed.minor + "." + (parsed.patch + 1);
  if (impact === "minor") return parsed.major + "." + (parsed.minor + 1) + ".0";
  if (parsed.major === 0) {
    throw blocked("MAJOR_FROM_ZERO", "Automatic major bump from " + version
      + " is forbidden; 1.0.0 is an explicit owner decision (pass it as --initial-version on a repository without tags, or tag it by hand).");
  }
  return (parsed.major + 1) + ".0.0";
}

export function maxImpact(impacts) {
  let best = "none";
  for (const impact of impacts) {
    if (!VERSION_IMPACTS.includes(impact)) throw blocked("INVALID_IMPACT", "Unsupported version impact: " + impact);
    if (IMPACT_RANK[impact] > IMPACT_RANK[best]) best = impact;
  }
  return best;
}

/**
 * Read `## Version impact` from a PR body. Returns `{ impact, raw }` with impact in VERSION_IMPACTS,
 * or `{ impact: null, raw, reason }` when the section is missing, empty or does not start with a keyword.
 * The first non-empty line of the section is used; list markers, backticks, bold/italic markers are
 * stripped before matching, so "- `patch`: …", "Patch: …" and "none (docs only)" all parse.
 */
export function parseVersionImpact(body) {
  const lines = String(body ?? "").replace(/\r\n/gu, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => /^##\s+Version impact\s*$/iu.test(line.trim()));
  if (headingIndex === -1) return { impact: null, raw: null, missingSection: true, reason: "missing `## Version impact` section" };
  let raw = null;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s/u.test(line)) break;
    if (line.trim() === "") continue;
    raw = line.trim();
    break;
  }
  if (raw === null) return { impact: null, raw: null, reason: "empty `## Version impact` section" };
  const cleaned = raw
    .replace(/^(?:[-*+]|\d+[.)])\s+/u, "")
    .replace(/^[`*_]+/u, "");
  const match = /^(none|patch|minor|major)\b/iu.exec(cleaned);
  if (!match) return { impact: null, raw, reason: "first line is not none/patch/minor/major: " + JSON.stringify(raw) };
  const keywords = new Set([...cleaned.matchAll(/\b(none|patch|minor|major)\b/giu)].map((hit) => hit[1].toLowerCase()));
  if (keywords.size > 1) return { impact: null, raw, reason: "first line names more than one impact keyword: " + JSON.stringify(raw) };
  return { impact: match[1].toLowerCase(), raw };
}

export const DEPENDABOT_LOGIN = "dependabot[bot]";

/**
 * Impact of one merged PR. A PR authored by `dependabot[bot]` whose body has no `## Version impact`
 * heading at all gets a default from its head branch `dependabot/<ecosystem>/…` (`raw: "dependabot-default"`):
 * `github_actions` → `none` (action pins change nothing a consumer pins), any other ecosystem → `patch`
 * (a runtime dependency bump ships code). An unreadable head branch, or one outside `dependabot/`, still
 * blocks. Any present section, even an empty or invalid one, is parsed as for every other PR, so an
 * explicit value always wins and a bad one blocks.
 */
export function resolvePullImpact(pull) {
  const parsed = parseVersionImpact(pull.body);
  if (parsed.missingSection === true && pull.author === DEPENDABOT_LOGIN) {
    const ecosystem = /^dependabot\/([^/]+)\//u.exec(typeof pull.headRef === "string" ? pull.headRef : "")?.[1] ?? null;
    if (ecosystem === null) {
      return { ...parsed, reason: parsed.reason + "; " + DEPENDABOT_LOGIN + " head branch " + JSON.stringify(pull.headRef ?? null)
        + " is not dependabot/<ecosystem>/…, so no default applies" };
    }
    if (ecosystem === "github_actions") {
      return { impact: "none", raw: "dependabot-default", reason: DEPENDABOT_LOGIN + " github-actions bump without a Version impact section → none" };
    }
    return { impact: "patch", raw: "dependabot-default",
      reason: DEPENDABOT_LOGIN + " " + ecosystem + " bump without a Version impact section → patch (runtime dependency)" };
  }
  return parsed;
}

function dependabotDefaults(pulls) {
  const count = pulls.filter((pull) => pull.impactRaw === "dependabot-default").length;
  return count > 0 ? " (" + count + " by dependabot default)" : "";
}

export function readTaskIdentity(body) {
  const matches = [...String(body ?? "").matchAll(new RegExp(TASK_IDENTITY_PATTERN.source, "gmu"))];
  if (matches.length !== 1) return null;
  return matches[0][1];
}

export function formatIncludedIssuesBlock(includedPullRequests) {
  const issues = [...new Set(includedPullRequests.map((pull) => pull.taskIdentity).filter(Boolean))];
  const lines = ["## Included Issues", ""];
  if (issues.length === 0) {
    lines.push("- none (no included pull request carries a `Task identity` line)");
  } else {
    for (const identity of issues) {
      const pulls = includedPullRequests.filter((pull) => pull.taskIdentity === identity).map((pull) => "#" + pull.number);
      lines.push("- " + identity + " (" + pulls.join(", ") + ")");
    }
  }
  const withoutIdentity = includedPullRequests.filter((pull) => !pull.taskIdentity);
  if (withoutIdentity.length > 0) {
    lines.push("", "Included pull requests without a task identity: "
      + withoutIdentity.map((pull) => "#" + pull.number).join(", ") + ".");
  }
  return lines.join("\n") + "\n";
}

export function sortedVersionTags(tags, tagPrefix) {
  const prefixed = tags
    .map((tag) => {
      const version = tag.name.startsWith(tagPrefix) ? tag.name.slice(tagPrefix.length) : null;
      return version !== null && SEMVER_PATTERN.test(version) ? { ...tag, version } : null;
    })
    .filter(Boolean)
    .sort((a, b) => compareSemVer(b.version, a.version));
  return prefixed;
}

// ---------------------------------------------------------------------------------------------
// GitHub store (REST). Every method is a single responsibility so tests can fake the store.

function splitRepository(repository) {
  const [owner, repo, extra] = String(repository ?? "").split("/");
  if (!owner || !repo || extra) throw blocked("INVALID_REPOSITORY", "Invalid repository identity: " + repository);
  return { owner, repo };
}

export function githubStore(client, repository) {
  const { owner, repo } = splitRepository(repository);
  const root = "/repos/" + owner + "/" + repo;

  // /commits/{sha}/pulls returns merged PRs only for commits reachable from the DEFAULT branch
  // (otherwise only open PRs). Every registry release branch is the default branch today
  // (frontend main, backend develop, .github master); a different layout needs another inventory.
  async function readCommitPullsPage(sha) {
    return client.listAll(root + "/commits/" + sha + "/pulls");
  }
  const mergeCommitCache = new Map();
  async function mergeCommitOf(pull) {
    if (!mergeCommitCache.has(pull.number)) {
      mergeCommitCache.set(pull.number, (async () => {
        const data = await client.graphql(MERGE_COMMIT_QUERY, { owner, repo, number: pull.number });
        const oid = data?.repository?.pullRequest?.mergeCommit?.oid ?? null;
        if (data?.repository?.pullRequest?.number !== pull.number || !SHA_PATTERN.test(oid ?? "")) {
          throw blocked("UNREADABLE_PULL", "Merged pull request #" + pull.number + " has no readable merge commit");
        }
        return oid;
      })());
    }
    return mergeCommitCache.get(pull.number);
  }

  return {
    async resolveCommit(ref) {
      const commit = await client.request(root + "/commits/" + encodeURIComponent(ref));
      if (!SHA_PATTERN.test(commit?.sha ?? "")) throw blocked("UNREADABLE_COMMIT", "Commit for ref " + ref + " is unreadable");
      return commit.sha;
    },
    async listVersionTags(tagPrefix) {
      const refs = await client.listAll(root + "/git/matching-refs/tags/" + tagPrefix);
      const tags = [];
      for (const ref of refs) {
        const name = String(ref?.ref ?? "").replace(/^refs\/tags\//u, "");
        let sha = ref?.object?.sha ?? null;
        if (ref?.object?.type === "tag") {
          const annotated = await client.request(root + "/git/tags/" + sha);
          if (annotated?.object?.type !== "commit" || !SHA_PATTERN.test(annotated?.object?.sha ?? "")) {
            throw blocked("UNREADABLE_TAG", "Annotated tag " + name + " does not point at a readable commit");
          }
          sha = annotated.object.sha;
        } else if (ref?.object?.type !== "commit") {
          throw blocked("UNREADABLE_TAG", "Tag " + name + " points at an unsupported object type " + (ref?.object?.type ?? "unknown"));
        }
        if (!SHA_PATTERN.test(sha ?? "")) throw blocked("UNREADABLE_TAG", "Tag " + name + " has an unreadable commit SHA");
        tags.push({ name, sha });
      }
      return tags;
    },
    async compare(base, head) {
      const commits = [];
      let status = null;
      let totalCommits = null;
      for (let page = 1; page <= MAX_COMPARE_PAGES; page += 1) {
        const comparison = await client.request(root + "/compare/" + base + "..." + head + "?per_page=100&page=" + page);
        if (!comparison?.status || !Array.isArray(comparison.commits)) {
          throw blocked("UNREADABLE_COMPARE", "Comparison " + base + "..." + head + " is unreadable");
        }
        status ??= comparison.status;
        totalCommits ??= Number(comparison.total_commits);
        commits.push(...comparison.commits.map((commit) => ({ sha: commit.sha })));
        if (!Number.isInteger(totalCommits)) throw blocked("UNREADABLE_COMPARE", "Comparison has no readable total_commits");
        if (commits.length >= totalCommits || comparison.commits.length === 0) break;
      }
      if (commits.length !== totalCommits) {
        throw blocked("UNREADABLE_COMPARE", "Comparison " + base + "..." + head + " is incomplete: read "
          + commits.length + " of " + totalCommits + " commits");
      }
      return { status, commits, totalCommits };
    },
    async listCommitPulls(sha) {
      // REST payloads under API version 2026-03-10 no longer carry merge_commit_sha; a merged PR
      // without it is re-read through GraphQL (mergeCommit.oid) so range membership is never guessed.
      const pulls = await readCommitPullsPage(sha);
      const result = [];
      for (const pull of pulls) {
        let mergeCommitSha = pull.merge_commit_sha ?? null;
        if (pull.merged_at && !mergeCommitSha) mergeCommitSha = await mergeCommitOf(pull);
        result.push({
          number: pull.number,
          title: pull.title ?? "",
          body: pull.body ?? "",
          url: pull.html_url ?? null,
          mergedAt: pull.merged_at ?? null,
          baseRef: pull.base?.ref ?? null,
          author: pull.user?.login ?? null,
          headRef: pull.head?.ref ?? null,
          mergeCommitSha,
        });
      }
      return result;
    },
    async readTagRef(tag) {
      const ref = await client.request(root + "/git/ref/tags/" + tag, { allow404: true });
      if (!ref) return null;
      let sha = ref.object?.sha ?? null;
      if (ref.object?.type === "tag") {
        const annotated = await client.request(root + "/git/tags/" + sha);
        sha = annotated?.object?.sha ?? null;
      }
      if (!SHA_PATTERN.test(sha ?? "")) throw blocked("UNREADABLE_TAG", "Tag " + tag + " has an unreadable commit SHA");
      return { sha };
    },
    async readRelease(tag) {
      const release = await client.request(root + "/releases/tags/" + tag, { allow404: true });
      if (!release) return null;
      return { id: release.id, url: release.html_url ?? null, tagName: release.tag_name ?? null, draft: release.draft === true };
    },
    async createTagRef(tag, sha) {
      const created = await client.request(root + "/git/refs", { method: "POST", body: { ref: "refs/tags/" + tag, sha } });
      return { sha: created?.object?.sha ?? null };
    },
    async createRelease({ tag, sha, body }) {
      const created = await client.request(root + "/releases", {
        method: "POST",
        body: {
          tag_name: tag,
          target_commitish: sha,
          name: tag,
          body,
          draft: false,
          prerelease: false,
          generate_release_notes: true,
        },
      });
      return { id: created?.id ?? null, url: created?.html_url ?? null, tagName: created?.tag_name ?? null };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Plan

function releaseBranchFor(profile) {
  const { strategy, trigger } = profile.release;
  if (strategy === "semver-by-impact" && trigger === "promotion-merge") return profile.branches.promotion;
  if (strategy === "semver-by-impact" && trigger === "integration-merge") return profile.branches.integration;
  return null; // deploy-tag: the deployed SHA is the authority, no branch check
}

async function assertOnReleaseBranch(store, branch, sha) {
  if (!branch) return;
  const comparison = await store.compare(sha, branch);
  if (comparison.status !== "ahead" && comparison.status !== "identical") {
    throw blocked("COMMIT_NOT_ON_RELEASE_BRANCH", "Commit " + sha + " is not contained in the release branch "
      + branch + " (compare status " + comparison.status + ")");
  }
}

async function findPreviousTag(store, tags, sha, { skip = null } = {}) {
  for (const tag of tags) {
    if (skip && tag.name === skip) continue;
    if (tag.sha === sha) return { tag, status: "identical", commits: [] };
    const comparison = await store.compare(tag.sha, sha);
    if (comparison.status === "identical") return { tag, status: "identical", commits: [] };
    if (comparison.status === "ahead") return { tag, status: "ahead", commits: comparison.commits };
  }
  return null;
}

async function collectIncludedPullRequests(store, commits, integrationBranch, promotionBranch = null) {
  const included = new Map();
  const excluded = new Map();
  const unattributed = [];
  const rangeShas = new Set(commits.map((commit) => commit.sha));
  for (const commit of commits) {
    const pulls = await store.listCommitPulls(commit.sha);
    const inRange = pulls.filter((pull) => pull.mergedAt && pull.mergeCommitSha && rangeShas.has(pull.mergeCommitSha));
    const merged = inRange.filter((pull) => pull.baseRef === integrationBranch);
    // PRs merged into the promotion branch (the dev -> main release PR itself, or a hotfix straight
    // into main) are never counted for the version; they are reported so nothing disappears silently.
    for (const pull of inRange.filter((pull) => promotionBranch && pull.baseRef === promotionBranch)) {
      excluded.set(pull.number, { number: pull.number, title: pull.title, url: pull.url, baseRef: pull.baseRef, mergedAt: pull.mergedAt, mergeCommitSha: pull.mergeCommitSha });
    }
    if (merged.length === 0 && !inRange.some((pull) => promotionBranch && pull.baseRef === promotionBranch && pull.mergeCommitSha === commit.sha)) {
      unattributed.push(commit.sha);
    }
    for (const pull of merged) {
      if (included.has(pull.number)) continue;
      const impact = resolvePullImpact(pull);
      included.set(pull.number, {
        number: pull.number,
        title: pull.title,
        url: pull.url,
        mergedAt: pull.mergedAt,
        mergeCommitSha: pull.mergeCommitSha,
        taskIdentity: readTaskIdentity(pull.body),
        author: pull.author ?? null,
        impact: impact.impact,
        impactRaw: impact.raw,
        impactReason: impact.reason ?? null,
      });
    }
  }
  return {
    included: [...included.values()].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)),
    excluded: [...excluded.values()].sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt)),
    unattributed,
  };
}

export async function planRelease(store, options) {
  const context = {};
  try {
    return await planReleaseInner(store, options, context);
  } catch (error) {
    // BLOCKED receipts carry the context resolved so far (sha, branch, previous tag, inventory).
    if (error instanceof ReleaseBlocked) error.extra = { ...context, ...error.extra };
    throw error;
  }
}

async function planReleaseInner(store, { repository, profile, ref, initialVersion = null }, context) {
  const base = {
    contract: RELEASE_CONTRACT,
    repository,
    strategy: profile.release.strategy,
    trigger: profile.release.trigger,
    tagPrefix: profile.release.tagPrefix,
    ref,
  };
  if (profile.release.strategy === "none") {
    throw blocked("RELEASE_DISABLED", repository + " has release strategy none; nothing to release");
  }
  if (initialVersion !== null) parseSemVer(initialVersion);

  Object.assign(context, base);
  const sha = await store.resolveCommit(ref);
  const releaseBranch = releaseBranchFor(profile);
  Object.assign(context, { sha, releaseBranch });
  await assertOnReleaseBranch(store, releaseBranch, sha);

  const tags = sortedVersionTags(await store.listVersionTags(profile.release.tagPrefix), profile.release.tagPrefix);
  const previous = await findPreviousTag(store, tags, sha);
  Object.assign(context, { previousTag: previous?.tag.name ?? null, previousSha: previous?.tag.sha ?? null });

  if (previous?.status === "identical") {
    const release = await store.readRelease(previous.tag.name);
    // The Release of an already tagged commit still needs the inventory of that version: the PRs
    // between the next lower ancestor tag and this commit.
    const inventoryBase = await findPreviousTag(store, tags, sha, { skip: previous.tag.name });
    const inventory = inventoryBase?.status === "ahead"
      ? await collectIncludedPullRequests(store, inventoryBase.commits, profile.branches.integration, profile.branches.promotion)
      : { included: [], excluded: [], unattributed: [] };
    return {
      ...base,
      sha,
      releaseBranch,
      previousTag: previous.tag.name,
      previousSha: previous.tag.sha,
      inventoryBaseTag: inventoryBase?.tag.name ?? null,
      includedPullRequests: inventory.included,
      excludedPullRequests: inventory.excluded,
      unattributedCommits: inventory.unattributed,
      impact: null,
      version: previous.tag.version,
      tag: previous.tag.name,
      outcome: release ? "ALREADY_RELEASED" : "RELEASE_MISSING",
      existingRelease: release,
      detail: release
        ? "Commit " + sha + " already carries tag " + previous.tag.name + " and its Release; nothing to do."
        : "Commit " + sha + " carries tag " + previous.tag.name + " but no GitHub Release; apply creates the Release only.",
    };
  }

  let version;
  let impact = null;
  let includedPullRequests = [];
  let excludedPullRequests = [];
  let unattributedCommits = [];
  if (previous === null) {
    if (tags.length > 0) {
      throw blocked("PREVIOUS_TAG_UNREACHABLE", "No " + profile.release.tagPrefix + "X.Y.Z tag is an ancestor of " + sha
        + " (tags: " + tags.map((tag) => tag.name).join(", ") + ")");
    }
    if (initialVersion === null) {
      throw blocked("NO_PREVIOUS_TAG", repository + " has no " + profile.release.tagPrefix
        + "X.Y.Z tag; the first release needs an explicit --initial-version");
    }
    version = initialVersion;
  } else {
    if (initialVersion !== null) {
      throw blocked("INITIAL_VERSION_NOT_ALLOWED", "--initial-version is only valid for a repository without tags; previous tag is "
        + previous.tag.name);
    }
    const collected = await collectIncludedPullRequests(store, previous.commits, profile.branches.integration, profile.branches.promotion);
    includedPullRequests = collected.included;
    excludedPullRequests = collected.excluded;
    unattributedCommits = collected.unattributed;
    Object.assign(context, { includedPullRequests, excludedPullRequests, unattributedCommits });
    if (includedPullRequests.length === 0 && previous.commits.length > 0) {
      // Commits since the tag but not one PR merged into the integration branch: a squash-merged
      // promotion, a hotfix straight into the promotion branch or direct pushes. Never guessed.
      throw blocked("NO_INCLUDED_PULL_REQUESTS", previous.commits.length + " commit(s) since " + previous.tag.name
        + " but no pull request merged into " + profile.branches.integration + " is in the range"
        + (excludedPullRequests.length > 0 ? " (excluded, base " + profile.branches.promotion + ": "
          + excludedPullRequests.map((pull) => "#" + pull.number).join(", ") + ")" : "")
        + (unattributedCommits.length > 0 ? "; commits without a pull request: " + unattributedCommits.map((sha) => sha.slice(0, 7)).join(", ") : "")
        + ". Decide by hand (tag it, or merge the work through the integration branch).");
    }
    const invalid = includedPullRequests.filter((pull) => pull.impact === null);
    if (invalid.length > 0) {
      throw blocked("INVALID_VERSION_IMPACT", "Included pull request(s) have no valid `## Version impact`: "
        + invalid.map((pull) => "#" + pull.number + " (" + pull.impactReason + ")").join("; "));
    }
    impact = maxImpact(includedPullRequests.map((pull) => pull.impact));
    if (impact === "none") {
      return {
        ...base,
        sha,
        releaseBranch,
        previousTag: previous.tag.name,
        previousSha: previous.tag.sha,
        includedPullRequests,
        excludedPullRequests,
        unattributedCommits,
        impact,
        version: null,
        tag: null,
        outcome: "NO_RELEASE",
        detail: includedPullRequests.length + " included pull request(s) since " + previous.tag.name
          + " all have Version impact none" + dependabotDefaults(includedPullRequests) + "; no tag and no Release are created.",
      };
    }
    version = bumpVersion(previous.tag.version, impact);
  }

  const tag = profile.release.tagPrefix + version;
  const existingTag = await store.readTagRef(tag);
  if (existingTag && existingTag.sha !== sha) {
    throw blocked("TAG_CONFLICT", "Tag " + tag + " already exists on " + existingTag.sha + ", not on " + sha);
  }
  const existingRelease = await store.readRelease(tag);
  if (existingRelease && !existingTag) {
    throw blocked("RELEASE_WITHOUT_TAG", "A GitHub Release " + tag + " exists but the tag ref does not; resolve by hand");
  }

  return {
    ...base,
    sha,
    releaseBranch,
    previousTag: previous?.tag.name ?? null,
    previousSha: previous?.tag.sha ?? null,
    includedPullRequests,
    excludedPullRequests,
    unattributedCommits,
    impact,
    version,
    tag,
    existingTag,
    existingRelease,
    outcome: existingTag && existingRelease ? "ALREADY_RELEASED" : "PLANNED",
    detail: existingTag && existingRelease
      ? "Tag " + tag + " and its Release already exist on " + sha + "; nothing to do."
      : (previous ? "Impact " + impact + " over " + includedPullRequests.length + " pull request(s) since "
        + previous.tag.name + ": " : "First release (no previous tag): ")
        + "create tag " + tag + (existingTag ? " (exists)" : "") + " and its Release on " + sha + ".",
  };
}

// ---------------------------------------------------------------------------------------------
// Apply

export async function applyRelease(store, plan) {
  if (plan.outcome === "ALREADY_RELEASED" || plan.outcome === "NO_RELEASE") {
    return { ...plan, mode: "apply", applied: { tag: false, release: false } };
  }
  if (plan.outcome !== "PLANNED" && plan.outcome !== "RELEASE_MISSING") {
    throw blocked("INVALID_PLAN", "Cannot apply a plan with outcome " + plan.outcome);
  }

  const applied = { tag: false, release: false };
  let tagRef = await store.readTagRef(plan.tag);
  if (tagRef && tagRef.sha !== plan.sha) {
    throw blocked("TAG_CONFLICT", "Tag " + plan.tag + " appeared on " + tagRef.sha + " before apply; not on " + plan.sha);
  }
  if (!tagRef) {
    await store.createTagRef(plan.tag, plan.sha);
    tagRef = await store.readTagRef(plan.tag);
    if (tagRef?.sha !== plan.sha) {
      throw blocked("READBACK_MISMATCH", "Tag " + plan.tag + " did not read back on " + plan.sha);
    }
    applied.tag = true;
  }

  let release = await store.readRelease(plan.tag);
  if (!release) {
    await store.createRelease({ tag: plan.tag, sha: plan.sha, body: formatIncludedIssuesBlock(plan.includedPullRequests) });
    release = await store.readRelease(plan.tag);
    if (!release || release.tagName !== plan.tag || release.draft) {
      throw blocked("READBACK_MISMATCH", "Release " + plan.tag + " did not read back as a published release");
    }
    applied.release = true;
  }

  return {
    ...plan,
    mode: "apply",
    outcome: "RELEASED",
    applied,
    release,
    detail: "Tag " + plan.tag + (applied.tag ? " created" : " existed") + ", Release "
      + (applied.release ? "created" : "existed") + " on " + plan.sha + ".",
  };
}

// ---------------------------------------------------------------------------------------------
// Summary and CLI

export function formatReleaseSummary(receipt) {
  const lines = [
    "# Release " + receipt.repository + " (" + receipt.mode + ")",
    "",
    "- Outcome: `" + receipt.outcome + "`" + (receipt.code ? " (`" + receipt.code + "`)" : ""),
    "- Commit: `" + (receipt.sha ?? receipt.ref) + "`" + (receipt.releaseBranch ? " on `" + receipt.releaseBranch + "`" : ""),
    "- Previous tag: " + (receipt.previousTag ? "`" + receipt.previousTag + "`" : "none"),
    "- Impact: " + (receipt.impact ?? "n/a") + "; version: " + (receipt.version ?? "n/a") + "; tag: " + (receipt.tag ? "`" + receipt.tag + "`" : "none"),
    "- " + receipt.detail,
  ];
  const pulls = receipt.includedPullRequests ?? [];
  if (pulls.length > 0) {
    lines.push("", "| PR | Impact | Task identity | Merged |", "| --- | --- | --- | --- |");
    for (const pull of pulls) {
      const impactCell = pull.impact === null ? "invalid: " + pull.impactReason
        : pull.impactRaw === "dependabot-default" ? pull.impact + " (dependabot default)" : pull.impact;
      lines.push("| #" + pull.number + " | " + impactCell + " | "
        + (pull.taskIdentity ?? "-") + " | " + pull.mergedAt + " |");
    }
  }
  if ((receipt.excludedPullRequests ?? []).length > 0) {
    lines.push("", "Pull requests merged into the promotion branch in range (never counted for the version): "
      + receipt.excludedPullRequests.map((pull) => "#" + pull.number + " (" + pull.baseRef + ")").join(", ") + ".");
  }
  if ((receipt.unattributedCommits ?? []).length > 0) {
    lines.push("", "Commits in range without a merged pull request (treated as impact none): "
      + receipt.unattributedCommits.map((sha) => "`" + sha.slice(0, 7) + "`").join(", ") + ".");
  }
  if (receipt.release?.url) lines.push("", "Release: " + receipt.release.url);
  return lines.join("\n") + "\n";
}

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, repository: null, ref: null, initialVersion: null, output: null, activate: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    const value = rest[index + 1];
    if (arg === "--repository") { options.repository = value; index += 1; } else
    if (arg === "--ref") { options.ref = value; index += 1; } else
    if (arg === "--initial-version") { options.initialVersion = value; index += 1; } else
    if (arg === "--output") { options.output = value; index += 1; } else
    if (arg === "--activate") { options.activate = value; index += 1; } else
    throw new Error("Unknown argument: " + arg);
  }
  if (options.mode !== "plan" && options.mode !== "apply") throw new Error("Usage: release.mjs plan|apply --repository <owner/repo> --ref <ref>");
  if (!options.repository || !options.ref) throw new Error("--repository and --ref are required");
  return options;
}

export async function runRelease(store, { mode, repository, profile, ref, initialVersion }) {
  let receipt;
  try {
    const plan = await planRelease(store, { repository, profile, ref, initialVersion });
    receipt = mode === "apply" ? await applyRelease(store, plan) : { ...plan, mode: "plan" };
  } catch (error) {
    if (!(error instanceof ReleaseBlocked)) throw error;
    receipt = {
      contract: RELEASE_CONTRACT,
      repository,
      mode,
      ref,
      outcome: "BLOCKED",
      code: error.code,
      detail: error.message,
      ...error.extra,
    };
  }
  receipt.generatedAt = new Date().toISOString();
  return receipt;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (options.mode === "apply") {
    if (options.activate !== RELEASE_ACTIVATION) throw new Error("apply requires --activate " + RELEASE_ACTIVATION);
    if (process.env.CHIPIN_RELEASE_WRITE !== "1") throw new Error("apply requires CHIPIN_RELEASE_WRITE=1");
  }
  const profile = requireRepositoryProfile(options.repository);
  const store = githubStore(new GitHubClient(token), options.repository);
  const receipt = await runRelease(store, { ...options, profile });
  const summary = formatReleaseSummary(receipt);
  process.stdout.write(summary);
  if (options.output) fs.writeFileSync(options.output, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, [
      "outcome=" + receipt.outcome,
      "tag=" + (receipt.tag ?? ""),
      "version=" + (receipt.version ?? ""),
      "sha=" + (receipt.sha ?? ""),
    ].join("\n") + "\n", "utf8");
  }
  if (receipt.outcome === "BLOCKED") process.exitCode = 1;
}

const isMainModule = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.stack ?? error.message : String(error)) + "\n");
    process.exitCode = 1;
  });
}
