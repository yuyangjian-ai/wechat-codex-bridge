import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path, { win32 } from 'node:path';
import { test } from 'node:test';
import { CodexRunError, type CodexRunnerOptions } from '../src/codex.js';
import { DesktopCodexRunner, desktopSettingsMatch, snapshotTurns, type DesktopConnection } from '../src/desktop-codex.js';

const THREAD = '019a1234-5678-7000-8000-123456789abc';
const OTHER_THREAD = '019a1234-5678-7000-8000-123456789abd';
const OWNER = 'desktop-owner';
const TURN = 'accepted-turn';
type Value = Record<string, any>;
type Request = { method: string; version: number; params: any; options?: { targetClientId?: string; timeoutMs?: number } };

const OPTIONS: CodexRunnerOptions = {
    executable: 'codex.exe', workingDirectory: 'D:\\code', sandbox: 'workspace-write', timeoutMs: 2000
};

function state(overrides: Value = {}): Value {
    return {
        id: THREAD,
        cwd: 'D:\\code',
        latestThreadSettings: {
            cwd: 'D:\\code', approvalPolicy: 'never', approvalsReviewer: 'user',
            sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] }
        },
        currentPermissions: { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: [] } },
        threadRuntimeStatus: { type: 'idle' },
        turns: [],
        ...overrides
    };
}

function turn(clientUserMessageId: string, status = 'completed', text = '桌面任务完成。'): Value {
    return {
        turnId: TURN, status, params: { clientUserMessageId },
        items: [
            { type: 'agentMessage', phase: 'commentary', text: '正在分析。' },
            ...(status === 'completed' ? [{ type: 'agentMessage', phase: 'final_answer', text }] : [])
        ]
    };
}

class FakeDesktop implements DesktopConnection {
    clientId = 'weixin-test';
    closed = false;
    requests: Request[] = [];
    broadcasts: Array<{ method: string; version: number; params: any; targetClientIds?: string[] }> = [];
    listeners = new Set<(message: any) => void>();
    disconnectListeners = new Set<() => void>();
    currentState = state();
    onStart?: (request: Request) => Promise<any> | any;

    async request(method: string, version: number, params: any, options?: Request['options']): Promise<any> {
        const request = { method, version, params, options };
        this.requests.push(request);
        if (method === 'thread-owner-discovery') return { resultType: 'success', handledByClientId: OWNER, result: { supportsUntrustedAppInput: true } };
        if (method === 'thread-follower-interrupt-turn') return { resultType: 'success', result: { ok: true, interruptedTurnId: params.expectedTurnId } };
        if (method !== 'thread-follower-start-turn') throw new Error(`Unexpected request: ${method}`);
        if (this.onStart) return this.onStart(request);
        this.currentState = state({ turns: [turn(params.turnStart.request.clientUserMessageId)] });
        queueMicrotask(() => this.emitSnapshot());
        return { resultType: 'success', result: { result: { turn: { id: TURN, status: 'inProgress' } } } };
    }

    broadcast(method: string, version: number, params: any, targetClientIds?: string[]): void {
        this.broadcasts.push({ method, version, params, targetClientIds });
        if (params.following === true) queueMicrotask(() => this.emitSnapshot());
    }

    emitSnapshot(overrides: Value = {}): void {
        if (this.closed) return;
        const message = {
            type: 'broadcast', method: 'thread-stream-state-changed', version: 11, sourceClientId: OWNER,
            params: { hostId: 'local', conversationId: THREAD, change: { type: 'snapshot', revision: 1, conversationState: this.currentState } },
            ...overrides
        };
        for (const listener of this.listeners) listener(message);
    }

    onBroadcast(listener: (message: any) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    onDisconnect(listener: () => void): () => void { this.disconnectListeners.add(listener); return () => this.disconnectListeners.delete(listener); }
    close(): void { this.closed = true; }
    startRequest(): Request | undefined { return this.requests.find(request => request.method === 'thread-follower-start-turn'); }
}

function setup(fake = new FakeDesktop(), overrides: Partial<CodexRunnerOptions> = {}) {
    return { fake, runner: new DesktopCodexRunner({ ...OPTIONS, ...overrides }, async () => fake, { collectImages: async () => ({ images: [] }) }) };
}

async function started(fake: FakeDesktop): Promise<Request> {
    for (let attempt = 0; attempt < 30; attempt++) {
        const request = fake.startRequest();
        if (request) return request;
        await new Promise<void>(resolve => setImmediate(resolve));
    }
    throw new Error('Expected a desktop turn submission');
}

function hasCode(code: string) { return (error: unknown) => error instanceof CodexRunError && error.code === code; }

test('desktop follower submits native images with text and with the image-only fallback prompt', async t => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'codex-desktop-input-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('codex-desktop-input-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, 'question.png');
    await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
    for (const prompt of ['说明这张图片', '']) {
        const { fake, runner } = setup();
        const result = await runner.run({ prompt, threadId: THREAD, images: [{ path: file }] });
        const request = fake.startRequest()!.params.turnStart.request;
        assert.deepEqual(request.input, [
            { type: 'text', text: prompt || '请查看并分析这些图片。', text_elements: [] },
            { type: 'localImage', path: file }
        ]);
        assert.equal(request.threadId, THREAD);
        assert.equal(request.permissions, null);
        assert.equal(request.approvalPolicy, 'never');
        assert.equal(result.threadId, THREAD);
    }
});

test('desktop rejects invalid native image paths before opening an IPC connection', async () => {
    let connected = false;
    const runner = new DesktopCodexRunner(OPTIONS, async () => { connected = true; return new FakeDesktop(); });
    await assert.rejects(runner.run({ prompt: '看图', threadId: THREAD, images: [{ path: 'relative.png' }] }), hasCode('invalid_output'));
    assert.equal(connected, false);
});

test('desktop pure-image completion collects only the accepted turn and keeps the original thread', async () => {
    const fake = new FakeDesktop();
    fake.onStart = request => {
        fake.currentState = state({ turns: [turn(request.params.turnStart.request.clientUserMessageId, 'completed', '')] });
        queueMicrotask(() => fake.emitSnapshot());
        return { resultType: 'success', result: { result: { turn: { id: TURN } } } };
    };
    const images = [{ path: 'C:\\bridge\\media\\image.png' }];
    const runner = new DesktopCodexRunner(OPTIONS, async () => fake, {
        collectImages: async (threadId, turnId) => {
            assert.equal(threadId, THREAD); assert.equal(turnId, TURN);
            return { images };
        }
    });
    assert.deepEqual(await runner.run({ prompt: '生成头像', threadId: THREAD }), { threadId: THREAD, text: '图片已生成。', images });
    assert.equal(fake.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
    assert.equal(fake.closed, true);
});

test('desktop image collection errors keep completed text and never resubmit a turn', async () => {
    const fake = new FakeDesktop();
    const runner = new DesktopCodexRunner(OPTIONS, async () => fake, {
        collectImages: async () => { throw new Error('SECRET media path'); }
    });
    const result = await runner.run({ prompt: '生成头像', threadId: THREAD });
    assert.match(result.text, /^桌面任务完成。\n\n图片.*Codex/);
    assert.equal(result.text.includes('SECRET'), false);
    assert.equal(fake.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
    assert.equal(fake.closed, true);
});

test('desktop runner completes the original thread and explicitly sends bridge permission settings', async () => {
    const { fake, runner } = setup();
    assert.deepEqual(await runner.run({ threadId: THREAD, prompt: '检查代码' }), { threadId: THREAD, text: '桌面任务完成。' });
    const start = fake.startRequest()!;
    assert.equal(start.version, 2);
    assert.equal(start.options?.targetClientId, OWNER);
    assert.equal(start.params.conversationId, THREAD);
    assert.equal(start.params.turnStart.request.threadId, THREAD);
    assert.deepEqual(start.params.turnStart.request.input, [{ type: 'text', text: '检查代码', text_elements: [] }]);
    assert.equal(start.params.turnStart.request.cwd, 'D:\\code');
    assert.equal(start.params.turnStart.request.approvalPolicy, 'never');
    assert.equal(start.params.turnStart.request.approvalsReviewer, 'user');
    assert.equal(start.params.turnStart.request.permissions, null);
    assert.deepEqual(start.params.turnStart.request.sandboxPolicy, {
        type: 'workspaceWrite', writableRoots: ['D:\\code'], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false
    });
    assert.equal(start.params.turnStart.context.inheritThreadSettings, true);
    assert.equal(start.params.turnStart.context.useAppServerPermissionDefault, false);
    assert.equal(start.params.turnStart.context.usePermissionSelection, false);
    assert.equal(fake.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
    assert.equal(fake.broadcasts.at(-1)?.params.following, false);
    assert.equal(fake.closed, true);
    assert.equal(fake.listeners.size, 0);
});

test('canonical snapshots return only the requested turn final response', async () => {
    const { fake, runner } = setup();
    fake.onStart = request => {
        const messageId = request.params.turnStart.request.clientUserMessageId;
        fake.currentState = state({
            turns: [{ turnId: 'older-turn', status: 'completed', items: [{ type: 'agentMessage', text: '旧答案' }] }],
            turnHistory: { kind: 'canonical', history: {
                islands: [{ entries: [{ value: 'entity-1' }] }],
                entitiesByKey: { 'entity-1': turn(messageId, 'completed', '本次正确答案') }
            } }
        });
        queueMicrotask(() => fake.emitSnapshot());
        return { resultType: 'success', result: { result: { turn: { id: TURN } } } };
    };
    assert.deepEqual(await runner.run({ threadId: THREAD, prompt: '继续' }), { threadId: THREAD, text: '本次正确答案' });
});

test('wrong owner, host, thread, state ID and stream version cannot complete a task', async () => {
    const { fake, runner } = setup();
    fake.onStart = () => ({ resultType: 'success', result: { result: { turn: { id: TURN } } } });
    let completed = false;
    const pending = runner.run({ threadId: THREAD, prompt: '继续' }).then(value => { completed = true; return value; });
    const request = await started(fake);
    const completedState = state({ turns: [turn(request.params.turnStart.request.clientUserMessageId, 'completed', '匹配结果')] });
    const params = { hostId: 'local', conversationId: THREAD, change: { type: 'snapshot', revision: 2, conversationState: completedState } };
    fake.emitSnapshot({ sourceClientId: 'other-owner', params });
    fake.emitSnapshot({ params: { ...params, hostId: 'other-host' } });
    fake.emitSnapshot({ params: { ...params, conversationId: OTHER_THREAD } });
    fake.emitSnapshot({ params: { ...params, change: { ...params.change, conversationState: { ...completedState, id: OTHER_THREAD } } } });
    fake.emitSnapshot({ version: 12, params });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    fake.currentState = completedState;
    fake.emitSnapshot();
    assert.equal((await pending).text, '匹配结果');
});

test('busy desktop turns and active runtimes reject before submitting', async () => {
    for (const initial of [state({ turns: [turn('other-user-message', 'inProgress')] }), state({ threadRuntimeStatus: { type: 'active', activeFlags: [] } })]) {
        const { fake, runner } = setup();
        fake.currentState = initial;
        await assert.rejects(runner.run({ threadId: THREAD, prompt: '继续' }), hasCode('session_busy'));
        assert.equal(fake.startRequest(), undefined);
        assert.equal(fake.closed, true);
    }
});

test('desktop writable roots and working directory mismatches reject before submitting', async () => {
    const fixtures = [
        state({ cwd: 'E:\\other', latestThreadSettings: { ...state().latestThreadSettings, cwd: 'E:\\other' } }),
        state({ latestThreadSettings: { ...state().latestThreadSettings, sandboxPolicy: { type: 'workspaceWrite', networkAccess: false, writableRoots: ['E:\\private'] } } }),
        state({ environments: [{ environmentId: 'desktop-local', cwd: 'E:\\other', runtimeWorkspaceRoots: ['E:\\other'] }] }),
        state({ environments: [{ environmentId: 'desktop-local', cwd: 'D:\\code', runtimeWorkspaceRoots: ['E:\\private'] }] }),
        state({ currentPermissions: { ...state().currentPermissions, runtimeWorkspaceRoots: ['E:\\private'] } })
    ];
    for (const initial of fixtures) {
        const { fake, runner } = setup();
        fake.currentState = initial;
        await assert.rejects(runner.run({ threadId: THREAD, prompt: '继续' }), hasCode('session_busy'));
        assert.equal(fake.startRequest(), undefined);
    }
});

test('desktop full access and other previous permissions are replaced by explicit bridge permissions', async () => {
    for (const sandbox of ['workspace-write', 'read-only'] as const) {
        for (const oldPolicy of [{ type: 'dangerFullAccess' }, { type: 'workspaceWrite', networkAccess: true, writableRoots: ['D:\\code'] }]) {
            const { fake, runner } = setup(undefined, { sandbox });
            const originalSettings = {
                ...state().latestThreadSettings, approvalPolicy: 'on-request', sandboxPolicy: oldPolicy,
                activePermissionProfile: { id: ':danger-full-access', extends: null }, model: 'existing-model', effort: 'high'
            };
            fake.currentState = state({ latestThreadSettings: originalSettings,
                currentPermissions: { sandboxPolicy: oldPolicy, activePermissionProfile: { id: ':danger-full-access' }, runtimeWorkspaceRoots: ['D:\\code'] },
                environments: [{ environmentId: 'desktop-local', cwd: 'D:\\code', runtimeWorkspaceRoots: ['D:\\code'] }] });
            const response = await runner.run({ threadId: THREAD, prompt: '当前加州时间' });
            assert.equal(response.text, '桌面任务完成。');
            const { request, context } = fake.startRequest()!.params.turnStart;
            assert.equal(request.sandboxPolicy.type, sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite');
            assert.equal(request.sandboxPolicy.networkAccess, false);
            assert.equal(request.permissions, null);
            assert.equal(request.approvalPolicy, 'never');
            assert.equal(request.approvalsReviewer, 'user');
            assert.equal(context.inheritThreadSettings, true);
            assert.equal(context.useAppServerPermissionDefault, false);
            assert.equal(context.usePermissionSelection, false);
            assert.equal(originalSettings.sandboxPolicy, oldPolicy);
            assert.equal(fake.requests.filter(r => r.method === 'thread-follower-start-turn').length, 1);
        }
    }
});

test('read-only desktop settings remain read-only in the submitted turn', async () => {
    const { fake, runner } = setup(undefined, { sandbox: 'read-only' });
    fake.currentState = state({ latestThreadSettings: { ...state().latestThreadSettings, sandboxPolicy: { type: 'readOnly', networkAccess: false } } });
    assert.equal((await runner.run({ threadId: THREAD, prompt: '读取项目' })).text, '桌面任务完成。');
    assert.equal(fake.startRequest()!.params.turnStart.request.sandboxPolicy.type, 'readOnly');
});

test('effective desktop permission verification rejects missing fields and inherited profiles', () => {
    assert.equal(desktopSettingsMatch(state(), OPTIONS), true);
    for (const settings of [
        { ...state().latestThreadSettings, activePermissionProfile: { id: 'custom-profile' } },
        { ...state().latestThreadSettings, approvalsReviewer: 'auto_review' },
        { ...state().latestThreadSettings, sandboxPolicy: { type: 'workspaceWrite', writableRoots: [] } }
    ]) assert.equal(desktopSettingsMatch(state({ latestThreadSettings: settings }), OPTIONS), false);
});

test('an error response recovers an accepted turn by client message ID without resubmitting', async () => {
    const { fake, runner } = setup();
    fake.onStart = request => {
        fake.currentState = state({ turns: [turn(request.params.turnStart.request.clientUserMessageId, 'completed', '超时后仍完成')] });
        return { resultType: 'error', error: 'thread-follower-start-turn-timeout' };
    };
    assert.equal((await runner.run({ threadId: THREAD, prompt: '继续' })).text, '超时后仍完成');
    assert.equal(fake.requests.filter(request => request.method === 'thread-follower-start-turn').length, 1);
});

test('abort sends an interrupt only for the accepted bridge turn', async () => {
    const { fake, runner } = setup();
    const controller = new AbortController();
    fake.onStart = request => {
        fake.currentState = state({ turns: [turn(request.params.turnStart.request.clientUserMessageId, 'inProgress')] });
        queueMicrotask(() => fake.emitSnapshot());
        return { resultType: 'success', result: { result: { turn: { id: TURN } } } };
    };
    const pending = runner.run({ threadId: THREAD, prompt: '执行任务', signal: controller.signal });
    await started(fake);
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pending, hasCode('aborted'));
    const interrupts = fake.requests.filter(request => request.method === 'thread-follower-interrupt-turn');
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].version, 4);
    assert.deepEqual(interrupts[0].params, { conversationId: THREAD, mode: 'user-stop', expectedTurnId: TURN });
    assert.equal(interrupts[0].options?.targetClientId, OWNER);
    assert.equal(fake.closed, true);
});

test('task timeout also uses an exact expected turn ID', async () => {
    const { fake, runner } = setup(undefined, { timeoutMs: 20 });
    fake.onStart = request => {
        fake.currentState = state({ turns: [turn(request.params.turnStart.request.clientUserMessageId, 'inProgress')] });
        return { resultType: 'success', result: { result: { turn: { id: TURN } } } };
    };
    await assert.rejects(runner.run({ threadId: THREAD, prompt: '执行任务' }), hasCode('timeout'));
    assert.equal(fake.requests.find(request => request.method === 'thread-follower-interrupt-turn')?.params.expectedTurnId, TURN);
});

test('snapshot helpers support case-insensitive Windows cwd and canonical live overlays', () => {
    assert.equal(desktopSettingsMatch(state({ cwd: 'd:\\CODE', latestThreadSettings: { ...state().latestThreadSettings, cwd: 'd:\\CODE' } }), OPTIONS), true);
    const canonical = turn('message', 'inProgress');
    const overlay = turn('message', 'completed');
    assert.deepEqual(snapshotTurns({
        turnHistory: { kind: 'canonical', history: { islands: [{ entries: [{ value: 'entity' }] }], entitiesByKey: { entity: canonical } } },
        turns: [overlay]
    }), [overlay]);
});

test('desktop visualization exception is restricted to this exact thread folder', () => {
    const ownVisualization = win32.join(homedir(), '.codex', 'visualizations', '2026', '09', '15', THREAD);
    const otherVisualization = win32.join(homedir(), '.codex', 'visualizations', '2026', '09', '15', OTHER_THREAD);
    assert.equal(desktopSettingsMatch(state({ currentPermissions: { ...state().currentPermissions, runtimeWorkspaceRoots: ['D:\\code', ownVisualization] } }), OPTIONS), true);
    assert.equal(desktopSettingsMatch(state({ currentPermissions: { ...state().currentPermissions, runtimeWorkspaceRoots: [otherVisualization] } }), OPTIONS), false);
    assert.equal(desktopSettingsMatch(state({ currentPermissions: { ...state().currentPermissions, runtimeWorkspaceRoots: [win32.dirname(ownVisualization)] } }), OPTIONS), false);
});

test('abort with an unknown turn waits for its client message ID and interrupts only that recovered turn', async () => {
    const { fake, runner } = setup();
    const controller = new AbortController();
    let settleStart!: (response: any) => void;
    fake.onStart = () => new Promise(resolve => { settleStart = resolve; });
    const pending = runner.run({ threadId: THREAD, prompt: '开始任务', signal: controller.signal });
    const rejection = assert.rejects(pending, hasCode('aborted'));
    const request = await started(fake);
    controller.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fake.requests.filter(call => call.method === 'thread-follower-interrupt-turn').length, 0);
    const recoveredTurn = { ...turn(request.params.turnStart.request.clientUserMessageId, 'inProgress'), turnId: 'recovered-original-turn' };
    fake.currentState = state({ turns: [recoveredTurn, { ...turn('other-message', 'inProgress'), turnId: 'another-current-turn' }] });
    fake.emitSnapshot();
    await rejection;
    const interrupts = fake.requests.filter(call => call.method === 'thread-follower-interrupt-turn');
    assert.equal(interrupts.length, 1);
    assert.equal(interrupts[0].params.expectedTurnId, 'recovered-original-turn');
    assert.equal(fake.requests.filter(call => call.method === 'thread-follower-start-turn').length, 1);
    settleStart({ resultType: 'error', error: 'timeout' });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fake.requests.filter(call => call.method === 'thread-follower-interrupt-turn').length, 1);
    assert.equal(fake.closed, true);
});

test('a synchronous follow write failure with disconnect leaves no unhandled promise rejection', async () => {
    const { fake, runner } = setup();
    fake.broadcast = (_method, _version, params: any) => {
        if (params.following !== true) return;
        for (const listener of fake.disconnectListeners) listener();
        throw new Error('Socket closed synchronously during follow');
    };
    await assert.rejects(runner.run({ threadId: THREAD, prompt: '继续' }), hasCode('process_failed'));
    // Node's test runner fails this test on any unhandled rejection emitted in these turns.
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(fake.startRequest(), undefined);
    assert.equal(fake.closed, true);
    assert.equal(fake.listeners.size, 0);
    assert.equal(fake.disconnectListeners.size, 0);
});
