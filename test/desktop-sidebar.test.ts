import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Socket } from 'node:net';
import { test, type TestContext } from 'node:test';
import { DesktopSidebar, DesktopSidebarError } from '../src/desktop-sidebar.js';

const THREAD = '11111111-1111-4111-8111-111111111111';
const THREAD_TWO = '22222222-2222-4222-8222-222222222222';
const SECTION = '33333333-3333-4333-8333-333333333333';
const PIPE = '\\\\.\\pipe\\codex-browser-use-44444444-4444-4444-8444-444444444444';
const PIPE_TWO = '\\\\.\\pipe\\codex-browser-use-55555555-5555-4555-8555-555555555555';
const TOOLS = ['list_threads', 'create_sidebar_section', 'move_thread_to_sidebar_section'];
type Value = Record<string, any>;

function frame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    return Buffer.concat([header, body]);
}

class FakeSocket extends EventEmitter {
    destroyed = false;
    pipePath = '';
    constructor(private readonly handler: (request: Value, socket: FakeSocket) => unknown) { super(); }
    write(bytes: Buffer): boolean {
        assert.equal(bytes.readUInt32LE(), bytes.length - 4);
        const request = JSON.parse(bytes.subarray(4).toString());
        queueMicrotask(() => {
            const result = this.handler(request, this);
            if (result === undefined) return;
            const bytes = frame({ id: request.id, jsonrpc: '2.0', result });
            // Exercise both split header and split UTF-8 payload handling.
            this.emit('data', bytes.subarray(0, 2));
            this.emit('data', bytes.subarray(2, 17));
            this.emit('data', bytes.subarray(17));
        });
        return true;
    }
    destroy(): this { if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); } return this; }
}

function setup(t: TestContext) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sidebar-test-'));
    t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
    const state = {
        sections: [{ sectionId: SECTION, name: '微信 Bot', itemKeys: [] as string[] }, { sectionId: 'other', name: '工作', itemKeys: ['codex:thread:local:unrelated'] }],
        requests: [] as Value[], sockets: [] as FakeSocket[],
        onRequest: undefined as ((request: Value, socket: FakeSocket) => unknown) | undefined,
        pipe: PIPE as string | undefined,
        inventory: [] as string[], paths: [] as string[]
    };
    const normal = (request: Value): unknown => {
        if (request.method === 'tools/list') return { tools: TOOLS.map(name => ({ name, namespace: 'codex_app' })) };
        assert.equal(request.method, 'tools/call');
        assert.equal(request.params.namespace, 'codex_app');
        assert.match(request.params.callId, /^mcp-call-[a-f\d-]{36}$/);
        assert.match(request.params.turnId, /^mcp-turn-[a-f\d-]{36}$/);
        let result: Value;
        switch (request.params.tool) {
            case 'list_threads': result = { sections: state.sections, threads: [THREAD, THREAD_TWO].map(id => ({ id, kind: 'codex', hostId: 'local' })) }; break;
            case 'create_sidebar_section':
                state.sections.push({ sectionId: SECTION, name: '微信 Bot', itemKeys: [] });
                result = { sectionId: SECTION, name: '微信 Bot' }; break;
            case 'move_thread_to_sidebar_section': {
                const { threadId, hostId, sectionId } = request.params.arguments;
                assert.equal(hostId, 'local');
                state.sections.find(section => section.sectionId === sectionId)!.itemKeys.push(`codex:thread:local:${threadId}`);
                result = { hostId, sectionId, threadId }; break;
            }
            default: throw new Error(`Unexpected tool ${request.params.tool}`);
        }
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    };
    const sidebar = new DesktopSidebar(runtime, {
        timeoutMs: 80, pipePath: () => state.pipe, discoverPipePaths: async () => state.inventory,
        socketFactory: pipe => {
            state.paths.push(pipe);
            const socket = new FakeSocket((request, socket) => {
                state.requests.push(request);
                return state.onRequest ? state.onRequest(request, socket) : normal(request);
            });
            socket.pipePath = pipe;
            state.sockets.push(socket);
            queueMicrotask(() => socket.emit('connect'));
            return socket as unknown as Socket;
        }
    });
    const count = (tool: string): number => state.requests.filter(request => request.params?.tool === tool).length;
    return { runtime, state, sidebar, normal, count };
}

test('moves only requested thread through the public tool and verifies UI membership', async t => {
    const { sidebar, state, runtime, count } = setup(t);
    const other = structuredClone(state.sections[1]);
    await sidebar.place(THREAD);
    assert.deepEqual(state.sections[0].itemKeys, [`codex:thread:local:${THREAD}`]);
    assert.deepEqual(state.sections[1], other);
    assert.equal(count('list_threads'), 2);
    assert.equal(count('move_thread_to_sidebar_section'), 1);
    assert.equal(count('create_sidebar_section'), 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'desktop-sidebar.json'), 'utf8')), { sectionId: SECTION });
    assert.ok(state.sockets.every(socket => socket.destroyed));
});

test('already grouped thread is read-only and pipe environment is resolved each time', async t => {
    const { sidebar, state, count } = setup(t);
    state.sections[0].itemKeys.push(`codex:thread:local:${THREAD}`);
    await sidebar.place(THREAD);
    state.pipe = '\\\\.\\pipe\\codex-browser-use-restarted';
    await sidebar.place(THREAD);
    assert.equal(count('move_thread_to_sidebar_section'), 0);
    assert.equal(count('create_sidebar_section'), 0);
    assert.equal(state.sockets.length, 4);
});

test('serialized simultaneous placements create one section and retain both tasks', async t => {
    const { sidebar, state, count } = setup(t);
    state.sections.shift();
    await Promise.all([sidebar.place(THREAD), sidebar.place(THREAD_TWO)]);
    assert.equal(count('create_sidebar_section'), 1);
    assert.deepEqual(state.sections.find(section => section.sectionId === SECTION)!.itemKeys, [`codex:thread:local:${THREAD}`, `codex:thread:local:${THREAD_TWO}`]);
});

test('unknown create result is durably recorded and never blindly created again', async t => {
    const { sidebar, state, normal, runtime, count } = setup(t);
    state.sections.shift();
    state.onRequest = request => request.params?.tool === 'create_sidebar_section' ? undefined : normal(request);
    await assert.rejects(sidebar.place(THREAD), DesktopSidebarError);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'desktop-sidebar.json'), 'utf8')), { createAttempted: true });
    await assert.rejects(sidebar.place(THREAD), /不会重复创建/);
    assert.equal(count('create_sidebar_section'), 1);
    assert.ok(state.sockets.every(socket => socket.destroyed));
    state.sections.push({ sectionId: SECTION, name: '微信 Bot', itemKeys: [] });
    state.onRequest = normal;
    await sidebar.place(THREAD);
    assert.equal(count('create_sidebar_section'), 1);
});

test('missing endpoint, remote pipe and invalid thread fail before connecting', async t => {
    const { sidebar, state } = setup(t);
    state.pipe = undefined;
    await assert.rejects(sidebar.place(THREAD), /未找到/);
    state.pipe = '\\\\remote\\pipe\\tool';
    await assert.rejects(sidebar.place(THREAD), /本机命名管道/);
    await assert.rejects(sidebar.place('not-a-thread'), /任务 ID 无效/);
    assert.equal(state.sockets.length, 0);
});

test('duplicate names cannot move a task into an arbitrary group', async t => {
    const { sidebar, state, count } = setup(t);
    state.sections.push({ sectionId: 'duplicate', name: '微信 Bot', itemKeys: [] });
    await assert.rejects(sidebar.place(THREAD), /多个同名/);
    assert.equal(count('move_thread_to_sidebar_section'), 0);
});

test('a previously confirmed UI section is reused after the user renames it', async t => {
    const { sidebar, state, count } = setup(t);
    await sidebar.place(THREAD);
    state.sections[0].name = '我的微信任务';
    await sidebar.place(THREAD_TWO);
    assert.equal(count('create_sidebar_section'), 0);
    assert.ok(state.sections[0].itemKeys.includes(`codex:thread:local:${THREAD_TWO}`));
});

test('unexpected tool namespace fails closed without a tool call', async t => {
    const { sidebar, state } = setup(t);
    state.onRequest = () => ({ tools: TOOLS.map(name => ({ name, namespace: 'untrusted' })) });
    await assert.rejects(sidebar.place(THREAD), /未找到/);
    assert.equal(state.requests.length, 1);
});

test('mismatched move response never reports success or repeats the mutation', async t => {
    const { sidebar, state, normal, count } = setup(t);
    state.onRequest = request => request.params?.tool === 'move_thread_to_sidebar_section'
        ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ sectionId: 'other', threadId: THREAD }) }] }
        : normal(request);
    await assert.rejects(sidebar.place(THREAD), /未匹配目标/);
    assert.equal(count('move_thread_to_sidebar_section'), 1);
});

test('a success response without actual UI membership is not accepted', async t => {
    const { sidebar, state, normal } = setup(t);
    state.onRequest = request => request.params?.tool === 'move_thread_to_sidebar_section'
        ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ sectionId: SECTION, threadId: THREAD }) }] }
        : normal(request);
    await assert.rejects(sidebar.place(THREAD), /尚未出现在/);
});

test('oversized frame is rejected without exposing payloads', async t => {
    const { sidebar, state } = setup(t);
    state.onRequest = (_, socket) => { const header = Buffer.alloc(4); header.writeUInt32LE(8 * 1024 * 1024 + 1); socket.emit('data', header); return undefined; };
    await assert.rejects(sidebar.place(THREAD), /未找到/);
    assert.ok(state.sockets[0].destroyed);
});

test('without env or cache discovers only an exact official UUID pipe and confirms thread ownership', async t => {
    const { sidebar, state, normal, runtime } = setup(t);
    state.pipe = undefined;
    state.inventory = ['\\\\.\\pipe\\unrelated', '\\\\.\\pipe\\codex-browser-use-not-uuid', PIPE, PIPE_TWO];
    state.onRequest = (request, socket) => socket.pipePath === PIPE_TWO ? { tools: [] } : normal(request);
    await sidebar.place(THREAD);
    assert.ok(state.paths.every(candidate => candidate === PIPE || candidate === PIPE_TWO));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'desktop-sidebar-endpoint.json'), 'utf8')), { pipePath: PIPE });
    assert.ok(state.sections[0].itemKeys.includes(`codex:thread:local:${THREAD}`));
});

test('successful cached pipe works after launch without inherited desktop environment', async t => {
    const { sidebar, state } = setup(t);
    await sidebar.place(THREAD);
    state.pipe = undefined;
    await sidebar.place(THREAD_TWO);
    assert.ok(state.paths.every(candidate => candidate === PIPE));
});

test('stale environment and cache are replaced by a verified discovered endpoint', async t => {
    const { sidebar, state, normal, runtime } = setup(t);
    fs.writeFileSync(path.join(runtime, 'desktop-sidebar-endpoint.json'), JSON.stringify({ pipePath: PIPE }));
    state.inventory = [PIPE, PIPE_TWO];
    state.onRequest = (request, socket) => socket.pipePath === PIPE ? { tools: [] } : normal(request);
    await sidebar.place(THREAD);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime, 'desktop-sidebar-endpoint.json'), 'utf8')), { pipePath: PIPE_TWO });
});

test('ambiguous verified desktop endpoints do not mutate either window', async t => {
    const { sidebar, state, count } = setup(t);
    state.pipe = undefined;
    state.inventory = [PIPE, PIPE_TWO];
    await assert.rejects(sidebar.place(THREAD), /多个 Codex 桌面连接/);
    assert.equal(count('move_thread_to_sidebar_section'), 0);
    assert.equal(count('create_sidebar_section'), 0);
});

test('catalog match without the real target thread cannot authorize discovered endpoint', async t => {
    const { sidebar, state, normal, count } = setup(t);
    state.pipe = undefined;
    state.inventory = [PIPE];
    state.onRequest = request => request.params?.tool === 'list_threads'
        ? { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ sections: state.sections, threads: [{ id: THREAD, kind: 'codex', hostId: 'other-host' }] }) }] }
        : normal(request);
    await assert.rejects(sidebar.place(THREAD), /未找到/);
    assert.equal(count('move_thread_to_sidebar_section'), 0);
});

test('tool errors produce safe diagnostics and close the pipe', async t => {
    const { sidebar, state, normal } = setup(t);
    state.onRequest = request => request.method === 'tools/call'
        ? { success: false, contentItems: [{ type: 'inputText', text: 'SECRET payload' }] } : normal(request);
    await assert.rejects(sidebar.place(THREAD), error => {
        assert.ok(error instanceof DesktopSidebarError);
        assert.equal(error.message.includes('SECRET'), false);
        return true;
    });
    assert.ok(state.sockets[0].destroyed);
});
