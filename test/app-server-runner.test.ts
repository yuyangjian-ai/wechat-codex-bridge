import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { AppServerRunner, type AppServerConnection, type OnThreadReady } from '../src/app-server-runner.js';
import type { AppServerMessage, AppServerRequestId } from '../src/app-server.js';
import { CodexRunError, type CodexRunnerOptions } from '../src/codex.js';

const THREAD = '019a1234-5678-7000-8000-123456789abc';
const TURN = '019a1234-5678-7000-8000-123456789def';
const OTHER = '019a1234-5678-7000-8000-123456789aaa';
const OPTIONS: CodexRunnerOptions = {
    executable: 'codex.exe', workingDirectory: 'D:\\code', sandbox: 'workspace-write', timeoutMs: 1_000
};

class FakeClient implements AppServerConnection {
    calls: { method: string; params: any; options?: { timeoutMs?: number } }[] = [];
    responses: unknown[] = [];
    notifications = new Set<(message: AppServerMessage) => void>();
    requests = new Set<(message: AppServerMessage) => void>();
    disconnects = new Set<(error: CodexRunError) => void>();
    closed = false;
    active = false;
    requestOverride?: (method: string, params: any) => Promise<any> | undefined;
    async request(method: string, params: any, options?: { timeoutMs?: number }): Promise<any> {
        this.calls.push({ method, params, options });
        const overridden = this.requestOverride?.(method, params);
        if (overridden) return overridden;
        if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: THREAD, status: { type: this.active ? 'active' : 'idle' }, turns: [] } };
        if (method === 'turn/start') return { turn: { id: TURN } };
        if (method === 'thread/items/list') return { data: [], nextCursor: null };
        return {};
    }
    onNotification(listener: (message: AppServerMessage) => void): () => void {
        this.notifications.add(listener); return () => { this.notifications.delete(listener); };
    }
    onRequest(listener: (message: AppServerMessage) => void): () => void {
        this.requests.add(listener); return () => { this.requests.delete(listener); };
    }
    onDisconnect(listener: (error: CodexRunError) => void): () => void {
        this.disconnects.add(listener); return () => { this.disconnects.delete(listener); };
    }
    respond(id: AppServerRequestId, result: unknown): void { this.responses.push({ id, result }); }
    respondError(id: AppServerRequestId, code = -32601): void { this.responses.push({ id, error: { code } }); }
    close(): void { this.closed = true; }
    emit(method: string, params: unknown): void { for (const listener of [...this.notifications]) listener({ method, params }); }
    ask(method: string, params: unknown): void { for (const listener of [...this.requests]) listener({ id: 'server-request', method, params }); }
    complete(text = '完成。', turnId = TURN, threadId = THREAD): void {
        this.emit('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text }] } });
    }
}

function setup(options: Partial<CodexRunnerOptions> = {}, onThreadReady?: OnThreadReady) {
    const client = new FakeClient();
    const runner = new AppServerRunner({ ...OPTIONS, ...options }, { connect: async () => client, onThreadReady });
    return { client, runner };
}

function safe(error: unknown, code: string): boolean {
    assert.ok(error instanceof CodexRunError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('SECRET'), false);
    return true;
}

test('new app-server threads persist and await the ready hook before exactly one turn is submitted', async () => {
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    const events: string[] = [];
    const { runner, client } = setup({ model: 'test-model' }, async (threadId, selectedClient) => {
        assert.equal(threadId, THREAD); assert.equal(selectedClient, client);
        events.push('ready'); await ready;
    });
    const prompt = '检查项目 $(SECRET)';
    const pending = runner.run({ prompt, onThreadId: id => { assert.equal(id, THREAD); events.push('persist'); } });
    await tick();
    assert.deepEqual(events, ['persist', 'ready']);
    assert.deepEqual(client.calls.map(call => call.method), ['thread/start']);
    assert.deepEqual(client.calls[0].params, {
        cwd: 'D:\\code', sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user',
        model: 'test-model', ephemeral: false, threadSource: 'weixin'
    });
    release(); await tick();
    const start = client.calls.find(call => call.method === 'turn/start')!;
    assert.equal(start.params.threadId, THREAD);
    assert.equal(start.params.cwd, 'D:\\code');
    assert.equal(start.params.approvalPolicy, 'never');
    assert.equal(start.params.model, 'test-model');
    assert.deepEqual(start.params.input, [{ type: 'text', text: prompt, text_elements: [] }]);
    assert.deepEqual(start.params.sandboxPolicy, {
        type: 'workspaceWrite', writableRoots: ['D:\\code'], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false
    });
    client.complete();
    assert.deepEqual(await pending, { threadId: THREAD, text: '完成。' });
    assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(client.calls.at(-1)!.method, 'thread/items/list');
    assert.equal(client.calls.at(-1)!.params.threadId, THREAD);
    assert.equal(client.calls.at(-1)!.params.turnId, TURN);
    assert.equal(client.closed, true);
    assert.equal(client.notifications.size, 0);
    assert.equal(client.requests.size, 0);
    assert.equal(client.disconnects.size, 0);
});

test('resume uses metadata hydration and reapplies explicit read-only policy', async () => {
    const { runner, client } = setup({ sandbox: 'read-only' });
    const pending = runner.run({ prompt: '继续', threadId: THREAD });
    await tick();
    assert.deepEqual(client.calls[0].params, {
        cwd: 'D:\\code', sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', threadId: THREAD, excludeTurns: true
    });
    assert.equal(client.calls[0].method, 'thread/resume');
    assert.deepEqual(client.calls[1].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    client.complete('继续完成。');
    assert.equal((await pending).text, '继续完成。');
});

test('thread persistence or preparation failures prevent model execution and hide callback diagnostics', async () => {
    for (const stage of ['persist', 'ready'] as const) {
        const { runner, client } = setup();
        const pending = runner.run({
            prompt: '运行',
            onThreadId: () => { if (stage === 'persist') throw new Error('SECRET storage path'); },
            onThreadReady: () => { if (stage === 'ready') throw new Error('SECRET section config'); }
        });
        await assert.rejects(pending, error => safe(error, 'process_failed'));
        assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
        assert.equal(client.closed, true);
    }
});

test('only matching final messages and completed turns become replies', async () => {
    const { runner, client } = setup();
    const progress: string[] = [];
    const pending = runner.run({ prompt: '处理', onProgress: text => progress.push(text) });
    await tick();
    client.complete('SECRET wrong thread', TURN, OTHER);
    client.complete('SECRET wrong turn', OTHER);
    client.emit('item/started', { threadId: THREAD, turnId: TURN, item: { type: 'commandExecution', command: 'SECRET command' } });
    client.emit('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', phase: 'commentary', text: 'SECRET commentary' } });
    client.emit('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'agentMessage', phase: 'final_answer', text: '正确结果' } });
    client.emit('turn/completed', { threadId: THREAD, turn: { id: TURN, status: 'completed', items: [] } });
    assert.equal((await pending).text, '正确结果');
    assert.deepEqual(progress, ['Codex 正在处理任务…', '正在执行本机命令…']);
});

test('completion arriving before turn/start response is buffered by the returned turn id', async () => {
    const { runner, client } = setup();
    client.requestOverride = method => {
        if (method !== 'turn/start') return;
        client.complete('SECRET unrelated', OTHER);
        client.complete('已完成');
        return Promise.resolve({ turn: { id: TURN } });
    };
    assert.equal((await runner.run({ prompt: '处理' })).text, '已完成');
});

test('failed and incomplete turns never return partial assistant output', async () => {
    for (const status of ['failed', 'completed'] as const) {
        const { runner, client } = setup();
        const pending = runner.run({ prompt: '运行' });
        await tick();
        client.emit('turn/completed', { threadId: THREAD, turn: {
            id: TURN, status, items: [{ type: 'agentMessage', phase: 'commentary', text: 'SECRET partial answer' }], error: { message: 'SECRET provider error' }
        } });
        await assert.rejects(pending, error => safe(error, status === 'failed' ? 'turn_failed' : 'invalid_output'));
    }
});

test('active resumes and active-writer failures never submit or interrupt another task', async () => {
    for (const kind of ['active', 'writer'] as const) {
        const { runner, client } = setup();
        client.active = kind === 'active';
        client.requestOverride = () => kind === 'writer' ? Promise.reject(new CodexRunError('session_busy', '会话已占用。')) : undefined;
        await assert.rejects(runner.run({ prompt: '继续', threadId: THREAD }), error => safe(error, 'session_busy'));
        assert.equal(client.calls.some(call => call.method.startsWith('turn/')), false);
        assert.equal(client.closed, true);
    }
});

test('cancellation and timeout interrupt only the selected thread and known turn', async () => {
    for (const code of ['aborted', 'timeout'] as const) {
        const { runner, client } = setup({ timeoutMs: code === 'timeout' ? 10 : 1_000 });
        const controller = new AbortController();
        const pending = runner.run({ prompt: '运行', signal: controller.signal });
        const checked = assert.rejects(pending, error => safe(error, code));
        await tick();
        if (code === 'aborted') controller.abort();
        await checked;
        assert.deepEqual(client.calls.find(call => call.method === 'turn/interrupt')?.params, { threadId: THREAD, turnId: TURN });
        assert.equal(client.closed, true);
    }
});

test('unknown-turn cancellation closes its private server without issuing a broad interrupt or retry', async () => {
    const { runner, client } = setup();
    client.requestOverride = method => method === 'turn/start' ? new Promise(() => {}) : undefined;
    const controller = new AbortController();
    const pending = runner.run({ prompt: '运行', signal: controller.signal });
    await tick();
    controller.abort();
    await assert.rejects(pending, error => safe(error, 'aborted'));
    assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(client.calls.some(call => call.method === 'turn/interrupt'), false);
    assert.equal(client.closed, true);
});

test('lost turn/start response is not retried', async () => {
    const { runner, client } = setup();
    client.requestOverride = method => method === 'turn/start' ? Promise.reject(new CodexRunError('timeout', '响应超时。')) : undefined;
    await assert.rejects(runner.run({ prompt: '运行' }), error => safe(error, 'timeout'));
    assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(client.closed, true);
});

test('unexpected approvals are declined without granting execution or permissions', async () => {
    const { runner, client } = setup();
    const pending = runner.run({ prompt: '运行' });
    await tick();
    for (const method of ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'execCommandApproval']) {
        client.ask(method, { threadId: THREAD, turnId: TURN, command: 'SECRET command' });
    }
    assert.deepEqual(client.responses, [
        { id: 'server-request', result: { decision: 'decline' } },
        { id: 'server-request', result: { decision: 'decline' } },
        { id: 'server-request', result: { permissions: {}, scope: 'turn' } },
        { id: 'server-request', result: { decision: 'abort' } }
    ]);
    client.complete(); await pending;
});

test('user input and elicitation require desktop interaction and stop only this turn', async () => {
    for (const method of ['item/tool/requestUserInput', 'mcpServer/elicitation/request']) {
        const { runner, client } = setup();
        const pending = runner.run({ prompt: '运行' });
        await tick();
        client.ask(method, { threadId: THREAD, turnId: TURN, message: 'SECRET question' });
        await assert.rejects(pending, error => {
            safe(error, 'turn_failed');
            assert.match((error as Error).message, /Codex 桌面交互/);
            return true;
        });
        assert.deepEqual(client.calls.find(call => call.method === 'turn/interrupt')?.params, { threadId: THREAD, turnId: TURN });
        assert.equal(client.closed, true);
    }
});

test('pre-aborted tasks do not connect and cancellation during preparation prevents submission', async () => {
    let connections = 0;
    const controller = new AbortController(); controller.abort();
    const runner = new AppServerRunner(OPTIONS, { connect: async () => { connections += 1; return new FakeClient(); } });
    await assert.rejects(runner.run({ prompt: '运行', signal: controller.signal }), error => safe(error, 'aborted'));
    assert.equal(connections, 0);
    const second = setup({}, () => new Promise(() => {}));
    const during = new AbortController();
    const pending = second.runner.run({ prompt: '运行', signal: during.signal });
    await tick(); during.abort();
    await assert.rejects(pending, error => safe(error, 'aborted'));
    assert.equal(second.client.calls.some(call => call.method === 'turn/start'), false);
    assert.equal(second.client.closed, true);
});

test('timeout during an unfinished ready hook disposes the server and does not submit a turn', async () => {
    const { runner, client } = setup({ timeoutMs: 5 }, () => new Promise(() => {}));
    await assert.rejects(runner.run({ prompt: '运行' }), error => safe(error, 'timeout'));
    assert.equal(client.calls.some(call => call.method === 'turn/start'), false);
    assert.equal(client.closed, true);
    assert.equal(client.notifications.size + client.requests.size + client.disconnects.size, 0);
});

test('cancellation while connecting closes the acquired server without creating a thread', async () => {
    let resolveConnection!: (client: AppServerConnection) => void;
    const connected = new Promise<AppServerConnection>(resolve => { resolveConnection = resolve; });
    const client = new FakeClient();
    const controller = new AbortController();
    const runner = new AppServerRunner(OPTIONS, { connect: () => connected });
    const pending = runner.run({ prompt: '运行', signal: controller.signal });
    await tick();
    controller.abort();
    resolveConnection(client);
    await assert.rejects(pending, error => safe(error, 'aborted'));
    assert.equal(client.calls.length, 0);
    assert.equal(client.closed, true);
});

test('pure image turns collect only the completed turn before closing the app-server', async () => {
    const client = new FakeClient();
    const images = [{ path: 'C:\\bridge\\media\\image.png' }];
    const runner = new AppServerRunner(OPTIONS, {
        connect: async () => client,
        collectImages: async (selected, threadId, turnId) => {
            assert.equal(selected, client);
            assert.equal(client.closed, false);
            assert.equal(threadId, THREAD); assert.equal(turnId, TURN);
            return { images };
        }
    });
    const pending = runner.run({ prompt: '生成头像' });
    await tick(); client.complete('');
    assert.deepEqual(await pending, { threadId: THREAD, text: '图片已生成。', images });
    assert.equal(client.closed, true);
    assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('image collection failure preserves completed app-server text without re-executing the turn', async () => {
    const client = new FakeClient();
    const runner = new AppServerRunner(OPTIONS, {
        connect: async () => client,
        collectImages: async () => { throw new Error('SECRET media file'); }
    });
    const pending = runner.run({ prompt: '生成头像' });
    await tick(); client.complete('头像任务已完成。');
    const result = await pending;
    assert.match(result.text, /^头像任务已完成。\n\n图片.*Codex/);
    assert.equal(result.text.includes('SECRET'), false);
    assert.equal(client.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(client.closed, true);
});

test('app-server sends text-plus-image and image-only prompts as native localImage input', async t => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'codex-appserver-input-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('codex-appserver-input-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, 'question.png');
    await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
    for (const prompt of ['说明这张图片', '']) {
        const { runner, client } = setup();
        let issued!: () => void;
        const submitted = new Promise<void>(resolve => { issued = resolve; });
        client.requestOverride = method => { if (method === 'turn/start') issued(); return undefined; };
        const pending = runner.run({ prompt, images: [{ path: file }] });
        await submitted; await tick();
        const request = client.calls.find(call => call.method === 'turn/start')!.params;
        assert.deepEqual(request.input, [
            { type: 'text', text: prompt || '请查看并分析这些图片。', text_elements: [] },
            { type: 'localImage', path: file }
        ]);
        assert.equal(request.approvalPolicy, 'never');
        assert.equal(request.sandboxPolicy.type, 'workspaceWrite');
        client.complete('图片解释完成。');
        assert.equal((await pending).text, '图片解释完成。');
    }
});

test('invalid image attachments are rejected before app-server connection or task submission', async () => {
    let connected = false;
    const runner = new AppServerRunner(OPTIONS, { connect: async () => { connected = true; return new FakeClient(); } });
    await assert.rejects(runner.run({ prompt: '看图', images: [{ path: 'https://example.com/SECRET.png' }] }), error => safe(error, 'invalid_output'));
    assert.equal(connected, false);
});
