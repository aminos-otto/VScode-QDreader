'use strict';

let control = null;
let reconnectTimer = null;
let pingTimer = null;

async function connectControl() {
  if (control && (control.readyState === WebSocket.OPEN || control.readyState === WebSocket.CONNECTING)) return;
  const { pairingCode } = await chrome.storage.local.get('pairingCode');
  const match = /^(17843):([0-9a-f]{64})$/.exec(pairingCode || '');
  if (!match) return;
  const ws = new WebSocket(`ws://127.0.0.1:17843/control?token=${match[2]}`);
  control = ws;
  ws.onopen = () => {
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' })); }, 20000);
  };
  ws.onmessage = async event => {
    let request;
    try { request = JSON.parse(event.data); } catch { return; }
    if (!['open', 'comments'].includes(request.type) || !request.id) return;
    try {
      const target = new URL(request.url);
      if (target.protocol !== 'https:' || !target.hostname.endsWith('.qidian.com')) throw new Error('地址无效');
      if (request.type === 'open') {
        const { readerTabId } = await chrome.storage.session.get('readerTabId');
        let reused = false;
        if (readerTabId) {
          try {
            const existing = await chrome.tabs.get(readerTabId);
            if (!existing.active) { await chrome.tabs.update(readerTabId, { url: target.href, active: false }); reused = true; }
          } catch { /* 后台标签页已被关闭。 */ }
        }
        if (!reused) {
          const window = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
          const tab = await chrome.tabs.create({ windowId: window.id, url: target.href, active: false });
          await chrome.storage.session.set({ readerTabId: tab.id });
        }
      } else {
        const tabs = await chrome.tabs.query({ url: 'https://*.qidian.com/chapter/*' });
        const tab = tabs.find(item => item.url?.split('#')[0] === target.href.split('#')[0]);
        if (!tab?.id) throw new Error('章节标签页未找到');
        const reply = await chrome.tabs.sendMessage(tab.id, { type: 'openComments', sourceIndex: request.sourceIndex });
        if (!reply?.ok) throw new Error('段评标记未找到');
      }
      ws.send(JSON.stringify({ id: request.id, ok: true }));
    } catch { ws.send(JSON.stringify({ id: request.id, ok: false })); }
  };
  ws.onclose = () => {
    if (control !== ws) return;
    control = null;
    clearInterval(pingTimer); pingTimer = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectControl, 3000);
  };
  ws.onerror = () => ws.close();
}

chrome.storage.onChanged.addListener(changes => {
  if (changes.pairingCode) { control?.close(); connectControl(); }
});
void connectControl();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'qidianPage') return false;
  (async () => {
    try {
      void connectControl();
      const source = new URL(sender.tab?.url || '');
      if (source.protocol !== 'https:' || !source.hostname.endsWith('.qidian.com')) throw new Error('页面来源无效');
      if (message.page?.url !== source.href) throw new Error('页面地址不符');
      const { pairingCode, autoEnabled } = await chrome.storage.local.get(['pairingCode', 'autoEnabled']);
      if (autoEnabled === false) throw new Error('自动同步已关闭');
      const match = /^(17843):([0-9a-f]{64})$/.exec(pairingCode || '');
      if (!match) throw new Error('尚未配对');
      const response = await fetch('http://127.0.0.1:17843/ingest', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${match[2]}` }, body: JSON.stringify(message.page)
      });
      sendResponse({ ok: response.ok });
    } catch { sendResponse({ ok: false }); }
  })();
  return true;
});
