'use strict';

const vscode = require('vscode');
const { spawn } = require('node:child_process');
const { QidianClient, safeUrl, extractBooks } = require('./qidian');
const { BrowserSession, edgePath } = require('./browserSession');
const { CompanionBridge, chapterFromPayload } = require('./companionBridge');
const { readerHtml, catalogHtml, commentsHtml } = require('./reader');
const { normalizeHistory, recordHistory } = require('./history');

const SECRET_KEY = 'qidian.sessionCookie';
const BROWSER_SECRET_KEY = 'qidian.browserCookies';
const LAST_KEY = 'qidian.lastChapter';
const POSITION_KEY = 'qidian.positions';
const HISTORY_KEY = 'qidian.history';
let activeBrowserSession = null;
let activeCompanionBridge = null;

function openNormalEdge(value) {
  const url = safeUrl(value).href;
  const executable = edgePath();
  if (!executable) throw new Error('本机未找到 Microsoft Edge');
  const child = spawn(executable, ['--new-tab', url], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}

class CatalogProvider {
  constructor(client) { this.client = client; this.mode = 'discover'; this.query = ''; this.books = []; this.history = []; this.currentBook = null; this.loading = false; this.loaded = false; this.error = ''; this.generation = 0; this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event; }
  refresh() { this.emitter.fire(); this.onRefresh?.(); }
  importBooks(books, mode = 'discover') {
    this.generation++;
    this.mode = mode; this.query = ''; this.books = books; this.currentBook = null;
    this.loading = false; this.loaded = true; this.error = '';
    this.refresh();
  }
  importBook(book) {
    this.generation++; this.currentBook = book; this.loading = false; this.loaded = true; this.error = '';
    this.refresh();
  }
  async load() {
    const generation = ++this.generation;
    this.loaded = true;
    this.loading = true; this.error = ''; this.currentBook = null; this.refresh();
    try {
      const books = this.mode === 'shelf' ? await this.client.shelf() : this.query ? await this.client.search(this.query) : await this.client.discover();
      if (generation !== this.generation) return;
      this.books = books;
    } catch (error) { if (generation === this.generation) { this.books = []; this.error = error.message || '加载失败'; } }
    finally { if (generation === this.generation) { this.loading = false; this.refresh(); } }
  }
  async openBook(book) {
    const generation = ++this.generation;
    this.loading = true; this.error = ''; this.refresh();
    try { const detail = await this.client.book(book.id); if (generation === this.generation) this.currentBook = detail; }
    catch (error) { if (generation === this.generation) this.error = error.message || '加载作品失败'; }
    finally { if (generation === this.generation) { this.loading = false; this.refresh(); } }
  }
  getTreeItem(element) { return element; }
  getChildren(element) {
    if (element?.chapterGroup) return element.children;
    if (this.loading) return [new vscode.TreeItem('正在加载…')];
    if (this.error) {
      const item = new vscode.TreeItem(this.error); item.iconPath = new vscode.ThemeIcon('warning');
      const importItem = new vscode.TreeItem('从正常 Edge 页面源码导入发现');
      importItem.command = { command: 'qidian.importDiscover', title: '从剪贴板导入发现' };
      return [item, importItem];
    }
    if (this.currentBook) {
      const back = new vscode.TreeItem(`← ${this.mode === 'shelf' ? '书架' : '发现'}`);
      back.command = { command: 'qidian.back', title: '返回列表' };
      const intro = new vscode.TreeItem(this.currentBook.title, vscode.TreeItemCollapsibleState.None);
      intro.description = this.currentBook.author;
      intro.tooltip = this.currentBook.intro || this.currentBook.title;
      const chapters = this.currentBook.chapters.map((chapter, index) => {
        const item = new vscode.TreeItem(chapter.title);
        item.description = chapter.vip ? 'VIP' : '';
        item.iconPath = new vscode.ThemeIcon(chapter.vip ? 'lock' : 'book');
        item.command = { command: 'qidian.openChapter', title: '阅读章节', arguments: [this.currentBook, chapter, index] };
        return item;
      });
      const groups = [];
      for (let start = 0; start < chapters.length; start += 200) {
        const end = Math.min(start + 200, chapters.length);
        const group = new vscode.TreeItem(`第 ${start + 1}–${end} 章`, vscode.TreeItemCollapsibleState.Collapsed);
        group.chapterGroup = true;
        group.children = chapters.slice(start, end);
        group.iconPath = new vscode.ThemeIcon('library');
        groups.push(group);
      }
      return [back, intro, ...groups];
    }
    if (!this.loaded) return [new vscode.TreeItem('先连接普通 Edge，再发送起点页面')];
    const search = new vscode.TreeItem('搜索作品…');
    search.iconPath = new vscode.ThemeIcon('search');
    search.command = { command: 'qidian.search', title: '搜索作品' };
    const account = new vscode.TreeItem('登录 / 查看账号（普通 Edge）');
    account.iconPath = new vscode.ThemeIcon('account');
    account.command = { command: 'qidian.login', title: '登录 / 查看账号' };
    if (!this.books.length) return [search, account, new vscode.TreeItem(this.mode === 'shelf' ? '书架为空或页面尚未返回书籍' : '没有找到作品')];
    return [search, account, ...this.books.map(book => { const item = new vscode.TreeItem(book.title); item.iconPath = new vscode.ThemeIcon('book'); item.command = { command: 'qidian.openBook', title: '打开作品', arguments: [book] }; return item; })];
  }
}

class ReaderProvider {
  constructor(context, catalog, onMessage) { this.context = context; this.catalog = catalog; this.onMessage = onMessage; this.current = null; this.screen = 'catalog'; this.view = null; this.panel = null; }
  resolveWebviewView(view) { this.view = view; view.webview.options = { enableScripts: true }; view.webview.onDidReceiveMessage(msg => this.onMessage(msg)); this.render(); }
  set(chapter) { this.current = chapter; this.screen = 'reader'; void vscode.commands.executeCommand('setContext', 'qidian.reading', true); this.render(); this.view?.show(true); }
  showCatalog() { this.screen = 'catalog'; void vscode.commands.executeCommand('setContext', 'qidian.reading', false); this.render(); this.view?.show(true); }
  render() {
    const chapter = this.current;
    const positions = this.context.globalState.get(POSITION_KEY, {});
    const config = vscode.workspace.getConfiguration('qidian');
    const reader = chapter ? readerHtml(chapter, { fontSize: config.get('fontSize', 16), theme: config.get('theme', 'auto'), position: positions[chapter.id] || 0 }) : '';
    if (this.view) { this.view.webview.html = this.screen === 'reader' && reader ? reader : catalogHtml(this.catalog); this.view.title = this.screen === 'reader' && chapter ? chapter.title : '发现 / 书架'; }
    if (this.panel && reader) { this.panel.webview.html = reader; this.panel.title = chapter.title; }
  }
  openEditor() {
    if (!this.current) return;
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Active); return; }
    this.panel = vscode.window.createWebviewPanel('qidian.chapter', this.current.title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.panel.onDidDispose(() => { this.panel = null; });
    this.render();
  }
  postMessage(message) { void this.view?.webview.postMessage(message); void this.panel?.webview.postMessage(message); }
  clear() { this.current = null; this.screen = 'catalog'; void vscode.commands.executeCommand('setContext', 'qidian.reading', false); if (this.panel) this.panel.dispose(); this.render(); }
}

class CommentsProvider {
  constructor() { this.view = null; this.state = {}; this.chapter = null; }
  resolveWebviewView(view) { this.view = view; this.render(); if (this.state.status === 'loading') view.show(true); }
  reset(chapter) { this.chapter = chapter?.id || null; this.state = {}; this.render(); }
  begin(chapter, index) { this.chapter = chapter; this.state = { index, status: 'loading' }; this.render(); this.view?.show(true); }
  finish(chapter, index, status, comments = []) { if (this.chapter !== chapter || this.state.index !== index) return; this.state = { index, status, comments }; this.render(); }
  render() { if (this.view) this.view.webview.html = commentsHtml(this.state); }
}

async function activate(context) {
  const browserSession = new BrowserSession();
  activeBrowserSession = browserSession;
  try { browserSession.setSavedCookies(JSON.parse(await context.secrets.get(BROWSER_SECRET_KEY) || '[]')); }
  catch { browserSession.setSavedCookies([]); }
  const client = new QidianClient(browserSession);
  client.setCookie(await context.secrets.get(SECRET_KEY) || '');
  const catalog = new CatalogProvider(client);
  catalog.history = normalizeHistory(context.globalState.get(HISTORY_KEY, []));
  const companion = new CompanionBridge(async data => {
    if (data.kind === 'list') {
      catalog.importBooks(data.books, data.url.includes('/bookcase') ? 'shelf' : 'discover');
      reader.showCatalog();
      void vscode.window.showInformationMessage(`普通 Edge 已发送 ${data.books.length} 本作品`);
    } else if (data.kind === 'book') {
      catalog.importBook(data);
      reader.showCatalog();
      void vscode.window.showInformationMessage(`普通 Edge 已发送《${data.title}》目录（${data.chapters.length} 章）`);
    } else if (data.kind === 'comments') {
      if (pendingComment && active?.chapter.id === data.url && pendingComment.sourceIndex === data.sourceIndex) {
        clearTimeout(pendingComment.timer);
        comments.finish(data.url, pendingComment.index, 'available', data.comments);
        pendingComment = null;
      }
    } else if (data.kind === 'chapter') {
      const matched = catalog.currentBook?.id === data.bookId ? catalog.currentBook : null;
      const book = matched || { id: data.bookId, title: '当前作品', chapters: [] };
      let index = book.chapters.findIndex(c => c.url === data.url);
      if (index < 0) { book.chapters.push({ id: data.url, url: data.url, title: data.title, vip: data.vip }); index = book.chapters.length - 1; }
      data.vip ||= !!book.chapters[index].vip;
      const chapter = chapterFromPayload(data);
      if (active?.chapter.id === chapter.id && active.chapter.access === chapter.access &&
          active.chapter.paragraphs.length === chapter.paragraphs.length &&
          active.chapter.paragraphs.every((p, i) => p.text === chapter.paragraphs[i].text && p.commentCount === chapter.paragraphs[i].commentCount)) {
        if (reader.screen !== 'reader') reader.set(active.chapter);
        return;
      }
      chapterGeneration++; commentsGeneration++;
      if (pendingComment) { clearTimeout(pendingComment.timer); pendingComment = null; }
      active = { book, chapter, index };
      catalog.loading = false;
      reader.set(chapter);
      comments.reset(chapter);
      if (chapter.access === 'readable') {
        const knownBook = catalog.history.find(item => item.url === chapter.id)?.bookTitle;
        catalog.history = recordHistory(catalog.history, { url: chapter.id, title: chapter.title, bookTitle: matched?.title || knownBook || book.title });
        await context.globalState.update(HISTORY_KEY, catalog.history);
      }
      await context.globalState.update(LAST_KEY, { bookId: data.bookId, chapterUrl: data.url });
      if (chapter.access !== 'readable') void vscode.window.showWarningMessage('当前页面未提供可确认的完整章节正文，已保持锁定');
    }
  });
  activeCompanionBridge = companion;
  async function navigateInBackground(url) {
    const opened = await companion.openInBackground(url);
    if (!opened) void vscode.window.showWarningMessage('普通 Edge 后台连接尚未就绪；请确认辅助扩展已加载并完成配对');
    return opened;
  }
  let active = null;
  let chapterGeneration = 0;
  let commentsGeneration = 0;
  let pendingComment = null;
  const comments = new CommentsProvider();
  const positions = () => context.globalState.get(POSITION_KEY, {});
  const reader = new ReaderProvider(context, catalog, async message => {
    if (!message || typeof message !== 'object') return;
    if (reader.screen === 'catalog' && !message.chapter) {
      if (message.command === 'openBook' && Number.isInteger(message.index) && message.index >= 0 && message.index < catalog.books.length && !catalog.currentBook) return vscode.commands.executeCommand('qidian.openBook', catalog.books[message.index]);
      if (message.command === 'openChapter' && Number.isInteger(message.index) && message.index >= 0 && message.index < (catalog.currentBook?.chapters.length || 0)) return openChapter(catalog.currentBook, catalog.currentBook.chapters[message.index], message.index);
      if (message.command === 'openHistory' && catalog.mode === 'history' && Number.isInteger(message.index) && message.index >= 0 && message.index < catalog.history.length) {
        const url = catalog.history[message.index].url;
        if (active?.chapter.id === url) { reader.set(active.chapter); return; }
        return navigateInBackground(url);
      }
      if (['discover', 'shelf', 'history', 'search', 'login', 'refresh', 'back'].includes(message.command)) return vscode.commands.executeCommand(`qidian.${message.command}`);
      return;
    }
    if (!active || message.chapter !== active.chapter.id) return;
    switch (message.command) {
      case 'prev': case 'next': {
        const next = active.index + (message.command === 'next' ? 1 : -1);
        if (next >= 0 && next < active.book.chapters.length) await openChapter(active.book, active.book.chapters[next], next);
        return;
      }
      case 'directory': catalog.currentBook = active.book; reader.showCatalog(); return;
      case 'history': await vscode.commands.executeCommand('qidian.history'); return;
      case 'editor': reader.openEditor(); return;
      case 'official': await vscode.env.openExternal(vscode.Uri.parse(safeUrl(active.chapter.url).href)); return;
      case 'position': {
        if (!Number.isFinite(message.position) || message.position < 0) return;
        const value = { ...positions(), [active.chapter.id]: Math.floor(message.position) };
        await context.globalState.update(POSITION_KEY, value);
        return;
      }
      case 'font': {
        const config = vscode.workspace.getConfiguration('qidian');
        const current = config.get('fontSize', 16);
        await config.update('fontSize', Math.max(12, Math.min(28, current + (message.delta > 0 ? 1 : -1))), vscode.ConfigurationTarget.Global);
        reader.render(); return;
      }
      case 'theme': {
        const config = vscode.workspace.getConfiguration('qidian');
        const modes = ['auto', 'light', 'dark'];
        await config.update('theme', modes[(modes.indexOf(config.get('theme', 'auto')) + 1) % modes.length], vscode.ConfigurationTarget.Global);
        reader.render(); return;
      }
      case 'comments': {
        if (!Number.isInteger(message.index) || message.index < 0 || message.index >= active.chapter.paragraphs.length) return;
        const generation = ++commentsGeneration;
        const chapterId = active.chapter.id;
        if (pendingComment) clearTimeout(pendingComment.timer);
        const unavailable = () => {
          if (generation === commentsGeneration && active?.chapter.id === chapterId) comments.finish(chapterId, message.index, 'unavailable');
          pendingComment = null;
        };
        const sourceIndex = active.chapter.paragraphs[message.index].sourceIndex;
        comments.begin(chapterId, message.index);
        setTimeout(() => reader.postMessage({ command: 'focusParagraph', chapter: chapterId, index: message.index }), 80);
        pendingComment = { index: message.index, sourceIndex, timer: setTimeout(unavailable, 10000) };
        const opened = companion.active && await companion.requestComments(chapterId, sourceIndex);
        if (generation !== commentsGeneration || !pendingComment) return;
        if (!opened) {
          clearTimeout(pendingComment.timer);
          unavailable();
        }
        return;
      }
    }
  });
  catalog.onRefresh = () => { if (reader.screen === 'catalog') reader.render(); };
  async function openChapter(book, chapter, index) {
    if (companion.active) {
      catalog.currentBook = book;
      catalog.loading = true; catalog.refresh();
      await navigateInBackground(chapter.url);
      return;
    }
    void vscode.window.showInformationMessage('先运行“起点阅读: 连接普通 Edge”，再打开章节');
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('qidian.catalog', reader));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('qidian.comments', comments));
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  register('qidian.connectEdge', async () => {
    try {
      const token = await context.secrets.get('qidian.companionToken');
      await companion.start(token);
      if (!token) await context.secrets.store('qidian.companionToken', companion.token);
      await vscode.env.clipboard.writeText(companion.pairingCode());
      void vscode.window.showInformationMessage('普通 Edge 配对码已复制。请在 Edge 加载本项目 edge-companion 文件夹，打开插件粘贴配对码并发送起点页面。');
    } catch (error) { void vscode.window.showErrorMessage(`连接普通 Edge 失败：${error.message}`); }
  });
  register('qidian.discover', async () => {
    reader.showCatalog(); catalog.loading = true; catalog.currentBook = null; catalog.refresh();
    if (companion.active) { await navigateInBackground('https://www.qidian.com/'); return; }
    void vscode.window.showInformationMessage('先连接普通 Edge，再从起点首页发送发现列表');
  });
  register('qidian.importDiscover', async () => {
    try {
      const html = await vscode.env.clipboard.readText();
      if (!html || html.length > 4 * 1024 * 1024) throw new Error('剪贴板为空或网页源码超过 4 MB');
      const books = extractBooks(html, 'https://www.qidian.com/');
      if (!books.length) throw new Error('未找到起点作品链接。请在正常 Edge 的起点首页按 Ctrl+U，再按 Ctrl+A、Ctrl+C 后重试');
      catalog.importBooks(books);
      void vscode.window.showInformationMessage(`已从剪贴板导入 ${books.length} 本作品；未保存网页源码`);
    } catch (error) { void vscode.window.showErrorMessage(`导入发现失败：${error.message}`); }
  });
  register('qidian.shelf', async () => {
    reader.showCatalog(); catalog.loading = true; catalog.currentBook = null; catalog.refresh();
    if (companion.active) { await navigateInBackground('https://my.qidian.com/bookcase'); return; }
    void vscode.window.showInformationMessage('先连接普通 Edge，再从起点书架发送列表');
  });
  register('qidian.history', () => {
    catalog.mode = 'history'; catalog.currentBook = null; catalog.loading = false; catalog.loaded = true; catalog.error = '';
    reader.showCatalog();
  });
  register('qidian.search', async () => {
    const query = await vscode.window.showInputBox({ prompt: '搜索起点作品' }); if (query === undefined) return;
    reader.showCatalog(); catalog.loading = true; catalog.currentBook = null; catalog.refresh();
    if (companion.active) { await navigateInBackground(`https://www.qidian.com/soushu/${encodeURIComponent(query.trim())}.html`); return; }
    void vscode.window.showInformationMessage('先连接普通 Edge，再从起点搜索页发送列表');
  });
  register('qidian.refresh', async () => {
    reader.showCatalog(); catalog.loading = true; catalog.refresh();
    if (companion.active) { await navigateInBackground(companion.lastPageUrl || 'https://www.qidian.com/'); return; }
    void vscode.window.showInformationMessage('先连接普通 Edge，再发送起点页面');
  });
  register('qidian.back', () => { catalog.currentBook = null; catalog.error = ''; catalog.refresh(); reader.showCatalog(); });
  register('qidian.openBook', async book => {
    if (companion.active) {
      reader.showCatalog(); catalog.loading = true; catalog.refresh();
      await navigateInBackground(book.url);
      return;
    }
    void vscode.window.showInformationMessage('先连接普通 Edge，再打开作品');
  });
  register('qidian.openChapter', openChapter);
  register('qidian.openUrl', async () => {
    const raw = await vscode.window.showInputBox({ prompt: '粘贴起点章节 URL', placeHolder: 'https://www.qidian.com/chapter/作品ID/章节ID/' });
    if (!raw) return;
    try {
      const url = safeUrl(raw).href;
      const match = /\/chapter\/(\d+)\/(\d+)\/?/.exec(url);
      if (!match) throw new Error('暂仅支持包含作品 ID 与章节 ID 的起点章节链接');
      const book = { id: match[1], title: '当前作品', chapters: [{ id: url, title: '当前章节', url, vip: true }] };
      await openChapter(book, book.chapters[0], 0);
    } catch (error) { void vscode.window.showErrorMessage(error.message); }
  });
  register('qidian.openEditor', () => reader.openEditor());
  register('qidian.continue', async () => {
    const last = context.globalState.get(LAST_KEY); if (!last) return void vscode.window.showInformationMessage('暂无阅读记录');
    if (companion.active) { await navigateInBackground(last.chapterUrl); return; }
    void vscode.window.showInformationMessage('先连接普通 Edge，再继续阅读');
  });
  register('qidian.login', async () => {
    if (!companion.active) return vscode.commands.executeCommand('qidian.connectEdge');
    openNormalEdge('https://www.qidian.com/');
    void vscode.window.showInformationMessage('请在普通 Edge 的起点官方页面查看账号或登录；登录状态由 Edge 保存');
  });
  register('qidian.logout', async () => {
    chapterGeneration++; commentsGeneration++;
    client.clear(); await browserSession.clear(); await companion.stop(); active = null; reader.clear(); comments.reset(null); catalog.books = []; catalog.history = []; catalog.currentBook = null; catalog.mode = 'discover'; catalog.refresh();
    await context.secrets.delete(SECRET_KEY);
    await context.secrets.delete(BROWSER_SECRET_KEY);
    await context.secrets.delete('qidian.companionToken');
    await context.globalState.update(LAST_KEY, undefined);
    await context.globalState.update(POSITION_KEY, undefined);
    await context.globalState.update(HISTORY_KEY, undefined);
    void vscode.window.showInformationMessage('已断开普通 Edge 并清除本地阅读记录；起点官网登录状态未改变');
  });
}

async function deactivate() {
  await activeCompanionBridge?.stop(); activeCompanionBridge = null;
  await activeBrowserSession?.dispose(); activeBrowserSession = null;
}
module.exports = { activate, deactivate };
