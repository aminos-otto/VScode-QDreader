'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { safeUrl } = require('./qidian');

const PORT = 17843;
const MAX_BYTES = 2 * 1024 * 1024;

function validatePayload(data) {
  if (!data || typeof data !== 'object') throw new Error('页面数据格式无效');
  const url = safeUrl(data.url);
  const kind = String(data.kind || '');
  if (!['list', 'book', 'chapter', 'comments'].includes(kind)) throw new Error('不支持的页面类型');
  if (kind === 'comments') {
    if (!/^\/chapter\/\d+\/\d+\/?$/.test(url.pathname) || !Number.isSafeInteger(data.sourceIndex) || data.sourceIndex < 0) throw new Error('段评锚点无效');
    if (!Array.isArray(data.comments) || data.comments.length > 100) throw new Error('段评数据无效');
    return { kind, url: url.href, sourceIndex: data.sourceIndex,
      comments: data.comments.map(c => ({ author: String(c.author || '起点读者').slice(0, 80), text: String(c.text || '').slice(0, 12000) }))
        .filter(c => c.text && !/^(打赏|打赏了|赠送了|月票|推荐票|起点页面段评)$/.test(c.author) && !/(^|\n)打赏了(\n|$)|\d+\s*起点币/.test(c.text)) };
  }
  if (kind === 'chapter') {
    if (!/^\/chapter\/\d+\/\d+\/?$/.test(url.pathname)) throw new Error('章节地址无效');
    if (!Array.isArray(data.paragraphs) || data.paragraphs.length > 500) throw new Error('段落数量无效');
    const paragraphs = data.paragraphs.map((p, index) => {
      const content = String(p.text || '').trim();
      if (content.length > 10000) throw new Error('段落过长');
      const sourceIndex = Number.isSafeInteger(p.index) && p.index >= 0 ? p.index : index;
      const commentCount = Number.isSafeInteger(p.count) && p.count >= 0 ? p.count : 0;
      return { text: content, sourceIndex, commentCount };
    }).filter(p => p.text);
    return { kind, url: url.href, bookId: url.pathname.split('/')[2], title: String(data.title || '章节').slice(0, 160), paragraphs,
      wordCount: Number.isSafeInteger(data.wordCount) && data.wordCount >= 0 ? data.wordCount : 0,
      locked: !!data.locked, vip: !!data.vip };
  }
  if (!Array.isArray(data.books) && kind === 'list') throw new Error('作品列表无效');
  if (kind === 'list') {
    const books = data.books.slice(0, 100).map(b => {
      try {
        const bookUrl = safeUrl(b.url);
        const id = /\/(?:book|info)\/(\d+)/.exec(bookUrl.pathname)?.[1];
        if (!id || String(b.title || '').length > 160) return null;
        return { id, title: String(b.title || '').trim(), url: bookUrl.href };
      } catch { return null; }
    }).filter(b => b?.title);
    return { kind, url: url.href, books };
  }
  const id = /\/(?:book|info)\/(\d+)/.exec(url.pathname)?.[1];
  if (!id || !Array.isArray(data.chapters) || data.chapters.length > 15000) throw new Error('作品目录无效');
  const chapters = data.chapters.map(c => {
    try {
      const chapterUrl = safeUrl(c.url);
      if (!/^\/chapter\/\d+\/\d+\/?$/.test(chapterUrl.pathname) || chapterUrl.pathname.split('/')[2] !== id) return null;
      return { id: chapterUrl.href, url: chapterUrl.href, title: String(c.title || '').slice(0, 160), vip: !!c.vip };
    } catch { return null; }
  }).filter(c => c?.title);
  return { kind, url: url.href, id, title: String(data.title || `作品 ${id}`).slice(0, 160),
    author: String(data.author || '').slice(0, 120), intro: String(data.intro || '').slice(0, 1000), chapters };
}

function chapterFromPayload(data) {
  const bodyLength = data.paragraphs.reduce((n, p) => n + p.text.length, 0);
  const readable = !data.locked && (data.vip
    ? data.paragraphs.length >= 5 && bodyLength >= 500 && data.wordCount >= 100 && bodyLength >= data.wordCount * 0.7
    : data.paragraphs.length >= 2 && bodyLength >= 100);
  return { id: data.url, url: data.url, bookId: data.bookId, title: data.title, vip: data.vip,
    access: readable ? 'readable' : data.vip || data.locked ? 'locked' : 'unavailable',
    paragraphs: readable ? data.paragraphs.map((p, index) => ({ id: `${data.bookId}:${data.url}:${p.sourceIndex}`, text: p.text,
      index, sourceIndex: p.sourceIndex, commentCount: p.commentCount })) : [] };
}

class CompanionBridge {
  constructor(onPayload, port = PORT) { this.onPayload = onPayload; this.port = port; this.server = null; this.control = null; this.pending = new Map(); this.token = null; this.connected = false; this.lastPageUrl = null; this.lastDigest = ''; this.lastReceivedAt = 0; }
  async start(token) {
    if (this.server) return;
    this.token = token || crypto.randomBytes(32).toString('hex');
    this.server = http.createServer((req, res) => {
      const reply = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
      if (req.method !== 'POST' || req.url !== '/ingest' || req.headers.authorization !== `Bearer ${this.token}`) return reply(403, { error: '未授权' });
      let size = 0; const chunks = [];
      req.on('data', chunk => { size += chunk.length; if (size > MAX_BYTES) { req.destroy(); return; } chunks.push(chunk); });
      req.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks);
          const data = validatePayload(JSON.parse(raw.toString('utf8')));
          const digest = crypto.createHash('sha256').update(raw).digest('hex');
          if (digest !== this.lastDigest || Date.now() - this.lastReceivedAt > 5000) await this.onPayload(data);
          this.lastDigest = digest; this.lastReceivedAt = Date.now();
          this.connected = true;
          this.lastPageUrl = data.url;
          reply(200, { ok: true });
        } catch (error) { reply(400, { error: error.message }); }
      });
    });
    const wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const target = new URL(req.url || '/', 'http://127.0.0.1');
      if (target.pathname !== '/control' || target.searchParams.get('token') !== this.token ||
          (req.headers.origin && !req.headers.origin.startsWith('chrome-extension://'))) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        this.control?.terminate(); this.control = ws;
        ws.on('message', raw => {
          try {
            const message = JSON.parse(raw.toString());
            const pending = this.pending.get(message.id);
            if (pending) { this.pending.delete(message.id); clearTimeout(pending.timer); pending.resolve(message.ok === true); }
          } catch { /* 忽略无效控制消息。 */ }
        });
        ws.on('close', () => { if (this.control === ws) this.control = null; });
      });
    });
    try {
      await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.port, '127.0.0.1', resolve); });
      this.port = this.server.address().port;
    } catch (error) { this.server = null; throw error; }
  }
  async stop() {
    const server = this.server; this.server = null; this.connected = false;
    this.control?.terminate(); this.control = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve(false); }
    this.pending.clear();
    if (server) await new Promise(resolve => server.close(resolve));
  }
  async sendControl(type, value, extra = {}) {
    if (!this.control || this.control.readyState !== WebSocket.OPEN) return false;
    const url = safeUrl(value).href;
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(false); }, 6000);
      this.pending.set(id, { resolve, timer });
      this.control.send(JSON.stringify({ type, id, url, ...extra }), error => {
        if (error && this.pending.has(id)) { this.pending.delete(id); clearTimeout(timer); resolve(false); }
      });
    });
  }
  async openInBackground(value) { return this.sendControl('open', value); }
  async requestComments(value, sourceIndex) {
    if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) return false;
    return this.sendControl('comments', value, { sourceIndex });
  }
  pairingCode() { return `${this.port}:${this.token}`; }
  get active() { return !!this.server; }
}

module.exports = { CompanionBridge, validatePayload, chapterFromPayload };
