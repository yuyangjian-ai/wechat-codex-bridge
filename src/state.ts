import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { writeJson, type Config } from './config.js';
import type { WeixinMessageItem, WeixinCDNMedia } from './weixin.js';
import type { IncomingMediaAttachment } from './incoming-media.js';

export interface IncomingMessage {
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  context_token?: string;
  message_type?: number;
  message_state?: number;
  create_time_ms?: number;
  item_list?: WeixinMessageItem[];
}
export interface Conversation { threadId?: string; previousThreadIds?: string[]; contextToken: string; updatedAt: string }
export interface Job {
  id: string; userId: string; prompt: string; status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: string; finishedAt?: string; result?: string; images?: Array<{ path: string }>;
  attachments?: IncomingMediaAttachment[];
  inputImages?: Array<{ path: string }>;
  readyAt?: number;
}
export interface AcceptBatchOptions { now?: number; mergeWindowMs?: number }
export interface Outgoing {
  id: string; userId: string; text: string; kind?: 'image'; imagePath?: string; status: 'pending' | 'sending' | 'sent' | 'failed'; createdAt: string;
}
export interface BridgeState {
  version: 1; accountId: string; cursor: string; seen: string[];
  conversations: Record<string, Conversation>; jobs: Job[]; outbox: Outgoing[];
}

function mediaReference(media: WeixinCDNMedia | undefined): WeixinCDNMedia {
  return { encrypt_query_param: media?.encrypt_query_param, aes_key: media?.aes_key,
    full_url: media?.full_url, encrypt_type: media?.encrypt_type };
}
function hasMediaLocation(media: WeixinCDNMedia | undefined): boolean {
  return !!media && ((typeof media.full_url === 'string' && !!media.full_url.trim())
    || (typeof media.encrypt_query_param === 'string' && !!media.encrypt_query_param.trim()));
}

/** Persist only input references; downloads and speech recognition belong to the job worker. */
function messageInput(items: WeixinMessageItem[]): { prompt: string; attachments: IncomingMediaAttachment[]; error?: string } {
  const text: string[] = [];
  const attachments: IncomingMediaAttachment[] = [];
  let error: string | undefined;
  for (const item of items) {
    if (item.type === 1 && typeof item.text_item?.text === 'string') text.push(item.text_item.text);
    else if (item.type === 2) {
      const value = item.image_item;
      if (!hasMediaLocation(value?.media)) { error = '没有取得图片下载信息，请重新发送图片。'; continue; }
      attachments.push({ kind: 'image', media: mediaReference(value?.media), aesKeyHex: value?.aeskey });
    } else if (item.type === 3) {
      const value = item.voice_item;
      if (typeof value?.text === 'string' && value.text.trim()) text.push(value.text);
      else if (value && hasMediaLocation(value.media)) attachments.push({ kind: 'voice', media: mediaReference(value.media),
        encodeType: value.encode_type, sampleRate: value.sample_rate, bitsPerSample: value.bits_per_sample, playtime: value.playtime });
      else error = '没有取得语音内容，请重新发送语音，或改用文字。';
    } else if (item.type === 4 || item.type === 5) error = '目前支持文字、图片和语音提问，视频与文件输入尚未接入。';
  }
  if (attachments.filter(value => value.kind === 'image').length > 4 || attachments.filter(value => value.kind === 'voice').length > 4) {
    error = '单条消息最多支持 4 张图片或 4 段语音，请分开发送。';
  }
  return { prompt: text.join('\n').trim(), attachments, error };
}
export function splitText(text: string, max = 1800): string[] {
  if (!Number.isInteger(max) || max < 1) throw new Error('分片长度必须为正整数。');
  // Preserve full graphemes, including flags, skin tones and family emoji.
  const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text);
  const result: string[] = [];
  let chunk = ''; let size = 0;
  for (const { segment } of segments) {
    const width = Array.from(segment).length;
    if (chunk && size + width > max) { result.push(chunk); chunk = ''; size = 0; }
    chunk += segment; size += width;
  }
  if (chunk) result.push(chunk);
  return result.length ? result : ['任务已完成，未返回文字。'];
}

export class StateStore {
  data: BridgeState;
  constructor(readonly file: string, readonly accountId: string) {
    if (fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8')) as BridgeState;
      if (this.data.version !== 1 || this.data.accountId !== accountId || !Array.isArray(this.data.jobs) || !Array.isArray(this.data.outbox)
        || !Array.isArray(this.data.seen) || typeof this.data.conversations !== 'object' || this.data.conversations === null) {
        throw new Error('状态文件与当前微信账号不匹配，或文件格式无效。');
      }
      this.data.conversations = Object.assign(Object.create(null), this.data.conversations);
    } else {
      this.data = { version: 1, accountId, cursor: '', seen: [], conversations: Object.create(null), jobs: [], outbox: [] };
    }
  }
  save(): void {
    this.data.seen = this.data.seen.slice(-10000);
    const finished = this.data.jobs.filter(j => j.status !== 'queued' && j.status !== 'running').slice(-100);
    this.data.jobs = [...finished, ...this.data.jobs.filter(j => j.status === 'queued' || j.status === 'running')];
    this.data.outbox = [...this.data.outbox.filter(o => o.status === 'sent' || o.status === 'failed').slice(-100), ...this.data.outbox.filter(o => o.status === 'pending' || o.status === 'sending')];
    writeJson(this.file, this.data);
  }
  recoverInterrupted(): void {
    for (const entry of this.data.outbox) {
      if (entry.status === 'sending') entry.status = 'failed'; // Unknown delivery; never blindly resend.
    }
    for (const job of this.data.jobs) {
      if (job.status === 'running') {
        job.status = 'failed'; job.prompt = ''; delete job.attachments; job.finishedAt = new Date().toISOString();
        this.reply(job.userId, '桥接程序在上一项任务执行期间中断。为避免重复修改，任务没有自动重跑。请先确认执行结果，再发送后续指令。');
      }
    }
    this.save();
  }
  reply(userId: string, text: string): void {
    for (const chunk of splitText(text)) this.data.outbox.push({ id: randomUUID(), userId, text: chunk, status: 'pending', createdAt: new Date().toISOString() });
  }
  replyImage(userId: string, imagePath: string): void {
    this.data.outbox.push({ id: randomUUID(), userId, kind: 'image', imagePath, text: '', status: 'pending', createdAt: new Date().toISOString() });
  }
  acceptBatch(messages: IncomingMessage[], nextCursor: string | undefined, config: Config, options: AcceptBatchOptions = {}): string[] {
    const now = options.now ?? Date.now();
    const mergeWindowMs = options.mergeWindowMs ?? 2000;
    if (!Number.isFinite(now) || !Number.isFinite(mergeWindowMs) || mergeWindowMs < 0 || !Number.isFinite(now + mergeWindowMs)) throw new Error('消息合并时间配置无效。');
    const timestamp = new Date(now).toISOString();
    const closeMergeWindow = (userId: string): void => {
      for (const job of this.data.jobs) if (job.userId === userId && job.status === 'queued' && job.readyAt !== undefined && job.readyAt > now) job.readyAt = now;
    };
    const cancelUsers: string[] = [];
    for (const msg of messages) {
      if (msg.message_type !== 1 || (msg.message_state !== undefined && msg.message_state !== 2) || !msg.from_user_id || !msg.context_token) continue;
      const userId = msg.from_user_id;
      const id = msg.message_id !== undefined ? `${userId}:${msg.message_id}` : createHash('sha256').update(JSON.stringify(msg)).digest('hex');
      if (this.data.seen.includes(id)) continue;
      this.data.seen.push(id);
      if (config.accessControl.enabled && !config.accessControl.allowedUserIds.includes(userId)) continue;
      const conversation = this.data.conversations[userId] ??= { contextToken: msg.context_token, updatedAt: timestamp };
      conversation.contextToken = msg.context_token;
      conversation.updatedAt = timestamp;
      const { prompt, attachments, error } = messageInput(msg.item_list ?? []);
      if (error) { closeMergeWindow(userId); this.reply(userId, error); continue; }
      if (!prompt && !attachments.length) {
        closeMergeWindow(userId);
        this.reply(userId, '请发送文字、图片或语音来描述任务。');
        continue;
      }
      const command = attachments.length ? '' : prompt.toLowerCase();
      if (['/help', '/whoami', '/result', '/status', '/new', '/stop'].includes(command)) closeMergeWindow(userId);
      if (command === '/help') this.reply(userId, '直接发送文字、图片或语音即可，后续消息会延续同一会话。图片可以结合前后消息提问；语音会先转成文字。\n/new 新会话\n/status 查看状态\n/result 再次获取最近任务结果和生成的图片\n/stop 停止当前任务并取消你的排队任务\n/whoami 查看用于白名单的用户 ID');
      else if (command === '/whoami') this.reply(userId, `你的微信通道用户 ID：\n${userId}\n白名单：${config.accessControl.enabled ? '开启' : '关闭'}`);
      else if (command === '/result') {
        const last = this.data.jobs.filter(j => j.userId === userId && (j.result || j.images?.length)).at(-1);
        this.reply(userId, last?.result || (last?.images?.length ? '图片已生成。' : '尚无已保存的任务结果。'));
        for (const image of last?.images ?? []) this.replyImage(userId, image.path);
      }
      else if (command === '/status') {
        const own = this.data.jobs.filter(j => j.userId === userId);
        const last = own.at(-1);
        const pending = own.filter(j => j.status === 'queued').length;
        const statusName = { queued: '等待执行', running: '执行中', done: '已完成', failed: '执行失败或中断', cancelled: '已取消' };
        this.reply(userId, `工作目录：${config.workingDirectory}\n当前任务：${last ? statusName[last.status] : '尚无任务'}\n排队：${pending}\n会话：${conversation.threadId ? '已建立' : '尚未建立'}\n白名单：${config.accessControl.enabled ? '开启' : '关闭'}`);
      } else if (command === '/new') {
        if (this.data.jobs.some(j => j.userId === userId && (j.status === 'running' || j.status === 'queued'))) this.reply(userId, '你还有任务在执行或排队，请先发送 /stop，等待停止后再 /new。');
        else { delete conversation.threadId; this.reply(userId, '已开启新会话，请发送任务。'); }
      } else if (command === '/stop') {
        cancelUsers.push(userId);
        for (const job of this.data.jobs) if (job.userId === userId && job.status === 'queued') { job.status = 'cancelled'; job.prompt = ''; delete job.attachments; job.finishedAt = timestamp; }
        this.reply(userId, '已取消你的排队任务，并请求停止正在执行的任务。停止不会撤销已完成的操作。');
      } else {
        // A provided voice transcript is still voice input, so it does not join a picture burst.
        const hasVoice = (msg.item_list ?? []).some(item => item.type === 3);
        const previous = this.data.jobs.filter(job => job.userId === userId).at(-1);
        const previousImages = previous?.attachments?.filter(item => item.kind === 'image').length ?? 0;
        const newImages = attachments.filter(item => item.kind === 'image').length;
        if (mergeWindowMs > 0 && !hasVoice && previous?.status === 'queued' && previous.readyAt !== undefined && now < previous.readyAt
          && !previous.attachments?.some(item => item.kind === 'voice') && previousImages + newImages > 0 && previousImages + newImages <= 4) {
          previous.prompt = [previous.prompt, prompt].filter(Boolean).join('\n');
          if (attachments.length) previous.attachments = [...(previous.attachments ?? []), ...attachments];
          // Keep the original deadline and acknowledgement; cursor and every message ID still commit below.
          continue;
        }
        const id = randomUUID();
        this.data.jobs.push({ id, userId, prompt, ...(attachments.length ? { attachments } : {}),
          ...(!hasVoice ? { readyAt: now + mergeWindowMs } : {}), status: 'queued', createdAt: timestamp });
        this.reply(userId, '收到，已加入任务队列。完成后会在这里回复。');
      }
    }
    if (nextCursor !== undefined) this.data.cursor = nextCursor;
    // Cursor, dedupe IDs and accepted jobs commit together before execution.
    this.save();
    return cancelUsers;
  }
}
