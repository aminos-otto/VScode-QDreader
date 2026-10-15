'use strict';

function extractQidianPage() {
  const url = location.href;
  if (!location.hostname.endsWith('.qidian.com')) throw new Error('请先打开起点官方网站');
  const text = node => (node?.textContent || '').replace(/\s+/g, ' ').trim();
  const absolute = href => { try { const u = new URL(href, url); return u.protocol === 'https:' && u.hostname.endsWith('.qidian.com') ? u.href : ''; } catch { return ''; } };
  const path = location.pathname;
  if (/^\/chapter\/\d+\/\d+\/?$/.test(path)) {
    const main = document.querySelector('main[id^="c-"]');
    if (!main) return null;
    const paragraphs = [...main.querySelectorAll(':scope > p')].map((p, i) => {
      const span = p.querySelector('span.content-text');
      return span ? { text: text(span), index: Number(span.dataset.index ?? i), count: Number(span.dataset.count ?? 0) } : null;
    }).filter(p => p?.text);
    const nearby = [...main.parentElement.children].filter(el => el !== main).map(text).join(' ').slice(0, 3000);
    return { kind: 'chapter', url, title: text(document.querySelector('h1.title,h1')) || document.title,
      paragraphs, wordCount: Number(nearby.match(/(\d{2,6})\s*字/)?.[1] || 0),
      locked: /订阅本章|购买本章|订阅后阅读/.test(nearby),
      vip: document.querySelector('#app[data-p="vipread"]') !== null || /\bVIP\b/i.test(nearby) };
  }
  const bookMatch = /\/(?:book|info)\/(\d+)/.exec(path);
  if (bookMatch) {
    const id = bookMatch[1]; const seen = new Set(); const chapters = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const chapterUrl = absolute(a.getAttribute('href'));
      if (!chapterUrl || !new RegExp(`/chapter/${id}/\\d+/?$`).test(new URL(chapterUrl).pathname) || seen.has(chapterUrl)) continue;
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
    const id = bookUrl ? /\/(?:book|info)\/(\d+)/.exec(new URL(bookUrl).pathname)?.[1] : null;
    if (!id || seen.has(id)) continue;
    const title = (a.title || text(a) || a.querySelector('img')?.alt || '').trim();
    if (!title || title.length > 160) continue;
    seen.add(id); books.push({ title, url: bookUrl });
    if (books.length >= 100) break;
  }
  return { kind: 'list', url, books };
}
