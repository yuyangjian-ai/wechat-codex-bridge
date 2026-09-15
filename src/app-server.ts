import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { win32 } from 'node:path';
import { CodexRunError, type CodexRunnerOptions, type CodexErrorCode } from './codex.js';

export type AppServerMessage = Record<string, any>;
export type AppServerRequestId = string | number;
type SpawnProcess = (executable: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface AppServerRuntime {
    spawnProcess?: SpawnProcess;
    platform?: NodeJS.Platform;
}

const MAX_MESSAGE_CHARS = 32 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
// RPC errors can omit the stderr-only "thread-store conflict:" prefix.
// Require the complete thread UUID and active-writer diagnostic in either form.
const ACTIVE_WRITER_ERROR = /\bthread [a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12} already has an active writer(?:[.\s]|$)/i;

export class AppServerError extends CodexRunError {
    constructor(code: CodexErrorCode, message: string, public readonly rpcCode?: number) {
        super(code, message);
        this.name = 'AppServerError';
    }
}

function record(value: unknown): AppServerMessage | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AppServerMessage : undefined;
}

function safeNotify<T>(listeners: Set<(value: T) => void>, value: T): void {
    for (const listener of [...listeners]) {
        try { listener(value); } catch { /* Callbacks own reporting; never disclose their errors. */ }
    }
}

/** A private stdio app-server process. No desktop process is signaled or terminated. */
export class AppServerClient {
    private nextId = 1;
    private closed = false;
    private processExited = false;
    private lineBuffer = '';
    private closePromise: Promise<void> | undefined;
    private resolveClose: (() => void) | undefined;
    private gracefulTimer: NodeJS.Timeout | undefined;
    private forceTimer: NodeJS.Timeout | undefined;
    private readonly pending = new Map<AppServerRequestId, {
        resolve: (result: any) => void;
        reject: (error: AppServerError) => void;
        timer: NodeJS.Timeout;
    }>();
    private readonly notifications = new Set<(message: AppServerMessage) => void>();
    private readonly requests = new Set<(message: AppServerMessage) => void>();
    private readonly disconnects = new Set<(error: AppServerError) => void>();

    private constructor(
        private readonly child: ChildProcessWithoutNullStreams,
        private readonly spawnProcess: SpawnProcess,
        private readonly platform: NodeJS.Platform
    ) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', this.onData);
        child.stdout.on('error', this.onProcessError);
        // Keep stderr flowing without retaining or logging credential-bearing diagnostics.
        child.stderr.resume();
        child.stderr.on('error', this.onProcessError);
        child.stdin.on('error', this.onProcessError);
        child.on('error', this.onProcessError);
        child.on('close', this.onProcessClose);
    }

    static async connect(options: CodexRunnerOptions, runtime: AppServerRuntime = {}): Promise<AppServerClient> {
        if (!options.executable || !options.workingDirectory || !['read-only', 'workspace-write'].includes(options.sandbox)) {
            throw new AppServerError('spawn_failed', 'Codex 程序路径、目录或权限配置无效。');
        }
        const environment = { ...process.env };
        delete environment.CODEX_THREAD_ID;
        delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
        const spawnProcess = runtime.spawnProcess ?? ((executable, args, settings) => spawn(executable, args, settings));
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawnProcess(options.executable, [
                'app-server', '--listen', 'stdio://',
                '--config', 'approval_policy="never"',
                '--config', `sandbox_mode="${options.sandbox}"`
            ], { cwd: options.workingDirectory, shell: false, windowsHide: true, env: environment });
        } catch {
            throw new AppServerError('spawn_failed', '无法启动本机 Codex 服务，请检查程序路径和运行权限。');
        }
        const client = new AppServerClient(child, spawnProcess, runtime.platform ?? process.platform);
        try {
            await client.request('initialize', {
                clientInfo: { name: 'weixin_codex_bridge', title: 'WeChat Codex Bridge', version: '0.1.0' },
                capabilities: { experimentalApi: true, requestAttestation: false }
            });
            client.notify('initialized', {});
            return client;
        } catch (error) {
            await client.close();
            if (error instanceof CodexRunError) throw error;
            throw new AppServerError('process_failed', 'Codex 服务初始化失败。');
        }
    }

    request(method: string, params: unknown, options: { timeoutMs?: number } = {}): Promise<any> {
        const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
            return Promise.reject(new AppServerError('invalid_output', 'Codex 请求超时参数无效。'));
        }
        if (this.closed) return Promise.reject(new AppServerError('process_failed', 'Codex 服务连接已关闭。'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new AppServerError('timeout', '等待 Codex 服务响应超时；请求不会自动重发。'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try { this.send({ id, method, params }); }
            catch (error) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(error);
            }
        });
    }

    notify(method: string, params: unknown): void {
        this.send({ method, params });
    }

    respond(id: AppServerRequestId, result: unknown): void {
        this.send({ id, result });
    }

    respondError(id: AppServerRequestId, code = -32601): void {
        this.send({ id, error: { code, message: 'This interaction is unavailable through the WeChat bridge.' } });
    }

    onNotification(listener: (message: AppServerMessage) => void): () => void {
        if (!this.closed) this.notifications.add(listener);
        return () => { this.notifications.delete(listener); };
    }

    onRequest(listener: (message: AppServerMessage) => void): () => void {
        if (!this.closed) this.requests.add(listener);
        return () => { this.requests.delete(listener); };
    }

    onDisconnect(listener: (error: AppServerError) => void): () => void {
        if (!this.closed) this.disconnects.add(listener);
        return () => { this.disconnects.delete(listener); };
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closePromise = new Promise((resolve) => { this.resolveClose = resolve; });
        this.disconnect(new AppServerError('process_failed', 'Codex 服务连接已关闭。'));
        if (this.processExited) {
            this.resolveClose?.();
            return this.closePromise;
        }
        // EOF lets app-server persist and release its own thread writer first.
        this.gracefulTimer = setTimeout(() => this.killOwnedTree(), 500);
        this.forceTimer = setTimeout(() => {
            try { this.child.kill('SIGKILL'); } catch { /* Only our child may be killed. */ }
            this.resolveClose?.();
        }, 5_000);
        try { this.child.stdin.end(); } catch { this.killOwnedTree(); }
        return this.closePromise;
    }

    private send(message: AppServerMessage): void {
        if (this.closed) throw new AppServerError('process_failed', 'Codex 服务连接已关闭。');
        let serialized: string;
        try {
            serialized = JSON.stringify(message);
            if (serialized.length > MAX_MESSAGE_CHARS) throw new Error();
        } catch {
            throw new AppServerError('invalid_output', 'Codex 请求无法编码或超出大小限制。');
        }
        try { this.child.stdin.write(`${serialized}\n`, 'utf8'); }
        catch {
            const error = new AppServerError('process_failed', '无法向 Codex 服务提交请求。');
            this.disconnect(error);
            void this.close();
            throw error;
        }
    }

    private readonly onData = (chunk: string): void => {
        if (this.closed) return;
        let offset = 0;
        while (offset < chunk.length && !this.closed) {
            const newline = chunk.indexOf('\n', offset);
            const end = newline < 0 ? chunk.length : newline;
            if (this.lineBuffer.length + end - offset > MAX_MESSAGE_CHARS) {
                this.invalidProtocol();
                return;
            }
            this.lineBuffer += chunk.slice(offset, end);
            if (newline < 0) return;
            const line = this.lineBuffer;
            this.lineBuffer = '';
            offset = newline + 1;
            if (!line.trim()) continue;
            let message: AppServerMessage | undefined;
            try { message = record(JSON.parse(line)); } catch { /* Use a fixed protocol error. */ }
            if (!message) { this.invalidProtocol(); return; }
            this.handleMessage(message);
        }
    };

    private handleMessage(message: AppServerMessage): void {
        const hasId = typeof message.id === 'string' || typeof message.id === 'number';
        if (typeof message.method === 'string') {
            if (hasId) {
                if (this.requests.size) safeNotify(this.requests, message);
                else { try { this.respondError(message.id); } catch { /* Disconnect reports transport errors. */ } }
            } else safeNotify(this.notifications, message);
            return;
        }
        if (!hasId) { this.invalidProtocol(); return; }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        const rpcError = record(message.error);
        if (rpcError) {
            const busy = typeof rpcError.message === 'string' && ACTIVE_WRITER_ERROR.test(rpcError.message);
            pending.reject(new AppServerError(busy ? 'session_busy' : 'process_failed', busy
                ? '该 Codex 会话正在被其他进程占用，请稍后重试。'
                : 'Codex 服务未能完成请求，请在本机查看任务状态。', Number.isSafeInteger(rpcError.code) ? rpcError.code : undefined));
        } else if ('result' in message) pending.resolve(message.result);
        else pending.reject(new AppServerError('invalid_output', 'Codex 服务响应格式无效。'));
    }

    private invalidProtocol(): void {
        this.disconnect(new AppServerError('invalid_output', 'Codex 服务响应格式无效或超出大小限制。'));
        void this.close();
    }

    private readonly onProcessError = (): void => {
        this.disconnect(new AppServerError('spawn_failed', 'Codex 本机服务异常退出或无法启动。'));
        void this.close();
    };

    private readonly onProcessClose = (): void => {
        this.processExited = true;
        clearTimeout(this.gracefulTimer);
        clearTimeout(this.forceTimer);
        this.disconnect(new AppServerError('process_failed', 'Codex 本机服务已退出。'));
        this.resolveClose?.();
    };

    private disconnect(error: AppServerError): void {
        if (this.closed) return;
        this.closed = true;
        this.lineBuffer = '';
        this.child.stdout.removeListener('data', this.onData);
        this.child.stdout.resume();
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        safeNotify(this.disconnects, error);
        this.notifications.clear();
        this.requests.clear();
        this.disconnects.clear();
    }

    private killOwnedTree(): void {
        if (this.processExited) return;
        const pid = this.child.pid;
        const killChild = () => { try { this.child.kill('SIGKILL'); } catch { /* A process may have already exited. */ } };
        if (this.platform !== 'win32' || !Number.isSafeInteger(pid) || !pid || pid <= 0) { killChild(); return; }
        try {
            const killer = this.spawnProcess(win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
                ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true });
            killer.stdout.resume();
            killer.stderr.resume();
            killer.stdin.end();
            killer.on('error', killChild);
            killer.on('close', (code) => { if (code !== 0 && !this.processExited) killChild(); });
        } catch { killChild(); }
    }
}
