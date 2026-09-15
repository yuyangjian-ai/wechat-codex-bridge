import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { prepareIncomingInput, type InputPreparationRuntime } from '../src/prepare-input.js';
import { IncomingMediaError } from '../src/incoming-media.js';
import { TranscriptionError } from '../src/transcription.js';
import { CodexRunError } from '../src/codex.js';
import type { Job } from '../src/state.js';

const runtime = path.join(os.tmpdir(), 'wechat-prepare-fixture');
const accountId = '0123456789abcdef';
const job = (overrides: Partial<Job> = {}): Job => ({ id: randomUUID(), userId: 'user', prompt: '', status: 'running', createdAt: new Date().toISOString(), ...overrides });
const image = { kind: 'image' as const, media: { encrypt_query_param: 'private-image-reference' } };
const voice = { kind: 'voice' as const, media: { encrypt_query_param: 'private-voice-reference' } };

test('images retain native file inputs while voice becomes text; source references never enter the prompt', async () => {
    const task = job({ prompt: '结合图片回答', attachments: [image, voice, image] });
    const paths: string[] = [];
    const signal = new AbortController().signal;
    const result = await prepareIncomingInput(runtime, accountId, task, signal, {
        download: async (attachment, directory, options) => {
            assert.equal(options?.signal, signal);
            paths.push(directory);
            return { kind: attachment.kind, path: path.join(directory, attachment.kind === 'image' ? 'picture.png' : 'speech.silk') };
        },
        transcribe: async (file, options) => { assert.equal(options?.signal, signal); assert.ok(file.endsWith('speech.silk')); return '这是什么颜色？'; }
    });
    assert.equal(result.prompt, '结合图片回答\n这是什么颜色？');
    assert.equal(result.images?.length, 2);
    assert.equal(result.images?.[0]?.path, path.join(paths[0]!, 'picture.png'));
    assert.equal(result.images?.[1]?.path, path.join(paths[2]!, 'picture.png'));
    paths.forEach((directory, index) => assert.equal(directory, path.join(runtime, 'incoming', accountId, task.id, String(index))));
    assert.doesNotMatch(JSON.stringify(result), /private-|encrypt_query_param/);
});

test('already transcribed voice and text never invoke media services', async () => {
    const task = job({ prompt: '微信已有转写' });
    const fail = async (): Promise<never> => { throw new Error('Unexpected media call'); };
    assert.deepEqual(await prepareIncomingInput(runtime, accountId, task, new AbortController().signal, { download: fail, transcribe: fail }), { prompt: task.prompt, images: undefined });
});

test('image-only input does not require text and different accounts/jobs cannot share directories', async () => {
    const directories: string[] = [];
    const dependencies: InputPreparationRuntime = { download: async (attachment, directory) => {
        directories.push(directory); return { kind: attachment.kind, path: path.join(directory, 'image.png') };
    } };
    const first = job({ attachments: [image] });
    for (const [selected, task] of [[accountId, first], ['fedcba9876543210', first], [accountId, job({ attachments: [image] })]] as const) {
        const result = await prepareIncomingInput(runtime, selected, task, new AbortController().signal, dependencies);
        assert.equal(result.prompt, ''); assert.equal(result.images?.length, 1);
    }
    assert.equal(new Set(directories).size, 3);
});

test('one failed attachment rejects the whole task without returning a partial prompt or secret diagnostic', async () => {
    for (const failure of [new IncomingMediaError('decrypt_failed'), new TranscriptionError('no_speech'), new Error('private-CDN-key-or-path')]) {
        let downloads = 0;
        const result = prepareIncomingInput(runtime, accountId, job({ prompt: 'do not execute partially', attachments: [image, voice] }), new AbortController().signal, {
            download: async (attachment, directory) => { downloads++; return { kind: attachment.kind, path: path.join(directory, 'input') }; },
            transcribe: async () => { throw failure; }
        });
        await assert.rejects(result, (error: unknown) => {
            assert.ok(error instanceof CodexRunError);
            assert.equal(error.code, 'invalid_output'); assert.doesNotMatch(error.message, /private|CDN-key|do not execute/);
            return true;
        });
        assert.equal(downloads, 2);
    }
});

test('cancellation during download or recognition prevents remaining processing', async () => {
    for (const phase of ['before', 'download', 'recognize']) {
        const controller = new AbortController();
        let downloads = 0; let recognitions = 0;
        if (phase === 'before') controller.abort();
        await assert.rejects(prepareIncomingInput(runtime, accountId, job({ attachments: [voice, image] }), controller.signal, {
            download: async attachment => { downloads++; if (phase === 'download') controller.abort(); return { kind: attachment.kind, path: path.join(runtime, 'voice.silk') }; },
            transcribe: async () => { recognitions++; controller.abort(); return '不要执行'; }
        }), (error: unknown) => error instanceof CodexRunError && error.code === 'aborted');
        assert.equal(downloads, phase === 'before' ? 0 : 1);
        assert.equal(recognitions, phase === 'recognize' ? 1 : 0);
    }
});

test('invalid storage identifiers and attachment counts are rejected before any download', async () => {
    const fail = async (): Promise<never> => { assert.fail('download must not run'); };
    for (const [selectedRuntime, selectedAccount, task] of [
        [runtime, '../account', job({ attachments: [image] })],
        [runtime, accountId, job({ id: '../job', attachments: [image] })],
        ['relative', accountId, job({ attachments: [image] })],
        [runtime, accountId, job({ attachments: Array(5).fill(image) })]
    ] as const) await assert.rejects(prepareIncomingInput(selectedRuntime, selectedAccount, task, new AbortController().signal, { download: fail }), CodexRunError);
});

test('empty recognition cannot silently execute only accompanying text', async () => {
    await assert.rejects(prepareIncomingInput(runtime, accountId, job({ prompt: '前半段', attachments: [voice] }), new AbortController().signal, {
        download: async attachment => ({ kind: attachment.kind, path: path.join(runtime, 'voice.silk') }), transcribe: async () => '  '
    }), (error: unknown) => error instanceof CodexRunError && /没有识别/.test(error.message));
});
