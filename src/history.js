'use strict';

const { safeUrl } = require('./qidian');

function normalizeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    try {
      const url = safeUrl(item?.url).href;
      if (!/^\/chapter\/\d+\/\d+\/?$/.test(new URL(url).pathname) || seen.has(url)) continue;
      seen.add(url);
      result.push({ url, title: String(item.title || '章节').slice(0, 160), bookTitle: String(item.bookTitle || '当前作品').slice(0, 160), openedAt: Number.isSafeInteger(item.openedAt) && item.openedAt > 0 ? item.openedAt : 0 });
      if (result.length >= 50) break;
    } catch { /* 忽略无效的旧记录。 */ }
  }
  return result;
}

function recordHistory(history, entry) {
  return normalizeHistory([{ ...entry, openedAt: Date.now() }, ...history.filter(item => item.url !== entry.url)]);
}

module.exports = { normalizeHistory, recordHistory };
