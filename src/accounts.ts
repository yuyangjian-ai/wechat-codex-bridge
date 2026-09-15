import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateWeixinBaseUrl, type WeixinCredentials } from './weixin.js';

export interface StoredWeixinAccount {
    id: string;
    label: string;
    credentials: WeixinCredentials;
    createdAt: string;
    updatedAt: string;
}

export interface WeixinAccountSummary {
    id: string;
    label: string;
}

interface AccountsDocument {
    version: 1;
    accounts: StoredWeixinAccount[];
}

const ACCOUNTS_FILE = 'weixin-accounts.json';
const LEGACY_FILE = 'weixin-credentials.json';
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

function invalidStore(): Error {
    // Do not forward JSON parse errors or serialized records: they contain credentials.
    return new Error('微信账号配置格式无效，请检查本机账号文件；原文件未被修改。');
}

export function validateAccountLabel(label: string): string {
    if (typeof label !== 'string' || CONTROL_CHARACTERS.test(label)) {
        throw new Error('账号名称必须为 1 至 40 个字符，且不能包含控制字符。');
    }
    const normalized = label.trim();
    const length = [...normalized].length;
    if (length < 1 || length > 40) throw new Error('账号名称必须为 1 至 40 个字符，且不能包含控制字符。');
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
    const keys = Object.keys(value);
    return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function readCredentials(value: unknown): WeixinCredentials {
    if (!isRecord(value) || !hasExactKeys(value, ['token', 'baseUrl', 'botId', 'userId'])) throw invalidStore();
    for (const key of ['token', 'baseUrl', 'botId', 'userId'] as const) {
        if (typeof value[key] !== 'string' || !value[key].trim() || CONTROL_CHARACTERS.test(value[key])) throw invalidStore();
    }
    const credentials = value as unknown as WeixinCredentials;
    if (credentials.botId !== credentials.botId.trim() || credentials.userId !== credentials.userId.trim()) throw invalidStore();
    try {
        validateWeixinBaseUrl(credentials.baseUrl);
    } catch {
        throw invalidStore();
    }
    // Validate without normalizing credentials. The original token is persisted unchanged.
    return {
        token: credentials.token,
        baseUrl: credentials.baseUrl,
        botId: credentials.botId,
        userId: credentials.userId
    };
}

function accountId(botId: string): string {
    return createHash('sha256').update(botId).digest('hex').slice(0, 16);
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function readDocument(value: unknown): AccountsDocument {
    if (!isRecord(value) || !hasExactKeys(value, ['version', 'accounts']) || value.version !== 1 || !Array.isArray(value.accounts)) throw invalidStore();
    const ids = new Set<string>();
    const users = new Set<string>();
    const accounts = value.accounts.map((entry: unknown): StoredWeixinAccount => {
        if (!isRecord(entry) || !hasExactKeys(entry, ['id', 'label', 'credentials', 'createdAt', 'updatedAt'])) throw invalidStore();
        const credentials = readCredentials(entry.credentials);
        if (typeof entry.id !== 'string' || !/^[a-f0-9]{16}$/.test(entry.id) || entry.id !== accountId(credentials.botId) || ids.has(entry.id)) throw invalidStore();
        if (users.has(credentials.userId)) throw invalidStore();
        let label: string;
        try {
            label = validateAccountLabel(entry.label as string);
        } catch {
            throw invalidStore();
        }
        if (label !== entry.label || !isTimestamp(entry.createdAt) || !isTimestamp(entry.updatedAt) || entry.updatedAt < entry.createdAt) throw invalidStore();
        ids.add(entry.id);
        users.add(credentials.userId);
        return { id: entry.id, label, credentials, createdAt: entry.createdAt, updatedAt: entry.updatedAt };
    });
    return { version: 1, accounts };
}

function readJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    } catch {
        throw invalidStore();
    }
}

function writeDocument(runtime: string, accounts: StoredWeixinAccount[]): void {
    const document: AccountsDocument = { version: 1, accounts };
    readDocument(document);
    const destination = path.join(runtime, ACCOUNTS_FILE);
    const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
        fs.mkdirSync(runtime, { recursive: true });
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, destination);
    } catch {
        throw new Error('微信账号保存失败，请检查本机账号目录和文件权限。');
    } finally {
        if (descriptor !== undefined) {
            try { fs.closeSync(descriptor); } catch { /* Keep the original write error. */ }
        }
        try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* Do not expose a credential-bearing path in an error. */ }
    }
}

/** Load credentials for local runners; use listAccounts for logs and user-visible lists. */
export function loadAccounts(runtime: string): StoredWeixinAccount[] {
    const current = path.join(runtime, ACCOUNTS_FILE);
    if (fs.existsSync(current)) return readDocument(readJson(current)).accounts;

    const legacy = path.join(runtime, LEGACY_FILE);
    if (!fs.existsSync(legacy)) return [];
    const credentials = readCredentials(readJson(legacy));
    const now = new Date().toISOString();
    const migrated: StoredWeixinAccount = {
        id: accountId(credentials.botId),
        label: '微信账号 1',
        credentials,
        createdAt: now,
        updatedAt: now
    };
    writeDocument(runtime, [migrated]);
    // The legacy file is deliberately retained unchanged for rollback.
    return [migrated];
}

/** A fresh account is appended; logging in again only refreshes that same bot. */
export function saveAccount(runtime: string, value: WeixinCredentials, label?: string): StoredWeixinAccount {
    const credentials = readCredentials(value);
    const normalizedLabel = label === undefined ? undefined : validateAccountLabel(label);
    const accounts = loadAccounts(runtime);
    const id = accountId(credentials.botId);
    const sameUser = accounts.find(account => account.credentials.userId === credentials.userId && account.credentials.botId !== credentials.botId);
    if (sameUser) throw new Error('这个微信账号已绑定其他机器人；请先使用明确的重新绑定流程，现有账号不会被替换。');
    const existing = accounts.find(account => account.id === id);
    if (existing && existing.credentials.botId !== credentials.botId) throw new Error('微信账号标识冲突，现有账号不会被替换。');
    const now = new Date().toISOString();
    const saved: StoredWeixinAccount = {
        id,
        label: existing?.label ?? normalizedLabel ?? `微信账号 ${accounts.length + 1}`,
        credentials,
        createdAt: existing?.createdAt ?? now,
        // Keep timestamps monotonic even if the host clock was adjusted backwards.
        updatedAt: existing && existing.updatedAt > now ? existing.updatedAt : now
    };
    if (existing) accounts[accounts.indexOf(existing)] = saved;
    else accounts.push(saved);
    writeDocument(runtime, accounts);
    return saved;
}

/** Intentionally omit user IDs and all credentials from displayable summaries. */
export function listAccounts(runtime: string): WeixinAccountSummary[] {
    return loadAccounts(runtime).map(({ id, label }) => ({ id, label }));
}
