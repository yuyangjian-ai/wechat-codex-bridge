import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { runBridge, type AccountClient, type BridgeServices } from '../src/bridge.js';
import { type StoredWeixinAccount } from '../src/accounts.js';
import { type Config } from '../src/config.js';
import { StateStore, type IncomingMessage } from '../src/state.js';
import { type PollResult } from '../src/weixin.js';

const CONFIG: Config = {
    workingDirectory: 'D:\\test-workspace', codexExecutable: 'C:\\test\\codex.exe',
    sandbox: 'workspace-write', taskTimeoutMinutes: 30,
    accessControl: { enabled: false, allowedUserIds: [] }
};
const NOW = '2026-09-15T00:00:00.000Z';

function account(label: string): StoredWeixinAccount {
    const botId = `test-bot-${label}`;
    return {
        id: createHash('sha256').update(botId).digest('hex').slice(0, 16), label,
        credentials: { botId, token: `test-token-${label}`, userId: `test-owner-${label}`, baseUrl: 'https://ilinkai.weixin.qq.com' },
        createdAt: NOW, updatedAt: NOW
    };
}

function message(id: string, prompt: string, userId: string, contextToken: string): IncomingMessage {
    return {
        message_id: id, message_type: 1, message_state: 2, from_user_id: userId, context_token: contextToken,
        item_list: [{ type: 1, text_item: { text: prompt } }]
    };
}

type SentText = { userId: string; contextToken: string; text: string; clientId: string };
type SentImage = { userId: string; contextToken: string; imagePath: string; clientId: string };

class FakeMediaClient implements AccountClient {
    texts: SentText[] = [];
    images: SentImage[] = [];
    onImage?: (entry: SentImage) => Promise<void> | void;
    private inbox: PollResult[] = [];
    private waiting?: (value: PollResult) => void;

    push(msgs: IncomingMessage[]): void {
        const value = { msgs } as PollResult;
        if (this.waiting) this.waiting(value);
        else this.inbox.push(value);
    }

    async poll(_cursor: string, signal?: AbortSignal): Promise<PollResult> {
        if (signal?.aborted) throw new Error('Stopped');
        const next = this.inbox.shift();
        if (next) return next;
        return new Promise((resolve, reject) => {
            const abort = () => {
                this.waiting = undefined;
                signal?.removeEventListener('abort', abort);
                reject(new Error('Stopped'));
            };
            this.waiting = value => {
                this.waiting = undefined;
                signal?.removeEventListener('abort', abort);
                resolve(value);
            };
            signal?.addEventListener('abort', abort, { once: true });
        });
    }

    async sendText(userId: string, contextToken: string, text: string, clientId: string): Promise<void> {
        this.texts.push({ userId, contextToken, text, clientId });
    }

    sendImage: AccountClient['sendImage'] = async (userId, contextToken, imagePath, clientId) => {
        const entry = { userId, contextToken, imagePath, clientId };
        this.images.push(entry);
        await this.onImage?.(entry);
    };
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
        await delay(10);
    }
}

function fixture(t: TestContext, accounts: StoredWeixinAccount[], run?: BridgeServices['run']) {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-media-delivery-test-'));
    const controller = new AbortController();
    const clients = new Map(accounts.map(selected => [selected.id, new FakeMediaClient()]));
    const logs: string[] = [];
    let completion: Promise<void> | undefined;
    let runCount = 0;
    const store = (selected: StoredWeixinAccount) => new StateStore(path.join(runtime, `state-${selected.id}.json`), selected.credentials.botId);
    const client = (selected: StoredWeixinAccount) => clients.get(selected.id)!;
    const stop = async () => { controller.abort(); await completion; };
    t.after(async () => {
        try { await stop(); }
        finally {
            for (const name of fs.readdirSync(runtime)) fs.unlinkSync(path.join(runtime, name));
            fs.rmdirSync(runtime);
        }
    });
    return {
        runtime, client, store, logs, stop, runCount: () => runCount,
        artifact(name: string): string {
            const file = path.join(runtime, name);
            fs.writeFileSync(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            return file;
        },
        start(): void {
            assert.equal(completion, undefined);
            completion = runBridge(CONFIG, {
                runtime, signal: controller.signal, accountRefreshMs: 10,
                loadAccounts: () => accounts, createClient: client,
                prepare: async () => {},
                run: async (context, input) => {
                    runCount++;
                    return run ? run(context, input) : { threadId: `thread-${context.account.id}`, text: '仅文字结果' };
                },
                log: value => logs.push(value), status: () => {}
            });
            void completion.catch(() => {});
        }
    };
}

test('generated images use the originating account, user and conversation context and persist with their jobs', async t => {
    const first = account('A');
    const second = account('B');
    const paths = new Map<string, string>();
    const harness = fixture(t, [first, second], async (context, input) => ({
        threadId: `thread-${context.account.id}-${input.prompt}`, text: `完成:${input.prompt}`,
        images: [{ path: paths.get(input.prompt)! }]
    }));
    for (const name of ['A-shared', 'A-other', 'B-shared']) paths.set(name, harness.artifact(`${name}.png`));
    harness.client(first).push([
        message('1', 'A-shared', 'shared-user', 'context-A-shared'),
        message('2', 'A-other', 'other-user', 'context-A-other')
    ]);
    harness.client(second).push([message('1', 'B-shared', 'shared-user', 'context-B-shared')]);
    for (const selected of [first, second]) harness.client(selected).onImage = entry => {
        const saved = harness.store(selected);
        assert.equal(saved.data.outbox.find(value => value.id === entry.clientId)?.status, 'sending', 'Persist the attempt before submitting the image');
        assert.ok(saved.data.jobs.some(job => job.userId === entry.userId && job.images?.some(image => image.path === entry.imagePath)));
    };
    harness.start();
    await waitUntil(() => harness.client(first).images.length === 2 && harness.client(second).images.length === 1, 'three image replies');
    await harness.stop();
    assert.deepEqual(harness.client(first).images.map(({ userId, contextToken, imagePath }) => ({ userId, contextToken, imagePath })), [
        { userId: 'shared-user', contextToken: 'context-A-shared', imagePath: paths.get('A-shared') },
        { userId: 'other-user', contextToken: 'context-A-other', imagePath: paths.get('A-other') }
    ]);
    assert.deepEqual(harness.client(second).images.map(({ userId, contextToken, imagePath }) => ({ userId, contextToken, imagePath })), [
        { userId: 'shared-user', contextToken: 'context-B-shared', imagePath: paths.get('B-shared') }
    ]);
    for (const selected of [first, second]) {
        const saved = harness.store(selected);
        assert.ok(saved.data.jobs.every(job => job.status === 'done' && job.images?.length === 1));
        assert.ok(saved.data.outbox.filter(entry => entry.kind === 'image').every(entry => entry.status === 'sent'));
    }
    assert.doesNotMatch(harness.logs.join('\n'), /context-[AB]-|[AB]-(?:shared|other)\.png/);
});

test('/result replays only the requesting user images from the same account using the fresh context', async t => {
    const first = account('A');
    const second = account('B');
    const harness = fixture(t, [first, second]);
    const firstImage = harness.artifact('first.png');
    const otherImage = harness.artifact('other-user.png');
    const secondImage = harness.artifact('second.png');
    for (const [selected, images] of [[first, [['shared-user', firstImage], ['other-user', otherImage]]], [second, [['shared-user', secondImage]]]] as const) {
        const saved = harness.store(selected);
        for (const [userId, imagePath] of images) {
            saved.data.conversations[userId] = { contextToken: 'old-context', updatedAt: NOW };
            saved.data.jobs.push({ id: `${selected.id}-${userId}`, userId, prompt: '', status: 'done', createdAt: NOW, finishedAt: NOW, result: `结果:${userId}`, images: [{ path: imagePath }] });
        }
        saved.save();
    }
    harness.client(first).push([message('result-1', '/result', 'shared-user', 'fresh-A')]);
    harness.client(second).push([message('result-1', '/result', 'shared-user', 'fresh-B')]);
    harness.start();
    await waitUntil(() => harness.client(first).images.length === 1 && harness.client(second).images.length === 1, 'explicit image replays');
    await harness.stop();
    assert.equal(harness.runCount(), 0, '/result never calls Codex again');
    assert.equal(harness.client(first).images[0]?.imagePath, firstImage);
    assert.equal(harness.client(first).images[0]?.contextToken, 'fresh-A');
    assert.equal(harness.client(second).images[0]?.imagePath, secondImage);
    assert.equal(harness.client(second).images[0]?.contextToken, 'fresh-B');
    assert.ok([...harness.client(first).images, ...harness.client(second).images].every(entry => entry.userId === 'shared-user' && entry.imagePath !== otherImage));
});

test('/result replays a persisted image-only job even when its text is empty', async t => {
    const selected = account('A');
    const harness = fixture(t, [selected]);
    const imagePath = harness.artifact('image-only.png');
    const saved = harness.store(selected);
    saved.data.conversations['image-user'] = { contextToken: 'old-context', updatedAt: NOW };
    saved.data.jobs.push({
        id: 'image-only-job', userId: 'image-user', prompt: '', status: 'done',
        createdAt: NOW, finishedAt: NOW, result: '', images: [{ path: imagePath }]
    });
    saved.save();
    harness.client(selected).push([message('result-1', '/result', 'image-user', 'fresh-context')]);
    harness.start();
    await waitUntil(() => harness.client(selected).images.length === 1, 'image-only replay');
    await harness.stop();
    assert.equal(harness.client(selected).images[0]?.imagePath, imagePath);
    assert.equal(harness.client(selected).images[0]?.contextToken, 'fresh-context');
    assert.equal(harness.runCount(), 0);
});

test('an unknown image delivery is failed, explained to the same user and retried only after /result', async t => {
    const selected = account('A');
    let imagePath = '';
    const harness = fixture(t, [selected], async () => ({ threadId: 'image-thread', text: '图片已生成', images: [{ path: imagePath }] }));
    imagePath = harness.artifact('unknown-delivery.png');
    harness.client(selected).onImage = () => { throw new Error('Connection closed after submission'); };
    harness.client(selected).push([message('1', '画图', 'image-user', 'image-context')]);
    harness.start();
    await waitUntil(() => harness.client(selected).texts.some(entry => entry.text.includes('图片发送未确认')), 'explicit unknown-delivery feedback');
    await delay(250);
    assert.equal(harness.client(selected).images.length, 1, 'An unknown delivery must not be automatically resubmitted');
    const firstAttempt = harness.client(selected).images[0]!;
    let saved = harness.store(selected);
    assert.equal(saved.data.outbox.find(entry => entry.id === firstAttempt.clientId)?.status, 'failed');
    assert.deepEqual(saved.data.jobs[0]?.images, [{ path: imagePath }]);
    assert.ok(fs.existsSync(imagePath));
    const feedback = harness.client(selected).texts.find(entry => entry.text.includes('图片发送未确认'))!;
    assert.equal(feedback.userId, 'image-user');
    assert.equal(feedback.contextToken, 'image-context');
    assert.match(feedback.text, /\/result/);
    assert.ok(!feedback.text.includes(imagePath), 'Do not expose the local image path in the failure message');

    harness.client(selected).onImage = undefined;
    harness.client(selected).push([message('2', '/result', 'image-user', 'fresh-retry-context')]);
    await waitUntil(() => harness.client(selected).images.length === 2, 'user-requested retry');
    await harness.stop();
    const retried = harness.client(selected).images[1]!;
    assert.equal(retried.imagePath, imagePath);
    assert.equal(retried.contextToken, 'fresh-retry-context');
    assert.notEqual(retried.clientId, firstAttempt.clientId);
    saved = harness.store(selected);
    assert.equal(saved.data.outbox.find(entry => entry.id === firstAttempt.clientId)?.status, 'failed');
    assert.equal(saved.data.outbox.find(entry => entry.id === retried.clientId)?.status, 'sent');
    assert.equal(harness.runCount(), 1);
});

test('recovery marks a sending image failed and does not resend it while pending text still works', async t => {
    const selected = account('A');
    const harness = fixture(t, [selected]);
    const imagePath = harness.artifact('interrupted.png');
    const saved = harness.store(selected);
    saved.data.conversations['image-user'] = { contextToken: 'saved-context', updatedAt: NOW };
    saved.replyImage('image-user', imagePath);
    saved.data.outbox[0]!.status = 'sending';
    const imageId = saved.data.outbox[0]!.id;
    saved.reply('image-user', '原有文字消息');
    saved.save();
    harness.start();
    await waitUntil(() => harness.client(selected).texts.some(entry => entry.text === '原有文字消息'), 'legacy pending text');
    await delay(150);
    await harness.stop();
    assert.equal(harness.client(selected).images.length, 0);
    assert.equal(harness.store(selected).data.outbox.find(entry => entry.id === imageId)?.status, 'failed');
    assert.equal(harness.runCount(), 0);
    assert.ok(fs.existsSync(imagePath));
});

test('text-only clients remain compatible with normal text jobs and /result', async t => {
    const selected = account('A');
    const harness = fixture(t, [selected]);
    harness.client(selected).sendImage = undefined;
    harness.client(selected).push([message('1', '文字任务', 'text-user', 'text-context')]);
    harness.start();
    await waitUntil(() => harness.client(selected).texts.some(entry => entry.text === '仅文字结果'), 'normal text result');
    harness.client(selected).push([message('2', '/result', 'text-user', 'fresh-text-context')]);
    await waitUntil(() => harness.client(selected).texts.filter(entry => entry.text === '仅文字结果').length === 2, 'text result replay');
    await harness.stop();
    assert.equal(harness.client(selected).images.length, 0);
    assert.equal(harness.runCount(), 1);
    const saved = harness.store(selected);
    assert.equal(saved.data.jobs[0]?.images, undefined);
    assert.ok(saved.data.outbox.every(entry => entry.kind === undefined));
    assert.equal(harness.client(selected).texts.at(-1)?.contextToken, 'fresh-text-context');
});

test('an unavailable image sender produces explicit feedback without losing the generated image record', async t => {
    const selected = account('A');
    let imagePath = '';
    const harness = fixture(t, [selected], async () => ({ threadId: 'image-thread', text: '图片已生成', images: [{ path: imagePath }] }));
    imagePath = harness.artifact('unsupported-client.png');
    harness.client(selected).sendImage = undefined;
    harness.client(selected).push([message('1', '画图', 'image-user', 'image-context')]);
    harness.start();
    await waitUntil(() => harness.client(selected).texts.some(entry => entry.text.includes('图片发送未确认')), 'unsupported-image feedback');
    await harness.stop();
    assert.equal(harness.client(selected).images.length, 0);
    const saved = harness.store(selected);
    assert.deepEqual(saved.data.jobs[0]?.images, [{ path: imagePath }]);
    assert.equal(saved.data.outbox.find(entry => entry.kind === 'image')?.status, 'failed');
});
