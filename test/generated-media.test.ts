import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { collectGeneratedImages, withGeneratedImages, GENERATED_MEDIA_WARNING, type GeneratedMediaOptions } from '../src/generated-media.js';

const THREAD = '019a1234-5678-7000-8000-123456789abc';
const TURN = '019a1234-5678-7000-8000-123456789def';
const OTHER = '019a1234-5678-7000-8000-123456789aaa';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64');

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'codex-generated-media-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('codex-generated-media-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const options: GeneratedMediaOptions = { mediaDirectory: path.join(root, 'media'), generatedImagesDirectory: path.join(root, 'generated_images') };
    return { root, options };
}

function entry(id = 'image-1', overrides: Record<string, unknown> = {}, turnId = TURN) {
    return { turnId, item: { id, type: 'imageGeneration', status: 'completed', result: PNG.toString('base64'), ...overrides } };
}

function pages(...responses: any[]) {
    const calls: Array<{ method: string; params: any; options: any }> = [];
    return {
        calls,
        request: async (method: string, params: any, options: any) => {
            calls.push({ method, params, options });
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return response;
        }
    };
}

test('collects explicit completed images from the exact turn across paginated items', async t => {
    const { options } = await fixture(t);
    const client = pages(
        { data: [entry('previous-image', {}, OTHER), entry('ignored', { type: 'agentMessage', text: 'C:\\SECRET.png' })], nextCursor: 'page-2' },
        { data: [entry('unfinished', { status: 'inProgress' }), entry('../SECRET image')], nextCursor: null }
    );
    const result = await collectGeneratedImages(client, THREAD, TURN, options);
    assert.equal(result.warning, undefined);
    assert.equal(result.images.length, 1);
    const output = result.images[0].path;
    assert.equal(path.dirname(output), path.join(options.mediaDirectory!, THREAD, TURN));
    assert.match(path.basename(output), /^[a-f\d]{64}\.png$/);
    assert.equal(output.includes('SECRET'), false);
    assert.deepEqual(await fs.readFile(output), PNG);
    assert.deepEqual(client.calls.map(call => call.params), [
        { threadId: THREAD, turnId: TURN, limit: 1, sortDirection: 'asc' },
        { threadId: THREAD, turnId: TURN, limit: 1, sortDirection: 'asc', cursor: 'page-2' }
    ]);
    assert.ok(client.calls.every(call => call.method === 'thread/items/list' && call.options.timeoutMs <= 10_000));
});

test('at most four images are saved and repeated item ids are deduplicated', async t => {
    const { options } = await fixture(t);
    const client = pages({ data: [entry(), entry(), entry('2'), entry('3'), entry('4'), entry('5')], nextCursor: 'unneeded' });
    const result = await collectGeneratedImages(client, THREAD, TURN, options);
    assert.equal(result.images.length, 4);
    assert.equal(client.calls.length, 1);
    assert.equal((await fs.readdir(path.join(options.mediaDirectory!, THREAD, TURN))).length, 4);
});

test('savedPath only reads regular images within this thread generated_images directory', async t => {
    const { root, options } = await fixture(t);
    const allowedDirectory = path.join(options.generatedImagesDirectory!, THREAD);
    await fs.mkdir(allowedDirectory, { recursive: true });
    const allowed = path.join(allowedDirectory, 'image.png');
    const outside = path.join(root, 'SECRET.png');
    await fs.writeFile(allowed, PNG); await fs.writeFile(outside, PNG);
    const result = await collectGeneratedImages(pages({ data: [
        entry('allowed', { result: '', savedPath: allowed }),
        entry('outside', { result: '', savedPath: outside }),
        entry('other-thread', { result: '', savedPath: path.join(options.generatedImagesDirectory!, OTHER, 'image.png') })
    ], nextCursor: null }), THREAD, TURN, options);
    assert.equal(result.images.length, 1);
    assert.equal(result.warning, GENERATED_MEDIA_WARNING);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('savedPath directory junctions cannot escape the authorized generated-image root', async t => {
    const { root, options } = await fixture(t);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside); await fs.mkdir(options.generatedImagesDirectory!);
    await fs.writeFile(path.join(outside, 'image.png'), PNG);
    await fs.symlink(outside, path.join(options.generatedImagesDirectory!, THREAD), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await collectGeneratedImages(pages({ data: [entry('escaped', {
        result: '', savedPath: path.join(options.generatedImagesDirectory!, THREAD, 'image.png')
    })], nextCursor: null }), THREAD, TURN, options);
    assert.deepEqual(result, { images: [], warning: GENERATED_MEDIA_WARNING });
});

test('output-directory junctions do not cause writes or nested directories outside media', async t => {
    const { root, options } = await fixture(t);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside); await fs.mkdir(options.mediaDirectory!);
    await fs.symlink(outside, path.join(options.mediaDirectory!, THREAD), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await collectGeneratedImages(pages({ data: [entry()], nextCursor: null }), THREAD, TURN, options);
    assert.deepEqual(result, { images: [], warning: GENERATED_MEDIA_WARNING });
    assert.deepEqual(await fs.readdir(outside), []);
});

test('strict base64, image signature, MIME and byte limit reject malformed image payloads', async t => {
    const { options } = await fixture(t);
    const corrupt = Buffer.from(PNG); corrupt[0] = 0;
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1).toString('base64');
    const client = pages({ data: [
        entry('url', { result: 'https://example.com/SECRET.png' }),
        entry('text', { result: Buffer.from('SECRET plain text').toString('base64') }),
        entry('magic', { result: corrupt.toString('base64') }),
        entry('mime', { result: `data:image/jpeg;base64,${PNG.toString('base64')}` }),
        entry('whitespace', { result: ` ${PNG.toString('base64')}` }),
        entry('oversized', { result: oversized }),
        entry('valid', { result: `data:image/png;base64,${PNG.toString('base64')}` })
    ], nextCursor: null });
    const result = await collectGeneratedImages(client, THREAD, TURN, options);
    assert.equal(result.images.length, 1);
    assert.equal(result.warning, GENERATED_MEDIA_WARNING);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('savedPath extension must agree with the image signature', async t => {
    const { options } = await fixture(t);
    const directory = path.join(options.generatedImagesDirectory!, THREAD);
    await fs.mkdir(directory, { recursive: true });
    const mislabeled = path.join(directory, 'image.jpg');
    await fs.writeFile(mislabeled, PNG);
    const result = await collectGeneratedImages(pages({ data: [entry('wrong-type', { result: '', savedPath: mislabeled })], nextCursor: null }), THREAD, TURN, options);
    assert.deepEqual(result, { images: [], warning: GENERATED_MEDIA_WARNING });
});

test('existing identical generated images are reusable without duplicate files', async t => {
    const { options } = await fixture(t);
    const collect = () => collectGeneratedImages(pages({ data: [entry()], nextCursor: null }), THREAD, TURN, options);
    const first = await collect();
    assert.deepEqual(await collect(), first);
    assert.equal((await fs.readdir(path.join(options.mediaDirectory!, THREAD, TURN))).length, 1);
});

test('pagination errors and repeated cursors preserve any images with only a fixed warning', async t => {
    const { options } = await fixture(t);
    for (const later of [new Error('SECRET cursor'), { data: [], nextCursor: 'repeat' }]) {
        const result = await collectGeneratedImages(pages({ data: [entry()], nextCursor: 'repeat' }, later), THREAD, TURN, options);
        assert.equal(result.images.length, 1);
        assert.equal(result.warning, GENERATED_MEDIA_WARNING);
        assert.equal(JSON.stringify(result).includes('SECRET'), false);
    }
});

test('untrusted thread or turn paths never trigger an API request or filesystem write', async t => {
    const { options } = await fixture(t);
    const client = pages();
    assert.deepEqual(await collectGeneratedImages(client, '../SECRET', TURN, options), { images: [], warning: GENERATED_MEDIA_WARNING });
    assert.deepEqual(await collectGeneratedImages(client, THREAD, '../SECRET', options), { images: [], warning: GENERATED_MEDIA_WARNING });
    assert.equal(client.calls.length, 0);
});

test('supplemental image failures retain completed text and pure images get a short caption', async () => {
    const failed = await withGeneratedImages({ threadId: THREAD, text: '任务已完成。' }, async () => { throw new Error('SECRET file'); });
    assert.deepEqual(failed, { threadId: THREAD, text: `任务已完成。\n\n${GENERATED_MEDIA_WARNING}` });
    const images = [{ path: 'C:\\allowed\\image.png' }];
    assert.deepEqual(await withGeneratedImages({ threadId: THREAD, text: '' }, async () => ({ images })), { threadId: THREAD, text: '图片已生成。', images });
    assert.deepEqual(await withGeneratedImages({ threadId: THREAD, text: '' }, async () => { throw new Error('SECRET file'); }), {
        threadId: THREAD, text: GENERATED_MEDIA_WARNING
    });
    await assert.rejects(withGeneratedImages({ threadId: THREAD, text: '' }, async () => ({ images: [] })), { code: 'invalid_output' });
});
