import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { type TestContext } from 'node:test';
import { writeJson } from '../src/config.js';

function fixture(t: TestContext) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-config-write-test-'));
    const file = path.join(directory, 'status.json');
    const original = '{ "state": "old", "complete": true }\n';
    fs.writeFileSync(file, original);
    t.after(() => {
        for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
        fs.rmdirSync(directory);
    });
    return { directory, file, original };
}

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`atomic JSON replacement retries temporary ${code} failures without changing the old file`, t => {
        const { directory, file, original } = fixture(t);
        const next = { state: 'running', accountCount: 2 };
        const actualRename = fs.renameSync;
        const actualWrite = fs.writeFileSync;
        let attempts = 0;
        let temporaryPath: fs.PathLike | undefined;
        t.mock.method(fs, 'writeFileSync', (...args: Parameters<typeof fs.writeFileSync>) => {
            assert.notEqual(args[0], file, 'Never overwrite the destination in place');
            return actualWrite(...args);
        });
        t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
            attempts++;
            assert.equal(destination, file);
            assert.notEqual(source, file);
            if (temporaryPath === undefined) temporaryPath = source;
            assert.equal(source, temporaryPath, 'Retry the same complete temporary file');
            assert.equal(fs.readFileSync(file, 'utf8'), original, 'Old content remains readable until replacement succeeds');
            assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), next);
            if (attempts <= 2) throw Object.assign(new Error('Temporarily occupied'), { code });
            actualRename(source, destination);
        });

        writeJson(file, next);

        assert.equal(attempts, 3);
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), next);
        assert.deepEqual(fs.readdirSync(directory), ['status.json']);
    });
}

test('a permanent replacement lock fails within a bound and leaves the previous JSON unchanged', t => {
    const { directory, file, original } = fixture(t);
    const failure = Object.assign(new Error('Still occupied'), { code: 'EPERM' });
    let attempts = 0;
    t.mock.method(fs, 'renameSync', (source: fs.PathLike, destination: fs.PathLike) => {
        attempts++;
        assert.equal(destination, file);
        assert.ok(fs.existsSync(source));
        assert.equal(fs.readFileSync(file, 'utf8'), original);
        throw failure;
    });
    const started = performance.now();

    assert.throws(() => writeJson(file, { state: 'new' }), error => error === failure);

    assert.ok(attempts > 1 && attempts <= 6, 'Replacement attempts are bounded');
    assert.ok(performance.now() - started < 2000, 'A persistent lock must not block indefinitely');
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(directory), ['status.json']);
});

test('non-lock errors fail immediately without replacing or deleting the previous file', t => {
    const { directory, file, original } = fixture(t);
    const failure = Object.assign(new Error('No space left'), { code: 'ENOSPC' });
    let attempts = 0;
    t.mock.method(fs, 'renameSync', () => { attempts++; throw failure; });

    assert.throws(() => writeJson(file, { state: 'new' }), error => error === failure);

    assert.equal(attempts, 1);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    assert.deepEqual(fs.readdirSync(directory), ['status.json']);
});
