import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { execFile } from 'node:child_process';
import { writeJson } from './config.js';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const SECTION_NAME = '微信 Bot';
const OFFICIAL_PIPE = /^\\\\\.\\pipe\\codex-browser-use-[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const MAX_CANDIDATES = 16;
const TOOL_NAMES = ['list_threads', 'create_sidebar_section', 'move_thread_to_sidebar_section'] as const;
type ToolName = typeof TOOL_NAMES[number];
type ObjectValue = Record<string, any>;

export class DesktopSidebarError extends Error {
    constructor(message: string) { super(message); this.name = 'DesktopSidebarError'; }
}

export interface DesktopSidebarOptions {
    /** Resolve on every placement: the desktop owns and may replace its native pipe. */
    pipePath?: () => string | undefined;
    socketFactory?: (pipePath: string) => Socket;
    timeoutMs?: number;
    /** Tests may inject the bounded Windows pipe-name inventory. */
    discoverPipePaths?: () => Promise<string[]>;
}

async function discoverPipePaths(): Promise<string[]> {
    if (process.platform !== 'win32') return [];
    // Node 20 readdir normalizes away the final slash and fails with ENOTDIR for
    // this Windows namespace. .NET can enumerate it without opening any pipe.
    const script = "[System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | Where-Object { $_ -match '^\\\\\\\\\\.\\\\pipe\\\\codex-browser-use-[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' } | Select-Object -First 17";
    return new Promise(resolve => {
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            windowsHide: true, timeout: 2_000, maxBuffer: 64 * 1024, encoding: 'utf8'
        }, (error, stdout) => {
            if (error) { resolve([]); return; }
            resolve(stdout.split(/\r?\n/).map(line => line.trim()).filter(candidate => OFFICIAL_PIPE.test(candidate)));
        });
    });
}

function object(value: unknown): ObjectValue | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;
}

function parseToolResult(response: unknown): ObjectValue {
    const result = object(response);
    if (result?.success !== true || !Array.isArray(result.contentItems)) throw new DesktopSidebarError('Codex 桌面未确认分组操作。');
    const text = result.contentItems.filter((item: any) => item?.type === 'inputText').map((item: any) => item.text).join('\n');
    try {
        const value = object(JSON.parse(text));
        if (value) return value;
    } catch { /* Never include desktop payloads in diagnostics. */ }
    throw new DesktopSidebarError('Codex 桌面分组响应格式无效。');
}

/** The same native tool protocol used by the installed codex-app-tools plugin. */
class SidebarPipe {
    private buffer = Buffer.alloc(0);
    private pending?: { id: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
    private closed = false;

    private constructor(private readonly socket: Socket, private readonly timeoutMs: number, private readonly deadline: number) {
        socket.on('data', this.onData);
        socket.on('error', this.onClose);
        socket.on('end', this.onClose);
        socket.on('close', this.onClose);
    }

    static async connect(pipePath: string, options: DesktopSidebarOptions, deadline = Date.now() + (options.timeoutMs ?? 10_000)): Promise<SidebarPipe> {
        const timeoutMs = options.timeoutMs ?? 10_000;
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new DesktopSidebarError('Codex 桌面分组连接参数无效。');
        let socket: Socket;
        try { socket = (options.socketFactory ?? createConnection)(pipePath); }
        catch { throw new DesktopSidebarError('无法连接 Codex 桌面分组工具。'); }
        const client = new SidebarPipe(socket, timeoutMs, deadline);
        try {
            await new Promise<void>((resolve, reject) => {
                const cleanup = (): void => { clearTimeout(timer); socket.removeListener('connect', connected); socket.removeListener('error', failed); socket.removeListener('close', failed); };
                const connected = (): void => { cleanup(); resolve(); };
                const failed = (): void => { cleanup(); reject(new DesktopSidebarError('无法连接 Codex 桌面分组工具。')); };
                const timer = setTimeout(failed, Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
                socket.once('connect', connected);
                socket.once('error', failed);
                socket.once('close', failed);
            });
            return client;
        } catch (error) { client.close(); throw error; }
    }

    request(method: 'tools/list' | 'tools/call', params: unknown): Promise<unknown> {
        if (this.closed || this.pending) return Promise.reject(new DesktopSidebarError('Codex 桌面分组连接不可用。'));
        if (Date.now() >= this.deadline) return Promise.reject(new DesktopSidebarError('Codex 桌面分组操作超时，结果尚未确认。'));
        const id = randomUUID();
        const body = Buffer.from(JSON.stringify({ id, jsonrpc: '2.0', method, params }));
        if (body.length > MAX_FRAME_BYTES) return Promise.reject(new DesktopSidebarError('Codex 桌面分组请求过大。'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.close(new DesktopSidebarError('Codex 桌面分组操作超时，结果尚未确认。')); }, Math.max(1, Math.min(this.timeoutMs, this.deadline - Date.now())));
            this.pending = { id, resolve, reject, timer };
            const header = Buffer.alloc(4);
            header.writeUInt32LE(body.length);
            try { this.socket.write(Buffer.concat([header, body])); }
            catch { this.close(); }
        });
    }

    close(error = new DesktopSidebarError('Codex 桌面分组连接已断开。')): void {
        if (this.closed) return;
        this.closed = true;
        if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = undefined; }
        this.buffer = Buffer.alloc(0);
        this.socket.removeListener('data', this.onData);
        // Keep an inert error handler for a late socket error during destroy.
        try { this.socket.destroy(); } catch { /* Already disconnected. */ }
    }

    private readonly onClose = (): void => { this.close(); };

    private readonly onData = (chunk: Buffer): void => {
        if (this.closed) return;
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (!length || length > MAX_FRAME_BYTES) { this.close(new DesktopSidebarError('Codex 桌面分组响应超出大小限制。')); return; }
            if (this.buffer.length < length + 4) return;
            let response: ObjectValue | undefined;
            try { response = object(JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8'))); }
            catch { /* Fixed protocol error below. */ }
            this.buffer = this.buffer.subarray(length + 4);
            if (!response || response.jsonrpc !== '2.0' || response.id !== this.pending?.id) {
                this.close(new DesktopSidebarError('Codex 桌面分组响应无法匹配。')); return;
            }
            const pending = this.pending!;
            this.pending = undefined;
            clearTimeout(pending.timer);
            if (response.error || !('result' in response)) pending.reject(new DesktopSidebarError('Codex 桌面分组工具调用失败。'));
            else pending.resolve(response.result);
        }
    };
}

interface SidebarSection { sectionId: string; name: string; itemKeys: string[] }

function sections(value: ObjectValue): SidebarSection[] {
    if (!Array.isArray(value.sections) || value.sections.some((section: any) =>
        !object(section) || typeof section.sectionId !== 'string' || typeof section.name !== 'string' ||
        !Array.isArray(section.itemKeys) || section.itemKeys.some((item: unknown) => typeof item !== 'string'))) {
        throw new DesktopSidebarError('Codex 桌面分组列表格式无效。');
    }
    return value.sections;
}

function validCatalog(value: unknown): boolean {
    const catalog = object(value);
    return Array.isArray(catalog?.tools) && TOOL_NAMES.every(name => catalog.tools.filter((tool: any) => tool?.name === name && tool?.namespace === 'codex_app').length === 1);
}

async function callSidebarTool(client: SidebarPipe, threadId: string, tool: ToolName, args: ObjectValue): Promise<ObjectValue> {
    const requestId = randomUUID();
    return parseToolResult(await client.request('tools/call', {
        arguments: args, callId: `mcp-call-${requestId}`, namespace: 'codex_app', threadId, tool,
        // Official plugin correlation fallback; this does not create a model turn.
        turnId: `mcp-turn-${requestId}`
    }));
}

function containsThread(value: ObjectValue, threadId: string): boolean {
    const key = `codex:thread:local:${threadId}`;
    return sections(value).some(section => section.itemKeys.includes(key)) ||
        [...(Array.isArray(value.threads) ? value.threads : []), ...(Array.isArray(value.pinnedThreads) ? value.pinnedThreads : [])]
            .some(thread => thread?.kind === 'codex' && thread?.hostId === 'local' && thread?.id === threadId);
}

/** Only places bridge-owned threads in the one WeChat UI section; no generic tool execution API. */
export class DesktopSidebar {
    private queue: Promise<void> = Promise.resolve();
    constructor(private readonly runtime: string, private readonly options: DesktopSidebarOptions = {}) {}

    place(threadId: string): Promise<void> {
        if (!/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(threadId)) {
            return Promise.reject(new DesktopSidebarError('微信任务 ID 无效，无法同步桌面分组。'));
        }
        const result = this.queue.then(() => this.placeOne(threadId));
        this.queue = result.catch(() => {});
        return result;
    }

    private async placeOne(threadId: string): Promise<void> {
        const deadline = Date.now() + (this.options.timeoutMs ?? 10_000);
        const pipePath = await this.findPipe(threadId, deadline);
        const client = await SidebarPipe.connect(pipePath, this.options, deadline);
        try {
            if (!validCatalog(await client.request('tools/list', { threadStartKind: 'all' }))) {
                throw new DesktopSidebarError('当前 Codex 桌面未提供所需分组工具。');
            }
            const call = (tool: ToolName, args: ObjectValue): Promise<ObjectValue> => callSidebarTool(client, threadId, tool, args);
            const savedFile = path.join(this.runtime, 'desktop-sidebar.json');
            let saved: ObjectValue = {};
            if (fs.existsSync(savedFile)) {
                try { saved = object(JSON.parse(fs.readFileSync(savedFile, 'utf8'))) ?? {}; }
                catch { throw new DesktopSidebarError('微信桌面分组记录无法读取。'); }
            }
            const before = sections(await call('list_threads', { limit: 1 }));
            const matches = before.filter(section => section.name === SECTION_NAME || section.name === '微信Bot');
            let selected = before.find(section => section.sectionId === saved.sectionId && !['pinned', 'threads', 'chats'].includes(section.sectionId))
                ?? (matches.length === 1 ? matches[0] : undefined);
            if (!selected && matches.length > 1) throw new DesktopSidebarError('存在多个同名微信分组，无法确定目标。');
            if (!selected) {
                if (saved.createAttempted) throw new DesktopSidebarError('微信分组创建结果尚未确认，程序不会重复创建。');
                writeJson(savedFile, { createAttempted: true });
                await call('create_sidebar_section', { name: SECTION_NAME });
                const created = sections(await call('list_threads', { limit: 1 })).filter(section => section.name === SECTION_NAME);
                if (created.length !== 1) throw new DesktopSidebarError('微信分组创建结果尚未确认。');
                selected = created[0];
            }
            writeJson(savedFile, { sectionId: selected.sectionId });
            const key = `codex:thread:local:${threadId}`;
            if (selected.itemKeys.includes(key)) { this.saveEndpoint(pipePath); return; }
            const moved = await call('move_thread_to_sidebar_section', { threadId, hostId: 'local', sectionId: selected.sectionId });
            if (moved.threadId !== threadId || moved.sectionId !== selected.sectionId) throw new DesktopSidebarError('微信任务分组移动响应未匹配目标。');
            const after = sections(await call('list_threads', { limit: 1 }));
            if (!after.find(section => section.sectionId === selected!.sectionId)?.itemKeys.includes(key)) throw new DesktopSidebarError('微信任务尚未出现在目标桌面分组中。');
            this.saveEndpoint(pipePath);
        } finally { client.close(); }
    }

    private saveEndpoint(pipePath: string): void {
        writeJson(path.join(this.runtime, 'desktop-sidebar-endpoint.json'), { pipePath });
    }

    private async findPipe(threadId: string, deadline: number): Promise<string> {
        const explicit = this.options.pipePath ? this.options.pipePath() : process.env.CODEX_APP_TOOLS_PIPE_PATH;
        if (explicit && !/^\\\\\.\\pipe\\[^\\/]+$/.test(explicit)) throw new DesktopSidebarError('Codex 桌面工具连接必须是本机命名管道。');
        let cached: unknown;
        try { cached = JSON.parse(fs.readFileSync(path.join(this.runtime, 'desktop-sidebar-endpoint.json'), 'utf8')).pipePath; } catch { /* Discovery can replace an absent/stale cache. */ }
        const preferred = [...new Set([explicit, typeof cached === 'string' && OFFICIAL_PIPE.test(cached) ? cached : undefined].filter((value): value is string => !!value))];
        const probe = async (candidate: string, requireOwner: boolean): Promise<boolean> => {
            let client: SidebarPipe | undefined;
            try {
                if (Date.now() >= deadline) return false;
                const probeDeadline = Math.min(deadline, Date.now() + 1_000);
                client = await SidebarPipe.connect(candidate, { ...this.options, timeoutMs: Math.min(1_000, this.options.timeoutMs ?? 10_000) }, probeDeadline);
                if (!validCatalog(await client.request('tools/list', { threadStartKind: 'all' }))) return false;
                if (!requireOwner) return true;
                return containsThread(await callSidebarTool(client, threadId, 'list_threads', { limit: 50 }), threadId);
            } catch { return false; }
            finally { client?.close(); }
        };
        for (const candidate of preferred) if (await probe(candidate, false)) return candidate;
        const inventory = await (this.options.discoverPipePaths ?? discoverPipePaths)();
        const candidates = [...new Set(inventory.filter(candidate => OFFICIAL_PIPE.test(candidate) && !preferred.includes(candidate)))];
        if (candidates.length > MAX_CANDIDATES) throw new DesktopSidebarError('Codex 桌面工具候选过多，无法确定分组连接。');
        const matched: string[] = [];
        for (let offset = 0; offset < candidates.length && Date.now() < deadline; offset += 4) {
            const batch = candidates.slice(offset, offset + 4);
            const results = await Promise.all(batch.map(candidate => probe(candidate, true)));
            for (let index = 0; index < batch.length; index++) if (results[index]) matched.push(batch[index]);
        }
        if (matched.length > 1) throw new DesktopSidebarError('多个 Codex 桌面连接包含该任务，无法确定分组目标。');
        if (Date.now() >= deadline || matched.length !== 1) throw new DesktopSidebarError('未找到可确认的 Codex 桌面工具连接，微信任务暂未同步分组。');
        return matched[0];
    }
}
