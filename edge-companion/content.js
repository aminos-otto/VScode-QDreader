'use strict';

let lastSent = '';
let timer;
let autoEnabled = false;
let paired = false;

function scheduleTransfer() {
  if (!paired || !autoEnabled) return;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    try {
      const page = extractQidianPage();
      if (!page) return;
      const snapshot = JSON.stringify(page);
      if (snapshot === lastSent || snapshot.length > 2 * 1024 * 1024) return;
      chrome.runtime.sendMessage({ type: 'qidianPage', page }).then(reply => {
        if (reply?.ok) lastSent = snapshot;
      }).catch(() => undefined);
    } catch { /* 页面未就绪时等待下一次 DOM 更新。 */ }
  }, 350);
}

chrome.storage.local.get(['pairingCode', 'autoEnabled']).then(state => {
  paired = !!state.pairingCode;
  autoEnabled = state.autoEnabled !== false;
  scheduleTransfer();
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.pairingCode) paired = !!changes.pairingCode.newValue;
  if (changes.autoEnabled) autoEnabled = changes.autoEnabled.newValue !== false;
  scheduleTransfer();
});
new MutationObserver(scheduleTransfer).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
window.addEventListener('popstate', scheduleTransfer);
window.addEventListener('hashchange', scheduleTransfer);

function visibleCommentPanel() {
  const candidates = [];
  for (const node of document.querySelectorAll('aside,section,div')) {
    const rect = node.getBoundingClientRect();
    if (rect.left < innerWidth * 0.45 || rect.width < 230 || rect.height < 250 || rect.right > innerWidth + 10) continue;
    if (!/^评论\s*\d+\s*条/.test((node.textContent || '').trim().slice(0, 40))) continue;
    const content = (node.innerText || '').trim();
    if (!/^评论\s*\d+\s*条/.test(content.slice(0, 40)) || content.length > 20000) continue;
    candidates.push({ node, rect, content });
  }
  candidates.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height);
  return candidates[0] || null;
}

function sendComments(sourceIndex, expectedCount, attempts = 0) {
  const panel = visibleCommentPanel();
  const count = Number(panel?.content.match(/^评论\s*(\d+)\s*条/)?.[1]);
  if (!panel || (expectedCount > 0 && count !== expectedCount)) {
    if (attempts < 12) setTimeout(() => sendComments(sourceIndex, expectedCount, attempts + 1), 500);
    return;
  }
  const body = panel.content.split(/请先登录|登录后发表评论|发表评论/)[0];
  const comments = parseComments(body);
  if (count > 0 && !comments.length) return;
  const page = { kind: 'comments', url: location.href, sourceIndex,
    comments };
  chrome.runtime.sendMessage({ type: 'qidianPage', page }).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'openComments') return false;
  const index = Number(message.sourceIndex);
  const spans = document.querySelectorAll('main[id^="c-"] span.content-text[data-index]');
  const span = [...spans].find(node => Number(node.dataset.index) === index);
  if (!span) { sendResponse({ ok: false }); return false; }
  const expectedCount = Number(span.dataset.count || 0);
  span.click();
  setTimeout(() => sendComments(index, expectedCount), 400);
  sendResponse({ ok: true });
  return false;
});
