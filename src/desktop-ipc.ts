import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

const PIPE_PATH = '\\\\.\\pipe\\codex-ipc';
const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export interface DesktopIpcConnectOptions {
    /** The factory starts connecting; injection is intended for protocol tests. */
    socketFactory?: (path: string) => Socket;
    timeoutMs?: number;
}

export interface DesktopIpcRequestOptions {
    targetClientId?: string;
    timeoutMs?: number;
}

export type DesktopIpcMessage = Record<string, any>;

type ErrorCode = 'connection_failed' | 'disconnected' | 'timeout' | 'invalid_response' | 'invalid_request';

export class DesktopIpcError extends Error {
    constructor(public readonly code: ErrorCode, message: string) {
        super(message);
        this.name = 'DesktopIpcError';
    }
}

function validTimeout(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

function object(value: unknown): DesktopIpcMessage | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as DesktopIpcMessage
        : undefined;
}

function safeNotify<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
        try { listener(value); } catch { /* Observers cannot corrupt the transport. */ }
    }
}

/** Local desktop transport. It never logs frames, retries requests, or exposes raw socket errors. */
export class DesktopIpcClient {
    private sourceClientId = 'initializing-client';
    private connected = false;
    private closed = false;
    private header = Buffer.alloc(4);
    private headerBytes = 0;
    private frame: Buffer | undefined;
    private frameBytes = 0;
    private readonly pending = new Map<string, {
        resolve: (value: DesktopIpcMessage) => void;
        reject: (error: DesktopIpcError) => void;
        timer: NodeJS.Timeout;
    }>();
    private readonly broadcasts = new Set<(message: DesktopIpcMessage) => void>();
    private readonly disconnects = new Set<() => void>();

    private constructor(private readonly socket: Socket) {
        socket.on('data', this.onData);
        socket.on('error', this.onSocketError);
        socket.on('end', this.onSocketEnd);
        socket.on('close', this.onSocketClose);
    }

    static async connect(options: DesktopIpcConnectOptions = {}): Promise<DesktopIpcClient> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!validTimeout(timeoutMs)) {
            throw new DesktopIpcError('invalid_request', 'Codex 桌面连接参数无效。');
        }
        let socket: Socket;
        try {
            socket = (options.socketFactory ?? createConnection)(PIPE_PATH);
        } catch {
            throw new DesktopIpcError('connection_failed', '无法连接 Codex 桌面程序。');
        }
        const client = new DesktopIpcClient(socket);
        try {
            await new Promise<void>((resolve, reject) => {
                const cleanup = (): void => {
                    clearTimeout(timer);
                    socket.removeListener('connect', onConnect);
                    client.disconnects.delete(onDisconnect);
                };
                const onConnect = (): void => {
                    cleanup();
                    client.connected = true;
                    resolve();
                };
                const onDisconnect = (): void => {
                    cleanup();
                    reject(new DesktopIpcError('connection_failed', '无法连接 Codex 桌面程序。'));
                };
                const timer = setTimeout(() => {
                    cleanup();
                    reject(new DesktopIpcError('timeout', '连接 Codex 桌面程序超时。'));
                }, timeoutMs);
                socket.once('connect', onConnect);
                client.disconnects.add(onDisconnect);
            });
            const response = await client.request('initialize', 0, { clientType: 'weixin-bridge' }, { timeoutMs });
            const result = object(response.result);
            if (response.resultType === 'error' || typeof result?.clientId !== 'string' || !result.clientId) {
                throw new DesktopIpcError('invalid_response', 'Codex 桌面连接初始化失败。');
            }
            client.sourceClientId = result.clientId;
            return client;
        } catch (error) {
            client.close();
            if (error instanceof DesktopIpcError) throw error;
            throw new DesktopIpcError('connection_failed', '无法连接 Codex 桌面程序。');
        }
    }

    get clientId(): string {
        return this.sourceClientId;
    }

    request(method: string, version: number, params: unknown, options: DesktopIpcRequestOptions = {}): Promise<DesktopIpcMessage> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!validTimeout(timeoutMs)) {
            return Promise.reject(new DesktopIpcError('invalid_request', 'Codex 桌面请求参数无效。'));
        }
        if (this.closed || !this.connected) {
            return Promise.reject(new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'));
        }
        const requestId = randomUUID();
        const message: DesktopIpcMessage = {
            type: 'request', requestId, sourceClientId: this.sourceClientId,
            version, method, params, timeoutMs
        };
        if (options.targetClientId !== undefined) message.targetClientId = options.targetClientId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new DesktopIpcError('timeout', 'Codex 桌面请求超时。'));
            }, timeoutMs);
            this.pending.set(requestId, { resolve, reject, timer });
            try {
                this.send(message);
            } catch (error) {
                this.pending.delete(requestId);
                clearTimeout(timer);
                reject(error instanceof DesktopIpcError ? error : new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'));
            }
        });
    }

    broadcast(method: string, version: number, params: unknown, targetClientIds?: string[]): void {
        const message: DesktopIpcMessage = {
            type: 'broadcast', sourceClientId: this.sourceClientId, version, method, params
        };
        if (targetClientIds !== undefined) message.targetClientIds = targetClientIds;
        this.send(message);
    }

    onBroadcast(listener: (message: DesktopIpcMessage) => void): () => void {
        if (!this.closed) this.broadcasts.add(listener);
        return () => { this.broadcasts.delete(listener); };
    }

    onDisconnect(listener: () => void): () => void {
        if (!this.closed) this.disconnects.add(listener);
        return () => { this.disconnects.delete(listener); };
    }

    close(): void {
        this.shutdown(new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'));
    }

    private send(message: DesktopIpcMessage): void {
        if (this.closed || !this.connected) throw new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。');
        let body: Buffer;
        try {
            const serialized = JSON.stringify(message);
            if (Buffer.byteLength(serialized, 'utf8') > MAX_FRAME_BYTES) throw new Error();
            body = Buffer.from(serialized, 'utf8');
        } catch {
            throw new DesktopIpcError('invalid_request', 'Codex 桌面请求无法编码或超出大小限制。');
        }
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32LE(body.length, 0);
        try {
            this.socket.write(Buffer.concat([header, body]));
        } catch {
            const error = new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。');
            this.shutdown(error);
            throw error;
        }
    }

    private readonly onData = (chunk: Buffer): void => {
        if (this.closed) return;
        let offset = 0;
        while (offset < chunk.length && !this.closed) {
            if (!this.frame) {
                const bytes = Math.min(4 - this.headerBytes, chunk.length - offset);
                chunk.copy(this.header, this.headerBytes, offset, offset + bytes);
                this.headerBytes += bytes;
                offset += bytes;
                if (this.headerBytes < 4) continue;
                const size = this.header.readUInt32LE(0);
                this.headerBytes = 0;
                if (size === 0 || size > MAX_FRAME_BYTES) {
                    this.shutdown(new DesktopIpcError('invalid_response', 'Codex 桌面响应格式无效。'));
                    return;
                }
                this.frame = Buffer.allocUnsafe(size);
                this.frameBytes = 0;
            }
            const bytes = Math.min(this.frame.length - this.frameBytes, chunk.length - offset);
            chunk.copy(this.frame, this.frameBytes, offset, offset + bytes);
            this.frameBytes += bytes;
            offset += bytes;
            if (this.frameBytes !== this.frame.length) continue;
            let message: DesktopIpcMessage | undefined;
            try { message = object(JSON.parse(this.frame.toString('utf8'))); } catch { /* Report a fixed protocol error. */ }
            this.frame = undefined;
            this.frameBytes = 0;
            if (!message || typeof message.type !== 'string') {
                this.shutdown(new DesktopIpcError('invalid_response', 'Codex 桌面响应格式无效。'));
                return;
            }
            this.handleMessage(message);
        }
    };

    private handleMessage(message: DesktopIpcMessage): void {
        if (message.type === 'response') {
            if (typeof message.requestId !== 'string') {
                this.shutdown(new DesktopIpcError('invalid_response', 'Codex 桌面响应格式无效。'));
                return;
            }
            const pending = this.pending.get(message.requestId);
            if (!pending) return;
            this.pending.delete(message.requestId);
            clearTimeout(pending.timer);
            pending.resolve(message);
        } else if (message.type === 'broadcast') {
            safeNotify(this.broadcasts, message);
        } else if (message.type === 'client-discovery-request') {
            if (typeof message.requestId !== 'string') {
                this.shutdown(new DesktopIpcError('invalid_response', 'Codex 桌面响应格式无效。'));
                return;
            }
            try {
                this.send({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
            } catch {
                this.shutdown(new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'));
            }
        }
    }

    private readonly onSocketError = (): void => {
        this.shutdown(new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'));
    };

    private readonly onSocketClose = (): void => {
        this.shutdown(new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'), true);
    };

    private readonly onSocketEnd = (): void => {
        this.shutdown(new DesktopIpcError('disconnected', 'Codex 桌面连接已断开。'));
    };

    private shutdown(error: DesktopIpcError, socketClosed = false): void {
        if (this.closed) return;
        this.closed = true;
        this.connected = false;
        this.frame = undefined;
        this.frameBytes = 0;
        this.headerBytes = 0;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.socket.removeListener('data', this.onData);
        this.socket.removeListener('end', this.onSocketEnd);
        this.socket.removeListener('close', this.onSocketClose);
        // Keep the inert error handler through destroy: a late socket error must not
        // become an uncaught exception after callers have closed their connection.
        if (socketClosed) {
            this.socket.removeListener('error', this.onSocketError);
        } else {
            this.socket.once('close', () => { this.socket.removeListener('error', this.onSocketError); });
            try { this.socket.destroy(); } catch { /* The connection is already closed. */ }
        }
        safeNotify(this.disconnects, undefined);
        this.disconnects.clear();
        this.broadcasts.clear();
    }
}
