import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import QRCode from 'qrcode';
import { ROOT, RUNTIME, readConfig, writeJson } from './config.js';
import { StateStore } from './state.js';
import { CodexRunError } from './codex.js';
import { AppServerClient } from './app-server.js';
import { AppServerRunner } from './app-server-runner.js';
import { ThreadCatalog } from './thread-catalog.js';
import { loadAccounts, listAccounts, saveAccount, validateAccountLabel } from './accounts.js';
import { runBridge, type AccountContext } from './bridge.js';
import { type Conversation } from './state.js';
import { DesktopCodexRunner } from './desktop-codex.js';
import { DesktopSidebar, DesktopSidebarError } from './desktop-sidebar.js';
import { prepareIncomingInput } from './prepare-input.js';
import { loginWeixin, WeixinClient, WeixinApiError, type WeixinCredentials } from './weixin.js';

const timestamp = () => new Date().toISOString();
function log(message: string): void { console.log(`${timestamp()} ${message}`); }
function lock(name: string): () => void {
  const file = path.join(RUNTIME, name);
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = Number(fs.readFileSync(file, 'utf8').trim());
      if (!Number.isInteger(previous) || previous <= 0) throw new Error('进程锁格式无效，请检查 .runtime 中的 PID 文件。');
      try { process.kill(previous, 0); throw new Error('已有程序持有进程锁，请先停止它。'); }
      catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        fs.unlinkSync(file);
      }
    }
  }
  throw new Error('无法取得进程锁。');
}

async function login(label?: string): Promise<void> {
  if (label !== undefined) label = validateAccountLabel(label);
  const unlock = lock('login.pid');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  const qrFile = path.join(RUNTIME, 'weixin-login.png');
  const loginStatus = path.join(RUNTIME, 'login-status.json');
  let qrData: string | undefined;
  let connected = false;
  const page = (message: string, waiting = true, showQr = true) => {
    const escape = (text: string) => text.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
    fs.writeFileSync(path.join(RUNTIME, 'login.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8">${waiting ? '<meta http-equiv="refresh" content="2">' : ''}<title>添加微信账号</title><style>body{font:16px/1.7 system-ui;margin:48px auto;max-width:520px;padding:24px;text-align:center;background:#f5f7fa;color:#172330}main{background:white;padding:28px;border-radius:18px}img{width:min(100%,360px)}p{color:#526175}</style><main><h1>添加微信账号</h1><p>${escape(message)}</p>${showQr && qrData ? `<img alt="请使用待接入者的微信扫描" src="${qrData}">` : ''}<p>请由要使用机器人的人扫码并确认。已有账号会继续保留。</p><p>二维码会自动更新。关闭此页面不会停止微信桥接。</p></main></html>`, { mode: 0o600 });
  };
  page('正在申请新的绑定二维码…', true, false);
  writeJson(loginStatus, { state: 'starting', updatedAt: timestamp() });
  try {
    const existing = loadAccounts(RUNTIME);
    const bound = await loginWeixin({
      existingTokens: existing.map(account => account.credentials.token),
      signal: controller.signal,
      onQRCode: async content => {
        await QRCode.toFile(qrFile, content, { width: 480, margin: 3, errorCorrectionLevel: 'M' });
        qrData = await QRCode.toDataURL(content, { width: 480, margin: 3, errorCorrectionLevel: 'M' });
        page('使用待接入者的微信扫描下方二维码。');
        writeJson(loginStatus, { state: 'waiting_for_scan', updatedAt: timestamp(), qrFile });
        log(`请使用手机微信扫码：${qrFile}`);
      },
      onStatus: status => {
        writeJson(loginStatus, { state: status, updatedAt: timestamp(), qrFile });
        if (status === 'scaned') page('已扫码，请在微信中确认绑定。');
        else if (status === 'expired') page('二维码已过期，正在刷新…', true, false);
        if (status !== 'wait') log(`微信登录状态：${status}`);
      },
      onVerification: async () => {
        const verificationFile = path.join(RUNTIME, 'verify-code.txt');
        writeJson(loginStatus, { state: 'verification_required', updatedAt: timestamp() });
        page(`微信要求配对码。请把手机上的数字写入：${verificationFile}`, true, false);
        log(`微信要求配对码，请将手机显示的验证码写入 ${verificationFile}`);
        for (let count = 0; count < 300 && !controller.signal.aborted; count++) {
          if (fs.existsSync(verificationFile)) {
            const code = fs.readFileSync(verificationFile, 'utf8').trim();
            fs.unlinkSync(verificationFile);
            if (code) return code;
          }
          await delay(1000, undefined, { signal: controller.signal });
        }
        throw new Error('等待验证码超时。');
      }
    });
    const account = saveAccount(RUNTIME, bound, label);
    writeJson(loginStatus, { state: 'connected', updatedAt: timestamp(), accountId: account.id, label: account.label });
    connected = true;
    page(`「${account.label}」绑定成功，可以从该微信账号的 ClawBot 对话发送任务。`, false, false);
    log(`微信账号「${account.label}」已绑定；运行中的桥接会自动接入。`);
  } finally {
    try {
      if (!connected) {
        writeJson(loginStatus, { state: 'stopped', updatedAt: timestamp() });
        page('本次扫码已结束，尚未新增账号。需要继续时请重新打开 add-account.cmd。', false, false);
      }
      if (fs.existsSync(qrFile)) fs.unlinkSync(qrFile);
    } finally {
      unlock(); process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort);
    }
  }
}

function doctor(): void {
  const config = readConfig();
  const version = spawnSync(config.codexExecutable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (version.error || version.status !== 0) throw new Error('Codex 程序不可运行。');
  console.log(`Codex：${version.stdout.trim()}`);
  const auth = spawnSync(config.codexExecutable, ['login', 'status'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (auth.error || auth.status !== 0) throw new Error('Codex 登录或配置检查失败，请在本机运行配置中程序的 login 命令。');
  console.log('Codex 登录：可用');
  console.log(`工作目录：${config.workingDirectory}`);
  console.log(`工作权限：${config.sandbox}`);
  console.log(`白名单：${config.accessControl.enabled ? '开启' : '关闭'}`);
  console.log(`微信账号：${listAccounts(RUNTIME).length} 个（在线状态在启动时验证）`);
}

async function start(): Promise<void> {
  const config = readConfig();
  if (!loadAccounts(RUNTIME).length) throw new Error('尚未绑定微信，请先运行 add-account.cmd。');
  const options = { executable: config.codexExecutable, workingDirectory: config.workingDirectory,
    sandbox: config.sandbox, timeoutMs: config.taskTimeoutMinutes * 60000, model: config.model };
  const catalog = new ThreadCatalog(RUNTIME, options);
  const desktop = new DesktopCodexRunner(options);
  const sidebar = new DesktopSidebar(RUNTIME);
  const placeOnDesktop = async (threadId: string) => {
    try { await sidebar.place(threadId); }
    catch (error) { log(`任务 ${threadId} 的桌面分组暂未确认：${error instanceof DesktopSidebarError ? error.message : '桌面分组工具暂不可用。'}`); }
  };
  const unlock = lock('bridge.pid');
  const stopFile = path.join(RUNTIME, 'stop.request');
  const shutdown = new AbortController();
  let statusValue: Record<string, unknown> = { state: 'starting', pendingJobs: 0, accessControlEnabled: config.accessControl.enabled };
  let backgroundError: unknown;
  const requestStop = () => shutdown.abort();
  const publish = (value = statusValue) => {
    statusValue = value;
    writeJson(path.join(RUNTIME, 'status.json'), { ...value, updatedAt: timestamp(), pid: process.pid });
  };
  process.once('SIGINT', requestStop); process.once('SIGTERM', requestStop);
  if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile);
  const timer = setInterval(() => {
    try { if (fs.existsSync(stopFile)) requestStop(); publish(); }
    catch (error) { backgroundError ??= error; requestStop(); }
  }, 1000);
  const title = (context: Pick<AccountContext, 'account'>) => `微信 · ${context.account.label}`;
  const prepare = async (context: Pick<AccountContext, 'account' | 'store'>, conversation: Conversation) => {
    if (!conversation.threadId) return;
    const api = await AppServerClient.connect(options);
    try {
      await catalog.ensureVisible(api, conversation.threadId, title(context), id => {
        if (id !== conversation.threadId) {
          conversation.previousThreadIds = [...(conversation.previousThreadIds ?? []), conversation.threadId!];
          conversation.threadId = id; context.store.save();
          log(`账号 ${context.account.id} 的历史已接入可见任务 ${id}。`);
        }
      });
    } finally { await api.close(); }
    await placeOnDesktop(conversation.threadId);
  };
  try {
    publish();
    // Complete existing idle-session migration once, before accepting new messages.
    for (const account of loadAccounts(RUNTIME)) {
      const store = new StateStore(path.join(RUNTIME, `state-${account.id}.json`), account.credentials.botId);
      for (const [userId, conversation] of Object.entries(store.data.conversations)) {
        if (shutdown.signal.aborted) break;
        if (store.data.jobs.some(job => job.userId === userId && job.status === 'running')) continue;
        try { await prepare({ account, store }, conversation); }
        catch { log(`账号 ${account.id} 的一个历史任务暂未完成显示迁移；账号接收继续运行，下次任务会检查迁移状态。`); }
      }
    }
    await runBridge(config, {
      runtime: RUNTIME, signal: shutdown.signal, loadAccounts: () => loadAccounts(RUNTIME),
      createClient: account => new WeixinClient(account.credentials), prepare, log, status: publish,
      prepareInput: (context, job, signal) => prepareIncomingInput(RUNTIME, context.account.id, job, signal),
      run: async (context, input) => {
        const runner = new AppServerRunner(options, { onThreadReady: async (id, api) => {
          await catalog.place(api, id, title(context));
          await placeOnDesktop(id);
        } });
        try { return await runner.run(input); }
        catch (error) {
          if (!(error instanceof CodexRunError) || error.code !== 'session_busy' || !input.threadId || input.signal?.aborted) throw error;
          log(`账号 ${context.account.id} 通过桌面 Codex 续接原任务。`);
          return desktop.run(input);
        }
      }
    });
    if (backgroundError) throw backgroundError;
  } finally {
    clearInterval(timer); shutdown.abort();
    try { publish({ ...statusValue, state: 'stopped' }); }
    finally {
      try { if (fs.existsSync(stopFile)) fs.unlinkSync(stopFile); }
      finally { unlock(); process.removeListener('SIGINT', requestStop); process.removeListener('SIGTERM', requestStop); }
    }
    log('桥接程序已停止。');
  }
}

try {
  const command = process.argv[2];
  if (command === 'login') await login(process.argv[3]);
  else if (command === 'accounts') console.log(JSON.stringify(listAccounts(RUNTIME), null, 2));
  else if (command === 'doctor') doctor();
  else if (command === 'start') await start();
  else console.log('用法：npm run doctor | npm run login -- [名称] | npm run accounts | npm start');
} catch (error) {
  // Never dump objects, API responses, prompts, tokens or child stderr to logs.
  if (error instanceof WeixinApiError) console.error(`微信请求失败（HTTP ${error.httpStatus ?? '-'} / ret ${error.ret ?? '-'} / errcode ${error.errcode ?? '-'}）。`);
  else if (error instanceof Error && !/fetch|JSON|Unexpected|ENOENT|EACCES/.test(error.message)) console.error(error.message);
  else console.error('程序启动或配置读取失败，请检查 config.json、网络和本机登录状态。');
  process.exitCode = 1;
}
