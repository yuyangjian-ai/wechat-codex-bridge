import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { win32 } from 'node:path';

export interface CodexRunnerOptions {
    executable: string;
    workingDirectory: string;
    sandbox: 'read-only' | 'workspace-write';
    timeoutMs: number;
    model?: string;
}

export interface CodexRunInput {
    prompt: string;
    images?: Array<{ path: string }>;
    threadId?: string;
    signal?: AbortSignal;
    onThreadId?: (id: string) => void;
    onProgress?: (text: string) => void;
}

export interface CodexRunResult {
    threadId: string;
    text: string;
    images?: Array<{ path: string }>;
}

export type CodexErrorCode = 'aborted' | 'timeout' | 'spawn_failed' | 'process_failed' | 'session_busy' | 'turn_failed' | 'invalid_output';

export class CodexRunError extends Error {
    constructor(public readonly code: CodexErrorCode, message: string) {
        super(message);
        this.name = 'CodexRunError';
    }
}

type SpawnProcess = (
    executable: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

/** Runtime injection keeps the CLI protocol testable without making model requests. */
export interface CodexRunnerRuntime {
    spawnProcess?: SpawnProcess;
    platform?: NodeJS.Platform;
}

const THREAD_ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_EVENT_CHARS = 4 * 1024 * 1024;
const MAX_REPLY_CHARS = 1024 * 1024;
const MAX_STDERR_CHARS = 8 * 1024;
const ACTIVE_WRITER_ERROR = /\bthread-store conflict: thread [a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12} already has an active writer(?=[.\s])/i;
const PROGRESS: Record<string, string> = {
    reasoning: '正在分析任务…',
    command_execution: '正在执行本机命令…',
    file_change: '正在修改文件…',
    mcp_tool_call: '正在调用工具…',
    web_search: '正在查询网页…'
};

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function notify<T>(callback: ((value: T) => void) | undefined, value: T): void {
    // Observers must not leave a running child behind if their own logging or persistence fails.
    try {
        callback?.(value);
    } catch {
        // The bridge owns observer error reporting; never disclose callback errors to WeChat.
    }
}

export class CodexRunner {
    private readonly spawnProcess: SpawnProcess;
    private readonly platform: NodeJS.Platform;

    constructor(private readonly options: CodexRunnerOptions, runtime: CodexRunnerRuntime = {}) {
        if (!options.executable || !options.workingDirectory) {
            throw new Error('Codex executable and workingDirectory are required.');
        }
        if (!['read-only', 'workspace-write'].includes(options.sandbox)) {
            throw new Error('Codex sandbox must be read-only or workspace-write.');
        }
        if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) {
            throw new Error('Codex timeoutMs must be a positive timer-safe integer.');
        }
        this.spawnProcess = runtime.spawnProcess ?? ((executable, args, options) => spawn(executable, args, options));
        this.platform = runtime.platform ?? process.platform;
    }

    async run(input: CodexRunInput): Promise<CodexRunResult> {
        if (input.signal?.aborted) {
            throw new CodexRunError('aborted', '任务已停止。');
        }
        if (input.images !== undefined && (!Array.isArray(input.images) || input.images.length > 0)) {
            throw new CodexRunError('invalid_output', '当前命令行执行通道不支持图片，请使用 App Server 或桌面通道。');
        }
        if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
            throw new CodexRunError('invalid_output', '任务内容不能为空。');
        }
        // Only ids emitted by Codex are resumable. Names could be mistaken for CLI options.
        if (input.threadId !== undefined && !THREAD_ID.test(input.threadId)) {
            throw new CodexRunError('invalid_output', '会话标识无效，请新建会话后重试。');
        }

        const args = [
            'exec',
            '--sandbox', this.options.sandbox,
            '--cd', this.options.workingDirectory,
            '--config', 'approval_policy="never"'
        ];
        if (input.threadId) {
            args.push('resume');
        }
        // Resume has its own config options. Set both restrictions again there instead of
        // inheriting the original session's permissions or the user's global defaults.
        args.push(
            '--config', `sandbox_mode="${this.options.sandbox}"`,
            '--config', 'approval_policy="never"',
            '--json',
            '--skip-git-repo-check'
        );
        if (this.options.model) {
            args.push(`--model=${this.options.model}`);
        }
        if (input.threadId) {
            args.push(input.threadId);
        }
        args.push('-');

        const environment = { ...process.env };
        // A CLI started from a Codex tool must create its own task context. Keep auth/proxy
        // variables while removing inherited desktop-task attribution.
        delete environment.CODEX_THREAD_ID;
        delete environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;

        return new Promise<CodexRunResult>((resolve, reject) => {
            let child: ChildProcessWithoutNullStreams;
            try {
                child = this.spawnProcess(this.options.executable, args, {
                    cwd: this.options.workingDirectory,
                    shell: false,
                    windowsHide: true,
                    env: environment
                });
            } catch {
                reject(new CodexRunError('spawn_failed', '无法启动本机 Codex，请检查程序路径和运行权限。'));
                return;
            }

            let settled = false;
            let threadId = input.threadId;
            let finalText = '';
            let lineBuffer = '';
            let droppingOversizedLine = false;
            let protocolFailed = false;
            let turnFailed = false;
            let turnCompleted = false;
            let stopError: CodexRunError | undefined;
            let lastProgress = '';
            let stderrTail = '';
            let sessionBusy = false;
            let terminationTimer: NodeJS.Timeout | undefined;
            let timeout: NodeJS.Timeout | undefined;

            const finish = (error?: CodexRunError): void => {
                if (settled) return;
                settled = true;
                stderrTail = '';
                clearTimeout(timeout);
                clearTimeout(terminationTimer);
                input.signal?.removeEventListener('abort', abort);
                if (error) {
                    reject(error);
                } else {
                    resolve({ threadId: threadId!, text: finalText });
                }
            };

            const progress = (text: string): void => {
                if (lastProgress === text || settled || stopError) return;
                lastProgress = text;
                notify(input.onProgress, text);
            };

            const parseLine = (line: string): void => {
                if (!line.trim() || settled || stopError) return;
                let event: Record<string, unknown> | undefined;
                try {
                    event = record(JSON.parse(line));
                } catch {
                    // stdout must be JSONL. Never echo unexpected CLI output to a chat.
                    protocolFailed = true;
                    return;
                }
                if (!event) return;
                if (event.type === 'thread.started') {
                    if (typeof event.thread_id !== 'string' || !THREAD_ID.test(event.thread_id)) {
                        protocolFailed = true;
                        return;
                    }
                    threadId = event.thread_id;
                    notify(input.onThreadId, threadId);
                } else if (event.type === 'turn.failed' || event.type === 'error') {
                    turnFailed = true;
                } else if (event.type === 'turn.completed') {
                    turnCompleted = true;
                } else if (event.type === 'turn.started') {
                    progress('Codex 正在处理任务…');
                } else if (event.type === 'item.started') {
                    const item = record(event.item);
                    if (item && typeof item.type === 'string' && PROGRESS[item.type]) {
                        progress(PROGRESS[item.type]);
                    }
                } else if (event.type === 'item.completed') {
                    const item = record(event.item);
                    if (item?.type === 'agent_message' && item.phase !== 'commentary' && typeof item.text === 'string') {
                        if (item.text.length > MAX_REPLY_CHARS) {
                            protocolFailed = true;
                            return;
                        }
                        finalText = item.text;
                    }
                }
            };

            const onData = (chunk: string): void => {
                // Process line segments rather than retaining a possibly unbounded command result.
                let offset = 0;
                while (offset < chunk.length) {
                    const newline = chunk.indexOf('\n', offset);
                    const end = newline === -1 ? chunk.length : newline;
                    const segment = chunk.slice(offset, end);
                    if (!droppingOversizedLine) {
                        if (lineBuffer.length + segment.length > MAX_EVENT_CHARS) {
                            droppingOversizedLine = true;
                            lineBuffer = '';
                            protocolFailed = true;
                        } else {
                            lineBuffer += segment;
                        }
                    }
                    if (newline === -1) break;
                    if (!droppingOversizedLine) parseLine(lineBuffer);
                    lineBuffer = '';
                    droppingOversizedLine = false;
                    offset = newline + 1;
                }
            };

            const killChild = (): void => {
                try { child.kill('SIGKILL'); } catch { /* Still report the original safe error. */ }
            };

            const stop = (error: CodexRunError): void => {
                if (settled || stopError) return;
                stopError = error;
                clearTimeout(timeout);
                child.stdin.destroy();
                // Allow process-close to settle first; the bound also covers broken subprocesses.
                terminationTimer = setTimeout(() => {
                    killChild();
                    finish(error);
                }, 5_000);
                const pid = child.pid;
                if (this.platform === 'win32' && pid !== undefined && Number.isSafeInteger(pid) && pid > 0) {
                    try {
                        const killer = this.spawnProcess(
                            win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
                            ['/PID', String(pid), '/T', '/F'],
                            { shell: false, windowsHide: true }
                        );
                        killer.stdout.resume();
                        killer.stderr.resume();
                        killer.stdin.end();
                        killer.on('error', killChild);
                        killer.on('close', (code) => {
                            if (code !== 0 && !settled) killChild();
                        });
                    } catch {
                        killChild();
                    }
                } else {
                    killChild();
                }
            };

            const abort = (): void => stop(new CodexRunError('aborted', '任务已停止。'));

            child.stdout.setEncoding('utf8');
            child.stdout.on('data', onData);
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => {
                if (settled || stopError || sessionBusy) return;
                // Keep only a small in-memory tail for errors split across stream chunks.
                // Never expose stderr through chat, logging, or an Error cause.
                for (let offset = 0; offset < chunk.length; offset += MAX_STDERR_CHARS) {
                    const fragment = stderrTail + chunk.slice(offset, offset + MAX_STDERR_CHARS);
                    if (ACTIVE_WRITER_ERROR.test(fragment)) {
                        sessionBusy = true;
                        stderrTail = '';
                        break;
                    }
                    stderrTail = fragment.slice(-MAX_STDERR_CHARS);
                }
            });
            child.stdin.on('error', () => {
                if (!settled && !stopError) stop(new CodexRunError('process_failed', '无法向 Codex 提交任务，请检查本机运行状态。'));
            });
            child.on('error', () => finish(stopError ?? new CodexRunError('spawn_failed', '无法启动本机 Codex，请检查程序路径和运行权限。')));
            child.on('close', (code) => {
                if (stopError) return finish(stopError);
                if (lineBuffer && !droppingOversizedLine) parseLine(lineBuffer);
                if (code !== 0) {
                    if (sessionBusy || ACTIVE_WRITER_ERROR.test(`${stderrTail}\n`)) {
                        return finish(new CodexRunError('session_busy', '该 Codex 会话正在被其他进程占用，请稍后重试。'));
                    }
                    return finish(new CodexRunError('process_failed', `Codex 执行失败${Number.isInteger(code) ? `（退出码 ${code}）` : ''}，请检查本机登录和配置。`));
                }
                if (turnFailed) return finish(new CodexRunError('turn_failed', 'Codex 未能完成本次任务，请稍后重试或检查本机配置。'));
                if (protocolFailed || !turnCompleted || !threadId || !finalText.trim()) {
                    return finish(new CodexRunError('invalid_output', 'Codex 没有返回完整结果，请检查本机运行状态。'));
                }
                finish();
            });

            timeout = setTimeout(() => stop(new CodexRunError('timeout', '任务执行超时，已请求停止。')), this.options.timeoutMs);
            input.signal?.addEventListener('abort', abort, { once: true });
            // Close the race between checking the signal and attaching its listener.
            if (input.signal?.aborted) {
                abort();
            } else {
                child.stdin.end(input.prompt, 'utf8');
            }
        });
    }
}
