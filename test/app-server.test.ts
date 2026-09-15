import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { AppServerClient, AppServerError, type AppServerMessage } from '../src/app-server.js';
import type { CodexRunnerOptions } from '../src/codex.js';

const THREAD = '019a1234-5678-7000-8000-123456789abc';
const options: CodexRunnerOptions = {
    executable: 'C:\\Tools\\Codex\\codex.exe', workingDirectory: 'D:\\code', sandbox: 'workspace-write', timeoutMs: 1_000
};

class FakeProcess extends EventEmitter {
    pid = 12345;
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    writes: AppServerMessage[] = [];
    exitOnEof = true;
    kills: unknown[] = [];
    constructor() {
        super();
        let input = '';
        this.stdin.on('data', chunk => {
            input += String(chunk);
            let index: number;
            while ((index = input.indexOf('\n')) >= 0) {
                const message = JSON.parse(input.slice(0, index));
                input = input.slice(index + 1);
                this.writes.push(message);
                if (message.method === 'initialize') queueMicrotask(() => this.reply(message.id, { userAgent: 'test' }));
            }
        });
        this.stdin.on('finish', () => { if (this.exitOnEof) queueMicrotask(() => this.emit('close', 0)); });
    }
    reply(id: string | number, result: unknown): void { this.stdout.write(`${JSON.stringify({ id, result })}\n`); }
    kill(signal: unknown): boolean { this.kills.push(signal); queueMicrotask(() => this.emit('close', null)); return true; }
    asChild(): ChildProcessWithoutNullStreams { return this as unknown as ChildProcessWithoutNullStreams; }
}

async function setup(platform: NodeJS.Platform = 'linux') {
    const child = new FakeProcess();
    const calls: { executable: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
    const client = await AppServerClient.connect(options, { platform, spawnProcess: (executable, args, settings) => {
        calls.push({ executable, args, options: settings });
        if (calls.length === 1) return child.asChild();
        const killer = new FakeProcess();
        queueMicrotask(() => child.emit('close', 0));
        return killer.asChild();
    } });
    return { child, client, calls };
}

function safe(error: unknown, code: string): boolean {
    assert.ok(error instanceof AppServerError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('SECRET'), false);
    return true;
}

test('app-server uses private stdio with sanitized task attribution and explicit initialization', async () => {
    const { child, client, calls } = await setup();
    assert.deepEqual(calls[0].args, ['app-server', '--listen', 'stdio://', '--config', 'approval_policy="never"', '--config', 'sandbox_mode="workspace-write"']);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.cwd, 'D:\\code');
    assert.equal(calls[0].options.env?.CODEX_THREAD_ID, undefined);
    assert.equal(calls[0].options.env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
    assert.equal(child.writes[0].params.clientInfo.name, 'weixin_codex_bridge');
    assert.equal(child.writes[0].params.capabilities.experimentalApi, true);
    assert.deepEqual(child.writes[1], { method: 'initialized', params: {} });
    await client.close();
});

test('stdio parser handles fragmented UTF-8 and multiple response and notification lines', async () => {
    const { child, client } = await setup();
    const notifications: AppServerMessage[] = [];
    const remove = client.onNotification(message => notifications.push(message));
    client.onNotification(() => { throw new Error('SECRET callback'); });
    const first = client.request('read', {});
    const second = client.request('other', {});
    const bytes = Buffer.from([
        { method: 'event', params: { text: '你好 🐱' } },
        { id: child.writes[3].id, result: { other: true } },
        { id: child.writes[2].id, result: { text: '完成' } }
    ].map(value => JSON.stringify(value)).join('\r\n') + '\n');
    for (let i = 0; i < bytes.length; i += 3) child.stdout.write(bytes.subarray(i, i + 3));
    assert.deepEqual(await first, { text: '完成' });
    assert.deepEqual(await second, { other: true });
    assert.deepEqual(notifications, [{ method: 'event', params: { text: '你好 🐱' } }]);
    remove();
    await client.close();
});

test('RPC errors preserve numeric code and only explicit active-writer conflicts become session busy', async () => {
    for (const [message, expected] of [
        [`SECRET thread-store conflict: thread ${THREAD} already has an active writer`, 'session_busy'],
        [`thread ${THREAD} already has an active writer`, 'session_busy'],
        [`Error: thread/resume failed: thread ${THREAD} already has an active writer`, 'session_busy'],
        ['SECRET active writer error', 'process_failed'],
        ['SECRET thread-store conflict: thread invalid already has an active writer', 'process_failed'],
        [`SECRET thread ${THREAD} already has no active writer`, 'process_failed'],
        [`SECRET thread ${THREAD} already has an active writers`, 'process_failed'],
        [`SECRET thread-store conflict: thread ${THREAD} already has an active writers`, 'process_failed']
    ]) {
        const { child, client } = await setup();
        const pending = client.request('thread/resume', {});
        child.stderr.write('SECRET token');
        child.stdout.write(`${JSON.stringify({ id: child.writes.at(-1)!.id, error: { code: -32000, message, data: 'SECRET key' } })}\n`);
        await assert.rejects(pending, error => {
            safe(error, expected);
            assert.equal((error as AppServerError).rpcCode, -32000);
            return true;
        });
        await client.close();
    }
});

test('server requests can be replied to and unsupported requests receive a fixed error', async () => {
    const { child, client } = await setup();
    child.stdout.write(`${JSON.stringify({ id: 'server-1', method: 'unknown', params: { secret: 'SECRET' } })}\n`);
    assert.equal(child.writes.at(-1)!.error.code, -32601);
    assert.equal(JSON.stringify(child.writes.at(-1)).includes('SECRET'), false);
    const remove = client.onRequest(message => client.respond(message.id, { decision: 'decline' }));
    child.stdout.write(`${JSON.stringify({ id: 'server-2', method: 'item/commandExecution/requestApproval', params: {} })}\n`);
    assert.deepEqual(child.writes.at(-1), { id: 'server-2', result: { decision: 'decline' } });
    remove();
    await client.close();
});

test('request timeout never retransmits and safely ignores late responses', async () => {
    const { child, client } = await setup();
    const pending = client.request('turn/start', {}, { timeoutMs: 5 });
    await assert.rejects(pending, error => safe(error, 'timeout'));
    assert.equal(child.writes.length, 3);
    child.reply(child.writes[2].id, { late: true });
    assert.equal(child.writes.length, 3);
    await client.close();
});

test('malformed stdout and process errors reject pending work without leaking diagnostics', async () => {
    for (const cause of ['protocol', 'process', 'stderr'] as const) {
        const { child, client } = await setup();
        let disconnected = 0;
        client.onDisconnect(() => { disconnected += 1; });
        const pending = client.request('read', {});
        const checked = assert.rejects(pending, error => safe(error, cause === 'protocol' ? 'invalid_output' : 'spawn_failed'));
        if (cause === 'protocol') child.stdout.write('SECRET malformed response\n');
        else if (cause === 'stderr') child.stderr.emit('error', new Error('SECRET pipe data'));
        else child.emit('error', new Error('SECRET executable path'));
        await checked;
        await client.close();
        assert.equal(disconnected, 1);
        assert.equal(child.stdout.listenerCount('data'), 0);
    }
});

test('oversized and invalid outbound requests remain safe', async () => {
    const { child, client } = await setup();
    const value: Record<string, unknown> = {}; value.self = value;
    await assert.rejects(client.request('test', value), error => safe(error, 'invalid_output'));
    await assert.rejects(client.request('test', {}, { timeoutMs: 0 }), error => safe(error, 'invalid_output'));
    assert.equal(child.writes.length, 2);
    const pending = client.request('read', {});
    child.stdout.write('x'.repeat(32 * 1024 * 1024 + 1));
    await assert.rejects(pending, error => safe(error, 'invalid_output'));
    await client.close();
});

test('close rejects pending requests and Windows fallback only terminates the private child tree', async () => {
    const { child, client, calls } = await setup('win32');
    child.exitOnEof = false;
    const pending = client.request('read', {});
    const checked = assert.rejects(pending, error => safe(error, 'process_failed'));
    await client.close();
    await checked;
    assert.equal(calls.length, 2);
    assert.ok(calls[1].executable.endsWith('\\System32\\taskkill.exe'));
    assert.deepEqual(calls[1].args, ['/PID', '12345', '/T', '/F']);
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].options.windowsHide, true);
    await client.close();
    assert.equal(calls.length, 2);
});
