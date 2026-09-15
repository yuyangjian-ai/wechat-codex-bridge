import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL_DIRECTORY = path.join(ROOT, '.runtime/speech/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
const MAX_BYTES = 20 * 1024 * 1024;
const MESSAGES = {
    invalid_audio: '这段语音格式无法读取，请重新发送微信语音或改用文字。',
    too_large: '语音文件超过 20 MiB，请缩短后重发。',
    too_long: '语音超过 5 分钟，请分段发送。',
    no_speech: '没有识别到清晰的语音，请重新录制或改用文字。',
    unavailable: '本机语音识别尚未就绪，请稍后重试或改用文字。',
    failed: '这段语音识别失败，请重新录制或改用文字。',
    timeout: '语音识别超时，请缩短后重发或改用文字。',
    cancelled: '语音识别已停止。'
} as const;
export type TranscriptionErrorCode = keyof typeof MESSAGES;
export class TranscriptionError extends Error {
    constructor(readonly code: TranscriptionErrorCode) { super(MESSAGES[code]); this.name = 'TranscriptionError'; }
}
export interface TranscriptionOptions { signal?: AbortSignal; timeoutMs?: number }
/** Test overrides are not loaded from incoming messages or bridge configuration. */
export interface TranscriptionRuntime { executable?: string; scriptPath?: string; modelDirectory?: string }

/** Decode and recognize locally in a disposable process, keeping the message poller responsive. */
export async function transcribeVoice(filePath: string, options: TranscriptionOptions = {}, runtime: TranscriptionRuntime = {}): Promise<string> {
    if (options.signal?.aborted) throw new TranscriptionError('cancelled');
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TranscriptionError('failed');
    if (!path.isAbsolute(filePath) || /^[/\\]{2}/.test(filePath) || filePath.includes('\0')) throw new TranscriptionError('invalid_audio');
    try {
        const info = await fs.lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new TranscriptionError('invalid_audio');
        if (info.size > MAX_BYTES) throw new TranscriptionError('too_large');
    } catch (error) {
        if (error instanceof TranscriptionError) throw error;
        throw new TranscriptionError('invalid_audio');
    }
    if (options.signal?.aborted) throw new TranscriptionError('cancelled');
    return new Promise<string>((resolve, reject) => {
        const child = spawn(runtime.executable ?? process.execPath, [
            runtime.scriptPath ?? path.join(ROOT, 'scripts/transcribe-voice.mjs'),
            filePath, runtime.modelDirectory ?? MODEL_DIRECTORY
        ], { cwd: ROOT, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        let settled = false;
        const finish = (error?: TranscriptionError, text?: string) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(text!);
        };
        const stop = (code: TranscriptionErrorCode) => {
            // The helper never spawns descendants. Terminate only this owned process.
            child.kill();
            finish(new TranscriptionError(code));
        };
        const abort = () => stop('cancelled');
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            if (settled) return;
            output += chunk;
            if (Buffer.byteLength(output, 'utf8') > 128 * 1024) stop('failed');
        });
        // Native library diagnostics can include local paths; do not expose or retain them.
        child.stderr.resume();
        child.once('error', () => finish(new TranscriptionError('unavailable')));
        child.once('close', code => {
            if (settled) return;
            try {
                const response = JSON.parse(output.trim()) as { ok?: boolean; code?: string; text?: unknown };
                if (response.ok !== true) {
                    const known = typeof response.code === 'string' && Object.hasOwn(MESSAGES, response.code);
                    finish(new TranscriptionError(known ? response.code as TranscriptionErrorCode : 'failed'));
                    return;
                }
                if (code !== 0 || typeof response.text !== 'string') throw new Error();
                const text = response.text.trim();
                if (!text || !/[\p{L}\p{N}]/u.test(text)) { finish(new TranscriptionError('no_speech')); return; }
                if (text.length > 16_000) throw new Error();
                finish(undefined, text);
            } catch { finish(new TranscriptionError('failed')); }
        });
    });
}
