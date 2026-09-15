import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { homedir } from 'node:os';
import { DesktopIpcClient } from './desktop-ipc.js';
import { CodexRunError, type CodexRunInput, type CodexRunResult, type CodexRunnerOptions } from './codex.js';
import { AppServerClient } from './app-server.js';
import { collectGeneratedImages, withGeneratedImages, type GeneratedMediaCollection } from './generated-media.js';
import { buildCodexInput } from './codex-input.js';

export interface DesktopCodexRunnerRuntime {
    collectImages?: (threadId: string, turnId: string) => Promise<GeneratedMediaCollection>;
}

type ObjectValue = Record<string, any>;

export interface DesktopConnection {
    clientId: string;
    request(method: string, version: number, params: unknown, options?: { targetClientId?: string; timeoutMs?: number }): Promise<any>;
    broadcast(method: string, version: number, params: unknown, targetClientIds?: string[]): void;
    onBroadcast(listener: (message: any) => void): () => void;
    onDisconnect(listener: () => void): () => void;
    close(): void;
}

/** Desktop IPC is version-specific; fail closed if its verified snapshot contract changes. */
export function snapshotTurns(state: ObjectValue): ObjectValue[] {
    const byId = new Map<string, ObjectValue>();
    const history = state.turnHistory?.kind === 'canonical' ? state.turnHistory.history : undefined;
    for (const island of history?.islands ?? []) {
        for (const entry of island.entries ?? []) {
            const turn = history.entitiesByKey?.[entry.value];
            if (typeof turn?.turnId === 'string') byId.set(turn.turnId, turn);
        }
    }
    for (const turn of state.turns ?? []) {
        if (typeof turn?.turnId === 'string') byId.set(turn.turnId, turn);
    }
    return [...byId.values()];
}

export function desktopWorkspaceMatch(state: ObjectValue, options: CodexRunnerOptions): boolean {
    const settings = state.latestThreadSettings;
    const cwd = settings?.cwd ?? state.cwd;
    const workdir = win32.resolve(options.workingDirectory).toLowerCase();
    const sameDirectory = (value: unknown) => typeof value === 'string' && win32.resolve(value).toLowerCase() === workdir;
    // The desktop adds a per-thread visualization output folder to workspace-write.
    const allowedRoot = (value: unknown) => {
        if (sameDirectory(value)) return true;
        if (typeof value !== 'string' || typeof state.id !== 'string') return false;
        const relative = win32.relative(win32.join(homedir(), '.codex', 'visualizations'), win32.resolve(value));
        return /^\d{4}\\\d{2}\\\d{2}\\[a-f\d-]+$/i.test(relative) && win32.basename(relative) === state.id;
    };
    const roots = [settings?.sandboxPolicy?.writableRoots, state.currentPermissions?.runtimeWorkspaceRoots,
        ...(state.environments ?? []).map((environment: ObjectValue) => environment.runtimeWorkspaceRoots)];
    return typeof cwd === 'string'
        && sameDirectory(cwd) && sameDirectory(state.cwd)
        && (state.environments ?? []).every((environment: ObjectValue) => sameDirectory(environment.cwd))
        && roots.every(values => values == null || (Array.isArray(values) && values.every(allowedRoot)));
}

/** Check effective permissions after submission; old desktop preferences are not input permissions. */
export function desktopSettingsMatch(state: ObjectValue, options: CodexRunnerOptions): boolean {
    const settings = state.latestThreadSettings;
    const policy = settings?.sandboxPolicy;
    const expected = options.sandbox === 'workspace-write' ? 'workspaceWrite' : 'readOnly';
    return desktopWorkspaceMatch(state, options)
        && settings?.approvalPolicy === 'never'
        && settings?.approvalsReviewer === 'user'
        && policy?.type === expected
        && policy?.networkAccess === false
        && settings?.activePermissionProfile == null;
}

function bridgeSandboxPolicy(options: CodexRunnerOptions): ObjectValue {
    return options.sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false }
        : { type: 'workspaceWrite', writableRoots: [options.workingDirectory], networkAccess: false,
            excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

export class DesktopCodexRunner {
    constructor(
        private readonly options: CodexRunnerOptions,
        private readonly connect: () => Promise<DesktopConnection> = () => DesktopIpcClient.connect(),
        private readonly runtime: DesktopCodexRunnerRuntime = {}
    ) {}

    async run(input: CodexRunInput): Promise<CodexRunResult> {
        if (input.signal?.aborted) throw new CodexRunError('aborted', '任务已停止。');
        if (!input.threadId || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(input.threadId)) {
            throw new CodexRunError('invalid_output', '桌面续聊需要有效的原会话和任务内容。');
        }
        const nativeInput = await buildCodexInput(input);
        if (input.signal?.aborted) throw new CodexRunError('aborted', '任务已停止。');
        const threadId = input.threadId;
        let ipc: DesktopConnection;
        try { ipc = await this.connect(); }
        catch { throw new CodexRunError('session_busy', '原会话被桌面端占用，但暂时无法连接桌面 Codex。请打开 Codex 后重试。'); }
        let owner: string | undefined;
        let following = false;
        const cleanup: Array<() => void> = [];
        const follow = () => ipc.broadcast('thread-stream-following-changed', 1,
            { hostId: 'local', conversationId: threadId, following: true }, [owner!]);
        try {
            const discovery = await ipc.request('thread-owner-discovery', 1,
                { hostId: 'local', conversationId: threadId }, { timeoutMs: 10000 });
            if (discovery.resultType !== 'success' || typeof discovery.handledByClientId !== 'string') {
                throw new CodexRunError('session_busy', '暂时找不到原会话的桌面执行进程，请在 Codex 打开原任务后重试。');
            }
            owner = discovery.handledByClientId;
            const clientUserMessageId = randomUUID();
            let state: ObjectValue | undefined;
            let turnId: string | undefined;
            let submitted = false;
            let submissionSettled = false;
            let finished = false;
            let stopping = false;
            let pendingStop: 'aborted' | 'timeout' | undefined;
            let stopRecoveryTimer: NodeJS.Timeout | undefined;
            cleanup.push(() => { if (stopRecoveryTimer) clearTimeout(stopRecoveryTimer); });
            let initialResolve: (value: ObjectValue) => void;
            let initialReject: (error: Error) => void;
            const initial = new Promise<ObjectValue>((resolve, reject) => { initialResolve = resolve; initialReject = reject; });
            void initial.catch(() => {});
            const initialTimer = setTimeout(() => initialReject(new CodexRunError('session_busy', '读取桌面会话状态超时，请稍后重试。')), 10000);
            cleanup.push(() => clearTimeout(initialTimer));
            let resolveResult: (value: CodexRunResult) => void;
            let rejectResult: (error: Error) => void;
            const result = new Promise<CodexRunResult>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
            // A disconnect can precede the await below; keep the rejection observed.
            void result.catch(() => {});
            const fail = (error: CodexRunError) => { if (!finished) { finished = true; rejectResult(error); } };
            const interrupt = async (code: 'aborted' | 'timeout') => {
                if (finished || stopping) return;
                if (!turnId) {
                    pendingStop = code;
                    if (!stopRecoveryTimer) {
                        try { follow(); } catch { /* A lost submission cannot be safely repeated. */ }
                        stopRecoveryTimer = setTimeout(() => fail(new CodexRunError(code,
                            '未能确认桌面任务编号，无法确认停止；任务可能仍在执行，请在 Codex 查看原任务。')), 10000);
                    }
                    return;
                }
                stopping = true;
                if (stopRecoveryTimer) clearTimeout(stopRecoveryTimer);
                let interrupted = false;
                if (turnId) {
                    try {
                        const response = await ipc.request('thread-follower-interrupt-turn', 4,
                            { conversationId: threadId, mode: 'user-stop', expectedTurnId: turnId },
                            { targetClientId: owner, timeoutMs: 5000 });
                        interrupted = response.resultType === 'success';
                    } catch { /* Never interrupt another turn or kill the desktop process. */ }
                }
                fail(new CodexRunError(code, !interrupted ? '停止请求未确认，任务可能仍在执行，请在 Codex 查看原任务。'
                    : code === 'aborted' ? '已请求停止，请在 Codex 确认任务的最终状态。' : '等待桌面任务超时，已请求停止；请在 Codex 查看任务状态。'));
            };
            const examine = () => {
                if (!submitted || !state || finished) return;
                const turns = snapshotTurns(state);
                const own = turns.find(turn => turn.params?.clientUserMessageId === clientUserMessageId)
                    ?? (turnId ? turns.find(turn => turn.turnId === turnId) : undefined);
                if (!own) return;
                turnId = own.turnId;
                if (pendingStop || input.signal?.aborted) { void interrupt(pendingStop ?? 'aborted'); return; }
                if (own.status === 'inProgress') return;
                if (own.status === 'completed') {
                    const messages = (own.items ?? []).filter((item: ObjectValue) => item.type === 'agentMessage'
                        && (item.phase == null || item.phase === 'final_answer') && typeof item.text === 'string' && item.text.trim());
                    const text = messages.at(-1)?.text;
                    if (text && text.length > 1024 * 1024) {
                        fail(new CodexRunError('invalid_output', '桌面任务已完成，但未取得完整文字结果；请在 Codex 查看。'));
                    } else { finished = true; resolveResult({ threadId, text: text ?? '' }); }
                } else if (own.status === 'failed' || own.status === 'interrupted' || own.status === 'cancelled') {
                    fail(new CodexRunError('turn_failed', '桌面 Codex 任务未完成，请在原任务中查看详情。'));
                }
            };
            cleanup.push(ipc.onBroadcast(message => {
                if (message.sourceClientId !== owner || message.method !== 'thread-stream-state-changed' || message.version !== 11
                    || message.params?.hostId !== 'local' || message.params?.conversationId !== threadId
                    || message.params?.change?.type !== 'snapshot') return;
                const incoming = message.params.change.conversationState;
                if (!incoming || incoming.id !== threadId) return;
                state = incoming;
                clearTimeout(initialTimer);
                initialResolve(incoming);
                examine();
            }));
            cleanup.push(ipc.onDisconnect(() => {
                const error = new CodexRunError('process_failed', submitted
                    ? '与桌面 Codex 的连接中断，任务可能仍在执行。请先查看原任务，避免重复提交。'
                    : '与桌面 Codex 的连接中断，请稍后重试。');
                initialReject(error); fail(error);
            }));
            const abort = () => {
                if (!submitted) {
                    const error = new CodexRunError('aborted', '任务已停止。');
                    initialReject(error); fail(error);
                } else if (turnId || submissionSettled) { void interrupt('aborted'); }
            };
            input.signal?.addEventListener('abort', abort, { once: true });
            cleanup.push(() => input.signal?.removeEventListener('abort', abort));
            following = true; follow();
            const initialState = await initial;
            if (input.signal?.aborted) throw new CodexRunError('aborted', '任务已停止。');
            if (!desktopWorkspaceMatch(initialState, this.options)) {
                throw new CodexRunError('session_busy', '桌面会话的工作目录与微信配置不一致，请在 Codex 检查原任务目录后重试。');
            }
            if (initialState.threadRuntimeStatus?.type === 'active' || snapshotTurns(initialState).some(turn => turn.status === 'inProgress')) {
                throw new CodexRunError('session_busy', '原会话正在桌面执行其他任务，请等它完成后再发送微信消息。');
            }
            const taskTimer = setTimeout(() => { void interrupt('timeout'); }, this.options.timeoutMs);
            cleanup.push(() => clearTimeout(taskTimer));
            submitted = true;
            // Submit exactly once. A timeout may mean the owner accepted the turn already.
            void ipc.request('thread-follower-start-turn', 2, {
                conversationId: threadId,
                turnStart: {
                    request: {
                        threadId, clientUserMessageId,
                        input: nativeInput,
                        cwd: this.options.workingDirectory,
                        approvalPolicy: 'never',
                        approvalsReviewer: 'user',
                        permissions: null,
                        // Explicit overrides clear an inherited permission profile. Only
                        // non-permission thread preferences (model, effort, etc.) are inherited.
                        sandboxPolicy: bridgeSandboxPolicy(this.options)
                    },
                    context: { inheritThreadSettings: true, useAppServerPermissionDefault: false, usePermissionSelection: false }
                }
            }, { targetClientId: owner, timeoutMs: 10000 }).then(response => {
                const id = response.resultType === 'success' ? response.result?.result?.turn?.id : undefined;
                if (typeof id === 'string') turnId = id;
            }).catch(() => { /* Recover only by clientUserMessageId; never retry a submission. */ }).finally(() => {
                submissionSettled = true;
                if (finished) return;
                examine();
                if (finished) return;
                if (pendingStop || input.signal?.aborted) { void interrupt(pendingStop ?? 'aborted'); return; }
                try { follow(); } catch { /* onDisconnect handles failed transport. */ }
                if (!turnId) {
                    const recoveryTimer = setTimeout(() => {
                        if (!turnId) fail(new CodexRunError('process_failed', '桌面任务提交结果未确认，请先查看原任务，避免重复提交。'));
                    }, 10000);
                    cleanup.push(() => clearTimeout(recoveryTimer));
                }
            }).catch(() => fail(new CodexRunError('invalid_output', '桌面会话状态无法解析，请在 Codex 查看原任务。')));
            const completedResult = await result;
            return await withGeneratedImages(completedResult, async () => {
                if (this.runtime.collectImages) return this.runtime.collectImages(threadId, turnId!);
                const mediaClient = await AppServerClient.connect(this.options);
                try { return await collectGeneratedImages(mediaClient, threadId, turnId!); }
                finally { await mediaClient.close(); }
            });
        } catch (error) {
            if (error instanceof CodexRunError) throw error;
            throw new CodexRunError('process_failed', '桌面续聊暂时不可用，请在 Codex 查看原任务状态。');
        } finally {
            if (following && owner) {
                try { ipc.broadcast('thread-stream-following-changed', 1,
                    { hostId: 'local', conversationId: threadId, following: false }, [owner]); } catch { /* Best effort unsubscribe. */ }
            }
            for (const dispose of cleanup) dispose();
            ipc.close();
        }
    }
}
