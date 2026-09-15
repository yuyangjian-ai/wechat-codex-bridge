import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Wire contract verified against Tencent/openclaw-weixin v2.4.8:
// https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md
const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '2.4.8';
const CLIENT_VERSION = String((2 << 16) | (4 << 8) | 8);
const BASE_INFO = { channel_version: CHANNEL_VERSION, bot_agent: 'WeChatCodexBridge/0.1.0' };
const DEFAULT_CDN_UPLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/upload';

export interface WeixinCredentials {
    token: string;
    baseUrl: string;
    botId: string;
    userId: string;
}

export interface WeixinCDNMedia {
    encrypt_query_param?: string;
    aes_key?: string;
    full_url?: string;
    encrypt_type?: number;
}

export interface WeixinImageItem {
    media?: WeixinCDNMedia;
    thumb_media?: WeixinCDNMedia;
    /** Inbound image key, hex encoded; preferred to media.aes_key. */
    aeskey?: string;
    mid_size?: number;
    hd_size?: number;
    [key: string]: unknown;
}

export interface WeixinVoiceItem {
    media?: WeixinCDNMedia;
    text?: string;
    encode_type?: number;
    sample_rate?: number;
    bits_per_sample?: number;
    playtime?: number;
    [key: string]: unknown;
}

export interface WeixinMessageItem {
    type?: number;
    text_item?: { text?: string; [key: string]: unknown };
    image_item?: WeixinImageItem;
    voice_item?: WeixinVoiceItem;
    [key: string]: unknown;
}

export interface WeixinMessage {
    // Numeric uint64 IDs from the wire are decoded as strings before JSON.parse.
    message_id?: string | number;
    seq?: number;
    from_user_id?: string;
    to_user_id?: string;
    client_id?: string;
    create_time_ms?: number;
    update_time_ms?: number;
    delete_time_ms?: number;
    session_id?: string;
    group_id?: string;
    message_type?: number;
    message_state?: number;
    context_token?: string;
    item_list?: WeixinMessageItem[];
    run_id?: string;
    [key: string]: unknown;
}

export interface PollResult {
    msgs: WeixinMessage[];
    get_updates_buf?: string;
}

export class WeixinApiError extends Error {
    constructor(
        operation: string,
        public readonly ret?: number,
        public readonly errcode?: number,
        public readonly httpStatus?: number
    ) {
        super(`${operation} failed${httpStatus === undefined ? '' : ` (HTTP ${httpStatus})`}${ret === undefined ? '' : ` (ret ${ret})`}${errcode === undefined ? '' : ` (errcode ${errcode})`}`);
        this.name = 'WeixinApiError';
    }
}

export class WeixinAlreadyBoundError extends Error {
    constructor() {
        super('This bot is already bound; keep using the existing local credentials.');
        this.name = 'WeixinAlreadyBoundError';
    }
}

class RequestTimeoutError extends Error {
    constructor() {
        super('Weixin request timed out');
        this.name = 'TimeoutError';
    }
}

function abortError(): Error {
    const error = new Error('Weixin operation cancelled');
    error.name = 'AbortError';
    return error;
}

function checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted) throw abortError();
}

/** Only allow an HTTPS Weixin API origin, never credentials, paths or URL redirects. */
export function validateWeixinBaseUrl(value: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid Weixin API base URL');
    }
    const host = url.hostname.toLowerCase();
    if (
        url.protocol !== 'https:' ||
        !(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')) ||
        url.username || url.password || url.port || url.search || url.hash ||
        (url.pathname !== '/' && url.pathname !== '')
    ) {
        throw new Error('Weixin API base URL must be an HTTPS weixin.qq.com origin');
    }
    return url.origin;
}

function headers(token?: string, json = true): Record<string, string> {
    const result: Record<string, string> = {
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': CLIENT_VERSION
    };
    if (json) {
        result['Content-Type'] = 'application/json';
        result.AuthorizationType = 'ilink_bot_token';
        result['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE()), 'utf8').toString('base64');
        if (token) result.Authorization = `Bearer ${token}`;
    }
    return result;
}

/** Preserve uint64 identifiers without ever rewriting text inside JSON strings. */
function parseResponse(raw: string): Record<string, unknown> {
    const quotedIds = raw.replace(/"(?:[^"\\]|\\.)*"|(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (token: string, offset: number) => {
        if (token[0] === '"') return token;
        const preceding = raw.slice(Math.max(0, offset - 128), offset);
        // The property name immediately before a numeric value is necessarily a
        // JSON token, so this anchored match cannot touch user-message text.
        if (/"(?:message_id|msg_id|svr_id)"\s*:\s*$/.test(preceding) && /^-?\d+$/.test(token)) {
            return `"${token}"`;
        }
        return token;
    });
    let data: unknown;
    try {
        data = JSON.parse(quotedIds) as unknown;
    } catch {
        // JSON parse errors can contain snippets of credentials: never forward them.
        throw new Error('Weixin returned invalid JSON');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Weixin returned an invalid response');
    return data as Record<string, unknown>;
}

function checkBusinessError(operation: string, data: Record<string, unknown>): void {
    for (const field of ['ret', 'errcode'] as const) {
        if (data[field] !== undefined && (typeof data[field] !== 'number' || !Number.isFinite(data[field]))) {
            throw new Error(`${operation} returned an invalid status code`);
        }
    }
    const ret = data.ret as number | undefined;
    const errcode = data.errcode as number | undefined;
    if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
        throw new WeixinApiError(operation, ret, errcode);
    }
}

interface RequestOptions {
    fetch: typeof fetch;
    baseUrl: string;
    endpoint: string;
    operation: string;
    token?: string;
    body?: Record<string, unknown>;
    signal?: AbortSignal;
    timeoutMs: number;
}

async function request(options: RequestOptions): Promise<Record<string, unknown>> {
    checkAbort(options.signal);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
    try {
        const response = await options.fetch(new URL(options.endpoint, validateWeixinBaseUrl(options.baseUrl)), {
            method: options.body === undefined ? 'GET' : 'POST',
            headers: headers(options.token, options.body !== undefined),
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            signal: controller.signal,
            // Never forward a POST body containing credentials to a redirected URL.
            redirect: 'error'
        });
        if (!response.ok) throw new WeixinApiError(options.operation, undefined, undefined, response.status);
        const data = parseResponse(await response.text());
        checkBusinessError(options.operation, data);
        return data;
    } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (timedOut) throw new RequestTimeoutError();
        if (error instanceof WeixinApiError) throw error;
        // Do not retain a cause: network/parse exceptions may embed a token or URL.
        throw new Error(`${options.operation} request failed`);
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}

function isLocalAbsolutePath(value: string): boolean {
    // UNC/device paths can point to network resources; this method accepts local files only.
    return path.isAbsolute(value) && !/^[\\/]{2}/.test(value) && !value.includes('\0');
}

async function readLocalImage(imagePath: string): Promise<Buffer> {
    if (!isLocalAbsolutePath(imagePath)) throw new Error('sendImage requires an absolute local image path');
    try {
        const resolved = await realpath(imagePath);
        if (!isLocalAbsolutePath(resolved)) throw new Error('not local');
        const handle = await open(resolved, 'r');
        try {
            if (!(await handle.stat()).isFile()) throw new Error('not a file');
            const bytes = await handle.readFile();
            const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
            const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
            const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
            const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
            if (!png && !jpeg && !gif && !webp) throw new Error('not a supported image');
            return bytes;
        } finally { await handle.close(); }
    } catch {
        // Filesystem exceptions include paths, and caller-provided paths can contain secrets.
        throw new Error('Unable to read a local PNG, JPEG, GIF or WebP image');
    }
}

function imageUploadUrl(data: Record<string, unknown>, filekey: string): URL {
    let value: string;
    if (typeof data.upload_full_url === 'string' && data.upload_full_url.trim()) value = data.upload_full_url.trim();
    else if (typeof data.upload_param === 'string' && data.upload_param) {
        const url = new URL(DEFAULT_CDN_UPLOAD_URL);
        url.searchParams.set('encrypted_query_param', data.upload_param);
        url.searchParams.set('filekey', filekey);
        value = url.toString();
    } else throw new Error('getuploadurl did not return an image upload URL');
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('Invalid Weixin image upload URL'); }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')) || url.username || url.password || url.port || url.hash) {
        throw new Error('Image upload URL must use HTTPS on a Weixin domain');
    }
    return url;
}

async function uploadImage(fetchImpl: typeof fetch, url: URL, ciphertext: Buffer, timeoutMs: number): Promise<string> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    try {
        const response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: new Uint8Array(ciphertext),
            signal: controller.signal,
            redirect: 'error'
        });
        // The download parameter is in the response header, never the response body.
        await response.body?.cancel();
        if (response.status !== 200) throw new WeixinApiError('imageupload', undefined, undefined, response.status);
        const downloadParam = response.headers.get('x-encrypted-param');
        if (!downloadParam?.trim()) throw new Error('missing download parameter');
        return downloadParam;
    } catch (error) {
        if (timedOut) throw new RequestTimeoutError();
        if (error instanceof WeixinApiError) throw error;
        // Never expose URL query parameters, encryption keys, response bodies or file paths.
        throw new Error('Weixin image upload failed');
    } finally { clearTimeout(timer); }
}

export interface WeixinClientOptions {
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    pollTimeoutMs?: number;
    uploadTimeoutMs?: number;
}

export class WeixinClient {
    private readonly credentials: WeixinCredentials;
    private readonly fetch: typeof fetch;
    private readonly requestTimeoutMs: number;
    private readonly uploadTimeoutMs: number;
    private pollTimeoutMs: number;

    constructor(credentials: WeixinCredentials, options: WeixinClientOptions = {}) {
        if (!credentials.token.trim()) throw new Error('Missing Weixin bot token');
        this.credentials = { ...credentials, token: credentials.token.trim(), baseUrl: validateWeixinBaseUrl(credentials.baseUrl) };
        this.fetch = options.fetch ?? globalThis.fetch;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
        this.uploadTimeoutMs = options.uploadTimeoutMs ?? 60_000;
        this.pollTimeoutMs = options.pollTimeoutMs ?? 40_000;
    }

    async poll(cursor: string, signal?: AbortSignal): Promise<PollResult> {
        let data: Record<string, unknown>;
        try {
            data = await request({
                fetch: this.fetch,
                baseUrl: this.credentials.baseUrl,
                token: this.credentials.token,
                endpoint: '/ilink/bot/getupdates',
                operation: 'getupdates',
                body: { get_updates_buf: cursor, base_info: BASE_INFO },
                timeoutMs: this.pollTimeoutMs,
                signal
            });
        } catch (error) {
            if (error instanceof RequestTimeoutError) return { msgs: [], get_updates_buf: cursor };
            throw error;
        }
        if (data.msgs !== undefined && (!Array.isArray(data.msgs) || data.msgs.some((msg) => !msg || typeof msg !== 'object' || Array.isArray(msg)))) {
            throw new Error('getupdates returned invalid messages');
        }
        if (data.get_updates_buf !== undefined && typeof data.get_updates_buf !== 'string') throw new Error('getupdates returned an invalid cursor');
        if (typeof data.longpolling_timeout_ms === 'number' && Number.isFinite(data.longpolling_timeout_ms) && data.longpolling_timeout_ms > 0) {
            this.pollTimeoutMs = Math.min(120_000, Math.max(5_000, data.longpolling_timeout_ms + 5_000));
        }
        return {
            msgs: (data.msgs ?? []) as WeixinMessage[],
            ...(typeof data.get_updates_buf === 'string' ? { get_updates_buf: data.get_updates_buf } : {})
        };
    }

    /** Single attempt only. A lost response must not cause a new client_id retry. */
    async sendText(userId: string, contextToken: string, text: string, clientId: string = randomUUID()): Promise<void> {
        if (!userId || !contextToken || !text || !clientId) throw new Error('sendmessage requires a recipient, context token, text and client ID');
        await request({
            fetch: this.fetch,
            baseUrl: this.credentials.baseUrl,
            token: this.credentials.token,
            endpoint: '/ilink/bot/sendmessage',
            operation: 'sendmessage',
            body: {
                msg: {
                    from_user_id: '',
                    to_user_id: userId,
                    client_id: clientId,
                    message_type: 2,
                    message_state: 2,
                    context_token: contextToken,
                    item_list: [{ type: 1, text_item: { text } }]
                },
                base_info: BASE_INFO
            },
            timeoutMs: this.requestTimeoutMs
        });
    }

    /** Upload an explicitly selected local image and send it once; no automatic retries. */
    async sendImage(userId: string, contextToken: string, imagePath: string, clientId: string = randomUUID()): Promise<void> {
        if (!userId || !contextToken || !imagePath || !clientId) throw new Error('sendImage requires a recipient, context token, local image and client ID');
        const plaintext = await readLocalImage(imagePath);
        const aeskey = randomBytes(16);
        const cipher = createCipheriv('aes-128-ecb', aeskey, null);
        const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const filekey = randomBytes(16).toString('hex');
        const response = await request({
            fetch: this.fetch,
            baseUrl: this.credentials.baseUrl,
            token: this.credentials.token,
            endpoint: '/ilink/bot/getuploadurl',
            operation: 'getuploadurl',
            body: {
                filekey, media_type: 1, to_user_id: userId,
                rawsize: plaintext.length,
                rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
                filesize: ciphertext.length,
                no_need_thumb: true,
                aeskey: aeskey.toString('hex'),
                base_info: BASE_INFO
            },
            timeoutMs: this.requestTimeoutMs
        });
        const downloadParam = await uploadImage(this.fetch, imageUploadUrl(response, filekey), ciphertext, this.uploadTimeoutMs);
        await request({
            fetch: this.fetch,
            baseUrl: this.credentials.baseUrl,
            token: this.credentials.token,
            endpoint: '/ilink/bot/sendmessage',
            operation: 'sendmessage',
            body: {
                msg: {
                    from_user_id: '', to_user_id: userId, client_id: clientId,
                    message_type: 2, message_state: 2, context_token: contextToken,
                    item_list: [{
                        type: 2,
                        image_item: {
                            media: {
                                encrypt_query_param: downloadParam,
                                // Tencent's sender base64-encodes the hexadecimal key text.
                                aes_key: Buffer.from(aeskey.toString('hex'), 'utf8').toString('base64'),
                                encrypt_type: 1
                            },
                            mid_size: ciphertext.length
                        }
                    }]
                },
                base_info: BASE_INFO
            },
            timeoutMs: this.requestTimeoutMs
        });
    }
}

export interface WeixinLoginOptions {
    existingTokens?: string[];
    signal?: AbortSignal;
    onQRCode: (content: string) => Promise<void>;
    onStatus?: (status: string) => void;
    onVerification?: () => Promise<string>;
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    pollIntervalMs?: number;
    timeoutMs?: number;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    checkAbort(signal);
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

export async function loginWeixin(options: WeixinLoginOptions): Promise<WeixinCredentials> {
    checkAbort(options.signal);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 480_000);
    const signal = controller.signal;
    const fetchImpl = options.fetch ?? globalThis.fetch;
    let baseUrl = DEFAULT_BASE_URL;
    let qrCode = '';
    let verifyCode: string | undefined;
    let refreshCount = 0;

    const refreshQRCode = async (): Promise<void> => {
        if (++refreshCount > 3) throw new Error('Weixin QR login stopped after three QR codes; start login again');
        const response = await request({
            fetch: fetchImpl,
            baseUrl: DEFAULT_BASE_URL,
            endpoint: '/ilink/bot/get_bot_qrcode?bot_type=3',
            operation: 'get_bot_qrcode',
            body: { local_token_list: (options.existingTokens ?? []).map((token) => token.trim()).filter(Boolean).slice(-10).reverse() },
            signal,
            timeoutMs: options.requestTimeoutMs ?? 15_000
        });
        if (typeof response.qrcode !== 'string' || !response.qrcode || typeof response.qrcode_img_content !== 'string' || !response.qrcode_img_content) {
            throw new Error('Weixin did not return a valid QR code');
        }
        qrCode = response.qrcode;
        baseUrl = DEFAULT_BASE_URL;
        verifyCode = undefined;
        await abortable(options.onQRCode(response.qrcode_img_content), signal);
    };

    try {
        await refreshQRCode();
        while (true) {
            checkAbort(signal);
            const query = new URLSearchParams({ qrcode: qrCode });
            if (verifyCode) query.set('verify_code', verifyCode);
            let response: Record<string, unknown>;
            try {
                response = await request({
                    fetch: fetchImpl,
                    baseUrl,
                    endpoint: `/ilink/bot/get_qrcode_status?${query}`,
                    operation: 'get_qrcode_status',
                    signal,
                    timeoutMs: options.requestTimeoutMs ?? 35_000
                });
            } catch (error) {
                if (error instanceof RequestTimeoutError) response = { status: 'wait' };
                else throw error;
            }
            const status = response.status;
            if (typeof status !== 'string' || !['wait', 'scaned', 'confirmed', 'expired', 'need_verifycode', 'verify_code_blocked', 'scaned_but_redirect', 'binded_redirect'].includes(status)) {
                throw new Error('Weixin returned an unsupported QR login status');
            }
            options.onStatus?.(status);
            switch (status) {
                case 'confirmed': {
                    if (typeof response.bot_token !== 'string' || !response.bot_token.trim() ||
                        typeof response.ilink_bot_id !== 'string' || !response.ilink_bot_id ||
                        typeof response.ilink_user_id !== 'string' || !response.ilink_user_id) {
                        throw new Error('Weixin confirmed login without complete credentials');
                    }
                    if (response.baseurl !== undefined && typeof response.baseurl !== 'string') throw new Error('Weixin returned an invalid API base URL');
                    return {
                        token: response.bot_token.trim(),
                        botId: response.ilink_bot_id,
                        userId: response.ilink_user_id,
                        baseUrl: validateWeixinBaseUrl((response.baseurl as string | undefined) || baseUrl)
                    };
                }
                case 'need_verifycode':
                    if (!options.onVerification) throw new Error('Weixin requires a verification code; run login in an interactive terminal');
                    verifyCode = (await abortable(options.onVerification(), signal)).trim();
                    if (!/^\d{1,16}$/.test(verifyCode)) throw new Error('Weixin verification code must contain only digits');
                    continue;
                case 'scaned':
                    verifyCode = undefined;
                    break;
                case 'scaned_but_redirect':
                    if (typeof response.redirect_host !== 'string' || !response.redirect_host) throw new Error('Weixin QR redirect did not include a host');
                    baseUrl = validateWeixinBaseUrl(`https://${response.redirect_host}`);
                    break;
                case 'expired':
                case 'verify_code_blocked':
                    await refreshQRCode();
                    break;
                case 'binded_redirect':
                    throw new WeixinAlreadyBoundError();
                case 'wait':
                    break;
            }
            await delay(options.pollIntervalMs ?? 1_000, undefined, { signal });
        }
    } catch (error) {
        if (options.signal?.aborted) throw abortError();
        if (timedOut) throw new Error('Weixin login timed out; start login again');
        throw error;
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
