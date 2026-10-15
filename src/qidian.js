'use strict';

const https = require('node:https');
const { load } = require('cheerio');

const HOSTS = new Set(['www.qidian.com', 'book.qidian.com', 'read.qidian.com', 'vipreader.qidian.com', 'my.qidian.com', 'm.qidian.com']);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

function safeUrl(value, base = 'https://www.qidian.com/') {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.username || url.password) throw new Error('只允许访问起点官方网站');
  return url;
}

function requestPage(value, cookie = '', redirects = 0) {
  const url = safeUrl(value);
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' };
    if (cookie) headers.Cookie = cookie;
    const req = https.get(url, { headers, timeout: 15000 }, response => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirects >= 4) return reject(new Error('重定向次数过多'));
        let next;
        try { next = safeUrl(response.headers.location, url); } catch (error) { return reject(error); }
        return requestPage(next.href, cookie, redirects + 1).then(resolve, reject);
      }
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) { req.destroy(new Error('页面内容超过限制')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const html = Buffer.concat(chunks).toString('utf8');
        if (status === 202 || /\/probe\.js\?v=|var buid =/.test(html)) return reject(new Error('起点返回网站验证页，当前请求无法获取书籍数据；请在官网正常阅读，插件不会绕过验证'));
        if (status === 401 || status === 403) return reject(new Error('登录已失效或网站拒绝访问'));
        if (status >= 400) return reject(new Error(`起点返回 HTTP ${status}`));
        resolve({ html, url: url.href });
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接起点超时')));
    req.on('error', reject);
  });
}

function unique(items, key) {
  const seen = new Set();
  return items.filter(item => { const id = key(item); if (seen.has(id)) return false; seen.add(id); return true; });
}

function extractBooks(html, base) {
  const $ = load(html);
  const books = [];
  $('a[href]').each((_, node) => {
    const href = $(node).attr('href') || '';
    if (!/(?:book\.qidian\.com\/info\/|qidian\.com\/book\/|^\/book\/|^\/info\/)(\d+)/.test(href)) return;
    let url;
    try { url = safeUrl(href, base).href; } catch { return; }
    const id = /(?:info|book)\/(\d+)/.exec(url)?.[1];
    if (!id) return;
    const title = ($(node).attr('title') || $(node).text() || $(node).find('img').attr('alt') || '').replace(/\s+/g, ' ').trim();
    if (!title || title.length > 100) return;
    books.push({ id, title, url });
  });
  return unique(books, book => book.id).slice(0, 80);
}

function extractBook(html, url, id) {
  const $ = load(html);
  const title = ($('h1').first().text() || $('meta[property="og:title"]').attr('content') || $('title').text()).replace(/\s+/g, ' ').trim();
  const author = ($('.writer').first().text() || $('[data-author]').first().attr('data-author') || '').replace(/\s+/g, ' ').trim();
  const intro = ($('.book-intro').first().text() || $('.intro').first().text() || $('meta[name="description"]').attr('content') || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  return { id, title: title || `作品 ${id}`, author, intro, url };
}

function extractChapters(html, base) {
  const $ = load(html);
  const chapters = [];
  $('a[href]').each((_, node) => {
    const href = $(node).attr('href') || '';
    if (!/qidian\.com\/chapter\/|^\/chapter\//.test(href)) return;
    let url;
    try { url = safeUrl(href, base).href; } catch { return; }
    const title = ($(node).attr('title') || $(node).text()).replace(/\s+/g, ' ').trim();
    if (!title || title.length > 160) return;
    chapters.push({ id: url, title, url, vip: url.includes('vipreader.qidian.com') || /vip|订阅/i.test($(node).parent().text()) });
  });
  return unique(chapters, chapter => chapter.id).slice(0, 10000);
}

function extractChapter(html, url, bookId, options = {}) {
  const $ = load(html);
  const currentMain = $('main[id^="c-"]').first();
  const title = (currentMain.length ? currentMain.siblings('h1').first().text() || $('h1.title').first().text() : $('h1').first().text() || $('title').text()).replace(/\s+/g, ' ').trim();
  const locked = /(?:订阅本章|购买本章|订阅后阅读|登录后订阅|本章为VIP章节|开通会员后阅读)/.test($('.read-content,.chapter-content,.main-text,body').first().text());
  const selectors = ['.read-content p', '.chapter-content p', '#chapterContent p', '.main-text p', '.read-content .p', '.chapter-content .p'];
  let paragraphs = [];
  if (currentMain.length) {
    paragraphs = currentMain.children('p').map((_, node) => {
      const span = $(node).find('span.content-text').first();
      if (!span.length) return null;
      const text = span.text().replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const sourceIndex = Number(span.attr('data-index'));
      const count = Number(span.attr('data-count'));
      return { text, sourceIndex: Number.isSafeInteger(sourceIndex) && sourceIndex >= 0 ? sourceIndex : undefined, commentCount: Number.isSafeInteger(count) && count >= 0 ? count : 0 };
    }).get().filter(Boolean);
  }
  for (const selector of selectors) {
    const values = $(selector).map((_, node) => $(node).text().replace(/\s+/g, ' ').trim()).get().filter(value => value.length > 0);
    if (values.length > paragraphs.length) paragraphs = values.map(text => ({ text, commentCount: 0 }));
  }
  const vip = !!options.expectedVip || url.includes('vipreader.qidian.com') || /\bVIP\b/i.test(title) || $('#app[data-p="vipread"]').length > 0;
  const bodyLength = paragraphs.reduce((total, p) => total + p.text.length, 0);
  const statedWordCount = Number(currentMain.prevAll('div').first().text().match(/(\d{2,6})\s*字/)?.[1] || 0);
  // 仅在已登录的官方浏览器完整呈现章节且正文长度与页面标注字数相符时，才允许读取 VIP。
  const fullVipBody = !!options.authenticated && currentMain.length > 0 && paragraphs.length >= 5 && bodyLength >= 500
    && statedWordCount > 0 && bodyLength >= statedWordCount * 0.7;
  const readable = !locked && (vip ? fullVipBody : paragraphs.length >= 2 && bodyLength >= 100);
  return {
    id: url, bookId, title: title || '章节', url, vip,
    access: readable ? 'readable' : locked || vip ? 'locked' : 'unavailable',
    paragraphs: readable ? paragraphs.map((p, index) => ({ id: `${bookId}:${url}:${p.sourceIndex ?? index}`, text: p.text, index, sourceIndex: p.sourceIndex ?? index, commentCount: p.commentCount })) : []
  };
}

class QidianClient {
  constructor(browserSession) { this.cookie = ''; this.browserSession = browserSession; }
  setCookie(cookie) {
    const clean = String(cookie || '').trim();
    if (clean && (!/^[\w.-]+=[^;\r\n]+/.test(clean) || /[\r\n]/.test(clean))) throw new Error('Cookie 格式无效');
    this.cookie = clean;
  }
  clear() { this.cookie = ''; }
  async request(value, selector) {
    if (this.browserSession?.hasSavedSession()) return this.browserSession.getHtml(value, selector);
    return requestPage(value, this.cookie);
  }
  async discover() {
    const page = await this.request('https://www.qidian.com/', 'a[href*="/book/"],a[href*="/info/"]');
    return extractBooks(page.html, page.url);
  }
  async search(query) {
    const page = await this.request(`https://www.qidian.com/soushu/${encodeURIComponent(query)}.html`, 'a[href*="/book/"],a[href*="/info/"]');
    return extractBooks(page.html, page.url);
  }
  async shelf() {
    if (!this.cookie && !this.browserSession?.hasSavedSession()) throw new Error('请先扫码登录');
    const page = await this.request('https://my.qidian.com/bookcase', 'a[href*="/book/"],a[href*="/info/"]');
    if (/登录|passport\.qidian\.com/.test(page.url) || /请先登录/.test(page.html)) throw new Error('登录会话已失效，请重新导入');
    return extractBooks(page.html, page.url);
  }
  async book(id) {
    if (!/^\d+$/.test(id)) throw new Error('作品 ID 无效');
    const page = await this.request(`https://book.qidian.com/info/${id}/`, 'a[href*="/chapter/"]');
    return { ...extractBook(page.html, page.url, id), chapters: extractChapters(page.html, page.url) };
  }
  async chapter(bookId, url, expectedVip = false) {
    const page = await this.request(url, 'main[id^="c-"] span.content-text');
    return extractChapter(page.html, page.url, bookId, { authenticated: !!this.browserSession?.hasSavedSession(), expectedVip });
  }
  async paragraphComments() {
    // 网站段评接入尚未验证。绝不把章节末评论误配到某个段落。
    return { status: 'unavailable', comments: [] };
  }
}

module.exports = { QidianClient, safeUrl, extractBooks, extractBook, extractChapters, extractChapter };
