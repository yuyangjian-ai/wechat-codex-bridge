import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import { test, type TestContext } from 'node:test';
import { CodexExecutableError, resolveCodexExecutable } from '../src/codex-executable.js';
import { readConfig } from '../src/config.js';

const OLD = '1111111111111111';
const NEW = '2222222222222222';

function fixture(t: TestContext) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-codex-executable-'));
    const installRoot = path.join(root, 'OpenAI', 'Codex', 'bin');
    fs.mkdirSync(installRoot, { recursive: true });
    t.after(() => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('bridge-codex-executable-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const version = (name: string, fileTime: number, directoryTime = fileTime): string => {
        const directory = path.join(installRoot, name);
        fs.mkdirSync(directory, { recursive: true });
        const file = path.join(directory, 'codex.exe');
        fs.writeFileSync(file, 'test executable');
        fs.utimesSync(file, fileTime, fileTime);
        fs.utimesSync(directory, directoryTime, directoryTime);
        return file;
    };
    return { root, installRoot, version };
}

function safe(code: CodexExecutableError['code']) {
    return (error: unknown) => {
        assert.ok(error instanceof CodexExecutableError);
        assert.equal(error.code, code);
        assert.equal(error.cause, undefined);
        assert.equal(`${error.message}${JSON.stringify(error)}`.includes('SECRET'), false);
        return true;
    };
}

test('auto chooses the newest version using both file and installation directory modification times', t => {
    const { installRoot, version } = fixture(t);
    const old = version(OLD, 100);
    const newestDirectory = version(NEW, 90, 200);
    const probed: string[] = [];
    const probe = (file: string) => { probed.push(file); return true; };
    assert.equal(resolveCodexExecutable('auto', { installRoot, probe }), newestDirectory);
    assert.deepEqual(probed, [newestDirectory]);
    fs.utimesSync(old, 300, 300);
    assert.equal(resolveCodexExecutable('auto', { installRoot, probe }), old);
});

test('discovery ignores the root executable, non-version directories and nested executables', t => {
    const { installRoot, version } = fixture(t);
    const expected = version(OLD, 100);
    version('not-a-codex-version', 500);
    version(path.join(NEW, 'nested'), 600);
    fs.writeFileSync(path.join(installRoot, 'codex.exe'), 'obsolete root executable');
    const probed: string[] = [];
    assert.equal(resolveCodexExecutable('auto', { installRoot, probe: file => { probed.push(file); return true; } }), expected);
    assert.deepEqual(probed, [expected]);
});

test('a failed new installation can fall back to the next usable version', t => {
    const { installRoot, version } = fixture(t);
    const old = version(OLD, 100);
    const newest = version(NEW, 200);
    const probed: string[] = [];
    assert.equal(resolveCodexExecutable('auto', { installRoot, probe: file => {
        probed.push(file); return file === old;
    } }), old);
    assert.deepEqual(probed, [newest, old]);
});

test('a deleted configured version in this installation resolves to its replacement', t => {
    const { installRoot, version } = fixture(t);
    const removed = version(OLD, 100);
    const replacement = version(NEW, 200);
    fs.unlinkSync(removed);
    assert.equal(resolveCodexExecutable(removed, { installRoot, probe: () => true }), replacement);
});

test('an existing explicit executable remains selected without discovery or a probe', t => {
    const { root, installRoot, version } = fixture(t);
    const explicit = path.join(root, 'custom-codex.exe');
    fs.writeFileSync(explicit, 'explicit executable');
    const old = version(OLD, 100);
    version(NEW, 200);
    const probe = () => assert.fail('Explicit paths must remain selected');
    assert.equal(resolveCodexExecutable(explicit, { installRoot, probe }), explicit);
    assert.equal(resolveCodexExecutable(old, { installRoot, probe }), old);
});

test('arbitrary missing paths and malformed configuration never silently select an installation', t => {
    const { root, installRoot, version } = fixture(t);
    version(NEW, 200);
    const bad = [path.join(root, 'SECRET', OLD, 'codex.exe'), path.join(installRoot, 'codex.exe'),
        path.join(installRoot, 'custom', 'codex.exe'), path.join(installRoot, OLD, 'other.exe'), 'codex.exe', '', 'SECRET\0.exe'];
    for (const value of bad) {
        assert.throws(() => resolveCodexExecutable(value, { installRoot, probe: () => assert.fail('No fallback allowed') }), safe('invalid_path'));
    }
    assert.throws(() => resolveCodexExecutable(undefined as unknown as string, { installRoot }), safe('invalid_path'));
});

test('missing installation and unusable candidates have fixed errors without private diagnostics', t => {
    const { root, installRoot, version } = fixture(t);
    assert.throws(() => resolveCodexExecutable('auto', { installRoot: path.join(root, 'SECRET-missing') }), safe('installation_unavailable'));
    assert.throws(() => resolveCodexExecutable('auto', { installRoot, probe: () => true }), safe('no_usable_executable'));
    version(NEW, 200);
    assert.throws(() => resolveCodexExecutable('auto', { installRoot, probe: () => { throw new Error('SECRET process output'); } }), safe('no_usable_executable'));
});

test('discovery does not follow a version directory junction outside the installation', t => {
    const { root, installRoot, version } = fixture(t);
    const expected = version(OLD, 100);
    const external = path.join(root, 'external');
    fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'codex.exe'), 'external executable');
    fs.symlinkSync(external, path.join(installRoot, NEW), process.platform === 'win32' ? 'junction' : 'dir');
    const probed: string[] = [];
    assert.equal(resolveCodexExecutable('auto', { installRoot, probe: file => { probed.push(file); return true; } }), expected);
    assert.deepEqual(probed, [expected]);
});

test('default probe is noninteractive and bounded, and accepts only successful Codex version output', t => {
    const { installRoot, version } = fixture(t);
    const executable = version(NEW, 200);
    let output = { status: 0, stdout: 'codex-cli 0.114.0-alpha.19\n', error: undefined as Error | undefined };
    t.mock.method(childProcess, 'spawnSync', (...args: unknown[]) => {
        assert.equal(args[0], executable);
        assert.deepEqual(args[1], ['--version']);
        const options = args[2] as Record<string, unknown>;
        assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
        assert.ok(typeof options.timeout === 'number' && options.timeout > 0 && options.timeout <= 5000);
        assert.ok(typeof options.maxBuffer === 'number' && options.maxBuffer <= 32 * 1024);
        assert.deepEqual(options.stdio, ['ignore', 'pipe', 'ignore']);
        return output as ReturnType<typeof childProcess.spawnSync>;
    });
    assert.equal(resolveCodexExecutable('auto', { installRoot }), executable);
    for (const response of [
        { status: 0, stdout: 'SECRET unexpected program output', error: undefined },
        { status: 1, stdout: 'codex-cli 0.114.0', error: undefined },
        { status: 0, stdout: 'codex-cli 0.114.0', error: new Error('SECRET timeout') }
    ]) {
        output = response;
        assert.throws(() => resolveCodexExecutable('auto', { installRoot }), safe('no_usable_executable'));
    }
});

test('readConfig uses the resolver and reports an unavailable explicit executable without a raw ENOENT', t => {
    const { root } = fixture(t);
    const executable = path.join(root, 'codex.exe'); fs.writeFileSync(executable, 'explicit executable');
    const configFile = path.join(root, 'config.json');
    const config = { workingDirectory: root, codexExecutable: executable, sandbox: 'workspace-write', taskTimeoutMinutes: 30,
        accessControl: { enabled: false, allowedUserIds: [] } };
    fs.writeFileSync(configFile, JSON.stringify(config));
    assert.equal(readConfig(configFile).codexExecutable, executable);
    fs.unlinkSync(executable);
    assert.throws(() => readConfig(configFile), safe('invalid_path'));
});
