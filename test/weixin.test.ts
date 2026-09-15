import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
    loginWeixin,
    validateWeixinBaseUrl,
    WeixinAlreadyBoundError,
    WeixinApiError,
    WeixinClient,
    type WeixinCredentials,
    type WeixinLoginOptions
} from '../src/weixin.js';

const credentials: WeixinCredentials = {
    token: 'test-bot-secret',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    botId: 'test-bot',
    userId: 'test-owner'
};

interface CapturedRequest {
    url: URL;
    init: RequestInit;
    body: Record<string, unknown> | undefined;
    headers: Headers;
}

function scriptedFetch(replies: Array<unknown | Response | ((request: CapturedRequest) => Response | Promise<Response>)>): { fetch: typeof fetch; requests: CapturedRequest[] } {
    const requests: CapturedRequest[] = [];
    const fetchImpl: typeof fetch = async (input, init = {}) => {
        const captured = {
            url: new URL(String(input)),
            init,
            body: typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined,
            headers: new Headers(init.headers)
        };
        requests.push(captured);
        assert.ok(replies.length > 0, 'Unexpected extra request (possibly a blind retry)');
        const reply = replies.shift();
        if (typeof reply === 'function') return await (reply as (request: CapturedRequest) => Response | Promise<Response>)(captured);
        return reply instanceof Response ? reply : Response.json(reply);
    };
    return { fetch: fetchImpl, requests };
}

function waitForAbort(request: CapturedRequest): Promise<Response> {
    return new Promise((_resolve, reject) => {
        const signal = request.init.signal;
        assert.ok(signal);
        if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
}

function loginOptions(fetchImpl: typeof fetch, extra: Partial<WeixinLoginOptions> = {}): WeixinLoginOptions {
    return { fetch: fetchImpl, onQRCode: async () => {}, pollIntervalMs: 0, ...extra };
}

const qr = { qrcode: 'test qr & id', qrcode_img_content: 'https://weixin.qq.com/test-qr' };
const confirmed = {
    status: 'confirmed',
    bot_token: credentials.token,
    ilink_bot_id: credentials.botId,
    ilink_user_id: credentials.userId,
    baseurl: credentials.baseUrl
};

test('poll sends the authenticated iLink wire headers, cursor and v2.4.8 metadata', async () => {
    const wire = scriptedFetch([{ ret: 0, msgs: [], get_updates_buf: 'next' }]);
    const result = await new WeixinClient(credentials, { fetch: wire.fetch }).poll('previous');
    assert.deepEqual(result, { msgs: [], get_updates_buf: 'next' });
    const request = wire.requests[0]!;
    assert.equal(request.url.pathname, '/ilink/bot/getupdates');
    assert.equal(request.init.method, 'POST');
    assert.equal(request.init.redirect, 'error');
    assert.equal(request.headers.get('Authorization'), `Bearer ${credentials.token}`);
    assert.equal(request.headers.get('AuthorizationType'), 'ilink_bot_token');
    assert.equal(request.headers.get('Content-Type'), 'application/json');
    assert.equal(request.headers.get('iLink-App-Id'), 'bot');
    assert.equal(request.headers.get('iLink-App-ClientVersion'), '132104');
    const uin = Buffer.from(request.headers.get('X-WECHAT-UIN')!, 'base64').toString('utf8');
    assert.match(uin, /^\d+$/);
    assert.ok(Number(uin) <= 0xffffffff);
    assert.deepEqual(request.body, {
        get_updates_buf: 'previous',
        base_info: { channel_version: '2.4.8', bot_agent: 'WeChatCodexBridge/0.1.0' }
    });
});

test('poll preserves adjacent uint64 IDs and literal JSON-looking message content', async () => {
    const text = 'literal "message_id": 18446744073709551615';
    const wire = scriptedFetch([new Response(`{"msgs":[{"message_id":18446744073709551614,"item_list":[{"type":1,"text_item":{"text":${JSON.stringify(text)}}}]},{"message_id":18446744073709551615}]}`)]);
    const result = await new WeixinClient(credentials, { fetch: wire.fetch }).poll('');
    assert.equal(result.msgs[0]?.message_id, '18446744073709551614');
    assert.equal(result.msgs[1]?.message_id, '18446744073709551615');
    assert.equal(result.msgs[0]?.item_list?.[0]?.text_item?.text, text);
});

test('poll timeout keeps the existing cursor while caller cancellation throws AbortError', async () => {
    const timedWire = scriptedFetch([waitForAbort]);
    const timed = await new WeixinClient(credentials, { fetch: timedWire.fetch, pollTimeoutMs: 5 }).poll('saved');
    assert.deepEqual(timed, { msgs: [], get_updates_buf: 'saved' });
    const abortedWire = scriptedFetch([waitForAbort]);
    const controller = new AbortController();
    const promise = new WeixinClient(credentials, { fetch: abortedWire.fetch }).poll('saved', controller.signal);
    controller.abort(new Error('caller-secret'));
    await assert.rejects(promise, { name: 'AbortError', message: 'Weixin operation cancelled' });
    const alreadyAborted = scriptedFetch([]);
    await assert.rejects(new WeixinClient(credentials, { fetch: alreadyAborted.fetch }).poll('saved', controller.signal), { name: 'AbortError' });
    assert.equal(alreadyAborted.requests.length, 0);
});

test('business error in either ret or errcode fails without including backend secrets', async () => {
    for (const status of [{ ret: -14 }, { ret: 0, errcode: 7 }]) {
        const wire = scriptedFetch([{ ...status, errmsg: 'reflected-token-secret', msgs: [] }]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch }).poll(''), (error: unknown) => {
            assert.ok(error instanceof WeixinApiError);
            assert.doesNotMatch(String(error), /secret/);
            assert.equal(error.ret, status.ret);
            assert.equal(error.errcode, 'errcode' in status ? status.errcode : undefined);
            return true;
        });
    }
});

test('malformed responses and HTTP errors are rejected without leaking response bodies', async () => {
    for (const response of [new Response('reflected-token-secret', { status: 401 }), new Response('{"token":"reflected-token-secret"'), Response.json({ msgs: [null] }), Response.json({ msgs: [], get_updates_buf: 123 })]) {
        const wire = scriptedFetch([response]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch }).poll(''), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(String(error), /secret/);
            return true;
        });
    }
});

test('sendText uses the incoming context, recipient and stable client ID in one POST', async () => {
    const wire = scriptedFetch([{ ret: 0 }]);
    await new WeixinClient(credentials, { fetch: wire.fetch }).sendText('recipient', 'incoming-context', '你好', 'stable-client-id');
    assert.equal(wire.requests.length, 1);
    assert.equal(wire.requests[0]?.url.pathname, '/ilink/bot/sendmessage');
    assert.deepEqual(wire.requests[0]?.body?.msg, {
        from_user_id: '', to_user_id: 'recipient', client_id: 'stable-client-id', message_type: 2, message_state: 2,
        context_token: 'incoming-context', item_list: [{ type: 1, text_item: { text: '你好' } }]
    });
});

test('sendText does not retry a lost response, timeout or business failure', async () => {
    const scenarios = [
        (() => { throw new Error('network failed with token-secret'); }),
        waitForAbort,
        { errcode: 9, errmsg: 'token-secret' }
    ];
    for (const scenario of scenarios) {
        const wire = scriptedFetch([scenario]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch, requestTimeoutMs: 5 }).sendText('user', 'context', 'text', 'one-id'), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(String(error), /secret/);
            return true;
        });
        assert.equal(wire.requests.length, 1);
    }
});

test('API bases reject third-party hosts, credential tricks, HTTP, paths and ports', () => {
    for (const url of ['http://ilinkai.weixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://evil.test', 'https://weixin.qq.com@evil.test', 'https://x@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444', 'https://ilinkai.weixin.qq.com/path', 'https://ilinkai.weixin.qq.com/?secret=1', 'https://ilinkai.weixin.qq.com/#secret']) {
        assert.throws(() => validateWeixinBaseUrl(url));
        assert.throws(() => new WeixinClient({ ...credentials, baseUrl: url }));
    }
    assert.equal(validateWeixinBaseUrl('https://region.ilinkai.weixin.qq.com/'), 'https://region.ilinkai.weixin.qq.com');
});

test('QR login uses unauthenticated POST and app-only GET headers, and returns credentials', async () => {
    const wire = scriptedFetch([qr, { status: 'wait' }, { status: 'scaned' }, confirmed]);
    const contents: string[] = [];
    const statuses: string[] = [];
    const result = await loginWeixin(loginOptions(wire.fetch, {
        existingTokens: Array.from({ length: 12 }, (_, n) => `local-${n}`),
        onQRCode: async (content) => { contents.push(content); },
        onStatus: (status) => { statuses.push(status); }
    }));
    assert.deepEqual(result, credentials);
    assert.deepEqual(contents, [qr.qrcode_img_content]);
    assert.deepEqual(statuses, ['wait', 'scaned', 'confirmed']);
    assert.equal(wire.requests[0]?.url.pathname, '/ilink/bot/get_bot_qrcode');
    assert.equal(wire.requests[0]?.url.searchParams.get('bot_type'), '3');
    assert.deepEqual(wire.requests[0]?.body, { local_token_list: Array.from({ length: 10 }, (_, n) => `local-${11 - n}`) });
    assert.equal(wire.requests[0]?.headers.get('Authorization'), null);
    assert.equal(wire.requests[0]?.headers.get('AuthorizationType'), 'ilink_bot_token');
    for (const request of wire.requests.slice(1)) {
        assert.equal(request.init.method, 'GET');
        assert.equal(request.init.redirect, 'error');
        assert.equal(request.body, undefined);
        assert.equal(request.url.searchParams.get('qrcode'), qr.qrcode);
        const headerNames: string[] = [];
        request.headers.forEach((_value, name) => { headerNames.push(name); });
        assert.deepEqual(headerNames.sort(), ['ilink-app-clientversion', 'ilink-app-id']);
    }
});

test('QR login follows a Weixin status redirect and resubmits verification until accepted', async () => {
    const wire = scriptedFetch([
        qr,
        { status: 'scaned_but_redirect', redirect_host: 'region.weixin.qq.com' },
        { status: 'need_verifycode' },
        { status: 'need_verifycode' },
        { status: 'scaned' },
        { ...confirmed, baseurl: 'https://region.weixin.qq.com/' }
    ]);
    const codes = ['123', '456'];
    const result = await loginWeixin(loginOptions(wire.fetch, { onVerification: async () => codes.shift()! }));
    assert.equal(result.baseUrl, 'https://region.weixin.qq.com');
    assert.equal(wire.requests[2]?.url.origin, result.baseUrl);
    assert.equal(wire.requests[3]?.url.searchParams.get('verify_code'), '123');
    assert.equal(wire.requests[4]?.url.searchParams.get('verify_code'), '456');
    assert.equal(wire.requests[5]?.url.searchParams.get('verify_code'), null);
});

test('expired or blocked QR codes refresh from the fixed origin and clear the verification code', async () => {
    for (const status of ['expired', 'verify_code_blocked']) {
        const wire = scriptedFetch([
            qr,
            { status: 'scaned_but_redirect', redirect_host: 'region.weixin.qq.com' },
            { status: 'need_verifycode' },
            { status },
            { qrcode: 'replacement', qrcode_img_content: 'replacement-content' },
            confirmed
        ]);
        const contents: string[] = [];
        await loginWeixin(loginOptions(wire.fetch, {
            onQRCode: async (content) => { contents.push(content); },
            onVerification: async () => '123'
        }));
        assert.deepEqual(contents, [qr.qrcode_img_content, 'replacement-content']);
        assert.equal(wire.requests[4]?.url.origin, credentials.baseUrl);
        assert.equal(wire.requests[5]?.url.origin, credentials.baseUrl);
        assert.equal(wire.requests[5]?.url.searchParams.get('qrcode'), 'replacement');
        assert.equal(wire.requests[5]?.url.searchParams.get('verify_code'), null);
    }
});

test('QR login rejects an unsafe redirect or confirmed base before sending credentials', async () => {
    for (const response of [{ status: 'scaned_but_redirect', redirect_host: 'evil.test' }, { ...confirmed, baseurl: 'https://evil.test' }]) {
        const wire = scriptedFetch([qr, response]);
        await assert.rejects(loginWeixin(loginOptions(wire.fetch)), /HTTPS weixin.qq.com/);
        assert.equal(wire.requests.length, 2);
    }
});

test('QR login handles already-bound state and rejects missing credentials or application failures', async () => {
    const boundWire = scriptedFetch([qr, { status: 'binded_redirect' }]);
    await assert.rejects(loginWeixin(loginOptions(boundWire.fetch)), WeixinAlreadyBoundError);
    const missingWire = scriptedFetch([qr, { ...confirmed, bot_token: '' }]);
    await assert.rejects(loginWeixin(loginOptions(missingWire.fetch)), /complete credentials/);
    const errorWire = scriptedFetch([qr, { ret: 0, errcode: 2, status: 'confirmed', errmsg: 'secret' }]);
    await assert.rejects(loginWeixin(loginOptions(errorWire.fetch)), WeixinApiError);
});

test('QR refresh limit stops after three codes', async () => {
    const wire = scriptedFetch([qr, { status: 'expired' }, qr, { status: 'expired' }, qr, { status: 'expired' }]);
    await assert.rejects(loginWeixin(loginOptions(wire.fetch)), /three QR codes/);
    assert.equal(wire.requests.length, 6);
});

test('QR polling timeout continues but overall timeout and external cancellation stop login', async () => {
    const transientWire = scriptedFetch([qr, waitForAbort, confirmed]);
    assert.deepEqual(await loginWeixin(loginOptions(transientWire.fetch, { requestTimeoutMs: 5 })), credentials);
    const deadlineWire = scriptedFetch([qr, waitForAbort]);
    await assert.rejects(loginWeixin(loginOptions(deadlineWire.fetch, { timeoutMs: 10 })), /login timed out/);
    const controller = new AbortController();
    const abortedWire = scriptedFetch([qr]);
    await assert.rejects(loginWeixin(loginOptions(abortedWire.fetch, {
        signal: controller.signal,
        onQRCode: async () => { controller.abort(); }
    })), { name: 'AbortError' });
    assert.equal(abortedWire.requests.length, 1);
});

function localImageFixture(t: TestContext): { file: string; directory: string; bytes: Buffer } {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-image-test-'));
    const file = path.join(directory, 'private-image-path.png');
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfkUAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(file, bytes);
    t.after(() => {
        for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
        fs.rmdirSync(directory);
    });
    return { file, directory, bytes };
}

function uploadSucceeded(): Response {
    return new Response('', { status: 200, headers: { 'x-encrypted-param': 'secret-download-param' } });
}

test('sendImage uploads AES-128-ECB bytes then sends an image item with the correct key encoding and stable client ID', async t => {
    const fixture = localImageFixture(t);
    const wire = scriptedFetch([{ upload_param: 'secret upload+param&value' }, uploadSucceeded(), { ret: 0 }]);
    await new WeixinClient(credentials, { fetch: wire.fetch }).sendImage('image-user', 'secret-image-context', fixture.file, 'image-stable-id');
    assert.equal(wire.requests.length, 3);
    const ticket = wire.requests[0]!;
    const upload = wire.requests[1]!;
    const message = wire.requests[2]!;
    assert.equal(ticket.url.pathname, '/ilink/bot/getuploadurl');
    assert.equal(ticket.headers.get('Authorization'), `Bearer ${credentials.token}`);
    const body = ticket.body!;
    assert.equal(body.media_type, 1);
    assert.equal(body.to_user_id, 'image-user');
    assert.equal(body.rawsize, fixture.bytes.length);
    assert.equal(body.rawfilemd5, createHash('md5').update(fixture.bytes).digest('hex'));
    assert.equal(body.filesize, Math.ceil((fixture.bytes.length + 1) / 16) * 16);
    assert.equal(body.no_need_thumb, true);
    assert.match(body.filekey as string, /^[a-f0-9]{32}$/);
    assert.match(body.aeskey as string, /^[a-f0-9]{32}$/);
    assert.deepEqual(body.base_info, { channel_version: '2.4.8', bot_agent: 'WeChatCodexBridge/0.1.0' });

    assert.equal(upload.url.origin, 'https://novac2c.cdn.weixin.qq.com');
    assert.equal(upload.url.pathname, '/c2c/upload');
    assert.equal(upload.url.searchParams.get('encrypted_query_param'), 'secret upload+param&value');
    assert.equal(upload.url.searchParams.get('filekey'), body.filekey);
    assert.equal(upload.init.method, 'POST');
    assert.equal(upload.init.redirect, 'error');
    assert.equal(upload.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(upload.headers.get('Authorization'), null);
    assert.equal(upload.headers.get('AuthorizationType'), null);
    assert.equal(upload.headers.get('iLink-App-Id'), null);
    assert.ok(upload.init.body instanceof Uint8Array);
    const ciphertext = Buffer.from(upload.init.body);
    assert.notDeepEqual(ciphertext, fixture.bytes);
    assert.equal(ciphertext.length, body.filesize);
    const decipher = createDecipheriv('aes-128-ecb', Buffer.from(body.aeskey as string, 'hex'), null);
    assert.deepEqual(Buffer.concat([decipher.update(ciphertext), decipher.final()]), fixture.bytes);
    assert.equal(message.url.pathname, '/ilink/bot/sendmessage');
    assert.equal(message.headers.get('Authorization'), `Bearer ${credentials.token}`);
    assert.deepEqual(message.body?.msg, {
        from_user_id: '', to_user_id: 'image-user', client_id: 'image-stable-id',
        message_type: 2, message_state: 2, context_token: 'secret-image-context',
        item_list: [{ type: 2, image_item: {
            media: {
                encrypt_query_param: 'secret-download-param',
                aes_key: Buffer.from(body.aeskey as string, 'utf8').toString('base64'),
                encrypt_type: 1
            },
            mid_size: ciphertext.length
        } }]
    });
    assert.doesNotMatch(JSON.stringify(ticket.body) + JSON.stringify(message.body), /private-image-path/);
});

test('sendImage prefers a valid full upload URL over the fallback parameter', async t => {
    const fixture = localImageFixture(t);
    const fullUrl = 'https://regional.cdn.weixin.qq.com/custom-upload?ticket=secret-full-ticket';
    const wire = scriptedFetch([{ upload_full_url: fullUrl, upload_param: 'unused-fallback' }, uploadSucceeded(), { ret: 0 }]);
    await new WeixinClient(credentials, { fetch: wire.fetch }).sendImage('user', 'context', fixture.file);
    assert.equal(wire.requests[1]?.url.toString(), fullUrl);
});

test('sendImage rejects URLs, relative paths, network paths and non-image files without network requests', async t => {
    const fixture = localImageFixture(t);
    const notImage = path.join(fixture.directory, 'private-secret-file.png');
    fs.writeFileSync(notImage, 'private-secret-contents');
    for (const file of ['https://example.com/private-secret-image.png', 'relative.png', '\\\\host\\share\\private-secret.png', fixture.directory, notImage, path.join(fixture.directory, 'missing-secret.png')]) {
        const wire = scriptedFetch([]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch }).sendImage('user', 'context', file), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(String(error), /private-secret|example.com|host|missing-secret/);
            return true;
        });
        assert.equal(wire.requests.length, 0);
    }
});

test('sendImage rejects failed upload tickets or unsafe upload hosts before posting image bytes', async t => {
    const fixture = localImageFixture(t);
    for (const response of [
        { ret: -2, errmsg: 'secret-token-reflected' },
        { ret: 0, errcode: 9, errmsg: 'secret-token-reflected' },
        {},
        { upload_full_url: 'https://weixin.qq.com.secret.example/upload?token=secret' },
        { upload_full_url: 'http://novac2c.cdn.weixin.qq.com/upload?token=secret' },
        { upload_full_url: 'https://secret@novac2c.cdn.weixin.qq.com/upload' }
    ]) {
        const wire = scriptedFetch([response]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch }).sendImage('user', 'context', fixture.file), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(String(error), /secret|token-reflected/);
            return true;
        });
        assert.equal(wire.requests.length, 1);
    }
});

test('sendImage fails once on CDN HTTP errors, missing download headers or timeout and never sends a message afterwards', async t => {
    const fixture = localImageFixture(t);
    for (const uploadResponse of [
        new Response('private-secret-response', { status: 403 }),
        new Response('private-secret-response', { status: 500 }),
        new Response('', { status: 200 }),
        waitForAbort,
        () => { throw new Error('private-secret-network-error'); }
    ]) {
        const wire = scriptedFetch([{ upload_param: 'secret-param' }, uploadResponse]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch, uploadTimeoutMs: 5 }).sendImage('user', 'context', fixture.file), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(String(error), /private-secret|secret-param/);
            return true;
        });
        assert.equal(wire.requests.length, 2);
    }
});

test('sendImage does not repeat a final send when its response is lost or contains a business error', async t => {
    const fixture = localImageFixture(t);
    for (const reply of [
        { ret: 0, errcode: 3, errmsg: 'private-secret-error' },
        () => { throw new Error('private-secret-network-error'); },
        waitForAbort
    ]) {
        const wire = scriptedFetch([{ upload_param: 'secret-param' }, uploadSucceeded(), reply]);
        await assert.rejects(new WeixinClient(credentials, { fetch: wire.fetch, requestTimeoutMs: 5 }).sendImage('user', 'context', fixture.file, 'same-image-client-id'));
        assert.equal(wire.requests.length, 3);
        assert.equal((wire.requests[2]?.body?.msg as Record<string, unknown>).client_id, 'same-image-client-id');
    }
});
