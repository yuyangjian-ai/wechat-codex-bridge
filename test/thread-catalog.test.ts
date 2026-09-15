import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { CodexRunError, type CodexRunnerOptions } from '../src/codex.js';
import { ThreadCatalog, type ThreadApi } from '../src/thread-catalog.js';

const SOURCE = '019a1234-5678-7000-8000-123456789abc';
const TARGET = '019a1234-5678-7000-8000-123456789abd';
const SECTION = '019a1234-5678-7000-8000-123456789abe';
const LAST_TURN = '019a1234-5678-7000-8000-123456789abf';
const OPTIONS: CodexRunnerOptions = {
    executable: 'codex.exe', workingDirectory: 'D:\\code', sandbox: 'workspace-write', timeoutMs: 2000
};
type Value = Record<string, any>;
type Request = { method: string; params: any; options?: { timeoutMs?: number } };
const DEFAULT = Symbol('default response');

class FakeThreadApi implements ThreadApi {
    requests: Request[] = [];
    sections = [{ id: SECTION, name: '微信 Bot' }];
    turns: Value[] = [{ id: LAST_TURN, status: 'completed' }];
    threads = new Map<string, Value>([[SOURCE, {
        id: SOURCE, source: 'exec', name: '原微信任务', cwd: OPTIONS.workingDirectory,
        status: { type: 'idle' }, createdAt: Math.floor(Date.now() / 1000)
    }]]);
    onRequest?: (request: Request) => unknown | Promise<unknown>;

    async request(method: string, params: any, options?: Request['options']): Promise<any> {
        const request = { method, params, options };
        this.requests.push(request);
        if (this.onRequest) {
            const result = await this.onRequest(request);
            if (result !== DEFAULT) return result;
        }
        switch (method) {
            case 'threadSection/list': return { data: this.sections.map(section => ({ ...section })), nextCursor: null };
            case 'threadSection/create': {
                const section = { id: `created-section-${this.count(method)}`, name: params.name };
                this.sections.push(section);
                return { section };
            }
            case 'thread/read': {
                const thread = this.threads.get(params.threadId);
                assert.ok(thread, `Unknown thread: ${params.threadId}`);
                return { thread: { ...thread } };
            }
            case 'thread/name/set': this.threads.get(params.threadId)!.name = params.name; return {};
            case 'thread/section/move': this.threads.get(params.threadId)!.section = { id: params.sectionId }; return {};
            case 'thread/fork': {
                const thread = {
                    id: TARGET, source: 'vscode', forkedFromId: params.threadId, ephemeral: false,
                    cwd: params.cwd, name: '继承的标题', status: { type: 'idle' },
                    createdAt: Math.floor(Date.now() / 1000)
                };
                this.threads.set(TARGET, thread);
                return { thread };
            }
            case 'thread/list': return {
                data: [...this.threads.values()].filter(thread =>
                    (!params.sourceKinds || params.sourceKinds.includes(thread.source)) &&
                    (!params.cwd || params.cwd === thread.cwd)), nextCursor: null
            };
            case 'thread/turns/list': return { data: this.turns, nextCursor: null };
            default: throw new Error(`Unexpected request: ${method}`);
        }
    }

    count(method: string): number { return this.requests.filter(request => request.method === method).length; }
}

function setup(t: TestContext) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-thread-catalog-test-'));
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
    return { runtime, api: new FakeThreadApi(), catalog: new ThreadCatalog(runtime, OPTIONS) };
}

function readJson(runtime: string, name: string): any { return JSON.parse(fs.readFileSync(path.join(runtime, name), 'utf8')); }
function journal(runtime: string, value: Value): void { fs.writeFileSync(path.join(runtime, 'thread-migrations.json'), JSON.stringify(value)); }
function hasCode(code: string) { return (error: unknown) => error instanceof CodexRunError && error.code === code; }

test('catalog reuses a paginated saved section by ID even after its name changes', async t => {
    const { runtime, api, catalog } = setup(t);
    fs.writeFileSync(path.join(runtime, 'sidebar-section.json'), JSON.stringify({ sectionId: SECTION }));
    api.onRequest = request => request.method === 'threadSection/list'
        ? request.params.cursor
            ? { data: [{ id: SECTION, name: '已重命名的微信分组' }], nextCursor: null }
            : { data: [{ id: 'other-section', name: '微信 Bot' }], nextCursor: 'page-two' }
        : DEFAULT;
    await catalog.place(api, SOURCE, '默认标题');
    assert.equal(api.count('threadSection/create'), 0);
    assert.equal(api.count('threadSection/list'), 2);
    assert.equal(api.count('thread/name/set'), 0, 'An existing user title is preserved');
    assert.equal(api.threads.get(SOURCE)!.section.id, SECTION);
    assert.deepEqual(readJson(runtime, 'sidebar-section.json'), { sectionId: SECTION });
});

test('repeated placement and a fresh catalog reuse one created section', async t => {
    const { runtime, api, catalog } = setup(t);
    api.sections = [];
    api.threads.get(SOURCE)!.name = null;
    await catalog.place(api, SOURCE, '微信 Bot · 默认会话');
    await catalog.place(api, SOURCE, '不覆盖已设置标题');
    await new ThreadCatalog(runtime, OPTIONS).place(api, SOURCE, '仍不覆盖');
    assert.equal(api.count('threadSection/create'), 1);
    assert.equal(api.count('thread/name/set'), 1);
    assert.equal(api.threads.get(SOURCE)!.name, '微信 Bot · 默认会话');
    assert.equal(api.threads.get(SOURCE)!.section.id, readJson(runtime, 'sidebar-section.json').sectionId);
});

test('concurrent first placements share section creation', async t => {
    const { api, catalog } = setup(t);
    api.sections = [];
    await Promise.all([
        catalog.place(api, SOURCE, '默认标题'),
        catalog.place(api, SOURCE, '默认标题')
    ]);
    assert.equal(api.count('threadSection/create'), 1);
});

test('visible threads are placed directly without a fork or routing change', async t => {
    const { runtime, api, catalog } = setup(t);
    api.threads.get(SOURCE)!.source = 'vscode';
    const routes: string[] = [];
    assert.equal(await catalog.ensureVisible(api, SOURCE, '默认标题', id => routes.push(id)), SOURCE);
    assert.deepEqual(routes, []);
    assert.equal(api.count('thread/fork'), 0);
    assert.equal(fs.existsSync(path.join(runtime, 'thread-migrations.json')), false);
});

test('exec migration journals intent and target before routing, then reuses the same fork', async t => {
    const { runtime, api, catalog } = setup(t);
    api.onRequest = request => {
        if (request.method === 'thread/fork') {
            const pending = readJson(runtime, 'thread-migrations.json')[SOURCE];
            assert.equal(pending.sourceId, SOURCE);
            assert.equal(pending.targetId, undefined);
            assert.ok(Number.isFinite(Date.parse(pending.startedAt)));
            assert.equal(request.params.excludeTurns, true, 'Do not hydrate response history');
            assert.equal(request.params.lastTurnId, LAST_TURN, 'Copy through the latest completed turn as an explicit boundary');
            assert.equal(request.params.cwd, OPTIONS.workingDirectory);
            assert.equal(request.params.approvalPolicy, 'never');
            assert.equal(request.params.approvalsReviewer, 'user');
            assert.equal(request.params.sandbox, 'workspace-write');
        }
        return DEFAULT;
    };
    const routes: string[] = [];
    const persist = (id: string) => {
        assert.equal(readJson(runtime, 'thread-migrations.json')[SOURCE].targetId, id);
        routes.push(id);
    };
    assert.equal(await catalog.ensureVisible(api, SOURCE, '微信 Bot · 默认会话', persist), TARGET);
    assert.equal(await new ThreadCatalog(runtime, OPTIONS).ensureVisible(api, SOURCE, '微信 Bot · 默认会话', persist), TARGET);
    assert.equal(api.count('thread/fork'), 1);
    assert.deepEqual(routes, [TARGET, TARGET]);
    assert.equal(api.threads.get(SOURCE)!.name, '原微信任务');
    assert.equal(api.threads.get(TARGET)!.section.id, SECTION);
    assert.equal(api.threads.get(TARGET)!.forkedFromId, SOURCE);
});

test('pending migration recovers one matching child without another fork', async t => {
    const { runtime, api, catalog } = setup(t);
    journal(runtime, { [SOURCE]: { sourceId: SOURCE, startedAt: new Date().toISOString() } });
    api.threads.set(TARGET, {
        id: TARGET, source: 'vscode', forkedFromId: SOURCE, cwd: OPTIONS.workingDirectory,
        createdAt: Math.floor(Date.now() / 1000), status: { type: 'idle' }
    });
    const routes: string[] = [];
    assert.equal(await catalog.ensureVisible(api, SOURCE, '恢复标题', id => routes.push(id)), TARGET);
    assert.equal(api.count('thread/fork'), 0);
    assert.equal(api.count('thread/list'), 1);
    assert.equal(readJson(runtime, 'thread-migrations.json')[SOURCE].targetId, TARGET);
    assert.deepEqual(routes, [TARGET]);
});

test('pending migration rejects missing or ambiguous children without another fork', async t => {
    for (const count of [0, 2]) {
        const { runtime, api, catalog } = setup(t);
        journal(runtime, { [SOURCE]: { sourceId: SOURCE, startedAt: new Date().toISOString() } });
        for (let index = 0; index < count; index++) api.threads.set(`child-${index}`, {
            id: `child-${index}`, source: 'vscode', forkedFromId: SOURCE, cwd: OPTIONS.workingDirectory,
            createdAt: Math.floor(Date.now() / 1000), status: { type: 'idle' }
        });
        const routes: string[] = [];
        await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', id => routes.push(id)), hasCode('process_failed'));
        assert.equal(api.count('thread/fork'), 0);
        assert.deepEqual(routes, []);
        assert.equal(api.count('thread/section/move'), 0);
    }
});

test('active source rejects migration before writing a journal or changing routing', async t => {
    const { runtime, api, catalog } = setup(t);
    api.threads.get(SOURCE)!.status = { type: 'active', activeFlags: [] };
    await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', () => assert.fail('Must not route an active source')), hasCode('session_busy'));
    assert.equal(api.count('thread/fork'), 0);
    assert.equal(fs.existsSync(path.join(runtime, 'thread-migrations.json')), false);
});

test('an in-progress persisted turn rejects migration even when the source runtime is not loaded', async t => {
    const { runtime, api, catalog } = setup(t);
    api.threads.get(SOURCE)!.status = { type: 'notLoaded' };
    api.turns = [{ id: LAST_TURN, status: 'inProgress' }];
    await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', () => assert.fail('Must not route a partial source')), hasCode('session_busy'));
    assert.equal(api.count('thread/turns/list'), 1);
    assert.equal(api.count('thread/fork'), 0);
    assert.equal(fs.existsSync(path.join(runtime, 'thread-migrations.json')), false);
});

test('lost fork response preserves pending intent and a retry does not blindly fork', async t => {
    const { runtime, api, catalog } = setup(t);
    api.onRequest = request => {
        if (request.method === 'thread/fork') throw new Error('Connection closed before fork response');
        return DEFAULT;
    };
    const persist = () => assert.fail('Unknown target must not replace the route');
    await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', persist), /Connection closed/);
    assert.equal(readJson(runtime, 'thread-migrations.json')[SOURCE].targetId, undefined);
    await assert.rejects(new ThreadCatalog(runtime, OPTIONS).ensureVisible(api, SOURCE, '默认标题', persist), hasCode('process_failed'));
    assert.equal(api.count('thread/fork'), 1);
});

test('section failure after migration retains target routing and the retry reuses its history', async t => {
    const { runtime, api, catalog } = setup(t);
    let fail = true;
    api.onRequest = request => {
        if (request.method === 'thread/section/move' && fail) throw new Error('Section service unavailable');
        return DEFAULT;
    };
    const routes: string[] = [];
    await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', id => routes.push(id)), /Section service unavailable/);
    assert.deepEqual(routes, [TARGET]);
    assert.equal(readJson(runtime, 'thread-migrations.json')[SOURCE].targetId, TARGET);
    fail = false;
    await new ThreadCatalog(runtime, OPTIONS).ensureVisible(api, SOURCE, '默认标题', id => routes.push(id));
    assert.equal(api.count('thread/fork'), 1);
});

test('a fork response for another source is rejected before replacing routing', async t => {
    const { api, catalog } = setup(t);
    api.onRequest = request => request.method === 'thread/fork'
        ? { thread: { id: TARGET, source: 'vscode', forkedFromId: 'different-source', ephemeral: false } }
        : DEFAULT;
    await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', () => assert.fail('Wrong lineage must not replace routing')), hasCode('invalid_output'));
});

test('a saved migration target is validated before routing or changing its title', async t => {
    const { runtime, api, catalog } = setup(t);
    journal(runtime, { [SOURCE]: { sourceId: SOURCE, targetId: TARGET, startedAt: new Date().toISOString() } });
    api.threads.set(TARGET, { id: TARGET, source: 'vscode', forkedFromId: 'different-source', name: 'Other task' });
    await assert.rejects(catalog.ensureVisible(api, SOURCE, '默认标题', () => assert.fail('Wrong recorded target must not replace routing')), hasCode('invalid_output'));
    assert.equal(api.count('thread/fork'), 0);
    assert.equal(api.count('thread/name/set'), 0);
    assert.equal(api.count('thread/section/move'), 0);
});

test('the existing legacy section name is reused without creating another group', async t => {
    const { runtime, api, catalog } = setup(t);
    api.sections = [{ id: SECTION, name: '微信Bot' }];
    await catalog.place(api, SOURCE, '默认标题');
    assert.equal(api.count('threadSection/create'), 0);
    assert.equal(readJson(runtime, 'sidebar-section.json').sectionId, SECTION);
});
