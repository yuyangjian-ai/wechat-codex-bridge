import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { StateStore, type IncomingMessage } from '../src/state.js';
import type { Config } from '../src/config.js';
import type { WeixinMessageItem } from '../src/weixin.js';

const NOW = 1_700_000_000_000;
const config: Config = { workingDirectory: 'D:\\test', codexExecutable: 'C:\\test\\codex.exe',
  sandbox: 'workspace-write', taskTimeoutMinutes: 30, accessControl: { enabled: false, allowedUserIds: [] } };

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-message-merge-'));
  t.after(() => {
    for (const file of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, file));
    fs.rmdirSync(directory);
  });
  const open = (account = 'a') => new StateStore(path.join(directory, `${account}.json`), account);
  return { store: open(), open };
}

function image(reference = 'picture'): WeixinMessageItem {
  return { type: 2, image_item: { media: { encrypt_query_param: reference, aes_key: 'fake-key' } } };
}
function text(value: string): WeixinMessageItem { return { type: 1, text_item: { text: value } }; }
function message(id: string, items: WeixinMessageItem[], user = 'alice'): IncomingMessage {
  return { message_id: id, from_user_id: user, context_token: `context-${id}`, message_type: 1, message_state: 2,
    create_time_ms: NOW - 60_000, item_list: items };
}
function accept(store: StateStore, now: number, ...messages: IncomingMessage[]) {
  return store.acceptBatch(messages, `cursor-${now}`, config, { now });
}
function acknowledgements(store: StateStore) { return store.data.outbox.filter(value => value.text.startsWith('收到，')); }

test('text arriving 207 ms before its image creates one durable task and one acknowledgement', t => {
  const { store, open } = fixture(t);
  accept(store, NOW, message('text', [text('请根据名字帮我生成 logo')]));
  const originalId = store.data.jobs[0].id;
  const acknowledgementId = acknowledgements(store)[0].id;
  accept(store, NOW + 207, message('image', [image('correct-reference')]));
  const saved = open();
  assert.equal(saved.data.jobs.length, 1);
  assert.equal(saved.data.jobs[0].id, originalId);
  assert.equal(saved.data.jobs[0].prompt, '请根据名字帮我生成 logo');
  assert.equal(saved.data.jobs[0].attachments?.[0].media.encrypt_query_param, 'correct-reference');
  assert.equal(saved.data.jobs[0].readyAt, NOW + 2000);
  assert.equal(saved.data.jobs[0].createdAt, new Date(NOW).toISOString());
  assert.deepEqual(acknowledgements(saved).map(value => value.id), [acknowledgementId]);
  assert.deepEqual(saved.data.seen, ['alice:text', 'alice:image']);
  assert.equal(saved.data.cursor, `cursor-${NOW + 207}`);
  assert.equal(saved.data.conversations.alice.contextToken, 'context-image');
});

test('image followed by text merges in arrival order without extending the window', t => {
  const { store } = fixture(t);
  accept(store, NOW, message('image', [image()]));
  accept(store, NOW + 207, message('text', [text('使用这张图')]));
  accept(store, NOW + 1700, message('detail', [text('背景用白色')]));
  assert.equal(store.data.jobs.length, 1);
  assert.equal(store.data.jobs[0].prompt, '使用这张图\n背景用白色');
  assert.equal(store.data.jobs[0].readyAt, NOW + 2000);
  assert.equal(acknowledgements(store).length, 1);
});

test('the 2000 ms boundary is exclusive and is measured using local receipt time', t => {
  const { store } = fixture(t);
  accept(store, NOW, message('image', [image()]));
  accept(store, NOW + 1999, message('inside', [text('窗口内')]));
  accept(store, NOW + 2000, message('outside', [text('独立任务')]));
  assert.equal(store.data.jobs.length, 2);
  assert.equal(store.data.jobs[0].prompt, '窗口内');
  assert.equal(store.data.jobs[1].prompt, '独立任务');
  assert.equal(store.data.jobs[1].readyAt, NOW + 4000);
  assert.equal(acknowledgements(store).length, 2);
});

test('an already running media task remains immutable even while preparation is awaiting I/O', t => {
  const { store } = fixture(t);
  accept(store, NOW, message('image', [image()]));
  store.data.jobs[0].status = 'running';
  const snapshot = JSON.stringify(store.data.jobs[0]);
  accept(store, NOW + 207, message('late', [text('迟到的补充')]));
  assert.equal(store.data.jobs.length, 2);
  assert.equal(JSON.stringify(store.data.jobs[0]), snapshot);
  assert.equal(store.data.jobs[1].prompt, '迟到的补充');
  assert.equal(acknowledgements(store).length, 2);
});

test('plain text remains independent, and a following image joins only the most recent task', t => {
  const { store } = fixture(t);
  accept(store, NOW, message('a', [text('第一个问题')]));
  accept(store, NOW + 50, message('b', [text('第二个问题')]));
  accept(store, NOW + 207, message('image', [image()]));
  assert.equal(store.data.jobs.length, 2);
  assert.equal(store.data.jobs[0].prompt, '第一个问题');
  assert.equal(store.data.jobs[0].attachments, undefined);
  assert.equal(store.data.jobs[1].prompt, '第二个问题');
  assert.equal(store.data.jobs[1].attachments?.length, 1);
  assert.equal(acknowledgements(store).length, 2);
});

test('users and account stores never share a merge window or a deduplication identity', t => {
  const { store, open } = fixture(t);
  const otherAccount = open('b');
  accept(store, NOW, message('same', [text('Alice 的任务')]));
  accept(store, NOW + 50, message('same', [image('bob-image')], 'bob'));
  accept(otherAccount, NOW + 50, message('same', [image('other-account-image')]));
  accept(store, NOW + 100, message('status', [text('/status')], 'bob'));
  accept(store, NOW + 207, message('own-image', [image('alice-image')]));
  assert.equal(store.data.jobs.length, 2);
  assert.equal(store.data.jobs.find(job => job.userId === 'alice')?.attachments?.[0].media.encrypt_query_param, 'alice-image');
  assert.equal(store.data.jobs.find(job => job.userId === 'bob')?.attachments?.[0].media.encrypt_query_param, 'bob-image');
  assert.equal(otherAccount.data.jobs[0].attachments?.[0].media.encrypt_query_param, 'other-account-image');
  assert.equal(otherAccount.data.jobs[0].prompt, '');
});

for (const command of ['/status', '/help', '/whoami', '/result', '/new', '/stop']) {
  test(`${command} acts immediately and closes the sender's prior merge window`, t => {
    const { store } = fixture(t);
    accept(store, NOW, message('first', [text('原任务')]));
    store.data.conversations.alice.threadId = 'original-thread';
    const cancelled = accept(store, NOW + 100, message('command', [text(command)]));
    assert.equal(store.data.jobs[0].readyAt, NOW + 100);
    assert.equal(store.data.outbox.length, 2);
    if (command === '/stop') {
      assert.deepEqual(cancelled, ['alice']);
      assert.equal(store.data.jobs[0].status, 'cancelled');
    } else assert.equal(store.data.jobs[0].status, 'queued');
    if (command === '/new') {
      assert.equal(store.data.conversations.alice.threadId, 'original-thread');
      assert.match(store.data.outbox[1].text, /请先发送 \/stop/);
    }
    accept(store, NOW + 207, message('after', [image()]));
    assert.equal(store.data.jobs.length, 2);
    assert.equal(acknowledgements(store).length, 2);
  });
}

test('invalid input is a barrier rather than allowing a later image to cross the rejected message', t => {
  const { store } = fixture(t);
  accept(store, NOW, message('first', [text('第一条')]));
  accept(store, NOW + 100, message('invalid', [{ type: 2, image_item: {} }]));
  accept(store, NOW + 207, message('image', [image()]));
  assert.equal(store.data.jobs.length, 2);
  assert.equal(store.data.jobs[0].attachments, undefined);
  assert.equal(store.data.jobs[0].readyAt, NOW + 100);
  assert.equal(store.data.outbox.length, 3);
});

test('more than four images starts another task without dropping any incoming image', t => {
  const { store } = fixture(t);
  accept(store, NOW, message('first', [image('a'), image('b'), image('c')]));
  accept(store, NOW + 100, message('fourth', [image('d')]));
  accept(store, NOW + 207, message('overflow', [image('e'), image('f')]));
  assert.deepEqual(store.data.jobs.map(job => job.attachments?.map(item => item.media.encrypt_query_param)), [['a', 'b', 'c', 'd'], ['e', 'f']]);
  assert.equal(acknowledgements(store).length, 2);
});

test('a queued window survives reload and duplicate messages never add text, images or acknowledgements twice', t => {
  const { store, open } = fixture(t);
  const picture = message('image', [image()]);
  accept(store, NOW, picture);
  const restored = open();
  const followup = message('text', [text('补充说明')]);
  accept(restored, NOW + 207, followup);
  accept(restored, NOW + 300, picture, followup);
  const final = open();
  assert.equal(final.data.jobs.length, 1);
  assert.equal(final.data.jobs[0].prompt, '补充说明');
  assert.equal(final.data.jobs[0].attachments?.length, 1);
  assert.equal(final.data.jobs[0].readyAt, NOW + 2000);
  assert.equal(acknowledgements(final).length, 1);
  assert.deepEqual(final.data.seen, ['alice:image', 'alice:text']);
  assert.equal(final.data.cursor, `cursor-${NOW + 300}`);
});

for (const transcript of [undefined, '微信提供的转写']) {
  test(`voice ${transcript ? 'with' : 'without'} transcription is immediate and never merged with images`, t => {
    const { store } = fixture(t);
    accept(store, NOW, message('image', [image()]));
    accept(store, NOW + 100, message('voice', [{ type: 3, voice_item: { text: transcript,
      media: { encrypt_query_param: 'voice-reference', aes_key: 'fake-key' }, encode_type: 6 } }]));
    accept(store, NOW + 207, message('after-voice', [image('another-image')]));
    assert.equal(store.data.jobs.length, 3);
    assert.equal(store.data.jobs[1].readyAt, undefined);
    assert.equal(store.data.jobs[1].prompt, transcript ?? '');
    assert.equal(acknowledgements(store).length, 3);
  });
}

test('zero window disables both delay and merging; old jobs without readyAt are not retroactively merged', t => {
  const { store } = fixture(t);
  store.acceptBatch([message('text', [text('第一条')]), message('image', [image()])], 'disabled', config, { now: NOW, mergeWindowMs: 0 });
  assert.equal(store.data.jobs.length, 2);
  assert.equal(store.data.jobs.every(job => job.readyAt === NOW), true);
  delete store.data.jobs[1].readyAt;
  accept(store, NOW + 207, message('third', [text('独立第三条')]));
  assert.equal(store.data.jobs.length, 3);
  assert.equal(store.data.jobs[1].prompt, '');
});
