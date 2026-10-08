import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    canCreateMilestone, findOrCreateMilestone, makeGitHubApi,
    matchingMilestone, parseMilestoneRequest, runMilestoneControl,
} from './create-milestone.mjs';

const issue = (title = '[create-milestone] FE 1.2', body = 'Description: Frontend iteration\nDue date: 2026-11-01') => ({
    title, body, state: 'open', user: { login: 'author' },
});
const milestone = (title = 'FE 1.2', state = 'open', number = 8) => ({
    title, state, number,
    html_url: 'https://github.com/ChipIn-one/chipin-frontend/milestone/8',
});
const failWrite = () => Promise.reject(new Error('Unexpected create'));

describe('milestone parsing and authorization', () => {
    it('ignores non-control Issues and rejects invalid requests', () => {
        assert.equal(parseMilestoneRequest(issue('Ordinary bug')), null);
        assert.equal(parseMilestoneRequest(issue('Mention [create-milestone] FE 1.2')), null);
        for (const request of [
            issue('[create-milestone]', 'Description: valid'),
            issue('[create-milestone] X', ''),
            issue('[create-milestone] X', 'Description: a\nDescription: b'),
            issue('[create-milestone] X', 'Description: a\nRun: shell'),
            issue('[create-milestone] X', 'Description: a\nDue date: 2026-02-29'),
            issue('[create-milestone] X', 'Description: a\nDue date: tomorrow'),
            issue('[create-milestone] X', 'Description: ' + 'x'.repeat(1001)),
        ]) assert.throws(() => parseMilestoneRequest(request));
    });
    it('accepts machine-readable case-insensitive command and optional date', () => {
        assert.deepEqual(parseMilestoneRequest(issue('[CREATE-MILESTONE] FE 1.2', 'description: Test\nDUE DATE: 2026-12-01')), {
            title: 'FE 1.2', description: 'Test', due_on: '2026-12-01T23:59:59Z',
        });
        assert.deepEqual(parseMilestoneRequest(issue('[create-milestone] FE 1.2', 'Description: Test')), {
            title: 'FE 1.2', description: 'Test',
        });
    });
    it('accepts only write/maintain/admin and fails closed on other roles', () => {
        for (const permission of ['write', 'maintain', 'admin']) {
            assert.equal(canCreateMilestone({ permission }), true);
            assert.equal(canCreateMilestone({ role_name: permission }), true);
        }
        for (const permission of ['read', 'triage', 'none']) {
            assert.equal(canCreateMilestone({ permission, role_name: permission }), false);
        }
        assert.equal(canCreateMilestone({ permission: 'read', role_name: 'admin' }), false);
        assert.equal(canCreateMilestone(null), false);
    });
});

describe('idempotency and race handling', () => {
    it('reuses an open milestone, case-insensitive, without writes', () =>
        findOrCreateMilestone({ title: 'FE 1.2' }, {
            listMilestones: () => Promise.resolve([milestone('fe 1.2')]),
            createMilestone: failWrite,
        }).then(result => assert.equal(result.created, false)));
    it('does not reopen closed milestone', () =>
        findOrCreateMilestone({ title: 'FE 1.2' }, {
            listMilestones: () => Promise.resolve([milestone('FE 1.2', 'closed')]),
            createMilestone: failWrite,
        }).then(result => assert.equal(result.milestone.state, 'closed')));
    it('refuses ambiguous existing duplicates', () =>
        assert.throws(() => matchingMilestone([milestone(), milestone('fe 1.2', 'closed', 9)], 'FE 1.2'), /Multiple/));
    it('re-lists after 422 race and returns winner', () => {
        let calls = 0;
        return findOrCreateMilestone({ title: 'FE 1.2' }, {
            listMilestones: () => Promise.resolve(++calls === 1 ? [] : [milestone()]),
            createMilestone: () => Promise.reject(Object.assign(new Error('race'), { status: 422 })),
        }).then(result => {
            assert.equal(result.created, false);
            assert.equal(result.milestone.number, 8);
            assert.equal(calls, 2);
        });
    });
    it('does not swallow a 422 validation failure without a winner', () =>
        assert.rejects(findOrCreateMilestone({ title: 'FE 1.2' }, {
            listMilestones: () => Promise.resolve([]),
            createMilestone: () => Promise.reject(Object.assign(new Error('invalid'), { status: 422 })),
        }), /invalid/));
    it('requires a successful create read-back', () =>
        assert.rejects(findOrCreateMilestone({ title: 'FE 1.2' }, {
            listMilestones: () => Promise.resolve([]),
            createMilestone: () => Promise.resolve(milestone()),
            getMilestone: () => Promise.resolve(milestone('different')),
        }), /read-back/));
});

describe('control Issue state transition', () => {
    const adapter = (valid = issue(), permission = 'write', failure = null) => {
        const milestones = [];
        const comments = [];
        const stats = { creates: 0, closes: 0 };
        let state = valid.state;
        const api = {
            getIssue: () => Promise.resolve({ ...valid, state, state_reason: state === 'closed' ? 'completed' : null }),
            getPermission: () => Promise.resolve({ permission }),
            listMilestones: () => Promise.resolve(milestones),
            createMilestone: () => {
                stats.creates++;
                if (failure === 'create') return Promise.reject(new Error('503 temporary outage'));
                const result = milestone();
                milestones.push(result);
                return Promise.resolve(result);
            },
            getMilestone: () => Promise.resolve(milestones[0]),
            upsertReceipt: (number, body) => {
                comments[0] = body;
                return Promise.resolve();
            },
            closeIssue: () => {
                stats.closes++;
                if (failure === 'close') return Promise.reject(new Error('close failed'));
                state = 'closed';
                return Promise.resolve();
            },
        };
        return { api, stats, comments, getState: () => state };
    };
    it('ignores ordinary issue without mutating or checking permissions', () => {
        const test = adapter(issue('Ordinary'));
        test.api.getPermission = failWrite;
        return runMilestoneControl(15, test.api).then(result => {
            assert.equal(result.status, 'ignored');
            assert.equal(test.stats.creates, 0);
        });
    });
    it('creates, comments and closes, then retry is a no-op', () => {
        const test = adapter();
        return runMilestoneControl(15, test.api).then(result => {
            assert.equal(result.status, 'completed');
            assert.equal(test.getState(), 'closed');
            assert.equal(test.stats.creates, 1);
            assert.equal(test.stats.closes, 1);
            assert.match(test.comments[0], /Number: \*\*#8\*\*/);
            return runMilestoneControl(15, test.api).then(retry => {
                assert.equal(retry.status, 'ignored');
                assert.equal(test.stats.creates, 1);
            });
        });
    });
    it('unauthorized and invalid Issue leave actionable receipt and stay open', () => {
        const noWrite = adapter(issue(), 'read');
        return assert.rejects(runMilestoneControl(15, noWrite.api), /requires repository write/)
            .then(() => {
                assert.equal(noWrite.stats.creates, 0);
                assert.equal(noWrite.getState(), 'open');
                assert.match(noWrite.comments[0], /write, maintain, or admin/);
                const bad = adapter(issue('[create-milestone] x', 'Shell: bad'));
                return assert.rejects(runMilestoneControl(15, bad.api), /Only Description/).then(() => {
                    assert.equal(bad.stats.creates, 0);
                    assert.equal(bad.getState(), 'open');
                });
            });
    });
    it('API failures comment once and keep issue open for retry', () => {
        const test = adapter(issue(), 'write', 'create');
        return assert.rejects(runMilestoneControl(15, test.api), /503/).then(() => {
            assert.equal(test.getState(), 'open');
            assert.match(test.comments[0], /503/);
        });
    });
    it('close failure does not duplicate milestones and reports actionable error', () => {
        const test = adapter(issue(), 'write', 'close');
        return assert.rejects(runMilestoneControl(15, test.api), /close failed/).then(() => {
            assert.equal(test.stats.creates, 1);
            assert.equal(test.getState(), 'open');
            assert.match(test.comments[0], /close failed/);
            return assert.rejects(runMilestoneControl(15, test.api), /close failed/).then(() => {
                assert.equal(test.stats.creates, 1);
                assert.match(test.comments[0], /close failed/);
            });
        });
    });
});

describe('concurrent cancellation and ambiguous closure', () => {
    const original = () => issue('[create-milestone] FE 1.2', 'Description: Current release');
    const mkApi = () => {
        const snapshots = [];
        const comments = [];
        let issueState = 'open';
        let current = original();
        let creates = 0;
        let closes = 0;
        const api = {
            getIssue: async () => { current = snapshots.shift() ?? current; return { ...current, state: issueState === 'closed' ? 'closed' : current.state, state_reason: issueState === 'closed' ? 'completed' : current.state_reason }; },
            getPermission: async () => ({ permission: 'write' }),
            listMilestones: async () => [],
            createMilestone: async () => { creates++; return milestone(); },
            getMilestone: async () => milestone(),
            upsertReceipt: async (_n, body) => { comments[0] = body; },
            closeIssue: async () => { closes++; issueState = 'closed'; return { state: 'closed', state_reason: 'completed' }; },
        };
        return { api, snapshots, comments, setState: value => { issueState = value; }, counts: () => ({ creates, closes }) };
    };
    it('never creates after title/body change during milestone listing', async () => {
        const t = mkApi();
        const initial = original();
        t.api.getIssue = async () => t.snapshots.shift() ?? initial;
        t.snapshots.push(initial, issue('[create-milestone] FE 1.3', 'Description: Updated'));
        await assert.rejects(runMilestoneControl(15, t.api), /request changed/);
        assert.equal(t.counts().creates, 0);
        assert.equal(t.counts().closes, 0);
        assert.match(t.comments[0], /request changed/);
    });
    it('never creates after cancellation during permission or list read', async () => {
        const t = mkApi();
        t.snapshots.push(original(), { ...original(), state: 'closed', state_reason: 'not_planned' });
        await assert.rejects(runMilestoneControl(15, t.api), /cancelled/);
        assert.equal(t.counts().creates, 0);
        assert.equal(t.counts().closes, 0);
        assert.equal(t.comments.length, 0);
    });
    it('does not write receipt or close when existing milestone request changed', async () => {
        const t = mkApi();
        t.api.listMilestones = async () => [milestone()];
        t.snapshots.push(original(), { ...original(), body: 'Description: Updated' });
        await assert.rejects(runMilestoneControl(15, t.api), /request changed/);
        assert.equal(t.counts().creates, 0);
        assert.equal(t.counts().closes, 0);
    });
    it('does not close when request was cancelled after success receipt', async () => {
        const t = mkApi();
        t.snapshots.push(original(), original(), original(), { ...original(), state: 'closed', state_reason: 'not_planned' });
        await assert.rejects(runMilestoneControl(15, t.api), /cancelled/);
        assert.equal(t.counts().closes, 0);
        assert.match(t.comments[0], /Milestone created/);
        assert.doesNotMatch(t.comments[0], /remains open/);
    });
    it('a lost PATCH response can be reconciled as completed from read-back', async () => {
        const t = mkApi();
        t.api.closeIssue = async () => { t.setState('closed'); throw new Error('connection dropped'); };
        const done = await runMilestoneControl(15, t.api);
        assert.equal(done.status, 'completed');
        assert.match(t.comments[0], /Milestone created/);
    });
    it('failed GET after PATCH accepts confirmed completed PATCH response', async () => {
        const t = mkApi();
        let closed = false;
        t.api.closeIssue = async () => { closed = true; return { state: 'closed', state_reason: 'completed' }; };
        const get = t.api.getIssue;
        t.api.getIssue = async () => { if (closed) throw new Error('GET 503'); return get(); };
        const done = await runMilestoneControl(15, t.api);
        assert.equal(done.status, 'completed');
        assert.match(t.comments[0], /Milestone created/);
    });
    it('does not overwrite success receipt when PATCH result and closure GET are both unknown', async () => {
        const t = mkApi();
        let lost = false;
        t.api.closeIssue = async () => { lost = true; throw new Error('PATCH timeout'); };
        const get = t.api.getIssue;
        t.api.getIssue = async () => { if (lost) throw new Error('GET timeout'); return get(); };
        await assert.rejects(runMilestoneControl(15, t.api), /PATCH timeout/);
        assert.match(t.comments[0], /Milestone created/);
        assert.doesNotMatch(t.comments[0], /remains open/);
    });
    it('confirmed open after close failure receives one accurate error receipt', async () => {
        const t = mkApi();
        t.api.closeIssue = async () => { throw new Error('close failed'); };
        await assert.rejects(runMilestoneControl(15, t.api), /close failed/);
        assert.match(t.comments[0], /not completed: close failed/);
        assert.equal(t.counts().creates, 1);
    });
});

describe('HTTP adapter', () => {
    it('fetches collaborator permission and all milestone states', () => {
        const urls = [];
        const fetchImpl = (url, init) => {
            urls.push({ url, init });
            const result = url.includes('/permission') ? { permission: 'write' } : [];
            return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(result)) });
        };
        const api = makeGitHubApi({ token: 'test-only', repository: 'ChipIn-one/chipin-frontend', fetchImpl });
        return api.getPermission('author').then(() => api.listMilestones()).then(() => {
            assert.match(urls[0].url, /collaborators\/author\/permission/);
            assert.match(urls[1].url, /milestones\?state=all&per_page=100&page=1/);
            assert.equal(urls[0].init.headers.Authorization, 'Bearer test-only');
        });
    });
    it('updates one existing bot receipt instead of posting a second one', () => {
        const methods = [];
        const fetchImpl = (url, init) => {
            methods.push({ url, method: init.method });
            const result = url.includes('/comments?') ? [{
                id: 77, user: { login: 'github-actions[bot]' },
                body: '<!-- chipin:create-milestone:v1 -->\nold',
            }] : {};
            return Promise.resolve({ ok: true, text: () => Promise.resolve(JSON.stringify(result)) });
        };
        const api = makeGitHubApi({ token: 'test-only', repository: 'ChipIn-one/chipin-frontend', fetchImpl });
        return api.upsertReceipt(15, '<!-- chipin:create-milestone:v1 -->\nnew').then(() => {
            assert.equal(methods.length, 2);
            assert.equal(methods[1].method, 'PATCH');
            assert.match(methods[1].url, /issues\/comments\/77$/);
        });
    });
    it('limits milestone operations to FE and BE repositories', () => {
        const fetchImpl = () => Promise.reject(new Error('Should not reach API'));
        assert.throws(
            () => makeGitHubApi({ token: 'test-only', repository: 'ChipIn-one/chipin-knowledge-base', fetchImpl }),
            /only in ChipIn-one\/chipin-frontend and ChipIn-one\/chipin-backend/,
        );
        assert.throws(
            () => makeGitHubApi({ token: 'test-only', repository: 'ChipIn-one\/.github', fetchImpl }),
            /only in ChipIn-one\/chipin-frontend and ChipIn-one\/chipin-backend/,
        );
        assert.doesNotThrow(
            () => makeGitHubApi({ token: 'test-only', repository: 'ChipIn-one/chipin-backend', fetchImpl }),
        );
    });
    it('fails closed on invalid token or paginated API response', () => {
        assert.throws(() => makeGitHubApi({ repository: 'a/b' }), /required/);
        const fetchImpl = () => Promise.resolve({ ok: true, text: () => Promise.resolve('{}') });
        return assert.rejects(makeGitHubApi({
            token: 'token', repository: 'ChipIn-one/chipin-backend', fetchImpl,
        }).listMilestones(), /paginated/);
    });
});
