'use strict';

const crypto = require('node:crypto');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function catalogHtml(catalog) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const book = catalog.currentBook;
  const history = !book && catalog.mode === 'history';
  const title = book ? book.title : history ? '阅读历史' : catalog.mode === 'shelf' ? '书架' : '发现';
  const entries = book ? book.chapters.map(c => ({ title: c.title, vip: !!c.vip })) : history ? catalog.history.map(h => ({ title: `${h.bookTitle} · ${h.title}` })) : catalog.books.map(b => ({ title: b.title }));
  const data = JSON.stringify(entries).replace(/</g, '\\u003c');
  const back = book ? '<button data-action="back" title="返回作品列表" aria-label="返回作品列表">←</button>' : '';
  const status = catalog.loading ? '<p class="status">正在加载…</p>' : catalog.error ? `<p class="status">${escapeHtml(catalog.error)}</p>` : history && !entries.length ? '<p class="status">还没有阅读记录。打开章节后会自动加入。</p>' : !catalog.loaded ? '<p class="status">先连接普通 Edge，再发送起点页面</p>' : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
  body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}*{box-sizing:border-box}.bar{position:sticky;top:0;z-index:2;background:inherit;border-bottom:1px solid var(--vscode-panel-border);padding:7px;display:flex;align-items:center;gap:5px}.bar strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-size:13px}button{font:inherit;color:inherit;background:transparent;border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer;padding:4px 7px;min-width:27px}button:hover,.entry:hover{background:var(--vscode-list-hoverBackground)}.items{padding:6px}.entry{display:block;width:100%;text-align:left;border:0;padding:7px 9px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry span{opacity:.65;font-size:11px}.group{width:100%;text-align:left;margin:4px 0}.status{padding:12px;line-height:1.6;color:var(--vscode-descriptionForeground)}</style></head><body><header class="bar">${back}<strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong><button data-action="discover" title="发现" aria-label="发现">⌂</button><button data-action="shelf" title="书架" aria-label="书架">▤</button><button data-action="history" title="阅读历史" aria-label="阅读历史">◷</button><button data-action="search" title="搜索作品" aria-label="搜索作品">⌕</button><button data-action="login" title="登录 / 查看账号" aria-label="登录 / 查看账号">♙</button><button data-action="refresh" title="刷新" aria-label="刷新">↻</button></header>${status}<div id="items" class="items"></div><script nonce="${nonce}">
  const api=acquireVsCodeApi(),entries=${data},book=${!!book},history=${history};const root=document.getElementById('items');
  function item(i){const b=document.createElement('button');b.className='entry';b.textContent=entries[i].title;if(entries[i].vip){const mark=document.createElement('span');mark.textContent=' VIP';b.append(mark)}b.title=entries[i].title;b.onclick=()=>api.postMessage({command:book?'openChapter':history?'openHistory':'openBook',index:i});return b}
  if(book){for(let start=0;start<entries.length;start+=200){const end=Math.min(start+200,entries.length);const group=document.createElement('button');group.className='group';group.textContent='第 '+(start+1)+'–'+end+' 章';group.setAttribute('aria-expanded','false');const holder=document.createElement('div');holder.hidden=true;group.onclick=()=>{holder.hidden=!holder.hidden;group.setAttribute('aria-expanded',String(!holder.hidden));if(!holder.hidden&&!holder.childElementCount){const fragment=document.createDocumentFragment();for(let i=start;i<end;i++)fragment.append(item(i));holder.append(fragment)}};root.append(group,holder)}}else{for(let i=0;i<entries.length;i++)root.append(item(i))}
  document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>api.postMessage({command:b.dataset.action}));
  </script></body></html>`;
}

function readerHtml(chapter, { fontSize = 16, theme = 'auto', position = 0 } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const size = Math.max(12, Math.min(28, Number(fontSize) || 16));
  const mode = ['auto', 'light', 'dark'].includes(theme) ? theme : 'auto';
  const paragraphs = chapter.paragraphs.map(p => `<div class="paragraph" id="p-${p.index}" data-index="${p.index}"><p>${escapeHtml(p.text)}</p><button class="comment" type="button" data-index="${p.index}" title="查看段评" aria-label="查看第 ${p.index + 1} 段的评论">💬${p.commentCount > 0 ? ` ${p.commentCount}` : ''}</button></div>`).join('');
  const content = chapter.access === 'readable'
    ? paragraphs
    : `<div class="state"><h2>${chapter.access === 'locked' ? '本章尚未确认阅读权限' : '暂时无法读取本章'}</h2><p>${chapter.access === 'locked' ? '请在起点官方页面确认订阅状态。插件不会尝试绕过订阅。' : '起点网页没有返回可确认的完整正文。请稍后重试。'}</p><button id="official" type="button">在起点打开</button></div>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
  :root{color-scheme:light dark}body{margin:0;color:var(--vscode-editor-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}body[data-theme=light]{color:#25231f;background:#faf7ef}body[data-theme=dark]{color:#e8e3d8;background:#202124}*{box-sizing:border-box}.toolbar{position:sticky;top:0;z-index:2;display:flex;gap:4px;padding:7px;border-bottom:1px solid var(--vscode-panel-border);background:inherit}button{font:inherit;padding:4px 6px;color:inherit;background:transparent;border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer;min-width:27px}button:hover{background:var(--vscode-list-hoverBackground)}.body{max-width:760px;margin:auto;padding:12px 18px 30px}.body h1{font-size:1.15rem;line-height:1.5;margin:10px 0 24px}.paragraph{position:relative;display:flex;align-items:flex-start;gap:7px;border-radius:5px}.paragraph:target,.paragraph.active{background:var(--vscode-list-hoverBackground)}.paragraph p{flex:1;margin:0 0 1.1em;font-size:${size}px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere;text-indent:2em}.comment{font-size:10px;opacity:.48;border:0;padding:3px;margin-top:7px}.comment:hover{opacity:1}.state{padding:30px 5px;line-height:1.7}</style></head><body data-theme="${mode}"><div class="toolbar"><button id="prev" title="上一章" aria-label="上一章">←</button><button id="next" title="下一章" aria-label="下一章">→</button><button id="directory" title="目录" aria-label="目录">☷</button><button id="history" title="阅读历史" aria-label="阅读历史">◷</button><button id="editor" title="在编辑区阅读" aria-label="在编辑区阅读">▣</button><button id="minus" title="缩小字号" aria-label="缩小字号">A−</button><button id="plus" title="放大字号" aria-label="放大字号">A+</button><button id="theme" title="切换主题" aria-label="切换主题">◐</button></div><main id="scroll" class="body"><h1>${escapeHtml(chapter.title)}</h1>${content}</main><script nonce="${nonce}">
  const api=acquireVsCodeApi();const key=${JSON.stringify(chapter.id)};const main=document.scrollingElement||document.documentElement;let timer,commentIndex=-1;
  const post=(command,extra={})=>api.postMessage({command,chapter:key,...extra});
  document.getElementById('prev').onclick=()=>post('prev');document.getElementById('next').onclick=()=>post('next');document.getElementById('directory').onclick=()=>post('directory');document.getElementById('history').onclick=()=>post('history');document.getElementById('editor').onclick=()=>post('editor');document.getElementById('minus').onclick=()=>post('font',{delta:-1});document.getElementById('plus').onclick=()=>post('font',{delta:1});document.getElementById('theme').onclick=()=>post('theme');document.getElementById('official')?.addEventListener('click',()=>post('official'));
  document.querySelectorAll('.comment').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('.paragraph.active').forEach(e=>e.classList.remove('active'));button.parentElement.classList.add('active');commentIndex=Number(button.dataset.index);button.parentElement.scrollIntoView({block:'center'});post('comments',{index:commentIndex});}));
  window.addEventListener('message',event=>{const d=event.data||{};if(d.command==='focusParagraph'&&d.chapter===key){const paragraph=document.getElementById('p-'+d.index);paragraph?.scrollIntoView({block:'center'});}});
  window.addEventListener('scroll',()=>{clearTimeout(timer);timer=setTimeout(()=>post('position',{position:Math.max(0,Math.floor(window.scrollY))}),350)},{passive:true});window.addEventListener('beforeunload',()=>post('position',{position:Math.max(0,Math.floor(window.scrollY))}));requestAnimationFrame(()=>window.scrollTo(0,${Math.max(0, Math.floor(Number(position) || 0))}));
  </script></body></html>`;
}

function commentsHtml(state = {}) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const title = Number.isInteger(state.index) ? `第 ${state.index + 1} 段段评` : '段评';
  const body = state.status === 'loading' ? '<p class="status">正在加载段评…</p>'
    : state.status === 'unavailable' ? '<p class="status">当前无法获取该段段评。</p>'
      : state.status === 'available' ? (state.comments || []).map(c => `<article><strong>${escapeHtml(c.author || '读者')}</strong><p>${escapeHtml(c.text)}</p></article>`).join('') || '<p class="status">暂无段评</p>'
        : '<p class="status">点击正文中的段评标记，即可在这里查看。</p>';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{margin:0;padding:10px 14px;color:var(--vscode-editor-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:13px}h2{font-size:13px;margin:0 0 10px}article{border-bottom:1px solid var(--vscode-panel-border);padding:8px 0}article p{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin:5px 0}.status{color:var(--vscode-descriptionForeground);line-height:1.6}</style></head><body><h2>${title}</h2>${body}</body></html>`;
}

function placeholderHtml() {
  return '<!doctype html><html><body style="font:13px sans-serif;padding:16px;color:#888">在“发现”或“书架”中选择一本书。</body></html>';
}

module.exports = { escapeHtml, catalogHtml, commentsHtml, readerHtml, placeholderHtml };
