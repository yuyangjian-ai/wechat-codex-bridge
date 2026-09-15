import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { test } from 'node:test';
import { DesktopIpcClient, DesktopIpcError, type DesktopIpcMessage } from '../src/desktop-ipc.js';

function frame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    return Buffer.concat([header, body]);
}

class FakeSocket extends EventEmitter {
    writes: DesktopIpcMessage[] = [];
    destroyed = false;
    autoInitialize = true;
    initializeResult: unknown = { clientId: 'bridge-client' };

    write(bytes: Buffer): boolean {
        assert.equal(bytes.readUInt32LE(0), bytes.length - 4);
        const message = JSON.parse(bytes.subarray(4).toString('utf8')) as DesktopIpcMessage;
        this.writes.push(message);
        if (this.autoInitialize && message.type === 'request' && message.method === 'initialize') {
            queueMicrotask(() => this.emit('data', frame({ type: 'response', requestId: message.requestId, resultType: 'success', result: this.initializeResult })));
        }
        return true;
    }

    destroy(): this {
        if (!this.destroyed) {
            this.destroyed = true;
            queueMicrotask(() => this.emit('close'));
        }
        return this;
    }

    reply(request: DesktopIpcMessage, result: unknown, resultType = 'success'): void {
        this.emit('data', frame({ type: 'response', requestId: request.requestId, resultType, result }));
    }

    asSocket(): Socket { return this as unknown as Socket; }
}

async function setup(socket = new FakeSocket()) {
    let observedPath = '';
    const pending = DesktopIpcClient.connect({ socketFactory: (path) => {
        observedPath = path;
        queueMicrotask(() => socket.emit('connect'));
        return socket.asSocket();
    }, timeoutMs: 1_000 });
    const client = await pending;
    return { client, socket, observedPath };
}

function safeError(error: unknown, code: string): boolean {
    assert.ok(error instanceof DesktopIpcError);
    assert.equal(error.code, code);
    assert.equal(error.cause, undefined);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('SECRET'), false);
    return true;
}

test('connect initializes the local pipe with protocol version zero and assigns source client id', async () => {
    const { client, socket, observedPath } = await setup();
    assert.equal(observedPath, '\\\\.\\pipe\\codex-ipc');
    assert.equal(client.clientId, 'bridge-client');
    const initialize = socket.writes[0];
    assert.match(initialize.requestId, /^[a-f\d-]{36}$/);
    assert.deepEqual(initialize, {
        type: 'request', requestId: initialize.requestId, sourceClientId: 'initializing-client',
        version: 0, method: 'initialize', params: { clientType: 'weixin-bridge' }, timeoutMs: 1_000
    });
    const pending = client.request('test', 3, { text: '你好' }, { targetClientId: 'desktop-owner', timeoutMs: 2_000 });
    const request = socket.writes[1];
    assert.deepEqual(request, {
        type: 'request', requestId: request.requestId, sourceClientId: 'bridge-client',
        version: 3, method: 'test', params: { text: '你好' }, timeoutMs: 2_000, targetClientId: 'desktop-owner'
    });
    assert.notEqual(initialize.requestId, request.requestId);
    assert.equal('hostId' in request, false);
    socket.reply(request, { ok: true });
    assert.deepEqual(await pending, { type: 'response', requestId: request.requestId, resultType: 'success', result: { ok: true } });
    client.close();
});

test('fragmented headers, UTF-8 bodies and multiple frames preserve requests and broadcasts', async () => {
    const { client, socket } = await setup();
    const observed: DesktopIpcMessage[] = [];
    client.onBroadcast(() => { throw new Error('SECRET observer'); });
    const unsubscribe = client.onBroadcast((message) => observed.push(message));
    const pending = client.request('test', 0, {});
    const request = socket.writes.at(-1)!;
    const broadcast = { type: 'broadcast', method: 'update', version: 0, params: { text: '你好 🐱' } };
    const response = { type: 'response', requestId: request.requestId, resultType: 'success', result: { text: '完成' } };
    const bytes = Buffer.concat([frame(broadcast), frame(response), frame(broadcast)]);
    for (let offset = 0; offset < bytes.length; offset += 3) socket.emit('data', bytes.subarray(offset, offset + 3));
    assert.deepEqual(await pending, response);
    assert.deepEqual(observed, [broadcast, broadcast]);
    unsubscribe();
    socket.emit('data', Buffer.concat([frame(broadcast), frame(broadcast)]));
    assert.equal(observed.length, 2);
    client.close();
});

test('error result envelopes are returned intact and never converted to raw exceptions', async () => {
    const { client, socket } = await setup();
    const pending = client.request('test', 0, {});
    const request = socket.writes.at(-1)!;
    socket.reply(request, { message: 'SECRET application detail' }, 'error');
    assert.deepEqual(await pending, {
        type: 'response', requestId: request.requestId, resultType: 'error', result: { message: 'SECRET application detail' }
    });
    client.close();
});

test('broadcast targeting and discovery replies follow their distinct frame shapes', async () => {
    const { client, socket } = await setup();
    client.broadcast('update', 1, { value: 2 }, ['desktop-owner']);
    assert.deepEqual(socket.writes.at(-1), {
        type: 'broadcast', sourceClientId: 'bridge-client', version: 1,
        method: 'update', params: { value: 2 }, targetClientIds: ['desktop-owner']
    });
    client.broadcast('untargeted', 0, {});
    assert.equal('targetClientIds' in socket.writes.at(-1)!, false);
    socket.emit('data', frame({ type: 'client-discovery-request', requestId: 'discovery-1', method: 'thread-owner' }));
    assert.deepEqual(socket.writes.at(-1), {
        type: 'client-discovery-response', requestId: 'discovery-1', response: { canHandle: false }
    });
    client.close();
});

test('request timeout does not retry and ignores late responses', async () => {
    const { client, socket } = await setup();
    const pending = client.request('test', 0, {}, { timeoutMs: 5 });
    await assert.rejects(pending, (error) => safeError(error, 'timeout'));
    assert.equal(socket.writes.length, 2);
    socket.reply(socket.writes[1], { late: true });
    assert.equal(socket.writes.length, 2);
    client.close();
});

test('disconnect rejects all pending requests, emits once and cleans transport listeners', async () => {
    const { client, socket } = await setup();
    let disconnected = 0;
    client.onDisconnect(() => { disconnected += 1; });
    const remove = client.onDisconnect(() => { throw new Error('must not be called'); });
    remove();
    const first = client.request('one', 0, {});
    const second = client.request('two', 0, {});
    const checks = [assert.rejects(first, (error) => safeError(error, 'disconnected')), assert.rejects(second, (error) => safeError(error, 'disconnected'))];
    socket.emit('error', new Error('SECRET socket configuration'));
    await Promise.all(checks);
    client.close();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assert.equal(disconnected, 1);
    assert.equal(socket.destroyed, true);
    for (const event of ['data', 'connect', 'error', 'end', 'close']) assert.equal(socket.listenerCount(event), 0);
    await assert.rejects(client.request('test', 0, {}), (error) => safeError(error, 'disconnected'));
    assert.throws(() => client.broadcast('test', 0, {}), (error) => safeError(error, 'disconnected'));
});

test('a socket close event also removes listeners without waiting for another close', async () => {
    const { client, socket } = await setup();
    const pending = client.request('test', 0, {});
    socket.emit('close');
    await assert.rejects(pending, (error) => safeError(error, 'disconnected'));
    for (const event of ['data', 'connect', 'error', 'end', 'close']) assert.equal(socket.listenerCount(event), 0);
});

test('malformed and over-limit input disconnects safely before allocating oversized frames', async () => {
    for (const kind of ['oversized', 'zero', 'malformed', 'nonobject', 'missing-request-id'] as const) {
        const { client, socket } = await setup();
        const pending = client.request('test', 0, {});
        let bytes: Buffer;
        if (kind === 'oversized' || kind === 'zero') {
            bytes = Buffer.alloc(4);
            bytes.writeUInt32LE(kind === 'oversized' ? 32 * 1024 * 1024 + 1 : 0);
        } else if (kind === 'malformed') {
            bytes = Buffer.concat([Buffer.from([6, 0, 0, 0]), Buffer.from('SECRET')]);
        } else {
            bytes = frame(kind === 'nonobject' ? 'SECRET' : { type: 'response', result: 'SECRET' });
        }
        socket.emit('data', bytes);
        await assert.rejects(pending, (error) => safeError(error, 'invalid_response'));
        assert.equal(socket.destroyed, true);
    }
});

test('invalid outbound values are rejected without retrying or disconnecting a healthy socket', async () => {
    const { client, socket } = await setup();
    const circular: Record<string, unknown> = {};
    circular.secret = circular;
    await assert.rejects(client.request('test', 0, circular), (error) => safeError(error, 'invalid_request'));
    await assert.rejects(client.request('test', 0, { text: 'x'.repeat(32 * 1024 * 1024) }), (error) => safeError(error, 'invalid_request'));
    await assert.rejects(client.request('test', 0, {}, { timeoutMs: -1 }), (error) => safeError(error, 'invalid_request'));
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.destroyed, false);
    client.close();
});

test('connection and initialization failures are safe and dispose their sockets', async () => {
    await assert.rejects(DesktopIpcClient.connect({ socketFactory: () => { throw new Error('SECRET pipe path'); } }), (error) => safeError(error, 'connection_failed'));
    const socket = new FakeSocket();
    const pending = DesktopIpcClient.connect({ socketFactory: () => socket.asSocket(), timeoutMs: 5 });
    await assert.rejects(pending, (error) => safeError(error, 'timeout'));
    assert.equal(socket.destroyed, true);
    const invalid = new FakeSocket();
    invalid.initializeResult = { error: 'SECRET initialization error' };
    await assert.rejects(setup(invalid), (error) => safeError(error, 'invalid_response'));
    assert.equal(invalid.destroyed, true);
    const unresponsive = new FakeSocket();
    unresponsive.autoInitialize = false;
    const handshake = DesktopIpcClient.connect({ socketFactory: () => {
        queueMicrotask(() => unresponsive.emit('connect'));
        return unresponsive.asSocket();
    }, timeoutMs: 5 });
    await assert.rejects(handshake, (error) => safeError(error, 'timeout'));
    assert.equal(unresponsive.destroyed, true);
});
