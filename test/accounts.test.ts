import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { listAccounts, loadAccounts, saveAccount, validateAccountLabel } from '../src/accounts.js';
import type { WeixinCredentials } from '../src/weixin.js';

function fixture(t: TestContext): string {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-codex-accounts-test-'));
    t.after(() => {
        // Delete only files from this known test directory; do not recursively delete paths.
        for (const name of fs.readdirSync(runtime)) fs.unlinkSync(path.join(runtime, name));
        fs.rmdirSync(runtime);
    });
    return runtime;
}

function credentials(suffix: string): WeixinCredentials {
    return { token: ` secret-token-${suffix} `, baseUrl: 'https://ilinkai.weixin.qq.com/', botId: `secret-bot-${suffix}`, userId: `secret-user-${suffix}` };
}

function documentPath(runtime: string): string { return path.join(runtime, 'weixin-accounts.json'); }
function legacyPath(runtime: string): string { return path.join(runtime, 'weixin-credentials.json'); }

test('an empty runtime has no accounts and does not create a credential file', t => {
    const runtime = fixture(t);
    assert.deepEqual(loadAccounts(runtime), []);
    assert.deepEqual(listAccounts(runtime), []);
    assert.deepEqual(fs.readdirSync(runtime), []);
});

test('first load migrates legacy credentials once while preserving the exact original file', t => {
    const runtime = fixture(t);
    const original = `  ${JSON.stringify(credentials('owner'))}\n`;
    fs.writeFileSync(legacyPath(runtime), original);
    const first = loadAccounts(runtime);
    const storedAfterMigration = fs.readFileSync(documentPath(runtime), 'utf8');
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]?.credentials, credentials('owner'));
    assert.equal(first[0]?.id, createHash('sha256').update(credentials('owner').botId).digest('hex').slice(0, 16));
    assert.equal(first[0]?.label, '微信账号 1');
    assert.equal(fs.readFileSync(legacyPath(runtime), 'utf8'), original);
    assert.deepEqual(loadAccounts(runtime), first);
    assert.equal(fs.readFileSync(documentPath(runtime), 'utf8'), storedAfterMigration);
    assert.equal(fs.readFileSync(legacyPath(runtime), 'utf8'), original);
    assert.deepEqual(fs.readdirSync(runtime).sort(), ['weixin-accounts.json', 'weixin-credentials.json']);
});

test('appending another account retains the original credentials, account ID and timestamps', t => {
    const runtime = fixture(t);
    const first = saveAccount(runtime, credentials('owner'), ' 我的微信 ');
    const second = saveAccount(runtime, credentials('visitor'), '同事');
    const accounts = loadAccounts(runtime);
    assert.equal(accounts.length, 2);
    assert.deepEqual(accounts[0], first);
    assert.deepEqual(accounts[1], second);
    assert.equal(first.label, '我的微信');
    assert.notEqual(first.id, second.id);
    assert.deepEqual(accounts.map(account => account.credentials), [credentials('owner'), credentials('visitor')]);
    assert.deepEqual(fs.readdirSync(runtime), ['weixin-accounts.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(documentPath(runtime)).mode & 0o777, 0o600);
});

test('refreshing one bot preserves its label and creation time and leaves other accounts untouched', t => {
    const runtime = fixture(t);
    const first = saveAccount(runtime, credentials('owner'), '原始名称');
    const second = saveAccount(runtime, credentials('visitor'), '另一个人');
    const refreshedCredentials = { ...credentials('owner'), token: ' refreshed-secret-token ' };
    const refreshed = saveAccount(runtime, refreshedCredentials, '不能替换原始名称');
    assert.equal(refreshed.id, first.id);
    assert.equal(refreshed.label, first.label);
    assert.equal(refreshed.createdAt, first.createdAt);
    assert.ok(refreshed.updatedAt >= first.updatedAt);
    assert.deepEqual(refreshed.credentials, refreshedCredentials);
    assert.deepEqual(loadAccounts(runtime), [refreshed, second]);
});

test('a different bot for the same bound user is rejected without replacing any account', t => {
    const runtime = fixture(t);
    saveAccount(runtime, credentials('owner'), '本人');
    const before = fs.readFileSync(documentPath(runtime), 'utf8');
    const duplicateOwner = { ...credentials('owner'), botId: 'different-secret-bot', token: 'new-secret-token' };
    assert.throws(() => saveAccount(runtime, duplicateOwner), /重新绑定流程/);
    assert.equal(fs.readFileSync(documentPath(runtime), 'utf8'), before);
});

test('display summaries expose only hashed IDs and labels', t => {
    const runtime = fixture(t);
    saveAccount(runtime, credentials('owner'), '本人');
    saveAccount(runtime, credentials('visitor'), '同事');
    const summaries = listAccounts(runtime);
    assert.deepEqual(summaries.map(value => Object.keys(value)), [['id', 'label'], ['id', 'label']]);
    assert.doesNotMatch(JSON.stringify(summaries), /secret|token|userId|botId|baseUrl|credentials/);
    assert.ok(summaries.every(value => /^[a-f0-9]{16}$/.test(value.id)));
});

test('account labels trim whitespace and require 1-40 characters without control characters', () => {
    assert.equal(validateAccountLabel('  同事甲  '), '同事甲');
    assert.equal(validateAccountLabel('😀'.repeat(40)), '😀'.repeat(40));
    for (const label of ['', '   ', 'a'.repeat(41), 'foo\nbar', '\tfoo', 'foo\u0000bar', 'foo\u2028bar', 'foo\u202ebar', 'foo\u007fbar']) {
        assert.throws(() => validateAccountLabel(label), /1 至 40/);
    }
});

test('unknown versions or record formats fail closed without changing the stored file or leaking values', t => {
    const runtime = fixture(t);
    const valid = saveAccount(runtime, credentials('owner'), '本人');
    const cases: unknown[] = [
        { version: 2, accounts: [valid] },
        { version: 1, accounts: {} },
        { version: 1, accounts: [valid], extra: 'secret-extra' },
        { version: 1, accounts: [{ ...valid, id: '../secret-path' }] },
        { version: 1, accounts: [{ ...valid, id: '1234567890abcdef' }] },
        { version: 1, accounts: [{ ...valid, createdAt: 'yesterday-secret' }] },
        { version: 1, accounts: [{ ...valid, label: 'bad\nsecret' }] },
        { version: 1, accounts: [{ ...valid, credentials: { ...valid.credentials, baseUrl: 'https://secret.evil.test' } }] },
        { version: 1, accounts: [valid, valid] },
        [], null
    ];
    for (const value of cases) {
        const original = JSON.stringify(value);
        fs.writeFileSync(documentPath(runtime), original);
        assert.throws(() => loadAccounts(runtime), (error: unknown) => {
            assert.ok(error instanceof Error);
            assert.doesNotMatch(String(error), /secret|token|userId|botId/);
            assert.match(error.message, /格式无效/);
            return true;
        });
        assert.throws(() => saveAccount(runtime, credentials('visitor'), '同事'));
        assert.equal(fs.readFileSync(documentPath(runtime), 'utf8'), original);
    }
});

test('malformed JSON never leaks credential snippets and does not fall back to old credentials', t => {
    const runtime = fixture(t);
    fs.writeFileSync(legacyPath(runtime), JSON.stringify(credentials('owner')));
    const malformed = '{"version":1,"accounts":[{"token":"never-log-this-secret"';
    fs.writeFileSync(documentPath(runtime), malformed);
    assert.throws(() => loadAccounts(runtime), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /never-log|secret|token/);
        return true;
    });
    assert.equal(fs.readFileSync(documentPath(runtime), 'utf8'), malformed);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath(runtime), 'utf8')), credentials('owner'));
});

test('invalid legacy credentials cannot overwrite or create a new account store', t => {
    const runtime = fixture(t);
    const invalid = JSON.stringify({ ...credentials('owner'), token: null });
    fs.writeFileSync(legacyPath(runtime), invalid);
    assert.throws(() => loadAccounts(runtime), /格式无效/);
    assert.equal(fs.existsSync(documentPath(runtime)), false);
    assert.equal(fs.readFileSync(legacyPath(runtime), 'utf8'), invalid);
});
