import fs from 'node:fs';
import path from 'node:path';
import { writeJson } from './config.js';
import { CodexRunError, type CodexRunnerOptions } from './codex.js';

export interface ThreadApi { request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<any> }
interface Migration { sourceId: string; targetId?: string; startedAt: string }

/** Uses server-owned sections and supported forks; never edits Codex's session database. */
export class ThreadCatalog {
    private sectionId?: string;
    private sectionPending?: Promise<string>;
    constructor(private readonly runtime: string, private readonly options: CodexRunnerOptions) {}

    private async section(api: ThreadApi): Promise<string> {
        if (this.sectionId) return this.sectionId;
        if (!this.sectionPending) this.sectionPending = this.loadSection(api).finally(() => { this.sectionPending = undefined; });
        return this.sectionPending;
    }

    private async loadSection(api: ThreadApi): Promise<string> {
        const savedFile = path.join(this.runtime, 'sidebar-section.json');
        const saved = fs.existsSync(savedFile) ? JSON.parse(fs.readFileSync(savedFile, 'utf8')) : undefined;
        let cursor: string | undefined;
        const sections: Array<{ id: string; name: string }> = [];
        do {
            const page = await api.request('threadSection/list', { cursor, limit: 100 });
            sections.push(...page.data);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        let selected = sections.find(section => section.id === saved?.sectionId)
            ?? sections.find(section => section.name === '微信 Bot' || section.name === '微信Bot');
        if (!selected) {
            const result = await api.request('threadSection/create', { name: '微信 Bot' });
            selected = result.section;
        }
        if (!selected?.id) throw new CodexRunError('invalid_output', '无法确定微信任务分组。');
        this.sectionId = selected.id;
        writeJson(savedFile, { sectionId: selected.id });
        return selected.id;
    }

    async place(api: ThreadApi, threadId: string, title: string): Promise<void> {
        const sectionId = await this.section(api);
        const result = await api.request('thread/read', { threadId, includeTurns: false });
        if (!result.thread.name) await api.request('thread/name/set', { threadId, name: title });
        await api.request('thread/section/move', { threadId, sectionId });
    }

    async ensureVisible(api: ThreadApi, threadId: string, title: string, persist: (id: string) => void): Promise<string> {
        const result = await api.request('thread/read', { threadId, includeTurns: false });
        if (result.thread.source !== 'exec') {
            await this.place(api, threadId, title);
            return threadId;
        }
        if (result.thread.status?.type === 'active') throw new CodexRunError('session_busy', '原微信任务仍在执行，完成后再迁移显示。');
        const journalFile = path.join(this.runtime, 'thread-migrations.json');
        const journal: Record<string, Migration> = fs.existsSync(journalFile) ? JSON.parse(fs.readFileSync(journalFile, 'utf8')) : {};
        let migration = journal[threadId];
        if (migration && !migration.targetId) {
            // A previous fork response may have been lost. Recover an existing child, never blindly fork again.
            let cursor: string | undefined;
            const matches: string[] = [];
            do {
                const page = await api.request('thread/list', { sourceKinds: ['vscode', 'appServer', 'cli'], cwd: this.options.workingDirectory, cursor, limit: 100 });
                for (const thread of page.data) if (thread.forkedFromId === threadId && thread.createdAt * 1000 >= Date.parse(migration.startedAt) - 2000) matches.push(thread.id);
                cursor = page.nextCursor ?? undefined;
            } while (cursor);
            if (matches.length !== 1) throw new CodexRunError('process_failed', '原会话迁移结果尚未确认，请在本机检查，程序不会重复复制历史。');
            migration.targetId = matches[0];
            writeJson(journalFile, journal);
        }
        if (!migration) {
            const recent = await api.request('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
            const lastTurn = recent.data?.[0];
            if (lastTurn?.status === 'inProgress') throw new CodexRunError('session_busy', '原微信任务仍在执行，完成后再迁移显示。');
            migration = journal[threadId] = { sourceId: threadId, startedAt: new Date().toISOString() };
            writeJson(journalFile, journal);
            const fork = await api.request('thread/fork', {
                threadId, excludeTurns: true, cwd: this.options.workingDirectory,
                ...(lastTurn?.id ? { lastTurnId: lastTurn.id } : {}),
                approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: this.options.sandbox,
                ...(this.options.model ? { model: this.options.model } : {})
            }, { timeoutMs: 30000 });
            if (!fork.thread?.id || fork.thread.id === threadId || fork.thread.forkedFromId !== threadId || !['vscode', 'appServer', 'cli'].includes(fork.thread.source)) {
                throw new CodexRunError('invalid_output', '迁移后的任务来源未通过验证，请在本机检查。');
            }
            migration.targetId = fork.thread.id;
            writeJson(journalFile, journal);
        }
        const targetId = migration.targetId!;
        const target = (await api.request('thread/read', { threadId: targetId, includeTurns: false })).thread;
        if (target.id !== targetId || target.forkedFromId !== threadId || !['vscode', 'appServer', 'cli'].includes(target.source)) {
            throw new CodexRunError('invalid_output', '迁移记录与原会话不匹配，请在本机检查。');
        }
        // Persist routing before optional UI updates, so a transient section failure cannot fork again.
        persist(targetId);
        await api.request('thread/name/set', { threadId: targetId, name: title });
        await this.place(api, targetId, title);
        return targetId;
    }
}
