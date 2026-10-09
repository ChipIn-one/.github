import { createHash } from 'node:crypto';
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

const verifyCreatedMilestone = (milestone, request) => {
    const verified = verifyMilestone(milestone, request.title);
    // A successful POST alone is not sufficient: confirm the exact metadata
    // requested by the control Issue. Do not modify existing milestones.
    const expectedDue = request.due_on === undefined ? null : Date.parse(request.due_on);
    const actualDue = verified.due_on == null ? null
        : typeof verified.due_on === 'string' ? Date.parse(verified.due_on) : NaN;
    if (verified.description !== request.description
        || !Number.isFinite(expectedDue) && expectedDue !== null
        || !Number.isFinite(actualDue) && actualDue !== null
        || actualDue !== expectedDue) {
        throw new Error('Created milestone metadata read-back does not match Description or Due date; inspect before retrying.');
    }
    return verified;
};

const requestFingerprint = request => createHash('sha256')
    .update(JSON.stringify(request)).digest('hex');

export const findOrCreateMilestone = async (
    request, api, beforeCreate = async () => {}, pending = null,
    beforePost = async () => {}, clearAbortedIntent = async () => {},
) => {
    const milestones = await api.listMilestones();
    const found = matchingMilestone(milestones, request.title);
    if (pending !== null) {
        // Number means POST returned before verification failed. An intent
        // fingerprint means POST may have committed even if its response was lost.
        if (typeof pending === 'object' && pending.intentHash !== requestFingerprint(request)) {
            throw new Error('Pending milestone request changed; reconcile manually before retrying.');
        }
        if (found) {
            if (typeof pending === 'number' && found.number !== pending) {
                throw new Error('Pending milestone no longer matches this request; reconcile manually before retrying.');
            }
            try {
                const receipt = await api.getMilestone(found.number);
                return { milestone: verifyCreatedMilestone(receipt, request), created: true };
            } catch (error) {
                error.pendingMilestoneNumber = found.number;
                throw error;
            }
        }
        if (typeof pending === 'number') {
            throw new Error('Pending milestone no longer matches this request; reconcile manually before retrying.');
        }
        // Persisted intent without a matching milestone: POST may have failed,
        // so a fresh authorized creation attempt is safe.
    } else if (found) {
        // Legacy milestones remain reusable without rewriting their metadata.
        return { milestone: verifyMilestone(found, request.title), created: false };
    }

    await beforeCreate();
    // Critical ordering: persist verification intent BEFORE any non-idempotent
    // POST. Never create if the receipt cannot be persisted.
    await beforePost();
    // Receipt writes can take time; recheck authorization and Issue state
    // immediately before creating the milestone.
    try {
        await beforeCreate();
    } catch (error) {
        // No POST occurred in this run. Clear only a newly recorded intent;
        // never erase a prior ambiguous POST's verification obligation.
        if (pending === null) await clearAbortedIntent();
        throw error;
    }
    try {
        const created = await api.createMilestone(request);
        try {
            const receipt = await api.getMilestone(created.number);
            return { milestone: verifyCreatedMilestone(receipt, request), created: true };
        } catch (error) {
            if (Number.isSafeInteger(created.number) && created.number > 0) {
                error.pendingMilestoneNumber = created.number;
            }
            throw error;
        }
    } catch (error) {
        if (error.status !== 422) throw error;
        const updated = await api.listMilestones();
        const raced = matchingMilestone(updated, request.title);
        if (!raced) throw error;
        // HTTP 422 confirms this POST was rejected. Another request owns the
        // winner; preserve existing-milestone reuse without mutating metadata.
        return { milestone: verifyMilestone(raced, request.title), created: false };
    }
};

const milestoneReceipt = ({ milestone, created }) => `${RECEIPT_MARKER}\n`
    + `Milestone ${created ? 'created' : 'already exists'}: ${milestone.html_url}\n\n`
    + `Number: **#${milestone.number}** · State: **${milestone.state}**.\n`
    + 'Existing milestone metadata and Issue assignments were not modified.';
const pendingMarker = number => `<!-- chipin:create-milestone:pending-verification:v1:${number} -->\n`;
const pendingIntentMarker = hash => `<!-- chipin:create-milestone:pending-intent:v1:${hash} -->\n`;
const pendingIntentReceipt = request => `${RECEIPT_MARKER}\n`
    + pendingIntentMarker(requestFingerprint(request))
    + 'Milestone POST may be in progress. Do not close this control Issue until the result is verified.';
const errorReceipt = error => `${RECEIPT_MARKER}\n`
    + (Number.isSafeInteger(error.pendingMilestoneNumber) && error.pendingMilestoneNumber > 0
        ? pendingMarker(error.pendingMilestoneNumber)
        : typeof error.pendingIntentHash === 'string' ? pendingIntentMarker(error.pendingIntentHash) : '')
    + `Milestone request not completed: ${displayError(error)}\n\n`
    + 'Correct the request or permissions, then edit the Issue or run Create milestone with this Issue number. The Issue remains open.';
const incompleteControlReceipt = (result, error) => milestoneReceipt(result)
    + `\n\nControl Issue not completed: ${displayError(error)}\n`
    + 'The milestone already exists; the control Issue remains open. '
    + 'Correct the request or retry without creating a second milestone.';


const confirmUnchangedControl = async (issueNumber, originalIssue, request, api) => {
    const latest = await api.getIssue(issueNumber);
    if (latest.state !== 'open' || latest.pull_request) {
        throw new Error('Control Issue is no longer open; the milestone request was cancelled.');
    }
    if (latest.user?.login !== originalIssue.user?.login
        || JSON.stringify(parseMilestoneRequest(latest)) !== JSON.stringify(request)) {
        throw new Error('Control Issue request changed; retry the updated request instead.');
    }
    return latest;
};

const isMilestoneControlIssue = issue => !issue?.pull_request
    && typeof issue?.title === 'string'
    && /^\[create-milestone\]/i.test(issue.title);

const matchesIssueEvent = (issue, eventIssue) =>
    eventIssue && typeof eventIssue.title === 'string'
    && (typeof eventIssue.body === 'string' || eventIssue.body === null)
    && typeof eventIssue.user?.login === 'string'
    && issue.title === eventIssue.title
    && issue.body === eventIssue.body
    && issue.user?.login === eventIssue.user.login;

export const runMilestoneControl = async (issueNumber, api, triggeringActor, eventIssue = null) => {
    let recognizedControl = false;
    let pendingState = null;
    let result;
    let successReceiptWritten = false;
    try {
        const issue = await api.getIssue(issueNumber);
        if (issue.pull_request || issue.state !== 'open') return { status: 'ignored' };
        // Never authorize the current Issue text with the actor of a stale
        // issues:edited/opened/reopened event. Only workflow_dispatch is
        // intentionally allowed to operate on the latest Issue contents.
        if (eventIssue !== null && !matchesIssueEvent(issue, eventIssue)) {
            return { status: 'ignored' };
        }
        recognizedControl = isMilestoneControlIssue(issue);
        const request = parseMilestoneRequest(issue);
        if (!request) return { status: 'ignored' };
        pendingState = await api.getPendingCreated(issueNumber);
        if (pendingState && typeof pendingState === 'object'
            && pendingState.intentHash !== requestFingerprint(request)) {
            throw new Error('Pending milestone request changed; reconcile manually before retrying.');
        }

        // An Issue editor/manual dispatcher cannot borrow the author's rights.
        // Recheck BOTH accounts after potentially long milestone pagination,
        // directly before POST, so a mid-run permission revocation fails closed.
        const checkPermissions = async () => {
            if (typeof triggeringActor !== 'string' || !/^[A-Za-z\d](?:[A-Za-z\d-]{0,38})$/.test(triggeringActor)) {
                throw new Error('A valid trusted triggering actor is required.');
            }
            const actorPermission = await api.getPermission(triggeringActor);
            if (!canCreateMilestone(actorPermission)) {
                throw new Error('Triggering actor requires repository write, maintain, or admin permission.');
            }
            const authorPermission = issue.user?.login === triggeringActor
                ? actorPermission : await api.getPermission(issue.user?.login);
            if (!canCreateMilestone(authorPermission)) {
                throw new Error('Issue author requires repository write, maintain, or admin permission.');
            }
        };
        await checkPermissions();
        const recheck = () => confirmUnchangedControl(issueNumber, issue, request, api);
        const reauthorizeBeforeCreate = async () => {
            await recheck();
            await checkPermissions();
        };
        const recordIntent = () => api.upsertReceipt(issueNumber, pendingIntentReceipt(request));
        const clearAbortedIntent = () => api.clearPendingIntent(issueNumber, requestFingerprint(request));
        result = await findOrCreateMilestone(
            request, api, reauthorizeBeforeCreate, pendingState, recordIntent, clearAbortedIntent,
        );
        // Also guard the existing-milestone and read-back paths before writing
        // any receipt: an Issue may have changed after the initial GET.
        await recheck();
        await api.upsertReceipt(issueNumber, milestoneReceipt(result));
        successReceiptWritten = true;
        await recheck(); // Last observable validation before closing the Issue.

        let patch, closeError;
        try {
            patch = await api.closeIssue(issueNumber);
        } catch (error) {
            closeError = error;
        }
        let actual;
        try {
            actual = await api.getIssue(issueNumber);
        } catch {
            // A successful PATCH response still confirms completion if a
            // subsequent GET is unavailable. A lost PATCH response does not.
        }
        if (actual?.state === 'closed' && actual.state_reason === 'completed') {
            return { status: 'completed', ...result };
        }
        if (actual?.state === 'closed') {
            throw new Error('Control Issue was closed for another reason; its terminal state was preserved.');
        }
        // A fresh successful GET is more authoritative than the earlier PATCH:
        // another user may have reopened the Issue after PATCH completed.
        if (actual !== undefined) {
            // Keep the concrete PATCH error when the follow-up read confirms
            // the Issue remains open; only a successful PATCH may be stale.
            if (closeError) throw closeError;
            throw new Error('Milestone exists, but control Issue read-back is not closed/completed.');
        }
        if (!closeError && patch?.state === 'closed' && patch.state_reason === 'completed') {
            return { status: 'completed', ...result };
        }
        if (closeError) throw closeError;
        throw new Error('Milestone exists, but control Issue closure was not confirmed.');
    } catch (error) {
        // If PATCH succeeded but its response/GET was lost, the Issue may be
        // closed. Never overwrite its success receipt with a false "open" error.
        let current;
        try {
            current = await api.getIssue(issueNumber);
        } catch {
            if (successReceiptWritten) throw error;
            // Without a fresh state read we cannot safely claim it is open.
            throw error;
        }
        // A temporary GET failure may recover to an ordinary Issue.
        // Ordinary Issues must not acquire a milestone bot receipt or fail
        // merely because this workflow was triggered for an edit.
        if (!recognizedControl && !result && !isMilestoneControlIssue(current)) {
            return { status: 'ignored' };
        }
        // The milestone is confirmed even if the control Issue was closed
        // externally before the first success receipt. Report that truth
        // without touching the Issue's terminal state.
        if (result && current?.state === 'closed' && !successReceiptWritten) {
            await api.upsertReceipt(issueNumber, milestoneReceipt(result));
        }
        if (current?.state === 'open' && (result || isMilestoneControlIssue(current))) {
            // Preserve a pending POST identity across further read/permission
            // failures. Without this marker, the next run could incorrectly
            // treat the unverified milestone as a legacy existing milestone.
            if (!result && !error.pendingMilestoneNumber) {
                const persisted = pendingState ?? await api.getPendingCreated(issueNumber);
                if (typeof persisted === 'number') {
                    error.pendingMilestoneNumber = persisted;
                } else if (persisted?.intentHash) {
                    error.pendingIntentHash = persisted.intentHash;
                }
            }
            await api.upsertReceipt(issueNumber, result
                ? incompleteControlReceipt(result, error) : errorReceipt(error));
        }
        throw error;
    }
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
    const singleBotReceipt = comments => {
        const receipts = comments.filter(item => item.user?.login === 'github-actions[bot]'
            && typeof item.body === 'string' && item.body.startsWith(RECEIPT_MARKER));
        if (receipts.length > 1) {
            throw new Error('Multiple bot receipts exist; manual reconciliation required.');
        }
        return receipts[0] ?? null;
    };
    const getPendingCreated = number => list(`${prefix}/issues/${number}/comments`)
        .then(comments => {
            const receipt = singleBotReceipt(comments);
            if (!receipt) return null;
            const pendingNumber = /<!-- chipin:create-milestone:pending-verification:v1:(\d+) -->/.exec(receipt.body);
            if (pendingNumber) {
                const numberValue = Number(pendingNumber[1]);
                if (!Number.isSafeInteger(numberValue) || numberValue < 1) {
                    throw new Error('Invalid pending milestone number; reconcile manually.');
                }
                return numberValue;
            }
            const intent = /<!-- chipin:create-milestone:pending-intent:v1:([a-f0-9]{64}) -->/.exec(receipt.body);
            if (intent) return { intentHash: intent[1] };
            if (receipt.body.includes('chipin:create-milestone:pending-verification:')
                || receipt.body.includes('chipin:create-milestone:pending-intent:')) {
                throw new Error('Malformed milestone pending-verification receipt; reconcile manually.');
            }
            return null;
        });
    const clearPendingIntent = (number, hash) => list(`${prefix}/issues/${number}/comments`)
        .then(comments => {
            const receipt = singleBotReceipt(comments);
            if (!receipt) return null;
            // Refuse to overwrite a receipt that a separate run changed.
            if (!receipt.body.includes(pendingIntentMarker(hash).trim())) return null;
            return request('PATCH', `${prefix}/issues/comments/${receipt.id}`, {
                body: `${RECEIPT_MARKER}\nMilestone creation cancelled before POST; no milestone was created by this run. Retry the updated request.`,
            });
        });
    const upsertReceipt = (number, message) => list(`${prefix}/issues/${number}/comments`)
        .then(comments => {
            const botReceipt = singleBotReceipt(comments);
            if (botReceipt) {
                if (botReceipt.body === message) return botReceipt;
                return request('PATCH', `${prefix}/issues/comments/${botReceipt.id}`, { body: message });
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
        getPendingCreated,
        clearPendingIntent,
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
        // GITHUB_ACTOR is runner-provided for both Issue events and manual
        // dispatch. Cross-check the signed Issue event's sender when present.
        const actor = process.env.GITHUB_ACTOR;
        const isIssueEvent = process.env.GITHUB_EVENT_NAME === 'issues';
        if (isIssueEvent && (event.sender?.login !== actor || event.issue?.number !== number
            || typeof event.issue?.title !== 'string'
            || (typeof event.issue?.body !== 'string' && event.issue?.body !== null)
            || typeof event.issue?.user?.login !== 'string')) {
            throw new Error('Issue event snapshot or sender is missing or mismatched.');
        }
        runMilestoneControl(number, makeGitHubApi({
            token: process.env.GITHUB_TOKEN,
            repository: process.env.GITHUB_REPOSITORY,
        }), actor, isIssueEvent ? event.issue : null).then(result => {
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
