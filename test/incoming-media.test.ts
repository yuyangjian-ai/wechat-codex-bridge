import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { downloadIncomingMedia, IncomingMediaError, type IncomingMediaAttachment } from '../src/incoming-media.js';

const KEY = Buffer.from('112233445566778899aabbccddeeff00', 'hex');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const SILK = Buffer.concat([Buffer.from([2]), Buffer.from('#!SILK_V3'), Buffer.from([10, 0, 1, 2, 3, 4, 5])]);

function directory(t: TestContext): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-incoming-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return path.join(root, 'account', 'job', '0');
}

function encrypt(bytes: Buffer, key = KEY): Buffer {
    const cipher = createCipheriv('aes-128-ecb', key, null);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function attachment(kind: 'image' | 'voice' = 'image'): IncomingMediaAttachment {
    return { kind, media: { encrypt_query_param: 'opaque & download / parameter', aes_key: KEY.toString('base64') } };
}

function fetchBytes(bytes: Buffer, check?: (url: string, init: RequestInit) => void): typeof fetch {
    return async (url, init = {}) => {
        check?.(String(url), init);
        return new Response(new Uint8Array(bytes));
    };
}

function code(expected: IncomingMediaError['code']): (error: unknown) => boolean {
    return error => error instanceof IncomingMediaError && error.code === expected;
}

test('image download decrypts bytes and sends only an unauthenticated CDN GET', async t => {
    const target = directory(t);
    let calls = 0;
    const result = await downloadIncomingMedia(attachment(), target, { fetch: fetchBytes(encrypt(PNG), (rawUrl, init) => {
        calls++;
        const url = new URL(rawUrl);
        assert.equal(url.origin, 'https://novac2c.cdn.weixin.qq.com');
        assert.equal(url.pathname, '/c2c/download');
        assert.equal(url.searchParams.get('encrypted_query_param'), 'opaque & download / parameter');
        assert.equal(init.method, 'GET');
        assert.equal(init.redirect, 'error');
        assert.equal(init.credentials, 'omit');
        const sentHeaders: string[] = [];
        new Headers(init.headers).forEach((_value, name) => sentHeaders.push(name));
        assert.deepEqual(sentHeaders, ['accept']);
        assert.ok(init.signal);
    }) });
    assert.equal(calls, 1);
    assert.equal(result.kind, 'image');
    assert.equal(path.dirname(result.path), fs.realpathSync(target));
    assert.match(path.basename(result.path), /^image-[0-9a-f-]{36}\.png$/);
    assert.deepEqual(fs.readFileSync(result.path), PNG);
});

test('image top-level hex key takes priority, full URL is used unchanged, and supplied filenames are ignored', async t => {
    const input = { ...attachment(), aesKeyHex: KEY.toString('hex'), fileName: '../../elsewhere.png' };
    input.media = { full_url: 'https://media.cdn.weixin.qq.com/signed/download?signature=secret', aes_key: Buffer.alloc(16, 4).toString('base64') };
    const result = await downloadIncomingMedia(input, directory(t), { fetch: fetchBytes(encrypt(PNG), (url) => assert.equal(url, input.media.full_url)) });
    assert.deepEqual(fs.readFileSync(result.path), PNG);
    assert.doesNotMatch(result.path, /elsewhere/);
});

test('voice download accepts base64 hex-text keys and retains SILK bytes without transcription', async t => {
    const input = attachment('voice');
    input.media.aes_key = Buffer.from(KEY.toString('hex'), 'ascii').toString('base64');
    const result = await downloadIncomingMedia(input, directory(t), { fetch: fetchBytes(encrypt(SILK)) });
    assert.equal(result.kind, 'voice');
    assert.match(result.path, /\.silk$/);
    assert.deepEqual(fs.readFileSync(result.path), SILK);
});

test('keyless image references support the plain CDN image variant', async t => {
    const input = attachment();
    delete input.media.aes_key;
    const result = await downloadIncomingMedia(input, directory(t), { fetch: fetchBytes(PNG) });
    assert.deepEqual(fs.readFileSync(result.path), PNG);
});

test('unsupported URL hosts, credentials, local targets, fragments, and redirects never get followed', async t => {
    for (const url of [
        'http://novac2c.cdn.weixin.qq.com/a', 'https://evil.example/a',
        'https://novac2c.cdn.weixin.qq.com.evil.example/a', 'https://127.0.0.1/a',
        'https://[::1]/a', 'file:///C:/secret', 'https://weixin.qq.com/a',
        'https://user:pass@novac2c.cdn.weixin.qq.com/a',
        'https://novac2c.cdn.weixin.qq.com:444/a', 'https://novac2c.cdn.weixin.qq.com/a#fragment'
    ]) {
        const input = attachment();
        input.media.full_url = url;
        await assert.rejects(downloadIncomingMedia(input, directory(t), { fetch: async () => { assert.fail('unsafe URL was fetched'); } }), code('invalid_media'));
    }
    let calls = 0;
    await assert.rejects(downloadIncomingMedia(attachment(), directory(t), { fetch: async () => {
        calls++;
        return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/secret' } });
    } }), code('download_failed'));
    assert.equal(calls, 1);
});

test('bad AES keys are rejected before networking without leaking their values', async t => {
    for (const key of ['invalid secret!', Buffer.alloc(17).toString('base64'), Buffer.from('z'.repeat(32)).toString('base64')]) {
        const input = attachment();
        input.media.aes_key = key;
        await assert.rejects(downloadIncomingMedia(input, directory(t), { fetch: async () => assert.fail('invalid key was fetched') }), error => {
            assert.ok(error instanceof IncomingMediaError);
            assert.equal(error.code, 'invalid_media');
            assert.ok(!error.message.includes(key));
            return true;
        });
    }
    const voice = attachment('voice');
    delete voice.media.aes_key;
    await assert.rejects(downloadIncomingMedia(voice, directory(t)), code('invalid_media'));
    await assert.rejects(downloadIncomingMedia({ ...attachment(), aesKeyHex: 'bad hex secret' }, directory(t)), code('invalid_media'));
});

test('wrong ciphertext is a sanitized decryption failure and no file is stored', async t => {
    const target = directory(t);
    await assert.rejects(downloadIncomingMedia(attachment(), target, { fetch: fetchBytes(Buffer.from('not encrypted')) }), code('decrypt_failed'));
    assert.equal(fs.existsSync(target), false);
});

test('unencrypted and decrypted non-image payloads are rejected even with image HTTP metadata', async t => {
    for (const encrypted of [false, true]) {
        const input = attachment();
        if (!encrypted) delete input.media.aes_key;
        const bytes = Buffer.from('<html>not an image</html>');
        const target = directory(t);
        await assert.rejects(downloadIncomingMedia(input, target, { fetch: fetchBytes(encrypted ? encrypt(bytes) : bytes) }), code('invalid_media'));
        assert.equal(fs.existsSync(target), false);
    }
});

test('content-length and streaming limits reject oversized ciphertext before saving', async t => {
    const target = directory(t);
    await assert.rejects(downloadIncomingMedia(attachment(), target, { maxBytes: 32, fetch: async () => new Response('small body', { headers: { 'content-length': '49' } }) }), code('too_large'));
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(32)); controller.enqueue(new Uint8Array(32)); },
        cancel() { cancelled = true; }
    });
    await assert.rejects(downloadIncomingMedia(attachment(), target, { maxBytes: 32, fetch: async () => new Response(stream) }), code('too_large'));
    assert.equal(cancelled, true);
    assert.equal(fs.existsSync(target), false);
});

test('plaintext limit is enforced after removing AES padding', async t => {
    await assert.rejects(downloadIncomingMedia(attachment(), directory(t), { maxBytes: PNG.length - 1, fetch: fetchBytes(encrypt(PNG)) }), code('too_large'));
    const result = await downloadIncomingMedia(attachment(), directory(t), { maxBytes: PNG.length, fetch: fetchBytes(encrypt(PNG)) });
    assert.deepEqual(fs.readFileSync(result.path), PNG);
    await assert.rejects(downloadIncomingMedia(attachment(), directory(t), { maxBytes: 20 * 1024 * 1024 + 1 }), code('invalid_media'));
});

test('timeout covers a stalled response body and cancels its reader', async t => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(downloadIncomingMedia(attachment(), directory(t), { timeoutMs: 20, fetch: async () => new Response(stream) }), code('timeout'));
    assert.equal(cancelled, true);
});

test('caller cancellation works before a request and during a stalled fetch', async t => {
    const preAborted = new AbortController();
    preAborted.abort();
    await assert.rejects(downloadIncomingMedia(attachment(), directory(t), { signal: preAborted.signal, fetch: async () => assert.fail('aborted call fetched') }), code('cancelled'));
    const controller = new AbortController();
    let networkSignal: AbortSignal | null | undefined;
    const pending = downloadIncomingMedia(attachment(), directory(t), { signal: controller.signal, fetch: async (_url, init) => {
        networkSignal = init?.signal;
        queueMicrotask(() => controller.abort());
        return new Promise<Response>(() => {});
    } });
    await assert.rejects(pending, code('cancelled'));
    assert.equal(networkSignal?.aborted, true);
});

test('network failures are not retried and do not expose URL query or vendor response text', async t => {
    let calls = 0;
    await assert.rejects(downloadIncomingMedia(attachment(), directory(t), { fetch: async () => {
        calls++;
        throw new Error('https://cdn.weixin.qq.com/?secret=aes-token');
    } }), error => {
        assert.ok(error instanceof IncomingMediaError);
        assert.equal(error.code, 'download_failed');
        assert.doesNotMatch(error.message, /secret|aes-token|https/);
        return true;
    });
    assert.equal(calls, 1);
});

test('image format extensions and voice formats come from file bytes', async t => {
    const webp = Buffer.from('524946460c000000574542505650382000000000', 'hex');
    const gif = Buffer.from('474946383961010001008000000000003b', 'hex');
    const jpeg = Buffer.from('ffd8ffe00002ffd9', 'hex');
    for (const [bytes, extension] of [[webp, '.webp'], [gif, '.gif'], [jpeg, '.jpg']] as const) {
        const result = await downloadIncomingMedia(attachment(), directory(t), { fetch: fetchBytes(encrypt(bytes)) });
        assert.equal(path.extname(result.path), extension);
    }
    for (const [bytes, extension] of [[Buffer.from('RIFF0000WAVEfmt '), '.wav'], [Buffer.from('#!SILK_V3\nvoice'), '.silk'], [Buffer.from('ID3voice'), '.mp3']] as const) {
        const result = await downloadIncomingMedia(attachment('voice'), directory(t), { fetch: fetchBytes(encrypt(bytes)) });
        assert.equal(path.extname(result.path), extension);
    }
});

test('relative, UNC and symlinked output directories are rejected and cannot redirect writes', async t => {
    for (const target of ['relative/job', '\\\\server\\share\\job']) {
        await assert.rejects(downloadIncomingMedia(attachment(), target, { fetch: fetchBytes(encrypt(PNG)) }), code('unsafe_directory'));
    }
    const target = directory(t);
    const root = path.dirname(path.dirname(path.dirname(target)));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    const linked = path.join(root, 'linked');
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(downloadIncomingMedia(attachment(), path.join(linked, 'job'), { fetch: fetchBytes(encrypt(PNG)) }), code('unsafe_directory'));
    assert.deepEqual(fs.readdirSync(outside), []);
});
