import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { CodexRunner, CodexRunError, type CodexRunnerOptions } from '../src/codex.js';

const THREAD = '019a1234-5678-7000-8000-123456789abc';

class FakeProcess extends EventEmitter {
    pid = 12345;
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    input = '';
    killSignals: (NodeJS.Signals | number | undefined)[] = [];

    constructor() {
        super();
        this.stdin.on('data', (chunk: Buffer) => { this.input += chunk.toString('utf8'); });
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        this.killSignals.push(signal);
        queueMicrotask(() => this.emit('close', null));
        return true;
    }

    complete(events: unknown[], code = 0): void {
        this.stdout.write(events.map((event) => JSON.stringify(event)).join('\n'));
        this.emit('close', code);
    }

    asChild(): ChildProcessWithoutNullStreams {
        return this as unknown as ChildProcessWithoutNullStreams;
    }
}

function setup(overrides: Partial<CodexRunnerOptions> = {}, platform: NodeJS.Platform = 'linux') {
    const child = new FakeProcess();
    const killer = new FakeProcess();
    const calls: { executable: string; args: string[]; options: SpawnOptionsWithoutStdio }[] = [];
    const runner = new CodexRunner({
        executable: 'C:\\Tools\\Codex\\codex.exe',
        workingDirectory: 'D:\\code',
        sandbox: 'workspace-write',
        timeoutMs: 10_000,
        ...overrides
    }, {
        platform,
        spawnProcess: (executable, args, options) => {
            calls.push({ executable, args, options });
            return (calls.length === 1 ? child : killer).asChild();
        }
    });
    return { runner, child, killer, calls };
}

function success(text = '已完成任务。') {
    return [
        { type: 'thread.started', thread_id: THREAD },
        { type: 'item.completed', item: { type: 'agent_message', text } },
        { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 10 } }
    ];
}

test('prompt is written only to stdin, with explicit sandbox and no shell', async () => {
    const { runner, child, calls } = setup({ model: 'gpt-test' });
    const prompt = '检查项目\n$(Get-Secret); `whoami` && --dangerously-bypass-approvals-and-sandbox';
    const pending = runner.run({ prompt });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.cwd, 'D:\\code');
    assert.equal(calls[0].options.env?.CODEX_THREAD_ID, undefined);
    assert.equal(calls[0].options.env?.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, undefined);
    assert.equal(child.input, prompt);
    assert.equal(calls[0].args.includes(prompt), false);
    assert.equal(calls[0].args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
    assert.equal(calls[0].args.at(-1), '-');
    assert.ok(calls[0].args.includes('--json'));
    assert.ok(calls[0].args.includes('--skip-git-repo-check'));
    assert.ok(calls[0].args.includes('approval_policy="never"'));
    assert.ok(calls[0].args.includes('sandbox_mode="workspace-write"'));
    assert.ok(calls[0].args.includes('--model=gpt-test'));
    child.complete(success());
    assert.deepEqual(await pending, { threadId: THREAD, text: '已完成任务。' });
});

test('resume applies current sandbox, approval, JSONL and cwd controls explicitly', async () => {
    const { runner, child, calls } = setup({ sandbox: 'read-only' });
    const pending = runner.run({ prompt: '继续', threadId: THREAD });
    const args = calls[0].args;
    const resumePosition = args.indexOf('resume');
    assert.ok(resumePosition > 0);
    assert.deepEqual(args.slice(0, 7), ['exec', '--sandbox', 'read-only', '--cd', 'D:\\code', '--config', 'approval_policy="never"']);
    assert.ok(args.indexOf('sandbox_mode="read-only"') > resumePosition);
    assert.ok(args.lastIndexOf('approval_policy="never"') > resumePosition);
    assert.ok(args.indexOf('--json') > resumePosition);
    assert.deepEqual(args.slice(-2), [THREAD, '-']);
    // Resumed streams can omit thread.started; the supplied id remains usable.
    child.complete(success('继续完成。').slice(1));
    assert.deepEqual(await pending, { threadId: THREAD, text: '继续完成。' });
});

test('JSONL handles split UTF-8, CRLF, multiple chunks and final line without newline', async () => {
    const { runner, child } = setup();
    const observedIds: string[] = [];
    const pending = runner.run({ prompt: '你好', onThreadId: (id) => observedIds.push(id) });
    const bytes = Buffer.from(success('你好，完成 🐱').map((event) => JSON.stringify(event)).join('\r\n'));
    for (let offset = 0; offset < bytes.length; offset += 7) child.stdout.write(bytes.subarray(offset, offset + 7));
    child.emit('close', 0);
    assert.deepEqual(observedIds, [THREAD]);
    assert.equal((await pending).text, '你好，完成 🐱');
});

test('progress reports action categories without commands, tool arguments or stderr', async () => {
    const { runner, child } = setup();
    const progress: string[] = [];
    const pending = runner.run({ prompt: '处理', onProgress: (text) => progress.push(text) });
    child.stderr.write('SECRET stderr token');
    child.complete([
        { type: 'turn.started' },
        { type: 'item.started', item: { type: 'command_execution', command: 'SECRET command' } },
        { type: 'item.started', item: { type: 'command_execution', command: 'SECRET command 2' } },
        { type: 'item.started', item: { type: 'mcp_tool_call', arguments: { secret: 'SECRET arguments' } } },
        { type: 'item.completed', item: { type: 'agent_message', phase: 'commentary', text: 'SECRET commentary' } },
        ...success()
    ]);
    const result = await pending;
    assert.deepEqual(progress, ['Codex 正在处理任务…', '正在执行本机命令…', '正在调用工具…']);
    assert.equal(JSON.stringify({ progress, result }).includes('SECRET'), false);
});

test('exit and protocol errors never return raw process output', async () => {
    for (const scenario of ['exit', 'turn.failed', 'error', 'malformed', 'empty', 'incomplete'] as const) {
        const { runner, child } = setup();
        const pending = runner.run({ prompt: '处理' });
        child.stderr.write('SECRET config key');
        if (scenario === 'malformed') {
            child.stdout.write('SECRET unstructured output\n');
            child.complete(success());
        } else if (scenario === 'empty') {
            child.complete([]);
        } else if (scenario === 'incomplete') {
            child.complete(success('SECRET unfinished answer').slice(0, 2));
        } else if (scenario === 'exit') {
            child.complete(success('SECRET partial answer'), 7);
        } else {
            child.complete([...success('SECRET partial answer'), { type: scenario, message: 'SECRET provider error' }]);
        }
        await assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof CodexRunError);
            assert.equal(error.message.includes('SECRET'), false);
            assert.equal(error.code, scenario === 'exit' ? 'process_failed' : ['error', 'turn.failed'].includes(scenario) ? 'turn_failed' : 'invalid_output');
            return true;
        });
    }
});

test('active writer stderr split across UTF-8 chunks reports session busy without exposing process data', async () => {
    const { runner, child } = setup();
    const progress: string[] = [];
    const pending = runner.run({ prompt: '继续', threadId: THREAD, onProgress: (text) => progress.push(text) });
    const stderr = Buffer.from(`SECRET 本机路径\r\nError: thread-store conflict: thread ${THREAD} already has an active writer`);
    for (let offset = 0; offset < stderr.length; offset += 7) child.stderr.write(stderr.subarray(offset, offset + 7));
    // Even plausible final output cannot turn a nonzero exit into a successful result.
    child.complete(success('SECRET partial answer'), 1);
    await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof CodexRunError);
        assert.equal(error.code, 'session_busy');
        assert.equal(error.message, '该 Codex 会话正在被其他进程占用，请稍后重试。');
        assert.equal(error.cause, undefined);
        assert.equal(`${error.stack}${JSON.stringify(error)}${JSON.stringify(progress)}`.includes('SECRET'), false);
        assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(THREAD), false);
        return true;
    });
});

test('large stderr is processed in bounded fragments and retains only the safe conflict classification', async () => {
    const { runner, child } = setup();
    const pending = runner.run({ prompt: '继续', threadId: THREAD });
    // Place the diagnostic across the internal fragment boundary, then evict its text.
    child.stderr.write('x'.repeat(8192 - 20) + `\nthread-store conflict: thread ${THREAD} already has an active writer\n` + 'SECRET'.repeat(20_000));
    child.stderr.write('later diagnostic\n');
    child.complete([], 1);
    await assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof CodexRunError);
        assert.equal(error.code, 'session_busy');
        assert.equal(error.cause, undefined);
        assert.equal(JSON.stringify(error).includes('SECRET'), false);
        return true;
    });
});

test('only the explicit thread-store active writer conflict is classified as session busy', async () => {
    const diagnostics = [
        ['SECRET unknown error'],
        ['thread-store conflict: unavailable database'],
        [`thread ${THREAD} already has an active writer`],
        ['thread-store conflict: thread invalid-id already has an active writer'],
        [`thread-store conflict: thread ${THREAD} already has no active writer`],
        [`thread-store conflict: thread ${THREAD} already has an active writer`, 's record\n'],
        ['thread-store conflict:', 'x'.repeat(20_000), ` thread ${THREAD} already has an active writer\n`]
    ];
    for (const chunks of diagnostics) {
        const { runner, child } = setup();
        const pending = runner.run({ prompt: '继续', threadId: THREAD });
        for (const chunk of chunks) child.stderr.write(chunk);
        child.complete([], 1);
        await assert.rejects(pending, (error: unknown) => {
            assert.ok(error instanceof CodexRunError);
            assert.equal(error.code, 'process_failed');
            assert.equal(error.cause, undefined);
            assert.equal(JSON.stringify(error).includes('SECRET'), false);
            assert.equal(error.message.includes('thread-store'), false);
            return true;
        });
    }
});

test('stderr classification does not override a completed successful process', async () => {
    const { runner, child } = setup();
    const pending = runner.run({ prompt: '继续', threadId: THREAD });
    child.stderr.write(`thread-store conflict: thread ${THREAD} already has an active writer\n`);
    child.complete(success());
    assert.deepEqual(await pending, { threadId: THREAD, text: '已完成任务。' });
});

test('pre-aborted task and invalid thread ids never launch a subprocess', async () => {
    const { runner, calls } = setup();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runner.run({ prompt: '运行', signal: controller.signal }), { code: 'aborted' });
    await assert.rejects(runner.run({ prompt: '运行', threadId: '--dangerously-bypass-approvals-and-sandbox' }), { code: 'invalid_output' });
    assert.equal(calls.length, 0);
});

test('legacy CLI rejects images explicitly without launching or silently dropping attachments', async () => {
    const { runner, calls } = setup();
    await assert.rejects(runner.run({ prompt: '看图', images: [{ path: 'C:\\SECRET.png' }] }), (error: unknown) => {
        assert.ok(error instanceof CodexRunError);
        assert.equal(error.code, 'invalid_output');
        assert.match(error.message, /不支持图片/);
        assert.equal(error.message.includes('SECRET'), false);
        return true;
    });
    assert.equal(calls.length, 0);
});

test('Windows cancellation terminates only the known child process tree without a shell', async () => {
    const { runner, child, calls } = setup({}, 'win32');
    const controller = new AbortController();
    const pending = runner.run({ prompt: '运行', signal: controller.signal });
    controller.abort();
    assert.equal(calls.length, 2);
    assert.ok(calls[1].executable.endsWith('\\System32\\taskkill.exe'));
    assert.deepEqual(calls[1].args, ['/PID', String(child.pid), '/T', '/F']);
    assert.equal(calls[1].options.shell, false);
    assert.equal(calls[1].options.windowsHide, true);
    child.emit('close', 1);
    await assert.rejects(pending, { code: 'aborted' });
});

test('timeout stops the subprocess and reports a safe timeout error', async () => {
    const { runner, child } = setup({ timeoutMs: 5 });
    const pending = runner.run({ prompt: '运行' });
    await assert.rejects(pending, { code: 'timeout' });
    assert.deepEqual(child.killSignals, ['SIGKILL']);
});

test('spawn failures and callback exceptions do not expose internal error messages', async () => {
    const first = setup();
    const failure = first.runner.run({ prompt: '运行' });
    first.child.emit('error', new Error('SECRET executable configuration'));
    await assert.rejects(failure, (error: unknown) => error instanceof CodexRunError && error.code === 'spawn_failed' && !error.message.includes('SECRET'));

    const second = setup();
    const completed = second.runner.run({ prompt: '运行', onThreadId: () => { throw new Error('SECRET observer'); } });
    second.child.complete(success());
    assert.equal((await completed).threadId, THREAD);
});

test('oversized stdout lines are bounded and cannot become chat output', async () => {
    const { runner, child } = setup();
    const pending = runner.run({ prompt: '运行' });
    for (let i = 0; i < 65; i += 1) child.stdout.write('x'.repeat(65_536));
    child.stdout.write('\n');
    child.complete(success());
    await assert.rejects(pending, { code: 'invalid_output' });
});
