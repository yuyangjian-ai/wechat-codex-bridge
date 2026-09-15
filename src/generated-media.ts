import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { RUNTIME } from './config.js';
import { CodexRunError, type CodexRunResult } from './codex.js';

export interface GeneratedMediaClient {
    request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<any>;
}

export interface GeneratedMediaCollection {
    images: Array<{ path: string }>;
    warning?: string;
}

export interface GeneratedMediaOptions {
    mediaDirectory?: string;
    generatedImagesDirectory?: string;
}

export const GENERATED_MEDIA_WARNING = '图片未能完整读取，可在 Codex 查看原任务中的图片。';
const ID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGES = 4;
const MAX_PAGES = 256;
const MAX_COLLECTION_MS = 30_000;
const PNG_START = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_END = Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

type ImageFormat = { extension: 'png' | 'jpg' | 'webp'; mime: string };

function imageFormat(bytes: Buffer): ImageFormat | undefined {
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return;
    if (bytes.length >= 45 && bytes.subarray(0, 8).equals(PNG_START)
        && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
        && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0 && bytes.subarray(-12).equals(PNG_END)) {
        return { extension: 'png', mime: 'image/png' };
    }
    if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
        return { extension: 'jpg', mime: 'image/jpeg' };
    }
    if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF'
        && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) === bytes.length - 8
        && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) {
        return { extension: 'webp', mime: 'image/webp' };
    }
}

function decodeResult(value: unknown): { bytes: Buffer; format: ImageFormat } | undefined {
    if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64) return;
    const data = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(value);
    const encoded = data ? value.slice(data[0].length) : value;
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return;
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== encoded) return;
    const format = imageFormat(bytes);
    return format && (!data || data[1] === format.mime) ? { bytes, format } : undefined;
}

function samePath(first: string, second: string): boolean {
    return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function inside(directory: string, file: string): boolean {
    const relative = path.relative(directory, file);
    return !!relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
        && (process.platform !== 'win32' || !relative.includes(':'));
}

async function readBounded(file: FileHandle): Promise<Buffer | undefined> {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return;
    const buffer = Buffer.allocUnsafe(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
    }
    return offset === info.size ? buffer.subarray(0, offset) : undefined;
}

async function readSavedImage(value: unknown, threadId: string, generatedDirectory: string): Promise<{ bytes: Buffer; format: ImageFormat } | undefined> {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return;
    const expectedThreadDirectory = path.resolve(generatedDirectory, threadId);
    const source = path.resolve(value);
    if (!inside(expectedThreadDirectory, source)) return;
    const expectedExtension = path.extname(source).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp'].includes(expectedExtension)) return;
    const [realRoot, realThread, realSource, info] = await Promise.all([
        fs.realpath(generatedDirectory), fs.realpath(expectedThreadDirectory), fs.realpath(source), fs.lstat(source)
    ]);
    // Reject thread-directory junctions and file symlinks that escape the exact
    // generated_images/<threadId> directory, even when the textual path is valid.
    if (!samePath(realThread, path.resolve(realRoot, threadId)) || !inside(realThread, realSource)
        || !info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return;
    const file = await fs.open(source, 'r');
    try {
        const openedInfo = await file.stat();
        if (!openedInfo.isFile() || openedInfo.size <= 0 || openedInfo.size > MAX_IMAGE_BYTES
            || !samePath(await fs.realpath(source), realSource)) return;
        const bytes = await readBounded(file);
        if (!bytes) return;
        const format = imageFormat(bytes);
        if (!format || (format.extension === 'jpg' ? !['.jpg', '.jpeg'].includes(expectedExtension) : expectedExtension !== `.${format.extension}`)) return;
        return { bytes, format };
    } finally { await file.close(); }
}

async function saveImage(item: any, threadId: string, turnId: string, options: GeneratedMediaOptions): Promise<{ path: string } | undefined> {
    if (typeof item.id !== 'string' || !item.id || item.id.length > 4096) return;
    const generatedDirectory = path.resolve(options.generatedImagesDirectory ?? path.join(homedir(), '.codex', 'generated_images'));
    const image = decodeResult(item.result) ?? await readSavedImage(item.savedPath, threadId, generatedDirectory);
    if (!image) return;
    const mediaDirectory = path.resolve(options.mediaDirectory ?? path.join(RUNTIME, 'media'));
    await fs.mkdir(mediaDirectory, { recursive: true });
    const realRoot = await fs.realpath(mediaDirectory);
    let realDirectory = realRoot;
    for (const segment of [threadId, turnId]) {
        const directory = path.join(realDirectory, segment);
        try { await fs.mkdir(directory); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await fs.realpath(directory), directory)) return;
        realDirectory = directory;
    }
    const filename = `${createHash('sha256').update(item.id).digest('hex')}.${image.format.extension}`;
    const output = path.join(realDirectory, filename);
    try {
        await fs.writeFile(output, image.bytes, { flag: 'wx', mode: 0o600 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await fs.lstat(output);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== image.bytes.length
            || !samePath(await fs.realpath(output), output)) return;
        const file = await fs.open(output, 'r');
        try { if (!(await readBounded(file))?.equals(image.bytes)) return; }
        finally { await file.close(); }
    }
    return { path: output };
}

/** Read only explicit generated-image items belonging to the exact completed turn. */
export async function collectGeneratedImages(
    client: GeneratedMediaClient, threadId: string, turnId: string, options: GeneratedMediaOptions = {}
): Promise<GeneratedMediaCollection> {
    const images: Array<{ path: string }> = [];
    let incomplete = false;
    if (!ID.test(threadId) || !ID.test(turnId)) return { images, warning: GENERATED_MEDIA_WARNING };
    const itemIds = new Set<string>();
    const cursors = new Set<string>();
    const deadline = Date.now() + MAX_COLLECTION_MS;
    let cursor: string | undefined;
    try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) { incomplete = true; break; }
            // One image at the permitted maximum must fit inside app-server's
            // bounded JSONL reader even when a turn contains several large images.
            const response = await client.request('thread/items/list', {
                threadId, turnId, limit: 1, sortDirection: 'asc', ...(cursor ? { cursor } : {})
            }, { timeoutMs: Math.min(10_000, remaining) });
            if (!Array.isArray(response?.data)) { incomplete = true; break; }
            for (const entry of response.data) {
                if (entry?.turnId !== turnId || entry.item?.type !== 'imageGeneration' || entry.item.status !== 'completed') continue;
                const item = entry.item;
                if (typeof item.id === 'string' && itemIds.has(item.id)) continue;
                if (typeof item.id === 'string') itemIds.add(item.id);
                try {
                    const image = await saveImage(item, threadId, turnId, options);
                    if (image) images.push(image); else incomplete = true;
                } catch { incomplete = true; }
                if (images.length >= MAX_IMAGES) break;
            }
            if (images.length >= MAX_IMAGES || response.nextCursor == null) break;
            if (typeof response.nextCursor !== 'string' || !response.nextCursor || cursors.has(response.nextCursor)) { incomplete = true; break; }
            const nextCursor: string = response.nextCursor;
            cursor = nextCursor;
            cursors.add(nextCursor);
            if (page === MAX_PAGES - 1) incomplete = true;
        }
    } catch { incomplete = true; }
    return { images, ...(incomplete ? { warning: GENERATED_MEDIA_WARNING } : {}) };
}

/** Media delivery is supplementary: its failure must never make a completed turn retryable. */
export async function withGeneratedImages(
    completed: CodexRunResult, collect: () => Promise<GeneratedMediaCollection>
): Promise<CodexRunResult> {
    let media: GeneratedMediaCollection;
    try {
        media = await collect();
        if (!media || !Array.isArray(media.images)) throw new Error();
    }
    catch { media = { images: [], warning: GENERATED_MEDIA_WARNING }; }
    const text = completed.text.trim() ? completed.text : media.images.length ? '图片已生成。' : '';
    if (!text && !media.warning) {
        throw new CodexRunError('invalid_output', 'Codex 未返回完整文字或图片结果，请在桌面查看原任务。');
    }
    return {
        ...completed,
        text: media.warning ? (text ? `${text}\n\n${GENERATED_MEDIA_WARNING}` : GENERATED_MEDIA_WARNING) : text,
        ...(media.images.length ? { images: media.images } : {}),
    };
}
