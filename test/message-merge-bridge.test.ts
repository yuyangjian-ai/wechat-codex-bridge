import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { runBridge, type AccountClient, type AccountContext, type BridgeServices } from '../src/bridge.js';
import type { StoredWeixinAccount } from '../src/accounts.js';
import type { Config } from '../src/config.js';
import { CodexRunError, type CodexRunInput } from '../src/codex.js';
import { buildCodexInput, type CodexInputItem } from '../src/codex-input.js';
import { StateStore, type Job } from '../src/state.js';
import type { PollResult, WeixinMessage, WeixinMessageItem } from '../src/weixin.js';

const config: Config = {
    workingDirectory: 'D:\\test-workspace', codexExecutable: 'C:\\test\\codex.exe',
    sandbox: 'workspace-write', taskTimeoutMinutes: 30,
    accessControl: { enabled: false, allowedUserIds: [] }
};
const START = Date.parse('2026-09-15T08:00:00.000Z');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function textItem(text: string): WeixinMessageItem { return { type: 1, text_item: { text } }; }
function imageItem(): WeixinMessageItem { return { type: 2, image_item: { media: { encrypt_query_param: 'test-image-reference', aes_key: 'test-image-key' } } }; }
function voiceItem(): WeixinMessageItem { return { type: 3, voice_item: { media: { encrypt_query_param: 'test-voice-reference', aes_key: 'test-voice-key' }, encode_type: 6 } }; }
function message(id: string, userId: string, items: WeixinMessageItem[]): WeixinMessage {
    return { message_id: id, from_user_id: userId, context_token: `context-${userId}-${id}`,
        message_type: 1, message_state: 2, item_list: items };
}

class FakeClient implements AccountClient {
    readonly sent: Array<{ userId: string; text: string }> = [];
    private readonly inbox: PollResult[] = [];
    private waiting?: (value: PollResult) => void;
    push(value: PollResult): void { if (this.waiting) this.waiting(value); else this.inbox.push(value); }
    async poll(_cursor: string, signal?: AbortSignal): Promise<PollResult> {
        if (signal?.aborted) throw new Error('cancelled');
        const next = this.inbox.shift();
        if (next) return next;
        return new Promise((resolve, reject) => {
            const abort = () => { this.waiting = undefined; reject(new Error('cancelled')); };
            this.waiting = value => { this.waiting = undefined; signal?.removeEventListener('abort', abort); resolve(value); };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }
    async sendText(userId: string, _context: string, text: string): Promise<void> { this.sent.push({ userId, text }); }
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `Timed out: ${description}`);
        await delay(5);
    }
}

function gate() {
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    return {
        release,
        wait: async (signal: AbortSignal) => {
            let listener!: () => void;
            const cancelled = new Promise<never>((_resolve, reject) => {
                listener = () => reject(new CodexRunError('aborted', '任务已停止。'));
                if (signal.aborted) listener();
                else signal.addEventListener('abort', listener, { once: true });
            });
            try { await Promise.race([promise, cancelled]); }
            finally { signal.removeEventListener('abort', listener); }
        }
    };
}

function fixture(t: TestContext, hooks: {
    beforePrepareInput?: (context: AccountContext, job: Job, signal: AbortSignal) => Promise<void>;
    beforeRun?: (context: AccountContext, input: CodexRunInput) => Promise<void>;
} = {}) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-message-merge-test-'));
    const imagePath = path.join(runtime, 'fixture.png');
    fs.writeFileSync(imagePath, PNG);
    const account: StoredWeixinAccount = {
        id: createHash('sha256').update('merge-test-bot').digest('hex').slice(0, 16), label: 'Merge test',
        credentials: { botId: 'merge-test-bot', token: 'test-token', baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'test-owner' },
        createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString()
    };
    const stateFile = path.join(runtime, `state-${account.id}.json`);
    const controller = new AbortController();
    const client = new FakeClient();
    const runs: Array<{ userId: string; prompt: string; items: CodexInputItem[] }> = [];
    const prepared: Array<{ jobId: string; prompt: string; kinds: string[] }> = [];
    let currentTime = START;
    let clockReads = 0;
    let completion: Promise<void> | undefined;
    const services: BridgeServices = {
        runtime, signal: controller.signal, accountRefreshMs: 20, messageMergeWindowMs: 2000,
        now: () => { clockReads++; return currentTime; },
        loadAccounts: () => [account], createClient: () => client,
        prepareInput: async (context, job, signal) => {
            prepared.push({ jobId: job.id, prompt: job.prompt, kinds: (job.attachments ?? []).map(item => item.kind) });
            await hooks.beforePrepareInput?.(context, job, signal);
            const images = (job.attachments ?? []).filter(item => item.kind === 'image').map(() => ({ path: imagePath }));
            const hasVoice = job.attachments?.some(item => item.kind === 'voice');
            return { prompt: hasVoice ? [job.prompt, '语音转写'].filter(Boolean).join('\n') : job.prompt, ...(images.length ? { images } : {}) };
        },
        prepare: async () => {},
        run: async (context, input) => {
            const userId = context.store.data.jobs.find(job => job.status === 'running')!.userId;
            // Use the actual input builder, not a mock of its text/image wire representation.
            runs.push({ userId, prompt: input.prompt, items: await buildCodexInput(input) });
            await hooks.beforeRun?.(context, input);
            return { threadId: `thread-${userId}`, text: `done:${userId}:${runs.length}` };
        },
        log: () => {}, status: () => {}
    };
    const store = () => new StateStore(stateFile, account.credentials.botId);
    const stop = async () => { controller.abort(); await completion; };
    t.after(async () => {
        try { await stop(); }
        finally {
            // This fixture creates only these two files and owns their exact paths.
            if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
            fs.unlinkSync(imagePath);
            fs.rmdirSync(runtime);
        }
    });
    return {
        imagePath, client, runs, prepared, store, stop,
        start() { completion = runBridge(config, services); void completion.catch(() => {}); },
        async receive(id: string, userId: string, items: WeixinMessageItem[]) {
            client.push({ msgs: [message(id, userId, items)], get_updates_buf: id });
            await waitUntil(() => fs.existsSync(stateFile) && store().data.cursor === id, `receive ${id}`);
        },
        async advance(ms: number) {
            const before = clockReads;
            currentTime += ms;
            await waitUntil(() => clockReads > before, 'worker observes fake clock');
        }
    };
}

for (const order of ['text-first', 'image-first'] as const) {
    test(`${order} messages 207 ms apart produce one acknowledgement and one real text plus localImage input`, async t => {
        const h = fixture(t);
        h.start();
        await h.receive('part-1', 'alice', order === 'text-first' ? [textItem('这张图片有什么问题？')] : [imageItem()]);
        await h.advance(207);
        assert.equal(h.runs.length, 0);
        await h.receive('part-2', 'alice', order === 'text-first' ? [imageItem()] : [textItem('这张图片有什么问题？')]);
        assert.equal(h.store().data.jobs.length, 1);
        assert.equal(h.store().data.jobs[0].readyAt, START + 2000);
        await h.advance(1792);
        assert.equal(h.runs.length, 0, 'the first task is not ready at 1999 ms');
        await h.advance(1);
        await waitUntil(() => h.runs.length === 1 && h.store().data.jobs[0].status === 'done', 'one merged run finishes at fixed deadline');
        await waitUntil(() => h.client.sent.some(item => item.text.startsWith('done:')), 'merged result sent');
        assert.equal(h.client.sent.filter(item => /已加入任务队列/.test(item.text)).length, 1);
        assert.deepEqual(h.runs[0].items, [
            { type: 'text', text: '这张图片有什么问题？', text_elements: [] },
            { type: 'localImage', path: h.imagePath }
        ]);
        assert.deepEqual(h.prepared[0].kinds, ['image']);
        assert.equal(h.store().data.seen.length, 2);
    });
}

test('a later voice task cannot pass its sender waiting text task while another sender ready task can run', async t => {
    const h = fixture(t);
    h.start();
    await h.receive('alice-text', 'alice', [textItem('先处理这项文字任务')]);
    await h.advance(207);
    await h.receive('alice-voice', 'alice', [voiceItem()]);
    await h.receive('bob-voice', 'bob', [voiceItem()]);
    await waitUntil(() => h.runs.length === 1, 'another sender ready task runs');
    assert.equal(h.runs[0].userId, 'bob');
    assert.equal(h.store().data.jobs.filter(job => job.userId === 'alice' && job.status === 'queued').length, 2);
    await h.advance(1793);
    await waitUntil(() => h.runs.length === 3, 'both alice tasks run after her first becomes ready');
    assert.deepEqual(h.runs.map(run => [run.userId, run.prompt]), [
        ['bob', '语音转写'], ['alice', '先处理这项文字任务'], ['alice', '语音转写']
    ]);
});

test('/stop during the merge window cancels the waiting task before preparation or execution', async t => {
    const h = fixture(t);
    h.start();
    await h.receive('waiting-image', 'alice', [imageItem()]);
    await h.advance(207);
    await h.receive('stop-waiting', 'alice', [textItem('/stop')]);
    await h.advance(5000);
    assert.equal(h.runs.length, 0);
    assert.equal(h.prepared.length, 0);
    const cancelled = h.store().data.jobs[0];
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.attachments, undefined);
    assert.equal(cancelled.prompt, '');
});

for (const phase of ['prepareInput', 'running'] as const) {
    test(`new text received during ${phase} creates a later task without mutating the active image task`, async t => {
        const blocked = gate();
        let entered = false;
        const h = fixture(t, phase === 'prepareInput' ? {
            beforePrepareInput: async (_context, _job, signal) => { if (!entered) { entered = true; await blocked.wait(signal); } }
        } : {
            beforeRun: async (_context, input) => { if (!entered) { entered = true; await blocked.wait(input.signal!); } }
        });
        h.start();
        await h.receive('first-image', 'alice', [imageItem()]);
        await h.advance(2000);
        await waitUntil(() => entered, `first job enters ${phase}`);
        const activeId = h.store().data.jobs.find(job => job.status === 'running')!.id;
        await h.receive('late-text', 'alice', [textItem('这是后续问题，不应修改执行中的任务')]);
        const saved = h.store().data;
        assert.equal(saved.jobs.length, 2);
        assert.equal(saved.jobs.find(job => job.id === activeId)!.prompt, '');
        assert.equal(saved.jobs.find(job => job.status === 'queued')!.prompt, '这是后续问题，不应修改执行中的任务');
        blocked.release();
        await h.advance(2000);
        await waitUntil(() => h.runs.length === 2 && h.store().data.jobs.every(job => job.status === 'done'), 'both separate jobs finish');
        assert.equal(h.runs[0].items.filter(item => item.type === 'localImage').length, 1);
        assert.ok(!h.runs[0].items.some(item => item.type === 'text' && item.text.includes('后续问题')));
        assert.deepEqual(h.runs[1].items, [{ type: 'text', text: '这是后续问题，不应修改执行中的任务', text_elements: [] }]);
    });
}
