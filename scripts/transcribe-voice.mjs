import fs from 'node:fs/promises';
import path from 'node:path';
import { decode, getDuration, isSilk } from 'silk-wasm';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SECONDS = 300;
class AudioError extends Error { constructor(code) { super(code); this.code = code; } }

function readWav(bytes) {
    if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
        || bytes.readUInt32LE(4) + 8 !== bytes.length) throw new AudioError('invalid_audio');
    let fmt; let pcm;
    for (let offset = 12; offset + 8 <= bytes.length;) {
        const name = bytes.toString('ascii', offset, offset + 4);
        const length = bytes.readUInt32LE(offset + 4);
        const start = offset + 8;
        if (start + length > bytes.length) throw new AudioError('invalid_audio');
        if (name === 'fmt ') {
            if (length < 16) throw new AudioError('invalid_audio');
            fmt = { encoding: bytes.readUInt16LE(start), channels: bytes.readUInt16LE(start + 2),
                sampleRate: bytes.readUInt32LE(start + 4), blockAlign: bytes.readUInt16LE(start + 12), bits: bytes.readUInt16LE(start + 14) };
        }
        if (name === 'data') pcm = bytes.subarray(start, start + length);
        offset = start + length + (length & 1);
    }
    if (!fmt || !pcm || ![1, 2].includes(fmt.channels) || fmt.sampleRate < 8000 || fmt.sampleRate > 48000
        || !((fmt.encoding === 1 && [8, 16, 24, 32].includes(fmt.bits)) || (fmt.encoding === 3 && fmt.bits === 32))
        || fmt.blockAlign !== fmt.channels * fmt.bits / 8 || pcm.length % fmt.blockAlign) throw new AudioError('invalid_audio');
    const count = pcm.length / fmt.blockAlign;
    if (count / fmt.sampleRate > MAX_SECONDS) throw new AudioError('too_long');
    const samples = new Float32Array(count);
    const width = fmt.bits / 8;
    for (let index = 0; index < count; index++) {
        let value = 0;
        for (let channel = 0; channel < fmt.channels; channel++) {
            const offset = index * fmt.blockAlign + channel * width;
            value += fmt.encoding === 3 ? pcm.readFloatLE(offset) : fmt.bits === 8 ? (pcm[offset] - 128) / 128
                : fmt.bits === 16 ? pcm.readInt16LE(offset) / 32768 : fmt.bits === 24 ? pcm.readIntLE(offset, 3) / 8388608
                : pcm.readInt32LE(offset) / 2147483648;
        }
        samples[index] = value / fmt.channels;
        if (!Number.isFinite(samples[index])) throw new AudioError('invalid_audio');
    }
    return { samples, sampleRate: fmt.sampleRate };
}

async function readAudio(filePath) {
    const info = await fs.lstat(filePath).catch(() => { throw new AudioError('invalid_audio'); });
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw new AudioError('invalid_audio');
    if (info.size > MAX_BYTES) throw new AudioError('too_large');
    const bytes = await fs.readFile(filePath);
    if (!isSilk(bytes)) return readWav(bytes);
    if (getDuration(bytes) > MAX_SECONDS * 1000) throw new AudioError('too_long');
    const result = await decode(bytes, 16000).catch(() => { throw new AudioError('invalid_audio'); });
    if (!result.data.length || result.data.length % 2) throw new AudioError('invalid_audio');
    const pcm = Buffer.from(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    const samples = Float32Array.from({ length: pcm.length / 2 }, (_, index) => pcm.readInt16LE(index * 2) / 32768);
    return { samples, sampleRate: 16000 };
}

function hasSignal(samples) {
    if (!samples.length) return false;
    let energy = 0; let active = 0;
    for (const value of samples) { energy += value * value; if (Math.abs(value) > 0.003) active++; }
    return Math.sqrt(energy / samples.length) > 0.001 && active >= Math.min(1600, samples.length / 10);
}

/** Bound attention memory for longer clips; favor a quiet 200 ms boundary near 25 seconds. */
function splitAudio(samples, sampleRate) {
    const chunks = [];
    let start = 0;
    while (start < samples.length) {
        let end = Math.min(samples.length, start + 30 * sampleRate);
        if (end < samples.length) {
            const limit = end;
            let bestEnergy = Infinity;
            for (let position = start + 25 * sampleRate; position <= limit - sampleRate / 5; position += Math.floor(sampleRate / 10)) {
                let energy = 0;
                for (let i = position; i < position + sampleRate / 5; i++) energy += samples[i] ** 2;
                if (energy < bestEnergy) { bestEnergy = energy; end = position + Math.floor(sampleRate / 10); }
            }
        }
        chunks.push(samples.subarray(start, end)); start = end;
    }
    return chunks;
}

async function main() {
    const [, , filePath, modelDirectory] = process.argv;
    if (!filePath || !modelDirectory) throw new AudioError('invalid_audio');
    const { samples, sampleRate } = await readAudio(filePath);
    if (samples.length / sampleRate > MAX_SECONDS) throw new AudioError('too_long');
    if (!hasSignal(samples)) throw new AudioError('no_speech');
    const model = path.join(modelDirectory, 'model.int8.onnx');
    const tokens = path.join(modelDirectory, 'tokens.txt');
    await Promise.all([fs.access(model), fs.access(tokens)]).catch(() => { throw new AudioError('unavailable'); });
    const { default: sherpa } = await import('sherpa-onnx-node').catch(() => { throw new AudioError('unavailable'); });
    const recognizer = new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: { senseVoice: { model, language: 'auto', useInverseTextNormalization: 1 },
            tokens, numThreads: 2, provider: 'cpu', debug: 0 }
    });
    const parts = [];
    for (const chunk of splitAudio(samples, sampleRate)) {
        if (!hasSignal(chunk)) continue;
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate, samples: chunk });
        recognizer.decode(stream);
        const result = recognizer.getResult(stream);
        if (result.event && result.event !== '<|Speech|>') continue;
        const text = String(result.text ?? '').replace(/<\|[^|]*\|>/g, '').trim();
        if (/[\p{L}\p{N}]/u.test(text)) parts.push(text);
    }
    const text = parts.join('\n').trim();
    if (!text) throw new AudioError('no_speech');
    process.stdout.write(JSON.stringify({ ok: true, text }));
}

main().catch(error => {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof AudioError ? error.code : 'failed' }));
    process.exitCode = 1;
});
