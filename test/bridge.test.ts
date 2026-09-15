import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { runBridge, type AccountClient, type AccountContext, type BridgeServices } from '../src/bridge.js';
import { type StoredWeixinAccount } from '../src/accounts.js';
import { CodexRunError, type CodexRunInput, type CodexRunResult } from '../src/codex.js';
import { type Config } from '../src/config.js';
import { StateStore, type Job } from '../src/state.js';
import { WeixinApiError, type PollResult, type WeixinMessage } from '../src/weixin.js';

const config: Config = {
    workingDirectory: 'D:\\test-workspace',
    codexExecutable: 'C:\\test\\codex.exe',
    sandbox: 'workspace-write',
    taskTimeoutMinutes: 30,
    accessControl: { enabled: false, allowedUserIds: [] }
};

function account(name: string): StoredWeixinAccount {
    const botId = `secret-bot-${name}`;
    return {
        id: createHash('sha256').update(botId).digest('hex').slice(0, 16),
        label: `账号 ${name}`,
        credentials: { botId, token: `secret-token-${name}`, baseUrl: 'https://ilinkai.weixin.qq.com', userId: `secret-owner-${name}` },
        createdAt: '2026-09-15T00:00:00.000Z',
        updatedAt: '2026-09-15T00:00:00.000Z'
    };
}

function message(id: string, prompt: string, contextToken: string, userId = 'secret-shared-sender'): WeixinMessage {
    return {
        message_id: id, from_user_id: userId, context_token: contextToken,
        message_type: 1, message_state: 2, create_time_ms: Date.now() - 1250,
        item_list: [{ type: 1, text_item: { text: prompt } }]
    };
}

class FakeClient implements AccountClient {
    readonly sent: Array<{ userId: string; contextToken: string; text: string; clientId: string; token: string }> = [];
    readonly cursors: string[] = [];
    private readonly inbox: Array<PollResult | Error> = [];
    private waiting?: (value: PollResult | Error) => void;

    constructor(readonly token: string) {}

    push(value: PollResult | Error): void {
        if (this.waiting) this.waiting(value);
        else this.inbox.push(value);
    }

    async poll(cursor: string, signal?: AbortSignal): Promise<PollResult> {
        this.cursors.push(cursor);
        if (signal?.aborted) throw new Error('cancelled');
        const value = this.inbox.shift();
        if (value instanceof Error) throw value;
        if (value) return value;
        return new Promise((resolve, reject) => {
            const onAbort = (): void => {
                this.waiting = undefined;
                signal?.removeEventListener('abort', onAbort);
                reject(new Error('cancelled'));
            };
            this.waiting = next => {
                this.waiting = undefined;
                signal?.removeEventListener('abort', onAbort);
                if (next instanceof Error) reject(next);
                else resolve(next);
            };
            signal?.addEventListener('abort', onAbort, { once: true });
        });
    }

    async sendText(userId: string, contextToken: string, text: string, clientId: string): Promise<void> {
        this.sent.push({ userId, contextToken, text, clientId, token: this.token });
    }
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `Timed out: ${description}`);
        await delay(10);
    }
}

function fixture(t: TestContext, initial: StoredWeixinAccount[], run?: BridgeServices['run'], preparation: Partial<Pick<BridgeServices, 'prepareInput' | 'prepare'>> = {}) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-codex-bridge-test-'));
    const controller = new AbortController();
    const available = [...initial];
    const clients = new Map<string, FakeClient>();
    const created: string[] = [];
    const logs: string[] = [];
    const statuses: Record<string, unknown>[] = [];
    const runs: Array<{ accountId: string; prompt: string; threadId?: string }> = [];
    let completion: Promise<void> | undefined;
    const client = (selected: StoredWeixinAccount): FakeClient => {
        let value = clients.get(selected.id);
        if (!value) { value = new FakeClient(selected.credentials.token); clients.set(selected.id, value); }
        return value;
    };
    const services: BridgeServices = {
        runtime, signal: controller.signal, accountRefreshMs: 10, messageMergeWindowMs: 0,
        loadAccounts: () => [...available],
        createClient: selected => { created.push(selected.id); return client(selected); },
        prepare: async () => {},
        ...preparation,
        run: async (context, input) => {
            runs.push({ accountId: context.account.id, prompt: input.prompt, threadId: input.threadId });
            if (run) return run(context, input);
            return { threadId: `thread-${context.account.id}`, text: `secret-result-${context.account.id}` };
        },
        log: value => { logs.push(value); },
        status: value => { statuses.push(value); }
    };
    const stop = async (): Promise<void> => { controller.abort(); await completion; };
    t.after(async () => {
        try { await stop(); }
        finally {
            // This fixture owns only these files. Do not recursively delete directories.
            for (const name of fs.readdirSync(runtime)) fs.unlinkSync(path.join(runtime, name));
            fs.rmdirSync(runtime);
        }
    });
    return {
        runtime, available, client, created, logs, statuses, runs, stop,
        start: () => {
            assert.equal(completion, undefined);
            completion = runBridge(config, services);
            // The teardown awaits the original promise; observe it immediately too.
            void completion.catch(() => {});
        },
        store: (selected: StoredWeixinAccount) => new StateStore(path.join(runtime, `state-${selected.id}.json`), selected.credentials.botId)
    };
}

test('same sender in different accounts keeps thread, reply context and client credentials isolated; timing logs omit secrets', async t => {
    const first = account('A');
    const second = account('B');
    const harness = fixture(t, [first, second]);
    for (const selected of [first, second]) {
        const store = harness.store(selected);
        store.data.conversations['secret-shared-sender'] = {
            contextToken: 'secret-old-context', threadId: `existing-${selected.id}`, updatedAt: new Date().toISOString()
        };
        store.save();
    }
    harness.client(first).push({ msgs: [message('same-message-id', 'secret-prompt-A', 'secret-context-A')], get_updates_buf: 'cursor-A' });
    harness.client(second).push({ msgs: [message('same-message-id', 'secret-prompt-B', 'secret-context-B')], get_updates_buf: 'cursor-B' });
    harness.start();
    await waitUntil(() => [first, second].every(selected => harness.client(selected).sent.some(reply => reply.text === `secret-result-${selected.id}`)), 'both accounts reply');
    await harness.stop();

    for (const [selected, contextToken, cursor] of [[first, 'secret-context-A', 'cursor-A'], [second, 'secret-context-B', 'cursor-B']] as const) {
        assert.ok(harness.client(selected).sent.every(reply => reply.contextToken === contextToken && reply.token === selected.credentials.token && reply.userId === 'secret-shared-sender'));
        assert.equal(harness.runs.find(run => run.accountId === selected.id)?.threadId, `existing-${selected.id}`);
        const saved = harness.store(selected);
        assert.equal(saved.data.cursor, cursor);
        assert.equal(saved.data.conversations['secret-shared-sender']?.threadId, `thread-${selected.id}`);
        assert.equal(saved.data.jobs.length, 1);
        assert.equal(saved.data.jobs[0]?.status, 'done');
    }
    assert.ok(harness.logs.some(log => /消息时间距接收 \d+ ms/.test(log)));
    assert.ok(harness.logs.some(log => /队列等待 \d+ ms；接口耗时 \d+ ms/.test(log)));
    assert.doesNotMatch(harness.logs.join('\n'), /secret-(?:prompt|token|context|shared|owner|bot|result)/);
    assert.doesNotMatch(JSON.stringify(harness.statuses), /secret-(?:prompt|token|context|shared|owner|bot|result)/);
});

test('one global worker serializes jobs across accounts while both accounts can receive messages', async t => {
    const first = account('A');
    const second = account('B');
    let active = 0;
    let maximumActive = 0;
    const events: string[] = [];
    const harness = fixture(t, [first, second], async (context, input) => {
        active++;
        maximumActive = Math.max(maximumActive, active);
        events.push(`start:${input.prompt}`);
        await delay(30);
        events.push(`finish:${input.prompt}`);
        active--;
        return { threadId: `thread-${context.account.id}`, text: `done:${input.prompt}` };
    });
    harness.client(first).push({ msgs: [message('1', 'A1', 'context-A'), message('2', 'A2', 'context-A')] });
    harness.client(second).push({ msgs: [message('1', 'B1', 'context-B')] });
    harness.start();
    await waitUntil(() => harness.client(first).sent.filter(reply => reply.text.startsWith('done:')).length === 2 && harness.client(second).sent.some(reply => reply.text === 'done:B1'), 'three jobs finish');
    await harness.stop();
    assert.equal(maximumActive, 1);
    assert.equal(events.length, 6);
    for (let index = 0; index < events.length; index += 2) {
        assert.equal(events[index]?.replace('start:', ''), events[index + 1]?.replace('finish:', ''));
    }
    assert.equal(harness.runs.length, 3);
});

test('an expired account pauses independently while a healthy account continues to execute and reply', async t => {
    const expired = account('expired');
    const healthy = account('healthy');
    const harness = fixture(t, [expired, healthy]);
    harness.client(expired).push(new WeixinApiError('getupdates', -14));
    harness.client(healthy).push({ msgs: [message('1', 'healthy task', 'secret-healthy-context')] });
    harness.start();
    await waitUntil(() => harness.client(healthy).sent.some(reply => reply.text === `secret-result-${healthy.id}`), 'healthy account returns a result');
    await harness.stop();
    assert.equal(harness.client(expired).cursors.length, 1);
    assert.deepEqual(harness.runs.map(run => run.accountId), [healthy.id]);
    const snapshot = harness.statuses.at(-1) as { accounts: Array<{ id: string; state: string }> };
    assert.equal(snapshot.accounts.find(value => value.id === expired.id)?.state, 'login_required');
    assert.equal(snapshot.accounts.find(value => value.id === healthy.id)?.state, 'running');
});

test('adding an account is picked up live without recreating existing clients or losing their sessions', async t => {
    const first = account('A');
    const added = account('B');
    const harness = fixture(t, [first]);
    harness.client(first).push({ msgs: [message('1', 'first task', 'context-A')] });
    harness.start();
    await waitUntil(() => harness.client(first).sent.some(reply => reply.text === `secret-result-${first.id}`), 'initial account works');
    harness.client(added).push({ msgs: [message('1', 'new account task', 'context-B')] });
    harness.available.push(added);
    await waitUntil(() => harness.client(added).sent.some(reply => reply.text === `secret-result-${added.id}`), 'new account works without restart');
    harness.client(first).push({ msgs: [message('2', 'continue first account', 'fresh-context-A')] });
    await waitUntil(() => harness.runs.filter(run => run.accountId === first.id).length === 2, 'original account continues its session');
    await harness.stop();
    assert.deepEqual(harness.created, [first.id, added.id]);
    assert.equal(harness.runs.filter(run => run.accountId === first.id)[1]?.threadId, `thread-${first.id}`);
    assert.equal(harness.store(first).data.conversations['secret-shared-sender']?.contextToken, 'fresh-context-A');
});

test('/stop must match both account and sender before cancelling the current run', async t => {
    const first = account('A');
    const other = account('B');
    let runningSignal: AbortSignal | undefined;
    const harness = fixture(t, [first, other], async (_context: AccountContext, input: CodexRunInput): Promise<CodexRunResult> => {
        runningSignal = input.signal;
        return new Promise((_resolve, reject) => {
            assert.ok(input.signal);
            const abort = () => reject(new CodexRunError('aborted', '任务已停止'));
            if (input.signal.aborted) abort();
            else input.signal.addEventListener('abort', abort, { once: true });
        });
    });
    harness.client(first).push({ msgs: [message('1', 'long task', 'context-A')] });
    harness.start();
    await waitUntil(() => runningSignal !== undefined, 'first account begins running');

    harness.client(other).push({ msgs: [message('1', '/stop', 'context-B')], get_updates_buf: 'other-stop-processed' });
    await waitUntil(() => harness.store(other).data.cursor === 'other-stop-processed', 'other-account stop is processed');
    assert.equal(runningSignal?.aborted, false);

    harness.client(first).push({ msgs: [message('2', '/stop', 'context-another-user', 'another-user')], get_updates_buf: 'different-user-stop-processed' });
    await waitUntil(() => harness.store(first).data.cursor === 'different-user-stop-processed', 'different-user stop is processed');
    assert.equal(runningSignal?.aborted, false);

    harness.client(first).push({ msgs: [message('3', '/stop', 'context-A')], get_updates_buf: 'own-stop-processed' });
    await waitUntil(() => harness.store(first).data.jobs[0]?.status === 'cancelled', 'matching account and user cancel the run');
    assert.equal(runningSignal?.aborted, true);
    assert.equal(harness.runs.length, 1);
});

function mediaMessage(id: string, contextToken: string, kind: 'image' | 'voice' = 'image'): WeixinMessage {
    const value = message(id, '检查附件', contextToken);
    const media = { encrypt_query_param: 'secret-cdn-reference', aes_key: 'secret-media-key', encrypt_type: 1 };
    value.item_list!.push(kind === 'image' ? { type: 2, image_item: { media } }
        : { type: 3, voice_item: { media, encode_type: 6 } });
    return value;
}

test('media acknowledgement and cursor are durable before preprocessing; prepared text and native images reach the runner', async t => {
    const selected = account('media');
    const images = [{ path: 'D:\\test-workspace\\incoming\\photo.png' }];
    let before: Job[] = [];
    let durableAcknowledgement = false;
    let durableCursor = '';
    let received: CodexRunInput | undefined;
    let savedBeforeRun = '';
    let prepareCalls = 0;
    const harness = fixture(t, [selected], async (context, input) => {
        received = input;
        savedBeforeRun = fs.readFileSync(context.store.file, 'utf8');
        return { threadId: 'media-thread', text: '看到了图片' };
    }, {
        prepareInput: async (context, job, signal) => {
            const saved = new StateStore(context.store.file, context.store.accountId);
            before = saved.data.jobs;
            durableCursor = saved.data.cursor;
            durableAcknowledgement = saved.data.outbox.some(entry => entry.userId === job.userId)
                && saved.data.seen.includes(`${job.userId}:image-1`);
            assert.equal(signal.aborted, false);
            return { prompt: '检查附件\n这是转写后的文字', images };
        },
        prepare: async () => { prepareCalls++; }
    });
    harness.client(selected).push({ msgs: [mediaMessage('image-1', 'media-context')], get_updates_buf: 'media-cursor' });
    harness.start();
    await waitUntil(() => harness.client(selected).sent.some(entry => entry.text === '看到了图片'), 'prepared image returns a result');
    await harness.stop();
    assert.equal(durableAcknowledgement, true);
    assert.equal(durableCursor, 'media-cursor');
    assert.equal(before[0]?.status, 'running');
    assert.equal(before[0]?.attachments?.[0]?.kind, 'image');
    assert.equal(prepareCalls, 1);
    assert.equal(received?.prompt, '检查附件\n这是转写后的文字');
    assert.deepEqual(received?.images, images);
    assert.doesNotMatch(savedBeforeRun, /secret-cdn-reference|secret-media-key/);
    assert.doesNotMatch(JSON.stringify(harness.store(selected).data), /secret-cdn-reference|secret-media-key/);
});

test('failed media preprocessing never prepares or runs Codex and sends a fixed safe failure', async t => {
    for (const [name, error, expected] of [
        ['known', new CodexRunError('invalid_output', '语音识别失败，请重新录制。'), '任务未完成：语音识别失败，请重新录制。'],
        ['unknown', new Error('secret-download-url and D:\\private\\audio.wav'), '任务未完成：任务执行遇到问题，请在本机查看。']
    ] as const) {
        await t.test(name, async subtest => {
            const selected = account(name);
            let prepareCalls = 0;
            const harness = fixture(subtest, [selected], undefined, {
                prepareInput: async () => { throw error; },
                prepare: async () => { prepareCalls++; }
            });
            harness.client(selected).push({ msgs: [mediaMessage('voice-1', 'voice-context', 'voice')] });
            harness.start();
            await waitUntil(() => harness.client(selected).sent.some(entry => entry.text === expected), 'safe media failure reply');
            await harness.stop();
            assert.equal(prepareCalls, 0);
            assert.equal(harness.runs.length, 0);
            assert.equal(harness.store(selected).data.jobs[0]?.status, 'failed');
            assert.doesNotMatch(JSON.stringify(harness.store(selected).data), /secret-cdn-reference|secret-media-key/);
            assert.doesNotMatch(harness.logs.join('\n') + JSON.stringify(harness.client(selected).sent), /secret-download-url|private\\\\audio/);
        });
    }
});

test('another account keeps receiving and acknowledging while media prepares; stop aborts that preparation before Codex starts', async t => {
    const slow = account('slow-media');
    const other = account('other');
    let mediaSignal: AbortSignal | undefined;
    const preparedAccounts: string[] = [];
    const harness = fixture(t, [slow, other], undefined, {
        prepareInput: async (_context, _job, signal) => {
            mediaSignal = signal;
            return new Promise((_resolve, reject) => {
                const abort = () => reject(new CodexRunError('aborted', '附件处理已停止。'));
                if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
            });
        },
        prepare: async context => { preparedAccounts.push(context.account.id); }
    });
    harness.client(slow).push({ msgs: [mediaMessage('voice-1', 'slow-context', 'voice')] });
    harness.start();
    await waitUntil(() => mediaSignal !== undefined, 'voice download or transcription starts');
    harness.client(other).push({ msgs: [message('other-1', '普通问题', 'other-context')], get_updates_buf: 'other-received' });
    await waitUntil(() => harness.client(other).sent.some(entry => entry.text.startsWith('收到，')), 'other account receives an acknowledgement during preprocessing');
    assert.equal(harness.store(other).data.cursor, 'other-received');
    assert.equal(harness.store(other).data.jobs[0]?.status, 'queued');
    assert.equal(harness.runs.length, 0);
    assert.equal(mediaSignal?.aborted, false);

    harness.client(slow).push({ msgs: [message('stop-1', '/stop', 'slow-context')] });
    await waitUntil(() => harness.store(slow).data.jobs[0]?.status === 'cancelled', 'stop aborts the media stage');
    await waitUntil(() => harness.client(other).sent.some(entry => entry.text === `secret-result-${other.id}`), 'other account runs after cancellation');
    await harness.stop();
    assert.equal(mediaSignal?.aborted, true);
    assert.deepEqual(harness.runs.map(value => value.accountId), [other.id]);
    assert.deepEqual(preparedAccounts, [other.id]);
    assert.doesNotMatch(JSON.stringify(harness.store(slow).data), /secret-cdn-reference|secret-media-key/);
});

test('a media helper that resolves after cancellation cannot start a model turn', async t => {
    const selected = account('late-media');
    let mediaSignal: AbortSignal | undefined;
    let prepareCalls = 0;
    const harness = fixture(t, [selected], undefined, {
        prepareInput: async (_context, _job, signal) => {
            mediaSignal = signal;
            return new Promise(resolve => {
                const finishLate = () => setTimeout(() => resolve({ prompt: 'late transcript', images: [] }), 20);
                if (signal.aborted) finishLate(); else signal.addEventListener('abort', finishLate, { once: true });
            });
        },
        prepare: async () => { prepareCalls++; }
    });
    harness.client(selected).push({ msgs: [mediaMessage('voice-1', 'late-context', 'voice')] });
    harness.start();
    await waitUntil(() => mediaSignal !== undefined, 'media preprocessing begins');
    harness.client(selected).push({ msgs: [message('stop-1', '/stop', 'late-context')] });
    await waitUntil(() => harness.store(selected).data.jobs[0]?.status === 'cancelled', 'late media result is discarded');
    await harness.stop();
    assert.equal(prepareCalls, 0);
    assert.equal(harness.runs.length, 0);
    assert.equal(mediaSignal?.aborted, true);
});
