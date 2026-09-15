import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';

export interface CodexExecutableOptions {
    /** Tests can supply an isolated installation tree instead of the current user's installation. */
    installRoot?: string;
    probe?: (executable: string) => boolean;
}

const MESSAGES = {
    invalid_path: 'Codex 程序路径无效或文件不可用，请检查 codexExecutable；使用自动发现时请填写 auto。',
    installation_unavailable: '未找到当前用户的 Codex 安装目录，请安装或更新 Codex 后重试。',
    no_usable_executable: '未找到可运行的 Codex 版本，请完成 Codex 安装或更新后重试。'
} as const;

export class CodexExecutableError extends Error {
    constructor(readonly code: keyof typeof MESSAGES) {
        super(MESSAGES[code]);
        this.name = 'CodexExecutableError';
    }
}

function identity(value: string): string {
    const normalized = path.resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isVersionExecutable(file: string, root: string): boolean {
    const parts = path.relative(root, file).split(path.sep);
    return parts.length === 2 && /^[a-f\d]{16}$/i.test(parts[0]!)
        && (process.platform === 'win32' ? parts[1]!.toLowerCase() : parts[1]) === 'codex.exe';
}

function probeVersion(executable: string): boolean {
    try {
        const result = childProcess.spawnSync(executable, ['--version'], {
            encoding: 'utf8', windowsHide: true, shell: false,
            timeout: 3000, maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'ignore']
        });
        return !result.error && result.status === 0 && typeof result.stdout === 'string'
            && /^codex-cli \d+\.\d+\.\d+(?:[-+][\da-z.-]+)?$/i.test(result.stdout.trim());
    } catch { return false; }
}

/** Discover only versioned executables from the desktop installation; never search PATH or the disk. */
export function resolveCodexExecutable(configured: string, options: CodexExecutableOptions = {}): string {
    if (typeof configured !== 'string' || !configured || configured.includes('\0')) throw new CodexExecutableError('invalid_path');
    const root = options.installRoot ?? (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : undefined);
    if (configured !== 'auto') {
        if (!path.isAbsolute(configured)) throw new CodexExecutableError('invalid_path');
        try {
            if (fs.statSync(configured).isFile()) return configured;
            throw new CodexExecutableError('invalid_path');
        } catch (error) {
            // Only a removed version in this installation may move to a newly installed version.
            if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
                || !root || !path.isAbsolute(root) || !isVersionExecutable(configured, root)) {
                throw new CodexExecutableError('invalid_path');
            }
        }
    }
    if (!root || !path.isAbsolute(root)) throw new CodexExecutableError('installation_unavailable');
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); }
    catch { throw new CodexExecutableError('installation_unavailable'); }
    const candidates: Array<{ file: string; updated: number }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-f\d]{16}$/i.test(entry.name)) continue;
        const directory = path.join(root, entry.name);
        const file = path.join(directory, 'codex.exe');
        try {
            const directoryInfo = fs.lstatSync(directory);
            const fileInfo = fs.lstatSync(file);
            if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || !fileInfo.isFile() || fileInfo.isSymbolicLink()
                || identity(fs.realpathSync(directory)) !== identity(path.join(fs.realpathSync(root), entry.name))) continue;
            candidates.push({ file, updated: Math.max(directoryInfo.mtimeMs, fileInfo.mtimeMs) });
        } catch { /* Installation updates may remove a version while it is being enumerated. */ }
    }
    candidates.sort((a, b) => b.updated - a.updated || b.file.localeCompare(a.file));
    const probe = options.probe ?? probeVersion;
    for (const candidate of candidates) {
        try { if (probe(candidate.file)) return candidate.file; }
        catch { /* A failing candidate must not expose process output or private paths. */ }
    }
    throw new CodexExecutableError('no_usable_executable');
}
