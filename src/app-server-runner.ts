import { randomUUID } from 'node:crypto';
import { AppServerClient, type AppServerMessage, type AppServerRuntime, type AppServerRequestId } from './app-server.js';
import { CodexRunError, type CodexRunInput, type CodexRunResult, type CodexRunnerOptions } from './codex.js';
import { collectGeneratedImages, withGeneratedImages, type GeneratedMediaCollection } from './generated-media.js';
import { buildCodexInput } from './codex-input.js';

export interface AppServerConnection {
    request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<any>;
    onNotification(listener: (message: AppServerMessage) => void): () => void;
    onRequest(listener: (message: AppServerMessage) => void): () => void;
    onDisconnect(listener: (error: CodexRunError) => void): () => void;
    respond(id: AppServerRequestId, result: unknown): void;
    respondError(id: AppServerRequestId, code?: number): void;
    close(): Promise<void> | void;
}

export type OnThreadReady = (threadId: string, client: AppServerConnection) => Promise<void> | void;

export interface AppServerRunnerRuntime extends AppServerRuntime {
    connect?: (options: CodexRunnerOptions) => Promise<AppServerConnection>;
    onThreadReady?: OnThreadReady;
    collectImages?: (client: AppServerConnection, threadId: string, turnId: string) => Promise<GeneratedMediaCollection>;
}

export interface AppServerRunInput extends CodexRunInput {
    onThreadReady?: OnThreadReady;
}

const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_REPLY_CHARS = 1024 * 1024;
const PROGRESS: Record<string, string> = {
    reasoning: '正在分析任务…', commandExecution: '正在执行本机命令…',
    fileChange: '正在修改文件…', mcpToolCall: '正在调用工具…', webSearch: '正在查询网页…'
};

function finalText(item: any): string | undefined {
    if (item?.type !== 'agentMessage' || (item.phase != null && item.phase !== 'final_answer') || typeof item.text !== 'string' || !item.text.trim()) return;
    if (item.text.length > MAX_REPLY_CHARS) throw new CodexRunError('invalid_output', 'Codex 返回的文字结果超出大小限制，请在桌面查看。');
    return item.text;
}

/** One invocation owns one app-server process and submits at most one model turn. */
export class AppServerRunner {
    constructor(private readonly options: CodexRunnerOptions, private readonly runtime: AppServerRunnerRuntime = {}) {}

    async run(input: AppServerRunInput): Promise<CodexRunResult> {
        if (input.signal?.aborted) throw new CodexRunError('aborted', '任务已停止。');
        if (input.threadId !== undefined && !ID.test(input.threadId)) {
            throw new CodexRunError('invalid_output', '任务内容或原会话标识无效。');
        }
        if (!Number.isSafeInteger(this.options.timeoutMs) || this.options.timeoutMs <= 0 || this.options.timeoutMs > 2_147_483_647) {
            throw new CodexRunError('invalid_output', '任务超时配置无效。');
        }
        const nativeInput = await buildCodexInput(input);
        if (input.signal?.aborted) throw new CodexRunError('aborted', '任务已停止。');
        let client: AppServerConnection;
        try { client = await (this.runtime.connect?.(this.options) ?? AppServerClient.connect(this.options, this.runtime)); }
        catch (error) {
            if (error instanceof CodexRunError) throw error;
            throw new CodexRunError('spawn_failed', '无法连接本机 Codex 服务。');
        }
        const cleanup: Array<() => void> = [];
        let threadId: string | undefined;
        let turnId: string | undefined;
        let submitted = false;
        let settled = false;
        let stopRequested = false;
        let lastProgress = '';
        const completed = new Map<string, any>();
        const messages = new Map<string, string>();
        let resolveResult!: (result: CodexRunResult) => void;
        let rejectResult!: (error: CodexRunError) => void;
        const result = new Promise<CodexRunResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
        void result.catch(() => {});
        const fail = (error: CodexRunError) => {
            if (!settled) { settled = true; rejectResult(error); }
        };
        const safeError = (error: unknown): CodexRunError => error instanceof CodexRunError ? error
            : new CodexRunError('process_failed', 'Codex 本机任务未能完成，请在桌面查看任务状态。');
        const stop = async (error: CodexRunError) => {
            if (settled || stopRequested) return;
            stopRequested = true;
            if (submitted && threadId && turnId) {
                try { await client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 }); }
                catch { /* Closing this invocation's child is the bounded fallback. */ }
            }
            fail(error);
        };
        const progress = (text: string) => {
            if (text === lastProgress || settled || stopRequested) return;
            lastProgress = text;
            try { input.onProgress?.(text); } catch { /* Progress is optional. */ }
        };
        const examine = () => {
            if (!turnId || !threadId || settled || stopRequested) return;
            const turn = completed.get(turnId);
            if (!turn) return;
            if (turn.status !== 'completed') {
                fail(new CodexRunError('turn_failed', 'Codex 未能完成本次任务，请在桌面查看详情。'));
                return;
            }
            const text = turn.text ?? messages.get(turnId);
            settled = true;
            resolveResult({ threadId, text: text ?? '' });
        };
        try {
            cleanup.push(client.onDisconnect(error => fail(safeError(error))));
            cleanup.push(client.onNotification(message => {
                try {
                    if (!submitted || settled || message.params?.threadId !== threadId) return;
                    const params = message.params;
                    const eventTurnId = params.turn?.id ?? params.turnId;
                    if (typeof eventTurnId !== 'string' || !ID.test(eventTurnId) || (turnId && eventTurnId !== turnId)) return;
                    if (message.method === 'item/completed') {
                        const text = finalText(params.item);
                        if (text && (messages.has(eventTurnId) || messages.size < 16)) messages.set(eventTurnId, text);
                    } else if (message.method === 'turn/completed') {
                        let text: string | undefined;
                        if (Array.isArray(params.turn?.items)) {
                            for (const item of params.turn.items) text = finalText(item) ?? text;
                        }
                        if (completed.has(eventTurnId) || completed.size < 16) completed.set(eventTurnId, { status: params.turn?.status, text });
                    } else if (message.method === 'item/started' && turnId === eventTurnId && PROGRESS[params.item?.type]) {
                        progress(PROGRESS[params.item.type]);
                    }
                    examine();
                } catch (error) { fail(safeError(error)); }
            }));
            cleanup.push(client.onRequest(message => {
                try {
                    // Never grant approvals, including requests unexpectedly routed here.
                    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
                        client.respond(message.id, { decision: 'decline' }); return;
                    }
                    if (message.method === 'item/permissions/requestApproval') {
                        client.respond(message.id, { permissions: {}, scope: 'turn' }); return;
                    }
                    if (message.method === 'execCommandApproval' || message.method === 'applyPatchApproval') {
                        client.respond(message.id, { decision: 'abort' }); return;
                    }
                    const sameTask = submitted && message.params?.threadId === threadId
                        && (message.params?.turnId == null || !turnId || message.params.turnId === turnId);
                    if (message.method === 'mcpServer/elicitation/request') {
                        client.respond(message.id, { action: 'decline', content: null, _meta: null });
                    } else client.respondError(message.id);
                    if (sameTask && ['item/tool/requestUserInput', 'mcpServer/elicitation/request'].includes(message.method)) {
                        void stop(new CodexRunError('turn_failed', '本次任务需要你在 Codex 桌面交互确认，微信执行已请求停止；请打开原任务继续。'));
                    }
                } catch (error) { fail(safeError(error)); }
            }));
            const abort = () => { void stop(new CodexRunError('aborted', '任务已请求停止。')); };
            input.signal?.addEventListener('abort', abort, { once: true });
            cleanup.push(() => input.signal?.removeEventListener('abort', abort));
            const timer = setTimeout(() => {
                void stop(new CodexRunError('timeout', '任务执行超时，已请求停止本次 Codex 执行。'));
            }, this.options.timeoutMs);
            cleanup.push(() => clearTimeout(timer));
            if (input.signal?.aborted) abort();
            const race = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, result.then(() => {
                throw new CodexRunError('process_failed', 'Codex 任务在准备阶段意外结束。');
            })]);
            const parameters: Record<string, unknown> = {
                cwd: this.options.workingDirectory, sandbox: this.options.sandbox,
                approvalPolicy: 'never', approvalsReviewer: 'user'
            };
            if (this.options.model) parameters.model = this.options.model;
            if (settled) return await result;
            const response = await race(client.request(input.threadId ? 'thread/resume' : 'thread/start', {
                ...parameters,
                ...(input.threadId ? { threadId: input.threadId, excludeTurns: true } : { ephemeral: false, threadSource: 'weixin' })
            }));
            const selectedId = response?.thread?.id;
            if (typeof selectedId !== 'string' || !ID.test(selectedId) || (input.threadId && selectedId !== input.threadId)) {
                throw new CodexRunError('invalid_output', 'Codex 返回的会话标识无效。');
            }
            threadId = selectedId;
            if (response.thread.status?.type === 'active' || (response.thread.turns ?? []).some((turn: any) => turn.status === 'inProgress')) {
                throw new CodexRunError('session_busy', '原会话正在执行其他任务，请等它完成后再发送微信消息。');
            }
            // Persistence failures must prevent turn/start: otherwise the next message
            // could silently create a second task and repeat side effects.
            try { input.onThreadId?.(threadId); }
            catch { throw new CodexRunError('process_failed', '无法保存微信会话关联，任务尚未提交。'); }
            const ready = input.onThreadReady ?? this.runtime.onThreadReady;
            if (ready) await race(Promise.resolve().then(() => ready(threadId!, client)));
            if (input.signal?.aborted) abort();
            if (settled || stopRequested) return await result;
            submitted = true;
            progress('Codex 正在处理任务…');
            const sandboxPolicy = this.options.sandbox === 'read-only'
                ? { type: 'readOnly', networkAccess: false }
                : { type: 'workspaceWrite', writableRoots: [this.options.workingDirectory], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
            const turnResponse = await race(client.request('turn/start', {
                threadId, clientUserMessageId: randomUUID(),
                input: nativeInput,
                cwd: this.options.workingDirectory, approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy,
                ...(this.options.model ? { model: this.options.model } : {})
            }));
            if (typeof turnResponse?.turn?.id !== 'string' || !ID.test(turnResponse.turn.id)) {
                throw new CodexRunError('invalid_output', 'Codex 未返回有效的任务编号，请在桌面查看原任务。');
            }
            turnId = turnResponse.turn.id;
            if (input.signal?.aborted) abort();
            examine();
            const completedResult = await result;
            return await withGeneratedImages(completedResult, () => this.runtime.collectImages
                ? this.runtime.collectImages(client, threadId!, turnId!)
                : collectGeneratedImages(client, threadId!, turnId!));
        } catch (error) {
            fail(safeError(error));
            throw safeError(error);
        } finally {
            settled = true;
            for (const dispose of cleanup) dispose();
            messages.clear(); completed.clear();
            await client.close();
        }
    }
}
