import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PREFIX = /^\[create-milestone\](?:\s+)(.+)$/i;
const RECEIPT_MARKER = '<!-- chipin:create-milestone:v1 -->';
const AUTHORIZED = new Set(['write', 'maintain', 'admin']);
const MILESTONE_REPOSITORIES = new Set([
    'ChipIn-one/chipin-frontend',
    'ChipIn-one/chipin-backend',
]);

const displayError = error => {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/[\r\n]+/g, ' ').slice(0, 400);
};

export const parseMilestoneRequest = ({ title, body }) => {
    if (typeof title !== 'string' || !/^\[create-milestone\]/i.test(title)) {
        return null;
    }
    const match = PREFIX.exec(title);
    if (!match) {
        throw new Error('Use title: [create-milestone] <milestone title>.');
    }
    const milestoneTitle = match[1].trim();
    if (milestoneTitle.length === 0 || milestoneTitle.length > 100 || /[\x00-\x1f\x7f]/.test(milestoneTitle)) {
        throw new Error('Milestone title must contain 1–100 printable characters.');
    }
    if (typeof body !== 'string' || body.length > 4096) {
        throw new Error('Request body must be plain text of at most 4096 characters.');
    }
    const fields = new Map();
    for (const rawLine of body.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const entry = /^(Description|Due date):\s*(.*?)\s*$/i.exec(line);
        if (!entry) {
            throw new Error('Only Description: and optional Due date: lines are supported.');
        }
        const key = entry[1].toLowerCase();
        if (fields.has(key)) {
            throw new Error(`Duplicate request field: ${entry[1]}.`);
        }
        fields.set(key, entry[2]);
    }
    const description = fields.get('description');
    if (!description || description.length > 1000) {
        throw new Error('Description: is required (1–1000 characters).');
    }
    const dueDate = fields.get('due date');
    let dueOn;
    if (dueDate !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)
            || Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))
            || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate) {
            throw new Error('Due date: must be a valid YYYY-MM-DD UTC calendar date.');
        }
        dueOn = `${dueDate}T23:59:59Z`;
    }
    return { title: milestoneTitle, description, ...(dueOn ? { due_on: dueOn } : {}) };
};

export const canCreateMilestone = value => {
    // A contradictory permission response must not grant mutation authority.
    if (!value || typeof value !== 'object') return false;
    if (typeof value.permission === 'string') return AUTHORIZED.has(value.permission);
    return AUTHORIZED.has(value.role_name);
};

export const matchingMilestone = (milestones, title) => {
    const key = title.trim().toLowerCase();
    const matches = milestones.filter(item => typeof item.title === 'string'
        && item.title.trim().toLowerCase() === key);
    if (matches.length > 1) {
        throw new Error(`Multiple milestones already match "${title}". Resolve them manually; no milestone created.`);
    }
    return matches[0] ?? null;
};

const verifyMilestone = (milestone, title) => {
    if (!milestone || !Number.isSafeInteger(milestone.number) || milestone.number < 1
        || typeof milestone.html_url !== 'string'
        || !/^https:\/\/github\.com\//.test(milestone.html_url)
        || milestone.title?.trim().toLowerCase() !== title.trim().toLowerCase()
        || !['open', 'closed'].includes(milestone.state)) {
        throw new Error('Milestone API read-back was invalid; inspect the repository before retrying.');
    }
    return milestone;
};

export const findOrCreateMilestone = (request, api) => api.listMilestones()
    .then(milestones => {
        const found = matchingMilestone(milestones, request.title);
        if (found) {
            return { milestone: verifyMilestone(found, request.title), created: false };
        }
        return api.createMilestone(request)
            .then(created => api.getMilestone(created.number)
                .then(receipt => ({ milestone: verifyMilestone(receipt, request.title), created: true })))
            .catch(error => {
                if (error.status !== 422) throw error;
                return api.listMilestones().then(updated => {
                    const raced = matchingMilestone(updated, request.title);
                    if (!raced) throw error;
                    return { milestone: verifyMilestone(raced, request.title), created: false };
                });
            });
    });

const milestoneReceipt = ({ milestone, created }) => `${RECEIPT_MARKER}\n`
    + `Milestone ${created ? 'created' : 'already exists'}: ${milestone.html_url}\n\n`
    + `Number: **#${milestone.number}** · State: **${milestone.state}**.\n`
    + 'Existing milestone metadata and Issue assignments were not modified.';
const errorReceipt = error => `${RECEIPT_MARKER}\nMilestone request not completed: ${displayError(error)}\n\n`
    + 'Correct the request or permissions, then edit the Issue or run Create milestone with this Issue number. The Issue remains open.';

export const runMilestoneControl = (issueNumber, api) => {
    let issue;
    return api.getIssue(issueNumber)
        .then(value => {
            issue = value;
            if (issue.pull_request || issue.state !== 'open') return { status: 'ignored' };
            const request = parseMilestoneRequest(issue);
            if (!request) return { status: 'ignored' };
            return api.getPermission(issue.user?.login)
                .then(permission => {
                    if (!canCreateMilestone(permission)) {
                        throw new Error('Issue author requires repository write, maintain, or admin permission.');
                    }
                    return findOrCreateMilestone(request, api);
                })
                .then(result => api.upsertReceipt(issueNumber, milestoneReceipt(result))
                    .then(() => {
                        return api.closeIssue(issueNumber);
                    })
                    .then(() => api.getIssue(issueNumber))
                    .then(updated => {
                        if (updated.state !== 'closed') {
                            throw new Error('Milestone exists, but control Issue closure was not confirmed.');
                        }
                        return { status: 'completed', ...result };
                    }));
        })
        .catch(error => {
            if (!issue || issue.state !== 'open') throw error;
            return api.upsertReceipt(issueNumber, errorReceipt(error))
                .then(() => { throw error; });
        });
};

export const makeGitHubApi = ({ token, repository, fetchImpl = fetch }) => {
    if (!token || !/^[-\w.]+\/[-\w.]+$/.test(repository)) {
        throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required.');
    }
    if (!MILESTONE_REPOSITORIES.has(repository)) {
        throw new Error('Milestone creation is supported only in ChipIn-one/chipin-frontend and ChipIn-one/chipin-backend.');
    }
    const prefix = `/repos/${repository}`;
    const request = (method, path, body) => fetchImpl(`https://api.github.com${path}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(response => response.text().then(raw => {
        let data;
        try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
        if (!response.ok) {
            const error = new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}): ${String(data?.message ?? 'API error').slice(0, 160)}`);
            error.status = response.status;
            throw error;
        }
        return data;
    }));
    const list = (path, page = 1, items = []) => {
        if (page > 100) {
            return Promise.reject(new Error('Pagination limit reached; refuse to create an unverified duplicate.'));
        }
        return request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
            .then(batch => {
                if (!Array.isArray(batch)) throw new Error('Expected a paginated GitHub API array.');
                items.push(...batch);
                return batch.length < 100 ? items : list(path, page + 1, items);
            });
    };
    const upsertReceipt = (number, message) => list(`${prefix}/issues/${number}/comments`)
        .then(comments => {
            const botReceipts = comments.filter(item => item.user?.login === 'github-actions[bot]'
                && typeof item.body === 'string' && item.body.startsWith(RECEIPT_MARKER));
            if (botReceipts.length > 1) {
                throw new Error('Multiple bot receipts exist; manual reconciliation required.');
            }
            if (botReceipts.length === 1) {
                if (botReceipts[0].body === message) return botReceipts[0];
                return request('PATCH', `${prefix}/issues/comments/${botReceipts[0].id}`, { body: message });
            }
            return request('POST', `${prefix}/issues/${number}/comments`, { body: message });
        });
    return {
        getIssue: number => request('GET', `${prefix}/issues/${number}`),
        getPermission: login => {
            if (typeof login !== 'string' || !/^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/.test(login)) {
                return Promise.reject(new Error('Issue author login is invalid.'));
            }
            return request('GET', `${prefix}/collaborators/${encodeURIComponent(login)}/permission`);
        },
        listMilestones: () => list(`${prefix}/milestones?state=all`),
        createMilestone: data => request('POST', `${prefix}/milestones`, data),
        getMilestone: number => request('GET', `${prefix}/milestones/${number}`),
        upsertReceipt,
        closeIssue: number => request('PATCH', `${prefix}/issues/${number}`, { state: 'closed', state_reason: 'completed' }),
    };
};

const isMainModule = process.argv[1]
    && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMainModule) {
    try {
        const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
        const rawNumber = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
            ? process.env.CONTROL_ISSUE_NUMBER : event.issue?.number;
        const number = Number(rawNumber);
        if (!Number.isSafeInteger(number) || number < 1 || String(rawNumber) !== String(number)) {
            throw new Error('A valid control Issue number is required.');
        }
        runMilestoneControl(number, makeGitHubApi({
            token: process.env.GITHUB_TOKEN,
            repository: process.env.GITHUB_REPOSITORY,
        })).then(result => {
            console.log(`Create milestone control: ${result.status}`);
        }).catch(error => {
            console.error(displayError(error));
            process.exitCode = 1;
        });
    } catch (error) {
        console.error(displayError(error));
        process.exitCode = 1;
    }
}
