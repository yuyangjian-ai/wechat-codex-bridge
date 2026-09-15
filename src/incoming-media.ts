import { createDecipheriv, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { WeixinCDNMedia } from './weixin.js';

/** Media references are copied only from the current authorized Weixin message. */
export interface IncomingMediaAttachment {
    kind: 'image' | 'voice';
    media: WeixinCDNMedia;
    aesKeyHex?: string;
    encodeType?: number;
    sampleRate?: number;
    bitsPerSample?: number;
    playtime?: number;
}

export interface IncomingMediaOptions {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    timeoutMs?: number;
    /** May lower, but never raise, the 20 MiB plaintext limit. */
    maxBytes?: number;
}

export class IncomingMediaError extends Error {
    constructor(public readonly code: 'invalid_media' | 'too_large' | 'download_failed' | 'decrypt_failed' | 'unsafe_directory' | 'save_failed' | 'timeout' | 'cancelled') {
        const messages = {
            invalid_media: '微信附件格式或下载信息无效。',
            too_large: '微信附件超过允许的大小。',
            download_failed: '微信附件下载失败，请重新发送。',
            decrypt_failed: '微信附件解密失败，请重新发送。',
            unsafe_directory: '微信附件保存目录无效。',
            save_failed: '微信附件保存失败。',
            timeout: '微信附件下载超时，请重新发送。',
            cancelled: '微信附件处理已取消。'
        };
        super(messages[code]);
        this.name = code === 'cancelled' ? 'AbortError' : code === 'timeout' ? 'TimeoutError' : 'IncomingMediaError';
    }
}

const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const DEFAULT_DOWNLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download';

function downloadUrl(media: WeixinCDNMedia): URL {
    let url: URL;
    try {
        if (media.full_url !== undefined) {
            if (typeof media.full_url !== 'string' || !media.full_url) throw new Error();
            url = new URL(media.full_url);
        } else {
            if (typeof media.encrypt_query_param !== 'string' || !media.encrypt_query_param || media.encrypt_query_param.length > 32 * 1024) throw new Error();
            url = new URL(DEFAULT_DOWNLOAD_URL);
            url.searchParams.set('encrypted_query_param', media.encrypt_query_param);
        }
    } catch {
        throw new IncomingMediaError('invalid_media');
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || !(host === 'cdn.weixin.qq.com' || host.endsWith('.cdn.weixin.qq.com')) || url.username || url.password || url.port || url.hash) {
        throw new IncomingMediaError('invalid_media');
    }
    return url;
}

/** Tencent currently returns both base64(raw key) and base64(hex key text). */
function encryptionKey(attachment: IncomingMediaAttachment): Buffer | undefined {
    if (attachment.kind === 'image' && attachment.aesKeyHex !== undefined) {
        if (typeof attachment.aesKeyHex !== 'string' || !/^[\da-f]{32}$/i.test(attachment.aesKeyHex)) throw new IncomingMediaError('invalid_media');
        return Buffer.from(attachment.aesKeyHex, 'hex');
    }
    const encoded = attachment.media.aes_key;
    if (encoded === undefined || encoded === '') {
        if (attachment.kind === 'image') return undefined;
        throw new IncomingMediaError('invalid_media');
    }
    if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new IncomingMediaError('invalid_media');
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new IncomingMediaError('invalid_media');
    if (decoded.length === 16) return decoded;
    if (decoded.length === 32 && /^[\da-f]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
    throw new IncomingMediaError('invalid_media');
}

function fileExtension(bytes: Buffer, attachment: IncomingMediaAttachment): string {
    if (attachment.kind === 'image') {
        if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) return '.png';
        if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return '.jpg';
        if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return '.webp';
        if (bytes.length >= 13 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) return '.gif';
        throw new IncomingMediaError('invalid_media');
    }
    if (bytes.subarray(0, 9).toString('ascii') === '#!SILK_V3' || (bytes[0] === 2 && bytes.subarray(1, 10).toString('ascii') === '#!SILK_V3')) return '.silk';
    if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return '.wav';
    if (bytes.subarray(0, 6).toString('ascii') === '#!AMR\n' || bytes.subarray(0, 9).toString('ascii') === '#!AMR-WB\n') return '.amr';
    if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return '.ogg';
    if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return '.flac';
    if (bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0)) return '.mp3';
    // PCM has no magic. Only retain it when the protocol explicitly declares PCM.
    if (attachment.encodeType === 1 && [8, 16, 24, 32].includes(attachment.bitsPerSample ?? 0) && Number.isInteger(attachment.sampleRate) && attachment.sampleRate! >= 8000 && attachment.sampleRate! <= 192000) return '.pcm';
    throw new IncomingMediaError('invalid_media');
}

function pathIdentity(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function safeDirectory(directory: string): Promise<string> {
    if (!path.isAbsolute(directory) || /^[/\\]{2}/.test(directory)) throw new IncomingMediaError('unsafe_directory');
    const target = path.resolve(directory);
    const root = path.parse(target).root;
    const parts = target.slice(root.length).split(path.sep).filter(Boolean);
    let current = root;
    try {
        for (const part of parts) {
            current = path.join(current, part);
            try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            const stat = await lstat(current);
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
        }
        const resolved = await realpath(target);
        if (pathIdentity(resolved) !== pathIdentity(target)) throw new Error();
        return resolved;
    } catch {
        throw new IncomingMediaError('unsafe_directory');
    }
}

/** Download only Weixin CDN media; no bot credentials, cookies, redirects or retries. */
export async function downloadIncomingMedia(attachment: IncomingMediaAttachment, directory: string, options: IncomingMediaOptions = {}): Promise<{ path: string; kind: 'image' | 'voice' }> {
    if (!attachment || !['image', 'voice'].includes(attachment.kind) || !attachment.media || typeof attachment.media !== 'object') throw new IncomingMediaError('invalid_media');
    const maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_MEDIA_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new IncomingMediaError('invalid_media');
    const url = downloadUrl(attachment.media);
    const key = encryptionKey(attachment);
    const controller = new AbortController();
    let abortFailure = new IncomingMediaError('cancelled');
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => { abortFailure = new IncomingMediaError('timeout'); controller.abort(); }, timeoutMs);
    const checkAbort = () => { if (controller.signal.aborted) throw abortFailure; };
    const abortable = async <T>(promise: Promise<T>): Promise<T> => {
        checkAbort();
        let cancel: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => { cancel = () => reject(abortFailure); controller.signal.addEventListener('abort', cancel, { once: true }); });
        try { return await Promise.race([promise, aborted]); }
        finally { if (cancel) controller.signal.removeEventListener('abort', cancel); }
    };
    try {
        checkAbort();
        let bytes: Buffer;
        try {
            const response = await abortable((options.fetch ?? fetch)(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { Accept: 'application/octet-stream' } }));
            if (!response.ok || response.redirected) {
                void response.body?.cancel().catch(() => {});
                throw new IncomingMediaError('download_failed');
            }
            const limit = key ? maxBytes + 16 : maxBytes;
            const declaredLength = response.headers.get('content-length');
            if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
                void response.body?.cancel().catch(() => {});
                throw new IncomingMediaError('too_large');
            }
            if (!response.body) throw new IncomingMediaError('invalid_media');
            const reader = response.body.getReader();
            const chunks: Buffer[] = [];
            let size = 0;
            try {
                while (true) {
                    const read = await abortable(reader.read());
                    if (read.done) break;
                    size += read.value.byteLength;
                    if (size > limit) throw new IncomingMediaError('too_large');
                    chunks.push(Buffer.from(read.value));
                }
            } catch (error) {
                void reader.cancel().catch(() => {});
                throw error;
            } finally { reader.releaseLock(); }
            bytes = Buffer.concat(chunks, size);
        } catch (error) {
            checkAbort();
            if (error instanceof IncomingMediaError) throw error;
            throw new IncomingMediaError('download_failed');
        }
        checkAbort();
        if (key) {
            try {
                const decrypt = createDecipheriv('aes-128-ecb', key, null);
                bytes = Buffer.concat([decrypt.update(bytes), decrypt.final()]);
            } catch { throw new IncomingMediaError('decrypt_failed'); }
        }
        if (bytes.length > maxBytes) throw new IncomingMediaError('too_large');
        if (!bytes.length) throw new IncomingMediaError('invalid_media');
        const extension = fileExtension(bytes, attachment);
        const targetDirectory = await safeDirectory(directory);
        checkAbort();
        const target = path.join(targetDirectory, `${attachment.kind}-${randomUUID()}${extension}`);
        let created = false;
        try {
            const file = await open(target, 'wx', 0o600);
            created = true;
            try {
                if (pathIdentity(await realpath(targetDirectory)) !== pathIdentity(targetDirectory)) throw new IncomingMediaError('unsafe_directory');
                checkAbort();
                await file.writeFile(bytes);
                checkAbort();
            } finally { await file.close(); }
            return { path: target, kind: attachment.kind };
        } catch (error) {
            if (created) await unlink(target).catch(() => {});
            checkAbort();
            if (error instanceof IncomingMediaError) throw error;
            throw new IncomingMediaError('save_failed');
        }
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
    }
}
