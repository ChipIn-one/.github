// Shared GitHub transport and active canonical-schema readers.

const API = "https://api.github.com";
const GRAPHQL = `${API}/graphql`;
const API_VERSION = "2026-03-10";

export function verifyOrgSchema(config, fields, types) {
  const blockers = [];
  for (const [name, expected] of Object.entries(config.issueFields)) {
    const matches = fields.filter((field) => Number(field.id) === expected.id);
    if (matches.length !== 1) {
      blockers.push(`Issue field ${name} id=${expected.id} is missing or ambiguous`);
      continue;
    }
    const field = matches[0];
    if (field.name !== name || field.data_type !== expected.dataType) {
      blockers.push(`Issue field id=${expected.id} has unexpected name/data type`);
      continue;
    }
    const options = new Set((field.options ?? []).map((option) => option.name));
    for (const option of expected.options) {
      if (!options.has(option)) blockers.push(`Issue field ${name} is missing option ${option}`);
    }
  }
  for (const [name, id] of Object.entries(config.issueTypes)) {
    const matches = types.filter((type) => Number(type.id) === id);
    if (matches.length !== 1 || matches[0].name !== name || matches[0].is_enabled === false) {
      blockers.push(`Issue Type ${name} id=${id} is missing, renamed, disabled, or ambiguous`);
    }
  }
  return blockers;
}


export function verifyProjectSnapshot(config, project) {
  const blockers = [];
  if (!project) return [`Project #${config.project.number} is unreadable`];
  for (const [name, expected] of Object.entries(config.issueFields)) {
    const matches = project.fields.filter((field) => field.name === name);
    if (matches.length !== 1) {
      blockers.push(`Project field ${name} is missing or ambiguous (${matches.length} matches)`);
      continue;
    }
    const field = matches[0];
    const linkedId = field.issueField?.fullDatabaseId == null ? null : Number(field.issueField.fullDatabaseId);
    if (!field.isIssueField || linkedId !== expected.id || field.issueField?.name !== name) {
      blockers.push(`Project field ${name} is not linked to org Issue Field id=${expected.id}`);
    }
  }
  const statusMatches = project.fields.filter((field) => field.name === config.project.statusField);
  if (statusMatches.length !== 1) {
    blockers.push(`Project Status is missing or ambiguous (${statusMatches.length} matches)`);
  } else {
    const status = statusMatches[0];
    if (status.isIssueField) blockers.push("Project Status must remain project-local");
    const options = new Set((status.options ?? []).map((option) => option.name));
    for (const value of config.project.statusValues) {
      if (!options.has(value)) blockers.push(`Project Status is missing option ${value}`);
    }
  }
  return blockers;
}


export class GitHubClient {
  constructor(token, fetchImpl = fetch) {
    if (!token) throw new Error("GITHUB_TOKEN is required");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }
  async request(path, { method = "GET", body, allow404 = false } = {}) {
    const response = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${await response.text()}`);
    if (response.status === 204) return null;
    return response.json();
  }
  async listAll(path) {
    const separator = path.includes("?") ? "&" : "?";
    const values = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`${path}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Expected array from ${path}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }
  async graphql(query, variables) {
    const response = await this.fetchImpl(GRAPHQL, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`GraphQL -> ${response.status}: ${await response.text()}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors.map((error) => error.message).join("; "));
    return payload.data;
  }
}


const PROJECT_QUERY = `
query MetadataProject($org: String!, $number: Int!, $itemsAfter: String, $fieldsAfter: String) {
  organization(login: $org) {
    projectV2(number: $number) {
      id
      fields(first: 100, after: $fieldsAfter) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on ProjectV2Field {
            id name dataType isIssueField
            issueField { __typename ... on IssueFieldSingleSelect { fullDatabaseId name } }
          }
          ... on ProjectV2SingleSelectField {
            id name dataType isIssueField options { id name }
            issueField { __typename ... on IssueFieldSingleSelect { fullDatabaseId name } }
          }
        }
      }
      items(first: 100, after: $itemsAfter) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content { __typename ... on Issue { number repository { nameWithOwner } } }
          fieldValueByName(name: "Status") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

export async function readProjectSnapshot(client, config) {
  const items = [];
  const fields = [];
  let itemsAfter = null;
  let fieldsAfter = null;
  let itemsDone = false;
  let fieldsDone = false;
  let totalCount = null;
  let fieldTotalCount = null;
  let projectId = null;

  do {
    const data = await client.graphql(PROJECT_QUERY, {
      org: config.organization,
      number: config.project.number,
      itemsAfter,
      fieldsAfter,
    });
    const project = data.organization?.projectV2;
    if (!project) throw new Error(`Project #${config.project.number} is unavailable`);
    if (projectId !== null && project?.id && projectId !== project.id) {
      throw new Error(`Project #${config.project.number} identity changed during pagination`);
    }
    projectId ??= project?.id ?? null;
    if (!project.fields?.pageInfo || !Array.isArray(project.fields.nodes)) {
      throw new Error("Project fields pagination is unreadable");
    }
    if (!project.items?.pageInfo || !Array.isArray(project.items.nodes)) {
      throw new Error("Project items pagination is unreadable");
    }

    if (!fieldsDone) {
      fieldTotalCount ??= project.fields.totalCount;
      fields.push(...project.fields.nodes.filter(Boolean));
      if (project.fields.pageInfo.hasNextPage && !project.fields.pageInfo.endCursor) {
        throw new Error("Project fields pagination cursor is missing");
      }
      fieldsAfter = project.fields.pageInfo.endCursor;
      fieldsDone = !project.fields.pageInfo.hasNextPage;
    }

    if (!itemsDone) {
      totalCount ??= project.items.totalCount;
      items.push(...project.items.nodes.filter(Boolean));
      if (project.items.pageInfo.hasNextPage && !project.items.pageInfo.endCursor) {
        throw new Error("Project items pagination cursor is missing");
      }
      itemsAfter = project.items.pageInfo.endCursor;
      itemsDone = !project.items.pageInfo.hasNextPage;
    }
  } while (!fieldsDone || !itemsDone);

  if (Number.isInteger(fieldTotalCount) && fields.length !== fieldTotalCount) {
    throw new Error(`Project fields pagination is incomplete: read ${fields.length} of ${fieldTotalCount}`);
  }
  if (Number.isInteger(totalCount) && items.length !== totalCount) {
    throw new Error(`Project items pagination is incomplete: read ${items.length} of ${totalCount}`);
  }

  return {
    id: projectId,
    totalCount,
    fields,
    items: items.map((item) => ({
      id: item.id,
      repository: item.content?.repository?.nameWithOwner ?? null,
      number: item.content?.number ?? null,
      status: item.fieldValueByName?.name ?? null,
    })),
  };
}


function compactIssue(issue) {
  if (!issue) return null;
  return { repository: issue.repository_url?.split("/repos/")[1] ?? null, number: issue.number, state: issue.state };
}

export async function readIssueSnapshot(client, repository, number) {
  const [owner, repo] = repository.split("/");
  const root = `/repos/${owner}/${repo}/issues/${number}`;
  const [issue, issueFieldValues, blockedBy, blocking, parent, subIssues] = await Promise.all([
    client.request(root),
    client.listAll(`${root}/issue-field-values`),
    client.listAll(`${root}/dependencies/blocked_by`),
    client.listAll(`${root}/dependencies/blocking`),
    client.request(`${root}/parent`, { allow404: true }),
    client.listAll(`${root}/sub_issues`),
  ]);
  return {
    issue,
    issueFieldValues,
    blockedBy: blockedBy.map(compactIssue),
    blocking: blocking.map(compactIssue),
    parent: compactIssue(parent),
    subIssues: subIssues.map(compactIssue),
    relationsReadable: true,
  };
}
