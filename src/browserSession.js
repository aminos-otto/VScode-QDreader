'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { safeUrl } = require('./qidian');

function edgePath() {
  const candidates = process.platform === 'win32' ? [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ] : process.platform === 'darwin' ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  return candidates.find(candidate => fs.existsSync(candidate));
}

function qidianCookies(cookies) {
  return (cookies || []).filter(cookie => {
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    return domain === 'qidian.com' || domain.endsWith('.qidian.com');
  }).map(cookie => ({
    name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path || '/',
    expires: cookie.expires, httpOnly: !!cookie.httpOnly, secure: !!cookie.secure, sameSite: cookie.sameSite,
  }));
}

class BrowserSession {
  constructor() { this.browser = null; this.context = null; this.loginPage = null; this.savedCookies = []; this.launching = null; }
  setSavedCookies(cookies) { this.savedCookies = qidianCookies(cookies); }
  hasSavedSession() { return this.savedCookies.length > 0; }
  async ensure() {
    if (this.browser?.connected && this.context) return;
    if (this.launching) return this.launching;
    this.launching = this.launch();
    try { await this.launching; } finally { this.launching = null; }
  }
  async launch() {
    const executablePath = edgePath();
    if (!executablePath) throw new Error('本机未找到 Microsoft Edge');
    const puppeteer = require('puppeteer-core');
    this.browser = await puppeteer.launch({ executablePath, headless: false, defaultViewport: null, args: ['--no-first-run', '--no-default-browser-check'] });
    try {
      this.context = await this.browser.createBrowserContext();
      if (this.savedCookies.length) {
        await this.context.setCookie(...this.savedCookies);
      }
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }
  async openLogin() {
    await this.ensure();
    if (this.loginPage && !this.loginPage.isClosed()) { await this.loginPage.bringToFront(); return; }
    this.loginPage = await this.context.newPage();
    await this.loginPage.goto('https://www.qidian.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.loginPage.bringToFront();
  }
  async finishLogin() {
    if (!this.context || !this.loginPage || this.loginPage.isClosed()) throw new Error('登录窗口已经关闭，请重新打开');
    const cookies = qidianCookies(await this.context.cookies());
    if (!cookies.length) throw new Error('尚未检测到起点会话；请在 Edge 官方页面完成登录');
    const page = await this.context.newPage();
    try {
      const response = await page.goto('https://my.qidian.com/bookcase', { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response || response.status() === 202 || response.status() >= 400) throw new Error('书架页面未通过验证');
      await page.waitForSelector('a[href*="/book/"],a[href*="/info/"]', { timeout: 15000 });
      this.savedCookies = qidianCookies(await this.context.cookies());
      return this.savedCookies;
    } catch (error) {
      throw new Error(`无法确认登录成功：${error.message}`);
    } finally { await page.close().catch(() => undefined); }
  }
  async getHtml(value, selector) {
    await this.ensure();
    const url = safeUrl(value);
    const page = await this.context.newPage();
    try {
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response) throw new Error('起点没有返回页面');
      if (response.status() === 202) throw new Error('起点返回网站验证页，无法继续读取');
      if (response.status() >= 400) throw new Error(`起点返回 HTTP ${response.status()}`);
      if (selector) {
        try { await page.waitForSelector(selector, { timeout: 20000 }); }
        catch { throw new Error('起点未正常渲染所需内容；请在 Edge 窗口检查页面状态'); }
      }
      safeUrl(page.url());
      return { html: await page.content(), url: page.url() };
    } finally {
      await page.close().catch(() => undefined);
    }
  }
  async dispose() {
    const browser = this.browser;
    this.browser = null; this.context = null; this.loginPage = null;
    if (browser?.connected) await browser.close().catch(() => undefined);
  }
  async clear() { this.savedCookies = []; await this.dispose(); }
}

module.exports = { BrowserSession, qidianCookies, edgePath };
