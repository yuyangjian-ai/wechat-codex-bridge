import fs from 'node:fs/promises';
import path from 'node:path';
import { CodexRunError, type CodexRunInput } from './codex.js';

export type CodexInputItem = { type: 'text'; text: string; text_elements: [] }
    | { type: 'localImage'; path: string };

export const IMAGE_ONLY_PROMPT = '请查看并分析这些图片。';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Downloaders validate media bytes; runners additionally reject invalid local input descriptors. */
export async function buildCodexInput(input: Pick<CodexRunInput, 'prompt' | 'images'>): Promise<CodexInputItem[]> {
    if (typeof input.prompt !== 'string' || (input.images !== undefined && !Array.isArray(input.images))) {
        throw new CodexRunError('invalid_output', '任务文字或图片参数无效。');
    }
    const images = input.images ?? [];
    if (images.length > MAX_IMAGES) throw new CodexRunError('invalid_output', '每条任务最多支持 4 张图片，请分批发送。');
    if (!input.prompt.trim() && images.length === 0) throw new CodexRunError('invalid_output', '任务内容不能为空。');
    const items: CodexInputItem[] = [{ type: 'text', text: input.prompt.trim() ? input.prompt : IMAGE_ONLY_PROMPT, text_elements: [] }];
    for (const image of images) {
        const file = image?.path;
        if (typeof file !== 'string' || !file || file.includes('\0') || !path.isAbsolute(file)
            || /^[a-z][a-z\d+.-]*:\/\//i.test(file) || /^[\\/]{2}/.test(file)
            || (process.platform === 'win32' && (!/^[a-z]:[\\/]/i.test(file) || file.slice(2).includes(':')))
            || !EXTENSIONS.has(path.extname(file).toLowerCase())) {
            throw new CodexRunError('invalid_output', '图片必须是有效的本地图片文件，请重新发送图片。');
        }
        const absoluteFile = path.resolve(file);
        try {
            const info = await fs.lstat(absoluteFile);
            if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) throw new Error();
        } catch {
            throw new CodexRunError('invalid_output', '图片文件无效、超过 20 MiB 或不可读取，请重新发送图片。');
        }
        items.push({ type: 'localImage', path: absoluteFile });
    }
    return items;
}
