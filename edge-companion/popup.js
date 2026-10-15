'use strict';

const codeInput = document.getElementById('code');
const autoInput = document.getElementById('auto');
const status = document.getElementById('status');
chrome.storage.local.get(['pairingCode', 'autoEnabled']).then(({ pairingCode, autoEnabled }) => {
  if (pairingCode) codeInput.value = pairingCode;
  autoInput.checked = autoEnabled !== false;
});
autoInput.addEventListener('change', () => chrome.storage.local.set({ autoEnabled: autoInput.checked }));

function extractPage() {
  const url = location.href;
  const host = location.hostname;
  if (host !== 'qidian.com' && !host.endsWith('.qidian.com')) throw new Error('请先打开起点官方网站');
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const absolute = href => { try { const u = new URL(href, url); return u.protocol === 'https:' && (u.hostname === 'qidian.com' || u.hostname.endsWith('.qidian.com')) ? u.href : ''; } catch { return ''; } };
  const path = location.pathname;
  if (/^\/chapter\/\d+\/\d+\/?$/.test(path)) {
    const main = document.querySelector('main[id^="c-"]');
    if (!main) throw new Error('章节正文尚未显示，请等页面完全加载后再发送');
    const paragraphs = [...main.querySelectorAll(':scope > p')].map((p, i) => {
      const span = p.querySelector('span.content-text');
      return span ? { text: text(span), index: Number(span.dataset.index ?? i), count: Number(span.dataset.count ?? 0) } : null;
    }).filter(p => p?.text);
    const nearby = [...main.parentElement.children].filter(el => el !== main).map(text).join(' ').slice(0, 3000);
    const wordCount = Number(nearby.match(/(\d{2,6})\s*字/)?.[1] || 0);
    return { kind: 'chapter', url, title: text(document.querySelector('h1.title,h1')) || document.title,
      paragraphs, wordCount, locked: /订阅本章|购买本章|订阅后阅读/.test(nearby),
      vip: document.querySelector('#app[data-p="vipread"]') !== null || /\bVIP\b/i.test(nearby) };
  }
  const bookMatch = /\/(?:book|info)\/(\d+)/.exec(path);
  if (bookMatch) {
    const id = bookMatch[1]; const seen = new Set(); const chapters = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const chapterUrl = absolute(a.getAttribute('href'));
      if (!new RegExp(`/chapter/${id}/\\d+/?$`).test(new URL(chapterUrl || url).pathname) || seen.has(chapterUrl)) continue;
      const title = text(a) || a.title;
      if (!title) continue;
      seen.add(chapterUrl); chapters.push({ title: title.slice(0, 160), url: chapterUrl, vip: /VIP|订阅/.test(text(a.parentElement)) });
      if (chapters.length >= 15000) break;
    }
    return { kind: 'book', url, title: text(document.querySelector('h1')) || document.title,
      author: text(document.querySelector('.writer,[data-author]')), intro: text(document.querySelector('.book-intro,.intro')).slice(0, 1000), chapters };
  }
  const seen = new Set(); const books = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const bookUrl = absolute(a.getAttribute('href'));
    const id = /\/(?:book|info)\/(\d+)/.exec(new URL(bookUrl || url).pathname)?.[1];
    if (!id || seen.has(id)) continue;
    const title = (a.title || text(a) || a.querySelector('img')?.alt || '').trim();
    if (!title || title.length > 160) continue;
    seen.add(id); books.push({ title, url: bookUrl });
    if (books.length >= 100) break;
  }
  return { kind: 'list', url, books };
}

document.getElementById('send').addEventListener('click', async () => {
  status.textContent = '正在读取当前页面…';
  try {
    const code = codeInput.value.trim();
    const match = /^(17843):([0-9a-f]{64})$/.exec(code);
    if (!match) throw new Error('请先从 VS Code 复制有效配对码');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/([^.]+\.)?qidian\.com\//.test(tab.url || '')) throw new Error('当前标签页不是起点官网');
    const result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractPage });
    const payload = result?.[0]?.result;
    if (!payload) throw new Error('未读取到页面数据');
    const response = await fetch('http://127.0.0.1:17843/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${match[2]}` }, body: JSON.stringify(payload)
    });
    const reply = await response.json();
    if (!response.ok) throw new Error(reply.error || 'VS Code 拒绝了页面数据');
    await chrome.storage.local.set({ pairingCode: code, autoEnabled: autoInput.checked });
    status.textContent = payload.kind === 'chapter' ? '章节已发送到 VS Code 阅读区' : payload.kind === 'book' ? `目录已发送（${payload.chapters.length} 章）` : `发现列表已发送（${payload.books.length} 本）`;
    if (autoInput.checked) status.textContent += '；以后打开起点页面会自动同步';
  } catch (error) { status.textContent = `发送失败：${error.message}`; }
});
