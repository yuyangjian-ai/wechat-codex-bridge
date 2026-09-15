import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { encode } from 'silk-wasm';
import { transcribeVoice, TranscriptionError, type TranscriptionErrorCode } from '../src/transcription.js';

async function fixture(t: TestContext) {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'bridge-transcription-'));
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
        assert.ok(path.basename(root).startsWith('bridge-transcription-'));
        await fs.rm(root, { recursive: true, force: true });
    });
    const audio = path.join(root, 'clip.dat');
    await fs.writeFile(audio, Buffer.from('fixture audio'));
    const scriptPath = path.join(root, 'helper.mjs');
    return { root, audio, scriptPath };
}

function errorCode(code: TranscriptionErrorCode) {
    return (error: unknown) => error instanceof TranscriptionError && error.code === code;
}

function wav(seconds = 1, signal = false): Buffer {
    const samples = Math.floor(16000 * seconds);
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
    if (signal) for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(10000 * Math.sin(i / 10)), 44 + i * 2);
    return bytes;
}

test('returns trimmed Chinese and English transcript from the owned helper', async t => {
    const files = await fixture(t);
    await fs.writeFile(files.scriptPath, 'process.stdout.write(JSON.stringify({ok:true,text:"  你好，please check the time.  "}));');
    assert.equal(await transcribeVoice(files.audio, {}, files), '你好，please check the time.');
});

test('maps known helper failures and never exposes stderr or arbitrary errors', async t => {
    const files = await fixture(t);
    await fs.writeFile(files.scriptPath, 'process.stderr.write("secret path"); process.stdout.write(JSON.stringify({ok:false,code:"no_speech"})); process.exitCode=1;');
    await assert.rejects(transcribeVoice(files.audio, {}, files), errorCode('no_speech'));
    await fs.writeFile(files.scriptPath, 'process.stdout.write(JSON.stringify({ok:false,code:"secret path"})); process.exitCode=1;');
    await assert.rejects(transcribeVoice(files.audio, {}, files), errorCode('failed'));
});

test('empty, punctuation-only, malformed and oversized output never becomes a task prompt', async t => {
    const files = await fixture(t);
    for (const text of ['', '   ', '...，。']) {
        await fs.writeFile(files.scriptPath, `process.stdout.write(JSON.stringify({ok:true,text:${JSON.stringify(text)}}));`);
        await assert.rejects(transcribeVoice(files.audio, {}, files), errorCode('no_speech'));
    }
    await fs.writeFile(files.scriptPath, 'process.stdout.write("unstructured native output");');
    await assert.rejects(transcribeVoice(files.audio, {}, files), errorCode('failed'));
    await fs.writeFile(files.scriptPath, 'process.stdout.write("x".repeat(140000));');
    await assert.rejects(transcribeVoice(files.audio, {}, files), errorCode('failed'));
});

test('times out and cancels only the owned recognizer process', async t => {
    const files = await fixture(t);
    await fs.writeFile(files.scriptPath, 'setInterval(()=>{},1000);');
    await assert.rejects(transcribeVoice(files.audio, { timeoutMs: 100 }, files), errorCode('timeout'));
    const controller = new AbortController();
    const pending = transcribeVoice(files.audio, { signal: controller.signal }, files);
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, errorCode('cancelled'));
    await assert.rejects(transcribeVoice(files.audio, { signal: controller.signal }, files), errorCode('cancelled'));
});

test('rejects non-local, missing and over-size input before launching ASR', async t => {
    const files = await fixture(t);
    for (const input of ['https://example.com/voice.wav', '\\\\server\\share\\voice.wav', path.join(files.root, 'missing.wav')]) {
        await assert.rejects(transcribeVoice(input), errorCode('invalid_audio'));
    }
    const handle = await fs.open(files.audio, 'w');
    await handle.truncate(20 * 1024 * 1024 + 1); await handle.close();
    await assert.rejects(transcribeVoice(files.audio), errorCode('too_large'));
});

test('unsupported or malformed audio is rejected without loading a model', async t => {
    const files = await fixture(t);
    await assert.rejects(transcribeVoice(files.audio), errorCode('invalid_audio'));
    const invalid = wav(); invalid.writeUInt32LE(9999, 4);
    await fs.writeFile(files.audio, invalid);
    await assert.rejects(transcribeVoice(files.audio), errorCode('invalid_audio'));
});

test('silent WAV is rejected instead of hallucinating speech', async t => {
    const files = await fixture(t);
    await fs.writeFile(files.audio, wav());
    await assert.rejects(transcribeVoice(files.audio), errorCode('no_speech'));
});

test('WeChat SILK decodes locally and silence is rejected', async t => {
    const files = await fixture(t);
    const silk = await encode(wav(), 0);
    await fs.writeFile(files.audio, silk.data);
    await assert.rejects(transcribeVoice(files.audio), errorCode('no_speech'));
});

test('over-five-minute audio is rejected before recognition', async t => {
    const files = await fixture(t);
    await fs.writeFile(files.audio, wav(300.1));
    await assert.rejects(transcribeVoice(files.audio), errorCode('too_long'));
});

test('missing model produces a fixed availability error', async t => {
    const files = await fixture(t);
    await fs.writeFile(files.audio, wav(1, true));
    await assert.rejects(transcribeVoice(files.audio, {}, { modelDirectory: path.join(files.root, 'missing') }), errorCode('unavailable'));
});
