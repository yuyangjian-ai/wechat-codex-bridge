import path from 'node:path';
import { CodexRunError } from './codex.js';
import { downloadIncomingMedia, IncomingMediaError } from './incoming-media.js';
import { transcribeVoice, TranscriptionError } from './transcription.js';
import type { Job } from './state.js';

export interface PreparedInput { prompt: string; images?: Array<{ path: string }> }
export interface InputPreparationRuntime {
    download?: typeof downloadIncomingMedia;
    transcribe?: typeof transcribeVoice;
}

/** Prepare within the shared task worker; polling and receipt acknowledgements never wait on media. */
export async function prepareIncomingInput(runtime: string, accountId: string, job: Job, signal: AbortSignal, dependencies: InputPreparationRuntime = {}): Promise<PreparedInput> {
    const check = () => { if (signal.aborted) throw new CodexRunError('aborted', '任务已停止。'); };
    check();
    if (!job.attachments?.length) return { prompt: job.prompt, images: job.inputImages };
    if (!path.isAbsolute(runtime) || !/^[a-f\d]{16}$/i.test(accountId) || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(job.id)
        || job.attachments.length > 8 || job.attachments.filter(item => item.kind === 'image').length > 4 || job.attachments.filter(item => item.kind === 'voice').length > 4) {
        throw new CodexRunError('invalid_output', '微信附件任务信息无效，请重新发送。');
    }
    const images: Array<{ path: string }> = [];
    const text = job.prompt.trim() ? [job.prompt.trim()] : [];
    try {
        for (const [index, attachment] of job.attachments.entries()) {
            check();
            const directory = path.join(runtime, 'incoming', accountId, job.id, String(index));
            const file = await (dependencies.download ?? downloadIncomingMedia)(attachment, directory, { signal });
            check();
            if (file.kind !== attachment.kind) throw new Error('Media kind mismatch');
            if (file.kind === 'image') images.push({ path: file.path });
            else if (file.kind === 'voice') {
                const transcript = await (dependencies.transcribe ?? transcribeVoice)(file.path, { signal });
                check();
                if (!transcript.trim()) throw new TranscriptionError('no_speech');
                text.push(transcript.trim());
            } else throw new Error('Unknown media kind');
        }
        check();
        return { prompt: text.join('\n'), ...(images.length ? { images } : {}) };
    } catch (error) {
        check();
        if (error instanceof CodexRunError) throw error;
        const message = error instanceof IncomingMediaError || error instanceof TranscriptionError
            ? error.message : '图片或语音处理失败，请重新发送。';
        throw new CodexRunError('invalid_output', message);
    }
}
