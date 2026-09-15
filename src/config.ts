import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexExecutable } from './codex-executable.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUNTIME = path.join(ROOT, '.runtime');

export interface Config {
  workingDirectory: string;
  codexExecutable: string;
  sandbox: 'read-only' | 'workspace-write';
  taskTimeoutMinutes: number;
  model?: string;
  accessControl: { enabled: boolean; allowedUserIds: string[] };
}

export function readConfig(file = path.join(ROOT, 'config.json')): Config {
  const config = JSON.parse(fs.readFileSync(file, 'utf8')) as Config;
  if (!path.isAbsolute(config.workingDirectory) || !fs.statSync(config.workingDirectory).isDirectory()) {
    throw new Error('工作目录必须是存在的绝对路径。');
  }
  config.codexExecutable = resolveCodexExecutable(config.codexExecutable);
  if (!['read-only', 'workspace-write'].includes(config.sandbox)) throw new Error('sandbox 配置无效。');
  if (!Number.isInteger(config.taskTimeoutMinutes) || config.taskTimeoutMinutes < 1 || config.taskTimeoutMinutes > 1440) {
    throw new Error('taskTimeoutMinutes 必须为 1 至 1440。');
  }
  if (!config.accessControl || typeof config.accessControl.enabled !== 'boolean' || !Array.isArray(config.accessControl.allowedUserIds)
    || config.accessControl.allowedUserIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('accessControl 配置无效。');
  }
  if (config.model !== undefined && (typeof config.model !== 'string' || !config.model.trim())) throw new Error('model 配置无效。');
  return config;
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  const retryDelays = [10, 20, 40, 80, 160];
  try {
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2), { mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(temporary, file);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= retryDelays.length) throw error;
        // Windows readers can briefly deny replacement. Keep the old file intact
        // and retry the same atomic rename, with at most 310 ms of added waiting.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelays[attempt]);
      }
    }
  } finally {
    // A failed replacement must not leave a second copy of persisted state behind.
    try { fs.unlinkSync(temporary); } catch { /* Preserve the original write/rename error. */ }
  }
}
