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
    description: 'Frontend iteration',
    due_on: '2026-11-01T23:59:59.000Z',
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
    it('verifies new milestone Description on read-back', async () => {
        const request = { title: 'FE 1.2', description: 'Frontend iteration' };
        for (const description of [undefined, null, 'Different description']) {
            await assert.rejects(findOrCreateMilestone(request, {
                listMilestones: async () => [],
                createMilestone: async () => milestone(),
                getMilestone: async () => ({ ...milestone(), description, due_on: null }),
            }), /metadata read-back/);
        }
    });
    it('verifies optional Due date for a newly created milestone', async () => {
        const request = {
            title: 'FE 1.2', description: 'Frontend iteration',
            due_on: '2026-11-01T23:59:59Z',
        };
        for (const due_on of [null, '2026-11-02T23:59:59Z', 'not-a-date']) {
            await assert.rejects(findOrCreateMilestone(request, {
                listMilestones: async () => [],
                createMilestone: async () => milestone(),
                getMilestone: async () => ({ ...milestone(), due_on }),
            }), /metadata read-back/);
        }
        const matching = await findOrCreateMilestone(request, {
            listMilestones: async () => [],
            createMilestone: async () => milestone(),
            getMilestone: async () => milestone(),
        });
        assert.equal(matching.created, true);
        assert.equal(matching.milestone.number, 8);
    });
    it('requires no due date when none was requested during creation', async () => {
        const request = { title: 'FE 1.2', description: 'Frontend iteration' };
        await assert.rejects(findOrCreateMilestone(request, {
            listMilestones: async () => [],
            createMilestone: async () => milestone(),
            getMilestone: async () => milestone(),
        }), /metadata read-back/);
        const created = await findOrCreateMilestone(request, {
            listMilestones: async () => [],
            createMilestone: async () => milestone(),
            getMilestone: async () => ({ ...milestone(), due_on: null }),
        });
        assert.equal(created.created, true);
    });
    it('reuses existing milestones without rewriting or validating their metadata', async () => {
        const existing = { ...milestone(), description: 'Legacy desc', due_on: '2030-01-01T00:00:00Z' };
        const result = await findOrCreateMilestone({
            title: 'FE 1.2', description: 'New description', due_on: '2026-11-01T23:59:59Z',
        }, {
            listMilestones: async () => [existing],
            createMilestone: failWrite,
        });
        assert.equal(result.created, false);
        assert.equal(result.milestone.description, 'Legacy desc');
    });
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
            getPendingCreated: async () => null,
            clearPendingIntent: async () => null,
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
        return runMilestoneControl(15, test.api, 'author').then(result => {
            assert.equal(result.status, 'ignored');
            assert.equal(test.stats.creates, 0);
        });
    });
    it('ignores a stale authorized event when a triage editor replaces an ordinary Issue with a command', async () => {
        const fromEvent = issue('Ordinary bug', 'Original details');
        const fromApi = issue('[create-milestone] FE 1.2', 'Description: Unauthorized edit');
        const test = adapter(fromApi);
        const calls = [];
        test.api.getPermission = async login => { calls.push(login); return { permission: 'write' }; };
        const result = await runMilestoneControl(15, test.api, 'authorized-editor', fromEvent);
        assert.equal(result.status, 'ignored');
        assert.deepEqual(calls, []);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
        assert.equal(test.comments.length, 0);
    });
    it('ignores an old authorized event after title or description changes', async () => {
        for (const changed of [
            issue('[create-milestone] FE 1.3'),
            issue('[create-milestone] FE 1.2', 'Description: Replaced by another editor'),
        ]) {
            const test = adapter(changed);
            test.api.getPermission = failWrite;
            const result = await runMilestoneControl(15, test.api, 'authorized-editor', issue());
            assert.equal(result.status, 'ignored');
            assert.equal(test.stats.creates, 0);
            assert.equal(test.comments.length, 0);
        }
    });
    it('ignores a mismatched Issue event author or malformed snapshot', async () => {
        for (const snapshot of [
            { ...issue(), user: { login: 'different-author' } },
            { ...issue(), body: undefined },
            { ...issue(), title: undefined },
        ]) {
            const test = adapter();
            test.api.getPermission = failWrite;
            const result = await runMilestoneControl(15, test.api, 'authorized-editor', snapshot);
            assert.equal(result.status, 'ignored');
            assert.equal(test.stats.creates, 0);
        }
    });
    it('runs a matching Issue event through both actor and author permission checks', async () => {
        const control = issue();
        const test = adapter(control);
        const checked = [];
        test.api.getPermission = async login => {
            checked.push(login);
            return { permission: 'write' };
        };
        assert.equal((await runMilestoneControl(15, test.api, 'authorized-editor', { ...control })).status, 'completed');
        assert.ok(checked.includes('authorized-editor'));
        assert.ok(checked.includes('author'));
        assert.equal(test.stats.creates, 1);
    });
    it('keeps manual workflow dispatch tied to live request and dispatch actor permissions', async () => {
        const test = adapter();
        const done = await runMilestoneControl(15, test.api, 'author');
        assert.equal(done.status, 'completed');
        assert.equal(test.stats.creates, 1);
    });
    it('rejects a triage editor even if the original author is a writer', async () => {
        const test = adapter();
        const actors = [];
        test.api.getPermission = async login => {
            actors.push(login);
            return { permission: login === 'triage-editor' ? 'triage' : 'write' };
        };
        await assert.rejects(runMilestoneControl(15, test.api, 'triage-editor'), /Triggering actor requires/);
        assert.deepEqual(actors, ['triage-editor']);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
    });
    it('rejects a low-permission Issue author even if the actor is authorized', async () => {
        const test = adapter();
        test.api.getPermission = async login => ({ permission: login === 'author' ? 'triage' : 'write' });
        await assert.rejects(runMilestoneControl(15, test.api, 'maintainer'), /Issue author requires/);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
    });
    it('fails closed when the trusted actor is unavailable', async () => {
        const test = adapter();
        await assert.rejects(runMilestoneControl(15, test.api), /trusted triggering actor/);
        assert.equal(test.stats.creates, 0);
    });
    it('allows a distinct writer to execute an existing writer-authored control Issue', async () => {
        const test = adapter();
        const checked = [];
        test.api.getPermission = async login => {
            checked.push(login);
            return { permission: 'write' };
        };
        assert.equal((await runMilestoneControl(15, test.api, 'authorized-editor')).status, 'completed');
        assert.deepEqual(checked, [
            'authorized-editor', 'author',
            'authorized-editor', 'author',
            'authorized-editor', 'author',
        ]);
    });
    it('rejects creation if the triggering actor loses write access during pagination', async () => {
        const test = adapter();
        const calls = [];
        test.api.getPermission = async login => {
            calls.push(login);
            return { permission: login === 'authorized-editor' && calls.filter(x => x === login).length > 1
                ? 'triage' : 'write' };
        };
        await assert.rejects(
            runMilestoneControl(15, test.api, 'authorized-editor'),
            /Triggering actor requires/,
        );
        assert.deepEqual(calls, ['authorized-editor', 'author', 'authorized-editor']);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
        assert.match(test.comments[0], /Triggering actor requires/);
    });
    it('rejects creation if the original author loses write access during pagination', async () => {
        const test = adapter();
        const calls = [];
        test.api.getPermission = async login => {
            calls.push(login);
            return { permission: login === 'author' && calls.filter(x => x === login).length > 1
                ? 'triage' : 'write' };
        };
        await assert.rejects(
            runMilestoneControl(15, test.api, 'authorized-editor'),
            /Issue author requires/,
        );
        assert.deepEqual(calls, ['authorized-editor', 'author', 'authorized-editor', 'author']);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
        assert.match(test.comments[0], /Issue author requires/);
    });
    it('rejects creation when the same author/actor is demoted before POST', async () => {
        const test = adapter();
        let checks = 0;
        test.api.getPermission = async () => ({ permission: ++checks === 1 ? 'write' : 'read' });
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /Triggering actor requires/);
        assert.equal(checks, 2);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
    });
    it('rejects creation if fresh permissions cannot be read', async () => {
        const test = adapter();
        let checks = 0;
        test.api.getPermission = async () => {
            if (++checks === 2) throw new Error('permission API unavailable');
            return { permission: 'write' };
        };
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /permission API unavailable/);
        assert.equal(test.stats.creates, 0);
        assert.equal(test.stats.closes, 0);
    });
    it('creates, comments and closes, then retry is a no-op', () => {
        const test = adapter();
        return runMilestoneControl(15, test.api, 'author').then(result => {
            assert.equal(result.status, 'completed');
            assert.equal(test.getState(), 'closed');
            assert.equal(test.stats.creates, 1);
            assert.equal(test.stats.closes, 1);
            assert.match(test.comments[0], /Number: \*\*#8\*\*/);
            return runMilestoneControl(15, test.api, 'author').then(retry => {
                assert.equal(retry.status, 'ignored');
                assert.equal(test.stats.creates, 1);
            });
        });
    });
    it('unauthorized and invalid Issue leave actionable receipt and stay open', () => {
        const noWrite = adapter(issue(), 'read');
        return assert.rejects(runMilestoneControl(15, noWrite.api, 'author'), /requires repository write/)
            .then(() => {
                assert.equal(noWrite.stats.creates, 0);
                assert.equal(noWrite.getState(), 'open');
                assert.match(noWrite.comments[0], /write, maintain, or admin/);
                const bad = adapter(issue('[create-milestone] x', 'Shell: bad'));
                return assert.rejects(runMilestoneControl(15, bad.api, 'author'), /Only Description/).then(() => {
                    assert.equal(bad.stats.creates, 0);
                    assert.equal(bad.getState(), 'open');
                });
            });
    });
    it('API failures comment once and keep issue open for retry', () => {
        const test = adapter(issue(), 'write', 'create');
        return assert.rejects(runMilestoneControl(15, test.api, 'author'), /503/).then(() => {
            assert.equal(test.getState(), 'open');
            assert.match(test.comments[0], /503/);
        });
    });
    it('close failure does not duplicate milestones and reports actionable error', () => {
        const test = adapter(issue(), 'write', 'close');
        return assert.rejects(runMilestoneControl(15, test.api, 'author'), /close failed/).then(() => {
            assert.equal(test.stats.creates, 1);
            assert.equal(test.getState(), 'open');
            assert.match(test.comments[0], /close failed/);
            return assert.rejects(runMilestoneControl(15, test.api, 'author'), /close failed/).then(() => {
                assert.equal(test.stats.creates, 1);
                assert.match(test.comments[0], /close failed/);
            });
        });
    });
});

describe('pending created milestone verification across retries', () => {
    const makeCase = () => {
        const original = issue();
        const milestones = [];
        let currentIssue = original;
        let botReceipt = null;
        let creates = 0;
        let closes = 0;
        let readbackFails = false;
        let permissionFails = false;
        let losePostResponse = false;
        let rejectPostBeforeCommit = false;
        let rejectIntentWrite = false;
        let onIntentWritten = null;
        let closeOnReadback = false;
        let clears = 0;
        const api = {
            getIssue: async () => ({ ...currentIssue }),
            getPermission: async () => {
                if (permissionFails) throw new Error('permission unavailable');
                return { permission: 'write' };
            },
            listMilestones: async () => milestones.map(x => ({ ...x })),
            createMilestone: async () => {
                creates++;
                if (rejectPostBeforeCommit) throw new Error('POST rejected before commit');
                const created = { ...milestone(), description: 'Wrong metadata' };
                milestones.push(created);
                if (losePostResponse) throw new Error('POST response lost');
                return { ...created };
            },
            getMilestone: async () => {
                if (readbackFails) throw new Error('GET milestone failed');
                if (closeOnReadback) {
                    currentIssue = { ...currentIssue, state: 'closed', state_reason: 'not_planned' };
                }
                return { ...milestones[0] };
            },
            getPendingCreated: async () => {
                const match = /chipin:create-milestone:pending-verification:v1:(\d+)/.exec(botReceipt ?? '');
                if (match) return Number(match[1]);
                const intent = /chipin:create-milestone:pending-intent:v1:([a-f0-9]{64})/.exec(botReceipt ?? '');
                return intent ? { intentHash: intent[1] } : null;
            },
            clearPendingIntent: async (_number, hash) => {
                if (botReceipt?.includes(`pending-intent:v1:${hash}`)) {
                    clears++;
                    botReceipt = '<!-- chipin:create-milestone:v1 -->\nMilestone creation cancelled before POST.';
                }
            },
            upsertReceipt: async (_number, value) => {
                if (rejectIntentWrite && value.includes('pending-intent:')) {
                    throw new Error('Receipt write failed');
                }
                botReceipt = value;
                if (value.includes('pending-intent:') && onIntentWritten) onIntentWritten();
            },
            closeIssue: async () => {
                closes++;
                currentIssue = { ...currentIssue, state: 'closed', state_reason: 'completed' };
                return { state: 'closed', state_reason: 'completed' };
            },
        };
        return {
            api, milestones,
            setIssue: value => { currentIssue = value; },
            setPermissionFails: value => { permissionFails = value; },
            setReadbackFails: value => { readbackFails = value; },
            setLosePostResponse: value => { losePostResponse = value; },
            setRejectPostBeforeCommit: value => { rejectPostBeforeCommit = value; },
            setRejectIntentWrite: value => { rejectIntentWrite = value; },
            onIntent: action => { onIntentWritten = action; },
            setCloseOnReadback: value => { closeOnReadback = value; },
            getReceipt: () => botReceipt,
            getIssue: () => currentIssue,
            clearCount: () => clears,
            counts: () => ({ creates, closes }),
        };
    };
    it('clears a newly recorded intent when an Issue edit aborts the last pre-POST check', async () => {
        const test = makeCase();
        test.onIntent(() => test.setIssue(issue('[create-milestone] FE 1.2', 'Description: New release')));
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /request changed/);
        assert.deepEqual(test.counts(), { creates: 0, closes: 0 });
        assert.equal(test.clearCount(), 1);
        assert.doesNotMatch(test.getReceipt(), /pending-intent:/);
        test.onIntent(null);
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /metadata read-back/);
        assert.deepEqual(test.counts(), { creates: 1, closes: 0 });
    });
    it('clears an unstarted intent when the control Issue was cancelled before POST', async () => {
        const test = makeCase();
        test.onIntent(() => test.setIssue({
            ...issue(), state: 'closed', state_reason: 'not_planned',
        }));
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /cancelled/);
        assert.deepEqual(test.counts(), { creates: 0, closes: 0 });
        assert.equal(test.clearCount(), 1);
        assert.equal(test.getIssue().state, 'closed');
        assert.doesNotMatch(test.getReceipt(), /pending-intent:/);
    });
    it('writes the confirmed milestone URL after external closure before first success receipt', async () => {
        const test = makeCase();
        test.setCloseOnReadback(true);
        test.api.createMilestone = async () => {
            test.milestones.push({ ...milestone(), description: 'Frontend iteration' });
            return { ...test.milestones[0] };
        };
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /cancelled/);
        assert.equal(test.getIssue().state, 'closed');
        assert.equal(test.getIssue().state_reason, 'not_planned');
        assert.match(test.getReceipt(), /Milestone created: https:\/\/github.com\//);
        assert.match(test.getReceipt(), /Number: \*\*#8\*\*/);
        assert.doesNotMatch(test.getReceipt(), /pending-intent:/);
        assert.equal(test.counts().closes, 0);
    });
    it('persists intent before POST and verifies persisted metadata after a lost response', async () => {
        const scenario = makeCase();
        scenario.setLosePostResponse(true);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /POST response lost/);
        assert.deepEqual(scenario.counts(), { creates: 1, closes: 0 });
        assert.match(scenario.getReceipt(), /pending-intent:v1:[a-f0-9]{64}/);
        scenario.setLosePostResponse(false);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /metadata read-back/);
        assert.deepEqual(scenario.counts(), { creates: 1, closes: 0 });
        assert.match(scenario.getReceipt(), /pending-verification:v1:8/);
        scenario.milestones[0].description = 'Frontend iteration';
        assert.equal((await runMilestoneControl(15, scenario.api, 'author')).status, 'completed');
        assert.deepEqual(scenario.counts(), { creates: 1, closes: 1 });
    });
    it('accepts a previously lost POST only after matching metadata is verified', async () => {
        const scenario = makeCase();
        scenario.setLosePostResponse(true);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /POST response lost/);
        scenario.milestones[0].description = 'Frontend iteration';
        scenario.setLosePostResponse(false);
        assert.equal((await runMilestoneControl(15, scenario.api, 'author')).status, 'completed');
        assert.deepEqual(scenario.counts(), { creates: 1, closes: 1 });
    });
    it('can retry an intent after a POST rejected before any milestone was stored', async () => {
        const scenario = makeCase();
        scenario.setRejectPostBeforeCommit(true);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /POST rejected before commit/);
        assert.match(scenario.getReceipt(), /pending-intent:v1:/);
        scenario.setRejectPostBeforeCommit(false);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /metadata read-back/);
        assert.deepEqual(scenario.counts(), { creates: 2, closes: 0 });
        assert.match(scenario.getReceipt(), /pending-verification:v1:8/);
    });
    it('refuses creation when the verification-intent receipt fails to persist', async () => {
        const scenario = makeCase();
        scenario.setRejectIntentWrite(true);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /Receipt write failed/);
        assert.deepEqual(scenario.counts(), { creates: 0, closes: 0 });
        scenario.setRejectIntentWrite(false);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /metadata read-back/);
        assert.deepEqual(scenario.counts(), { creates: 1, closes: 0 });
    });
    it('fails closed when a control request changes while an unknown POST is pending', async () => {
        const scenario = makeCase();
        scenario.setLosePostResponse(true);
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /POST response lost/);
        scenario.setIssue(issue('[create-milestone] Other release', 'Description: Different'));
        await assert.rejects(runMilestoneControl(15, scenario.api, 'author'), /Pending milestone request changed/);
        assert.deepEqual(scenario.counts(), { creates: 1, closes: 0 });
        assert.match(scenario.getReceipt(), /pending-intent:v1:/);
    });
    it('does not close a control Issue by reusing an unverified POST on retry', async () => {
        const t = makeCase();
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /metadata read-back/);
        assert.deepEqual(t.counts(), { creates: 1, closes: 0 });
        assert.match(t.getReceipt(), /pending-verification:v1:8/);
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /metadata read-back/);
        assert.deepEqual(t.counts(), { creates: 1, closes: 0 });
        assert.match(t.getReceipt(), /pending-verification:v1:8/);
        t.milestones[0].description = 'Frontend iteration';
        const result = await runMilestoneControl(15, t.api, 'author');
        assert.equal(result.status, 'completed');
        assert.deepEqual(t.counts(), { creates: 1, closes: 1 });
        assert.doesNotMatch(t.getReceipt(), /pending-verification/);
    });
    it('preserves pending milestone identity after a retry permission failure', async () => {
        const t = makeCase();
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /metadata read-back/);
        t.setPermissionFails(true);
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /permission unavailable/);
        assert.match(t.getReceipt(), /pending-verification:v1:8/);
        assert.deepEqual(t.counts(), { creates: 1, closes: 0 });
    });
    it('refuses to create a new milestone when a pending request is retitled', async () => {
        const t = makeCase();
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /metadata read-back/);
        t.setIssue(issue('[create-milestone] Different release', 'Description: New'));
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /Pending milestone no longer matches/);
        assert.deepEqual(t.counts(), { creates: 1, closes: 0 });
        assert.match(t.getReceipt(), /pending-verification:v1:8/);
    });
    it('persists a pending marker for a failed GET after POST', async () => {
        const t = makeCase();
        t.setReadbackFails(true);
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /GET milestone failed/);
        assert.match(t.getReceipt(), /pending-verification:v1:8/);
        t.setReadbackFails(false);
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /metadata read-back/);
        assert.deepEqual(t.counts(), { creates: 1, closes: 0 });
    });
});

describe('recovery receipt routing', () => {
    const recoveredIssue = title => issue(title, 'Description: Initial release');
    const makeApi = title => {
        let reads = 0;
        const writes = [];
        return {
            getIssue: async () => {
                if (++reads === 1) throw new Error('GET 503');
                return recoveredIssue(title);
            },
            getPermission: failWrite,
            listMilestones: failWrite,
            createMilestone: failWrite,
            getMilestone: failWrite,
            getPendingCreated: async () => null,
            clearPendingIntent: async () => null,
            upsertReceipt: async (_num, body) => { writes.push(body); },
            closeIssue: failWrite,
            writes,
        };
    };

    it('ignores normal Issue when first GET fails but recovery succeeds', async () => {
        const api = makeApi('Fix a broken expense view');
        const result = await runMilestoneControl(15, api, 'author');
        assert.deepEqual(result, { status: 'ignored' });
        assert.equal(api.writes.length, 0);
    });
    it('ignores a stale event that predates a new control command after failed initial GET', async () => {
        const api = makeApi('[create-milestone] Product 1.2');
        const eventSnapshot = issue('Ordinary bug', 'Description: Initial release');
        const result = await runMilestoneControl(15, api, 'author', eventSnapshot);
        assert.deepEqual(result, { status: 'ignored' });
        assert.deepEqual(api.writes, []);
    });
    it('never overwrites a confirmed receipt after failed initial GET and newer command edit', async () => {
        const api = makeApi('[create-milestone] Product 1.3');
        const confirmedReceipt = '<!-- chipin:create-milestone:v1 -->\\nMilestone created: confirmed';
        api.writes.push(confirmedReceipt);
        const previousSnapshot = recoveredIssue('[create-milestone] Product 1.2');
        const result = await runMilestoneControl(15, api, 'author', previousSnapshot);
        assert.deepEqual(result, { status: 'ignored' });
        assert.deepEqual(api.writes, [confirmedReceipt]);
    });
    it('rejects stale recovery event when only body or original author differs', async () => {
        for (const eventSnapshot of [
            issue('[create-milestone] Product 1.2', 'Description: Earlier release'),
            { ...recoveredIssue('[create-milestone] Product 1.2'), user: { login: 'other-author' } },
        ]) {
            const api = makeApi('[create-milestone] Product 1.2');
            const result = await runMilestoneControl(15, api, 'author', eventSnapshot);
            assert.deepEqual(result, { status: 'ignored' });
            assert.deepEqual(api.writes, []);
        }
    });
    it('posts recovery error only if the issues event snapshot still matches', async () => {
        const api = makeApi('[create-milestone] Product 1.2');
        await assert.rejects(
            runMilestoneControl(15, api, 'author', recoveredIssue('[create-milestone] Product 1.2')),
            /GET 503/,
        );
        assert.equal(api.writes.length, 1);
        assert.match(api.writes[0], /Milestone request not completed: GET 503/);
    });
    it('posts one actionable receipt for a recovered control Issue', async () => {
        const api = makeApi('[create-milestone] Product 1.2');
        await assert.rejects(runMilestoneControl(15, api, 'author'), /GET 503/);
        assert.equal(api.writes.length, 1);
        assert.match(api.writes[0], /Milestone request not completed: GET 503/);
    });
    it('ignores ordinary Issue edited after an initial transport failure', async () => {
        const api = makeApi('Ordinary issue with [create-milestone] mentioned inside');
        const result = await runMilestoneControl(15, api, 'author');
        assert.equal(result.status, 'ignored');
        assert.deepEqual(api.writes, []);
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
            getMilestone: async () => ({ ...milestone(), description: 'Current release', due_on: null }),
            getPendingCreated: async () => null,
            clearPendingIntent: async () => null,
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
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /request changed/);
        assert.equal(t.counts().creates, 0);
        assert.equal(t.counts().closes, 0);
        assert.match(t.comments[0], /request changed/);
    });
    it('never creates after cancellation during permission or list read', async () => {
        const t = mkApi();
        t.snapshots.push(original(), { ...original(), state: 'closed', state_reason: 'not_planned' });
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /cancelled/);
        assert.equal(t.counts().creates, 0);
        assert.equal(t.counts().closes, 0);
        assert.equal(t.comments.length, 0);
    });
    it('does not write receipt or close when existing milestone request changed', async () => {
        const t = mkApi();
        t.api.listMilestones = async () => [milestone()];
        t.snapshots.push(original(), { ...original(), body: 'Description: Updated' });
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /request changed/);
        assert.equal(t.counts().creates, 0);
        assert.equal(t.counts().closes, 0);
    });
    it('does not close when request was cancelled after success receipt', async () => {
        const t = mkApi();
        t.snapshots.push(original(), original(), original(), original(), { ...original(), state: 'closed', state_reason: 'not_planned' });
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /cancelled/);
        assert.equal(t.counts().closes, 0);
        assert.match(t.comments[0], /Milestone created/);
        assert.doesNotMatch(t.comments[0], /remains open/);
    });
    it('keeps milestone success truthful when the Issue is edited after the receipt', async () => {
        const test = mkApi();
        const changed = { ...original(), body: 'Description: Edited after creation' };
        test.snapshots.push(original(), original(), original(), original(), changed);
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /request changed/);
        assert.equal(test.counts().creates, 1);
        assert.equal(test.counts().closes, 0);
        assert.match(test.comments[0], /Milestone created/);
        assert.match(test.comments[0], /Number: /);
        assert.match(test.comments[0], /Control Issue not completed: Control Issue request changed/);
        assert.doesNotMatch(test.comments[0], /Milestone request not completed/);
    });
    it('reports confirmed milestone even when request edits before initial receipt', async () => {
        const test = mkApi();
        const changed = { ...original(), title: '[create-milestone] Different release' };
        test.snapshots.push(original(), original(), original(), original(), changed);
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /request changed/);
        assert.equal(test.counts().creates, 1);
        assert.equal(test.counts().closes, 0);
        assert.match(test.comments[0], /Milestone created/);
        assert.match(test.comments[0], /Control Issue not completed/);
    });
    it('does not claim completed when an Issue is reopened after successful PATCH', async () => {
        const test = mkApi();
        // PATCH returned success, but the subsequent successful GET observes
        // that the control Issue was reopened by another user.
        test.api.closeIssue = async () => ({ state: 'closed', state_reason: 'completed' });
        await assert.rejects(runMilestoneControl(15, test.api, 'author'), /read-back is not closed\/completed/);
        assert.equal(test.counts().creates, 1);
        assert.match(test.comments[0], /Milestone created/);
        assert.match(test.comments[0], /Control Issue not completed/);
        assert.doesNotMatch(test.comments[0], /Milestone request not completed/);
    });
    it('a lost PATCH response can be reconciled as completed from read-back', async () => {
        const t = mkApi();
        t.api.closeIssue = async () => { t.setState('closed'); throw new Error('connection dropped'); };
        const done = await runMilestoneControl(15, t.api, 'author');
        assert.equal(done.status, 'completed');
        assert.match(t.comments[0], /Milestone created/);
    });
    it('failed GET after PATCH accepts confirmed completed PATCH response', async () => {
        const t = mkApi();
        let closed = false;
        t.api.closeIssue = async () => { closed = true; return { state: 'closed', state_reason: 'completed' }; };
        const get = t.api.getIssue;
        t.api.getIssue = async () => { if (closed) throw new Error('GET 503'); return get(); };
        const done = await runMilestoneControl(15, t.api, 'author');
        assert.equal(done.status, 'completed');
        assert.match(t.comments[0], /Milestone created/);
    });
    it('does not overwrite success receipt when PATCH result and closure GET are both unknown', async () => {
        const t = mkApi();
        let lost = false;
        t.api.closeIssue = async () => { lost = true; throw new Error('PATCH timeout'); };
        const get = t.api.getIssue;
        t.api.getIssue = async () => { if (lost) throw new Error('GET timeout'); return get(); };
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /PATCH timeout/);
        assert.match(t.comments[0], /Milestone created/);
        assert.doesNotMatch(t.comments[0], /remains open/);
    });
    it('confirmed open after close failure receives one accurate error receipt', async () => {
        const t = mkApi();
        t.api.closeIssue = async () => { throw new Error('close failed'); };
        await assert.rejects(runMilestoneControl(15, t.api, 'author'), /close failed/);
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
