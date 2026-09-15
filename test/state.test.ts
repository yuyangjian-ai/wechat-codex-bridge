import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { StateStore, splitText, type IncomingMessage } from '../src/state.js';
import type { Config } from '../src/config.js';
import type { WeixinMessageItem } from '../src/weixin.js';

const config: Config = {
  workingDirectory: 'D:\\code',
  codexExecutable: 'C:\\codex\\codex.exe',
  sandbox: 'workspace-write',
  taskTimeoutMinutes: 30,
  accessControl: { enabled: false, allowedUserIds: [] }
};

function fixture(t: TestContext): { store: StateStore; reload: () => StateStore } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-codex-state-test-'));
  const file = path.join(directory, 'state.json');
  t.after(() => {
    // Only these fixture files are removed; do not recursively delete temp paths.
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(directory);
  });
  return { store: new StateStore(file, 'test-bot'), reload: () => new StateStore(file, 'test-bot') };
}

function message(id: string, userId: string, text: string, contextToken = `context-${userId}`): IncomingMessage {
  return {
    message_id: id,
    from_user_id: userId,
    context_token: contextToken,
    message_type: 1,
    message_state: 2,
    item_list: [{ type: 1, text_item: { text } }]
  };
}

function imageItem(reference = 'image-reference'): WeixinMessageItem {
  return { type: 2, image_item: { media: { encrypt_query_param: reference, aes_key: 'image-key' }, aeskey: '112233445566778899aabbccddeeff00' } };
}

function voiceItem(reference = 'voice-reference', text?: string): WeixinMessageItem {
  return { type: 3, voice_item: { media: { encrypt_query_param: reference, aes_key: 'voice-key' }, text,
    encode_type: 6, sample_rate: 24000, bits_per_sample: 16, playtime: 1200 } };
}

function mediaMessage(id: string, userId: string, items: WeixinMessageItem[]): IncomingMessage {
  return { ...message(id, userId, ''), item_list: items };
}

test('disabled access control accepts all senders, including IDs matching object prototype names', t => {
  const { store, reload } = fixture(t);
  const senders = ['owner', 'visitor', '__proto__', 'constructor'];
  const disabledWithAllowlist: Config = { ...config, accessControl: { enabled: false, allowedUserIds: ['owner'] } };
  store.acceptBatch(senders.map((sender, index) => message(String(index), sender, 'inspect project')), 'cursor-1', disabledWithAllowlist);

  assert.deepEqual(store.data.jobs.map(job => job.userId), senders);
  assert.equal(store.data.jobs.every(job => job.status === 'queued'), true);
  const restored = reload();
  for (const sender of senders) assert.equal(restored.data.conversations[sender].contextToken, `context-${sender}`);
  assert.equal(Object.getPrototypeOf(restored.data.conversations), null);
});

test('enabled access control requires an exact user ID and never queues unauthorized messages', t => {
  const { store, reload } = fixture(t);
  const restricted: Config = { ...config, accessControl: { enabled: true, allowedUserIds: ['owner-ID'] } };
  const senders = ['owner-ID', 'OWNER-ID', 'owner-ID-suffix', ' owner-ID', 'visitor'];
  store.acceptBatch(senders.map((sender, index) => message(String(index), sender, 'do work')), 'restricted-cursor', restricted);

  const restored = reload();
  assert.deepEqual(restored.data.jobs.map(job => job.userId), ['owner-ID']);
  assert.deepEqual(Object.keys(restored.data.conversations), ['owner-ID']);
  assert.deepEqual(restored.data.outbox.map(outgoing => outgoing.userId), ['owner-ID']);
  assert.equal(restored.data.cursor, 'restricted-cursor');
});

test('each sender retains an independent Codex thread and the latest reply context across reloads', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([message('1', 'alice', 'first'), message('1', 'bob', 'first')], 'first', config);
  store.data.conversations.alice.threadId = 'thread-alice';
  store.data.conversations.bob.threadId = 'thread-bob';
  store.acceptBatch([
    message('2', 'alice', 'continue alice', 'alice-fresh-context'),
    message('2', 'bob', 'continue bob', 'bob-fresh-context')
  ], 'second', config);

  const restored = reload();
  assert.equal(restored.data.conversations.alice.threadId, 'thread-alice');
  assert.equal(restored.data.conversations.bob.threadId, 'thread-bob');
  assert.equal(restored.data.conversations.alice.contextToken, 'alice-fresh-context');
  assert.equal(restored.data.conversations.bob.contextToken, 'bob-fresh-context');
  assert.deepEqual(restored.data.jobs.filter(job => job.userId === 'alice').map(job => job.prompt), ['first', 'continue alice']);
  assert.deepEqual(restored.data.jobs.filter(job => job.userId === 'bob').map(job => job.prompt), ['first', 'continue bob']);
});

test('duplicate messages are accepted once while adjacent uint64 string IDs remain distinct', t => {
  const { store, reload } = fixture(t);
  const first = message('18446744073709551614', 'alice', 'first task');
  const second = message('18446744073709551615', 'alice', 'second task');
  store.acceptBatch([first, first, second], 'before-restart', config);
  assert.equal(store.data.jobs.length, 2);
  assert.equal(store.data.outbox.length, 2);

  const restored = reload();
  restored.acceptBatch([first, second], 'after-restart', config);
  assert.deepEqual(restored.data.jobs.map(job => job.prompt), ['first task', 'second task']);
  assert.equal(restored.data.outbox.length, 2);
  assert.equal(restored.data.seen.length, 2);
  assert.equal(reload().data.cursor, 'after-restart');

  // Message IDs are scoped to a sender, so a different user can reuse an ID.
  restored.acceptBatch([message(first.message_id as string, 'bob', 'bob task')], undefined, config);
  assert.equal(restored.data.jobs.length, 3);
  assert.equal(restored.data.jobs.at(-1)?.userId, 'bob');
});

test('cursor, queued task, dedupe ID and acknowledgement survive one committed batch', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([message('persist-1', 'alice', 'task to survive restart')], 'opaque-cursor', config);
  const restored = reload();

  assert.equal(restored.data.cursor, 'opaque-cursor');
  assert.deepEqual(restored.data.seen, ['alice:persist-1']);
  assert.equal(restored.data.jobs.length, 1);
  assert.equal(restored.data.jobs[0].prompt, 'task to survive restart');
  assert.equal(restored.data.jobs[0].status, 'queued');
  assert.equal(restored.data.outbox[0].status, 'pending');
  restored.acceptBatch([], undefined, config);
  assert.equal(reload().data.cursor, 'opaque-cursor');
});

test('recovery fails interrupted work and uncertain sends without rerunning or blindly resending', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([message('1', 'alice', 'may have changed files'), message('1', 'bob', 'not started')], 'recovery-cursor', config);
  store.data.jobs[0].status = 'running';
  const interruptedJobId = store.data.jobs[0].id;
  const uncertainReplyId = store.data.outbox[0].id;
  const pendingReplyId = store.data.outbox[1].id;
  store.data.outbox[0].status = 'sending';
  store.save();

  const restored = reload();
  restored.recoverInterrupted();
  const interrupted = restored.data.jobs.find(job => job.id === interruptedJobId)!;
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.prompt, '');
  assert.equal(Number.isNaN(Date.parse(interrupted.finishedAt!)), false);
  assert.equal(restored.data.jobs.filter(job => job.status === 'queued').length, 1);
  assert.equal(restored.data.jobs.find(job => job.userId === 'bob')?.status, 'queued');
  assert.equal(restored.data.outbox.find(outgoing => outgoing.id === uncertainReplyId)?.status, 'failed');
  assert.equal(restored.data.outbox.find(outgoing => outgoing.id === pendingReplyId)?.status, 'pending');
  const warnings = restored.data.outbox.filter(outgoing => outgoing.userId === 'alice' && outgoing.status === 'pending');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /没有自动重跑/);

  const secondRestart = reload();
  secondRestart.recoverInterrupted();
  assert.equal(secondRestart.data.jobs.length, 2);
  assert.equal(secondRestart.data.outbox.length, restored.data.outbox.length);
  assert.equal(secondRestart.data.cursor, 'recovery-cursor');
});

test('/stop cancels only the requesting sender queued work and returns only that sender for runner cancellation', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([
    message('1', 'alice', 'alice active'),
    message('2', 'alice', 'alice queued'),
    message('1', 'bob', 'bob queued')
  ], 'before-stop', config);
  store.data.jobs[0].status = 'running';

  const cancelUsers = store.acceptBatch([message('3', 'alice', '/stop')], 'after-stop', config);
  assert.deepEqual(cancelUsers, ['alice']);
  const restored = reload();
  assert.equal(restored.data.jobs.find(job => job.prompt === 'alice active')?.status, 'running');
  assert.equal(restored.data.jobs.find(job => job.userId === 'alice' && job.status === 'cancelled')?.prompt, '');
  assert.equal(restored.data.jobs.find(job => job.userId === 'bob')?.status, 'queued');
  assert.equal(restored.data.jobs.find(job => job.userId === 'bob')?.prompt, 'bob queued');
  assert.equal(restored.data.jobs.filter(job => job.status === 'cancelled').length, 1);
});

for (const busyStatus of ['queued', 'running'] as const) {
  test(`/new preserves the sender session while a task is ${busyStatus}`, t => {
    const { store, reload } = fixture(t);
    store.acceptBatch([message('1', 'alice', 'ongoing')], 'before-new', config);
    store.data.jobs[0].status = busyStatus;
    store.data.conversations.alice.threadId = 'existing-thread';
    store.acceptBatch([message('2', 'alice', '/new')], 'after-new', config);

    assert.equal(reload().data.conversations.alice.threadId, 'existing-thread');
    assert.equal(store.data.jobs.length, 1);
    assert.match(store.data.outbox.at(-1)!.text, /先发送 \/stop/);
  });
}

test('/new clears only an idle sender session and leaves another sender session intact', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([message('1', 'alice', '/help'), message('1', 'bob', '/help')], 'before-new', config);
  store.data.conversations.alice.threadId = 'alice-old';
  store.data.conversations.bob.threadId = 'bob-keep';
  store.acceptBatch([message('2', 'alice', '/new')], 'after-new', config);

  const restored = reload();
  assert.equal(restored.data.conversations.alice.threadId, undefined);
  assert.equal(restored.data.conversations.bob.threadId, 'bob-keep');
  assert.equal(restored.data.jobs.length, 0);
});

test('system messages, incomplete messages and messages without reply context never trigger work', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([
    { ...message('system', 'alice', 'ignore'), message_type: 2 },
    { ...message('incomplete', 'alice', 'ignore'), message_state: 1 },
    { ...message('no-context', 'alice', 'ignore'), context_token: undefined },
    { ...message('no-sender', 'alice', 'ignore'), from_user_id: undefined }
  ], 'skip-cursor', config);

  const restored = reload();
  assert.equal(restored.data.jobs.length, 0);
  assert.equal(restored.data.outbox.length, 0);
  assert.equal(restored.data.cursor, 'skip-cursor');
});

test('state for another bot account is rejected instead of reusing its user sessions', t => {
  const { store } = fixture(t);
  store.acceptBatch([message('1', 'alice', 'hello')], 'account-cursor', config);
  assert.throws(() => new StateStore(store.file, 'different-bot'), /账号不匹配/);
});

test('splitText preserves all text and never separates an emoji surrogate pair', () => {
  const original = 'a'.repeat(1799) + '😀' + '后续文字';
  const chunks = splitText(original);
  assert.equal(chunks.join(''), original);
  assert.equal(chunks.every(chunk => Array.from(chunk).length <= 1800), true);
  assert.equal(chunks[0].endsWith('😀'), true);
  assert.equal(splitText('').length, 1);
  assert.equal(splitText('')[0].length > 0, true);
});

test('splitText boundaries preserve multi-code-point emoji as complete visible characters', () => {
  const original = 'abcd👍🏽ef👨‍👩‍👧‍👦gh🇨🇳ij';
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const boundaries = new Set(Array.from(segmenter.segment(original), part => part.index + part.segment.length));
  const chunks = splitText(original, 5);
  assert.equal(chunks.join(''), original);
  let offset = 0;
  for (const chunk of chunks) {
    offset += chunk.length;
    assert.equal(boundaries.has(offset), true, `chunk boundary at ${offset} splits a visible emoji`);
  }
});

test('image-only input persists its exact attachment, cursor and acknowledgement and deduplicates after restart', t => {
  const { store, reload } = fixture(t);
  const incoming = mediaMessage('image-only', 'alice', [imageItem()]);
  store.acceptBatch([incoming, incoming], 'image-cursor', config);
  const restored = reload();
  assert.equal(restored.data.jobs.length, 1);
  assert.equal(restored.data.jobs[0].status, 'queued');
  assert.equal(restored.data.jobs[0].prompt, '');
  assert.deepEqual(restored.data.jobs[0].attachments, [{
    kind: 'image', media: { encrypt_query_param: 'image-reference', aes_key: 'image-key' },
    aesKeyHex: '112233445566778899aabbccddeeff00'
  }]);
  assert.equal(restored.data.jobs[0].inputImages, undefined);
  assert.equal(restored.data.cursor, 'image-cursor');
  assert.deepEqual(restored.data.seen, ['alice:image-only']);
  assert.equal(restored.data.outbox.length, 1);
  assert.match(restored.data.outbox[0].text, /已加入任务队列/);
  restored.acceptBatch([incoming], 'image-cursor-after-restart', config);
  assert.equal(reload().data.jobs.length, 1);
  assert.equal(reload().data.outbox.length, 1);
  assert.equal(reload().data.cursor, 'image-cursor-after-restart');
});

test('Weixin supplied voice transcription becomes text and never queues voice media for download', t => {
  const { store, reload } = fixture(t);
  const voice = voiceItem('should-not-download', '  总结这个项目\n并列出问题  ');
  voice.voice_item!.media!.full_url = 'https://untrusted.example/should-not-download';
  store.acceptBatch([mediaMessage('voice-transcribed', 'alice', [voice])], 'voice-text-cursor', config);
  const job = reload().data.jobs[0];
  assert.equal(job.prompt, '总结这个项目\n并列出问题');
  assert.equal(job.attachments, undefined);
  assert.equal(job.inputImages, undefined);
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /should-not-download|voice-key/);
});

test('blank or absent voice transcription queues raw voice references and audio metadata', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([
    mediaMessage('voice-blank', 'alice', [voiceItem('voice-blank-reference', ' \n ')]),
    mediaMessage('voice-absent', 'alice', [voiceItem('voice-absent-reference')])
  ], 'raw-voice-cursor', config);
  const restored = reload();
  assert.equal(restored.data.jobs.length, 2);
  for (const [index, reference] of ['voice-blank-reference', 'voice-absent-reference'].entries()) {
    assert.equal(restored.data.jobs[index].prompt, '');
    assert.deepEqual(restored.data.jobs[index].attachments, [{ kind: 'voice',
      media: { encrypt_query_param: reference, aes_key: 'voice-key' },
      encodeType: 6, sampleRate: 24000, bitsPerSample: 16, playtime: 1200 }]);
  }
});

test('mixed image and text inputs stay in one task with ordered attachments and complete text', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([mediaMessage('mixed', 'alice', [
    { type: 1, text_item: { text: '比较这两张图' } }, imageItem('first-image'),
    { type: 1, text_item: { text: '重点看价格差异' } }, imageItem('second-image')
  ])], 'mixed-cursor', config);
  const restored = reload();
  assert.equal(restored.data.jobs.length, 1);
  assert.equal(restored.data.jobs[0].prompt, '比较这两张图\n重点看价格差异');
  assert.deepEqual(restored.data.jobs[0].attachments?.map(item => item.media.encrypt_query_param), ['first-image', 'second-image']);
});

test('slash command text accompanying a media attachment is ordinary task content', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([message('initialize', 'alice', '/help')], undefined, config);
  store.data.conversations.alice.threadId = 'keep-existing-thread';
  const cancellations = store.acceptBatch([mediaMessage('command-with-image', 'alice', [
    { type: 1, text_item: { text: '/new' } }, imageItem()
  ])], 'command-media-cursor', config);
  const restored = reload();
  assert.equal(restored.data.conversations.alice.threadId, 'keep-existing-thread');
  assert.equal(restored.data.jobs.length, 1);
  assert.equal(restored.data.jobs[0].prompt, '/new');
  assert.equal(restored.data.jobs[0].attachments?.length, 1);
  assert.deepEqual(cancellations, []);
  assert.match(restored.data.outbox.at(-1)!.text, /已加入任务队列/);
});

for (const [name, invalidItem] of [
  ['image without media', { type: 2, image_item: {} }],
  ['voice without content', { type: 3, voice_item: { text: ' ' } }],
  ['image without download locator', { type: 2, image_item: { media: { aes_key: 'orphan-key' } } }],
  ['voice with empty media', { type: 3, voice_item: { media: {} } }],
  ['file input', { type: 4, file_item: { media: { encrypt_query_param: 'file-reference' } } }],
  ['video input', { type: 5, video_item: { media: { encrypt_query_param: 'video-reference' } } }]
] as Array<[string, WeixinMessageItem]>) {
  test(`${name} rejects the whole message, including any accompanying valid text and image`, t => {
    const { store, reload } = fixture(t);
    const incoming = mediaMessage('bad-media', 'alice', [
      { type: 1, text_item: { text: 'do not run only this fragment' } }, imageItem(), invalidItem
    ]);
    store.acceptBatch([incoming, incoming], 'invalid-media-cursor', config);
    const restored = reload();
    assert.equal(restored.data.jobs.length, 0);
    assert.equal(restored.data.outbox.length, 1);
    assert.doesNotMatch(restored.data.outbox[0].text, /已加入任务队列/);
    assert.equal(restored.data.cursor, 'invalid-media-cursor');
    assert.deepEqual(restored.data.seen, ['alice:bad-media']);
  });
}

for (const kind of ['image', 'voice'] as const) {
  test(`more than four ${kind} attachments rejects the whole message without truncating it`, t => {
    const { store, reload } = fixture(t);
    const items = Array.from({ length: 5 }, (_, index) => kind === 'image' ? imageItem(`image-${index}`) : voiceItem(`voice-${index}`));
    store.acceptBatch([mediaMessage('too-many', 'alice', [
      { type: 1, text_item: { text: 'this text must not execute either' } }, ...items
    ])], 'too-many-cursor', config);
    assert.equal(reload().data.jobs.length, 0);
    assert.match(reload().data.outbox.at(-1)!.text, /最多支持 4/);
    assert.equal(reload().data.cursor, 'too-many-cursor');
  });
}

test('/stop clears queued media references for only the requesting sender', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([
    mediaMessage('shared-id', 'alice', [imageItem('alice-private-reference')]),
    mediaMessage('shared-id', 'bob', [voiceItem('bob-private-reference')])
  ], 'before-media-stop', config);
  store.data.conversations.alice.threadId = 'alice-thread';
  store.data.conversations.bob.threadId = 'bob-thread';
  assert.deepEqual(store.acceptBatch([message('stop-media', 'alice', '/stop', 'alice-latest-context')], 'after-media-stop', config), ['alice']);
  const restored = reload();
  const alice = restored.data.jobs.find(job => job.userId === 'alice')!;
  const bob = restored.data.jobs.find(job => job.userId === 'bob')!;
  assert.equal(alice.status, 'cancelled');
  assert.equal(alice.attachments, undefined);
  assert.equal(alice.prompt, '');
  assert.ok(alice.finishedAt);
  assert.equal(bob.status, 'queued');
  assert.equal(bob.attachments?.[0].media.encrypt_query_param, 'bob-private-reference');
  assert.equal(restored.data.conversations.alice.threadId, 'alice-thread');
  assert.equal(restored.data.conversations.bob.threadId, 'bob-thread');
  assert.equal(restored.data.conversations.alice.contextToken, 'alice-latest-context');
  assert.equal(restored.data.conversations.bob.contextToken, 'context-bob');
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /alice-private-reference/);
});

test('restart clears interrupted media references while retaining another sender queued media', t => {
  const { store, reload } = fixture(t);
  store.acceptBatch([
    mediaMessage('running-media', 'alice', [voiceItem('running-voice-reference')]),
    mediaMessage('queued-media', 'bob', [imageItem('queued-image-reference')])
  ], 'media-recovery-cursor', config);
  store.data.jobs[0].status = 'running';
  store.save();
  const restored = reload();
  restored.recoverInterrupted();
  assert.equal(restored.data.jobs.find(job => job.userId === 'alice')?.status, 'failed');
  assert.equal(restored.data.jobs.find(job => job.userId === 'alice')?.attachments, undefined);
  assert.equal(restored.data.jobs.find(job => job.userId === 'bob')?.status, 'queued');
  assert.equal(restored.data.jobs.find(job => job.userId === 'bob')?.attachments?.[0].media.encrypt_query_param, 'queued-image-reference');
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /running-voice-reference/);
});

test('unauthorized senders cannot persist media references or create a conversation', t => {
  const { store, reload } = fixture(t);
  const restricted: Config = { ...config, accessControl: { enabled: true, allowedUserIds: ['owner'] } };
  store.acceptBatch([mediaMessage('blocked-media', 'visitor', [imageItem('blocked-download-reference')])], 'blocked-media-cursor', restricted);
  const restored = reload();
  assert.equal(restored.data.jobs.length, 0);
  assert.equal(restored.data.outbox.length, 0);
  assert.deepEqual(Object.keys(restored.data.conversations), []);
  assert.doesNotMatch(fs.readFileSync(store.file, 'utf8'), /blocked-download-reference/);
});
