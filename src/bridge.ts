import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { type Config } from './config.js';
import { type StoredWeixinAccount } from './accounts.js';
import { CodexRunError, type CodexRunInput, type CodexRunResult } from './codex.js';
import { StateStore, type Conversation, type Job } from './state.js';
import { WeixinApiError, type PollResult } from './weixin.js';
import type { PreparedInput } from './prepare-input.js';

export interface AccountClient {
    poll(cursor: string, signal?: AbortSignal): Promise<PollResult>;
    sendText(userId: string, contextToken: string, text: string, clientId: string): Promise<void>;
    sendImage?(userId: string, contextToken: string, imagePath: string, clientId: string): Promise<void>;
}
export interface AccountContext {
    account: StoredWeixinAccount;
    store: StateStore;
    client: AccountClient;
    phase: 'connecting' | 'running' | 'reconnecting' | 'login_required';
    lastPollAt?: string;
    lastReceiveDelayMs?: number;
    lastSendDurationMs?: number;
}
export interface BridgeServices {
    runtime: string;
    signal: AbortSignal;
    loadAccounts(): StoredWeixinAccount[];
    createClient(account: StoredWeixinAccount): AccountClient;
    prepareInput?(context: AccountContext, job: Job, signal: AbortSignal): Promise<PreparedInput>;
    prepare(context: AccountContext, conversation: Conversation): Promise<void>;
    run(context: AccountContext, input: CodexRunInput): Promise<CodexRunResult>;
    log(message: string): void;
    status(value: Record<string, unknown>): void;
    accountRefreshMs?: number;
    now?: () => number;
    messageMergeWindowMs?: number;
}

/** Accounts receive and reply independently; one shared worker serializes local file operations. */
export async function runBridge(config: Config, services: BridgeServices): Promise<void> {
    const shutdown = new AbortController();
    const contexts = new Map<string, AccountContext>();
    const tasks: Promise<void>[] = [];
    let failure: unknown;
    let current: { context: AccountContext; job: Job; controller: AbortController } | undefined;
    const stop = () => { shutdown.abort(); current?.controller.abort(); };
    services.signal.addEventListener('abort', stop, { once: true });
    if (services.signal.aborted) stop();
    const sleep = (ms: number) => delay(ms, undefined, { signal: shutdown.signal }).catch(() => {});
    const log = services.log;
    const now = services.now ?? Date.now;
    const publish = () => {
        const accounts = [...contexts.values()].map(context => ({
            id: context.account.id, label: context.account.label, state: context.phase,
            lastPollAt: context.lastPollAt, lastReceiveDelayMs: context.lastReceiveDelayMs,
            lastSendDurationMs: context.lastSendDurationMs,
            pendingJobs: context.store.data.jobs.filter(job => job.status === 'queued').length
        }));
        const state = shutdown.signal.aborted ? 'stopped'
            : accounts.some(account => account.state === 'running') ? 'running'
            : accounts.length && accounts.every(account => account.state === 'login_required') ? 'login_required' : 'connecting';
        services.status({ state, accountCount: accounts.length, accounts,
            lastPollAt: accounts.map(account => account.lastPollAt).filter(Boolean).sort().at(-1),
            currentJobId: current?.job.id, currentAccountId: current?.context.account.id,
            pendingJobs: accounts.reduce((count, account) => count + account.pendingJobs, 0), accessControlEnabled: config.accessControl.enabled });
    };
    const spawn = (task: Promise<void>) => {
        // Observe immediately; adding accounts later must not create an unhandled rejection.
        tasks.push(task.catch(error => { failure ??= error; stop(); }));
    };
    const poller = async (context: AccountContext) => {
        let failures = 0;
        while (!shutdown.signal.aborted) {
            if (context.phase === 'login_required') { await sleep(500); continue; }
            let result: PollResult;
            const polledClient = context.client;
            try { result = await polledClient.poll(context.store.data.cursor, shutdown.signal); }
            catch (error) {
                if (shutdown.signal.aborted) break;
                if (polledClient !== context.client) continue;
                if (error instanceof WeixinApiError && (error.errcode === -14 || error.ret === -14 || error.httpStatus === 401 || error.httpStatus === 403)) {
                    context.phase = 'login_required';
                    log(`账号 ${context.account.id} 登录失效；其他账号继续运行。`); publish(); continue;
                }
                failures++; context.phase = 'reconnecting';
                log(`账号 ${context.account.id} 正在重连（第 ${failures} 次）。`); publish();
                await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5))); continue;
            }
            if (polledClient !== context.client) continue;
            const receivedAt = Date.now();
            // Persist messages/cursor before exposing new work to either worker or sender.
            const cancelledUsers = context.store.acceptBatch(result.msgs, result.get_updates_buf, config,
                { now: now(), mergeWindowMs: services.messageMergeWindowMs });
            if (current?.context === context && cancelledUsers.includes(current.job.userId)) current.controller.abort();
            if (result.msgs.length) {
                const times = result.msgs.filter(message => message.message_type === 1).map(message => message.create_time_ms).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
                context.lastReceiveDelayMs = times.length ? Math.round(receivedAt - Math.max(...times)) : undefined;
                log(`账号 ${context.account.id} 接收 ${result.msgs.length} 条消息；消息时间距接收 ${context.lastReceiveDelayMs ?? '未知'} ms（含时钟差）。`);
            }
            failures = 0; context.phase = 'running'; context.lastPollAt = new Date().toISOString(); publish();
        }
    };
    const sender = async (context: AccountContext) => {
        while (!shutdown.signal.aborted) {
            if (context.phase === 'login_required') { await sleep(500); continue; }
            const entry = context.store.data.outbox.find(value => value.status === 'pending');
            if (!entry) { await sleep(100); continue; }
            const token = context.store.data.conversations[entry.userId]?.contextToken;
            if (!token) { entry.status = 'failed'; context.store.save(); continue; }
            const queuedMs = Date.now() - Date.parse(entry.createdAt);
            entry.status = 'sending'; context.store.save();
            const started = performance.now();
            try {
                if (entry.kind === 'image') {
                    if (!entry.imagePath || !context.client.sendImage) throw new Error('Image sender unavailable');
                    await context.client.sendImage(entry.userId, token, entry.imagePath, entry.id);
                } else await context.client.sendText(entry.userId, token, entry.text, entry.id);
                entry.status = 'sent'; entry.text = '';
                context.lastSendDurationMs = Math.round(performance.now() - started);
                log(`回复 ${entry.id} 已发送；队列等待 ${queuedMs} ms；接口耗时 ${context.lastSendDurationMs} ms。`);
            } catch {
                entry.status = 'failed';
                log(`回复 ${entry.id} 发送未确认；结果已保存，不自动重复发送。`);
                if (entry.kind === 'image') context.store.reply(entry.userId, '图片发送未确认，原图已保留。可以发送 /result 再取一次，或在 Codex 原任务中查看。');
            }
            context.store.save(); publish();
        }
    };
    const refresh = () => {
        for (const account of services.loadAccounts()) {
            const existing = contexts.get(account.id);
            if (existing) {
                if (existing.account.updatedAt !== account.updatedAt) {
                    existing.account = account; existing.client = services.createClient(account); existing.phase = 'connecting';
                    log(`账号 ${account.id} 登录资料已刷新。`);
                }
                continue;
            }
            const store = new StateStore(path.join(services.runtime, `state-${account.id}.json`), account.credentials.botId);
            store.recoverInterrupted();
            const context: AccountContext = { account, store, client: services.createClient(account), phase: 'connecting' };
            contexts.set(account.id, context);
            spawn(poller(context)); spawn(sender(context));
            log(`账号 ${account.id} 已接入。`);
        }
        publish();
    };
    const worker = async () => {
        while (!shutdown.signal.aborted) {
            const readyTime = now();
            const candidates = [...contexts.values()].flatMap(context => {
                const waitingUsers = new Set<string>();
                return context.store.data.jobs.filter(job => {
                    if (job.status !== 'queued' || waitingUsers.has(job.userId)) return false;
                    // A later message may not overtake the same sender's pending image/text group.
                    waitingUsers.add(job.userId);
                    return job.readyAt === undefined || job.readyAt <= readyTime;
                }).map(job => ({ context, job }));
            });
            candidates.sort((a, b) => a.job.createdAt.localeCompare(b.job.createdAt));
            const candidate = candidates[0];
            if (!candidate) { await sleep(100); continue; }
            const { context, job } = candidate;
            const conversation = context.store.data.conversations[job.userId];
            const controller = new AbortController();
            current = { context, job, controller };
            job.status = 'running'; context.store.save(); publish();
            log(`账号 ${context.account.id} 任务 ${job.id} 开始执行。`);
            try {
                const checkCancelled = () => { if (controller.signal.aborted) throw new CodexRunError('aborted', '任务已停止。'); };
                checkCancelled();
                if (job.attachments?.length) {
                    if (!services.prepareInput) throw new CodexRunError('invalid_output', '本机附件处理尚未就绪，请稍后重试。');
                    const prepared = await services.prepareInput(context, job, controller.signal);
                    checkCancelled();
                    job.prompt = prepared.prompt; job.inputImages = prepared.images; delete job.attachments;
                    context.store.save();
                }
                await services.prepare(context, conversation);
                checkCancelled();
                if (job.inputImages?.length) log(`任务 ${job.id} 向 Codex 提交 ${job.inputImages.length} 张图片。`);
                const result = await services.run(context, { prompt: job.prompt, images: job.inputImages, threadId: conversation.threadId, signal: controller.signal,
                    onThreadId: id => { conversation.threadId = id; context.store.save(); } });
                conversation.threadId = result.threadId;
                job.status = 'done'; job.result = result.text; job.images = result.images;
                context.store.reply(job.userId, result.text);
                for (const image of result.images ?? []) context.store.replyImage(job.userId, image.path);
                log(`任务 ${job.id} 已完成。`);
            } catch (error) {
                const cancelled = controller.signal.aborted;
                job.status = cancelled ? 'cancelled' : 'failed';
                const reason = error instanceof CodexRunError ? error.message : '任务执行遇到问题，请在本机查看。';
                job.result = cancelled ? `${reason}\n已完成的修改不会自动撤销。` : `任务未完成：${reason}`;
                context.store.reply(job.userId, job.result); log(`任务 ${job.id} ${cancelled ? '已停止' : '失败'}。`);
            } finally {
                job.prompt = ''; delete job.attachments; job.finishedAt = new Date().toISOString(); current = undefined;
                context.store.save(); publish();
            }
        }
    };
    try {
        refresh(); spawn(worker());
        while (!shutdown.signal.aborted) { await sleep(services.accountRefreshMs ?? 2000); if (!shutdown.signal.aborted) refresh(); }
    } finally {
        stop(); await Promise.all(tasks);
        services.signal.removeEventListener('abort', stop);
        publish();
    }
    if (failure) throw failure;
}
