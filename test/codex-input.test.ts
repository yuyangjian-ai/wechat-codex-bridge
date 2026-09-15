import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildCodexInput, IMAGE_ONLY_PROMPT } from '../src/codex-input.js';
import { CodexRunError, type CodexRunInput } from '../src/codex.js';

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'codex-native-input-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('codex-native-input-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const file = path.join(root, 'image.png');
    await fs.writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'));
    return { root, file };
}

function safe(error: unknown): boolean {
    assert.ok(error instanceof CodexRunError);
    assert.equal(error.code, 'invalid_output');
    assert.equal(error.cause, undefined);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes('SECRET'), false);
    return true;
}

test('native input keeps the prompt unchanged and attaches images as localImage items', async t => {
    const { file } = await fixture(t);
    const text = '请解释这张图，不要把路径当成文字内容。';
    assert.deepEqual(await buildCodexInput({ prompt: text, images: [{ path: file }] }), [
        { type: 'text', text, text_elements: [] },
        { type: 'localImage', path: file }
    ]);
    assert.deepEqual(await buildCodexInput({ prompt: '   ', images: [{ path: file }] }), [
        { type: 'text', text: IMAGE_ONLY_PROMPT, text_elements: [] },
        { type: 'localImage', path: file }
    ]);
    assert.deepEqual(await buildCodexInput({ prompt: '普通问题', images: [] }), [{ type: 'text', text: '普通问题', text_elements: [] }]);
});

test('rejects excess images, empty content and malformed image descriptors', async t => {
    const { file } = await fixture(t);
    await assert.rejects(buildCodexInput({ prompt: '图', images: Array.from({ length: 5 }, () => ({ path: file })) }), safe);
    await assert.rejects(buildCodexInput({ prompt: '' }), safe);
    for (const images of [null, {}, ['SECRET'], [{ path: 17 }], [null]]) {
        await assert.rejects(buildCodexInput({ prompt: '图', images } as CodexRunInput), safe);
    }
});

test('rejects remote URLs, file URLs, UNC/device paths, relative paths and unsupported extensions', async t => {
    const { root } = await fixture(t);
    for (const file of [
        'https://example.com/SECRET.png', 'file:///C:/SECRET.png', '\\\\server\\share\\SECRET.png',
        '\\\\?\\C:\\SECRET.png', 'relative-SECRET.png', path.join(root, 'SECRET.txt'),
        path.join(root, 'SECRET\0.png'), 'C:\\SECRET.txt:photo.png'
    ]) {
        await assert.rejects(buildCodexInput({ prompt: '图', images: [{ path: file }] }), safe);
    }
});

test('rejects missing files, image-named directories, empty files, links and files over the limit', async t => {
    const { root, file } = await fixture(t);
    const directory = path.join(root, 'directory.png'); await fs.mkdir(directory);
    const empty = path.join(root, 'empty.png'); await fs.writeFile(empty, Buffer.alloc(0));
    const large = path.join(root, 'large.png'); await fs.writeFile(large, 'x'); await fs.truncate(large, 20 * 1024 * 1024 + 1);
    const link = path.join(root, 'linked.png');
    await fs.symlink(process.platform === 'win32' ? directory : file, link, process.platform === 'win32' ? 'junction' : 'file');
    for (const invalid of [path.join(root, 'SECRET-missing.png'), directory, empty, large, link]) {
        await assert.rejects(buildCodexInput({ prompt: '图', images: [{ path: invalid }] }), safe);
    }
});
