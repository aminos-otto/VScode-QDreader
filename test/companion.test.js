'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');
const { CompanionBridge, validatePayload, chapterFromPayload } = require('../src/companionBridge');

test('ordinary Edge metadata is limited to official Qidian book links', () => {
  const page = validatePayload({ kind: 'list', url: 'https://www.qidian.com/', books: [
    { title: '作品 A', url: 'https://book.qidian.com/info/123/' },
    { title: '恶意链接', url: 'https://example.com/info/456/' }
  ] });
  assert.deepEqual(page.books.map(book => book.id), ['123']);
});

test('chapter transfer keeps incomplete VIP content locked', () => {
  const base = { kind: 'chapter', url: 'https://www.qidian.com/chapter/123/456/', title: '已购章节', vip: true,
    wordCount: 1000, paragraphs: Array.from({ length: 7 }, (_, i) => ({ text: '用于测试的正文。'.repeat(16), index: i, count: i })) };
  const valid = validatePayload(base);
  assert.equal(chapterFromPayload(valid).access, 'readable');
  assert.equal(chapterFromPayload(validatePayload({ ...base, wordCount: 9000 })).access, 'locked');
  assert.equal(chapterFromPayload(validatePayload({ ...base, locked: true })).access, 'locked');
  assert.throws(() => validatePayload({ ...base, url: 'https://evil.test/chapter/123/456/' }));
});

test('paragraph comments require a chapter URL and an explicit paragraph anchor', () => {
  const data = validatePayload({ kind: 'comments', url: 'https://www.qidian.com/chapter/123/456/', sourceIndex: 7,
    comments: [{ author: '读者', text: '评论正文与回复' }] });
  assert.equal(data.sourceIndex, 7);
  assert.equal(data.comments[0].text, '评论正文与回复');
  assert.throws(() => validatePayload({ ...data, sourceIndex: -1 }));
  const filtered = validatePayload({ ...data, comments: [
    { author: '打赏', text: '克拉缇亚斯\n打赏了\n869587起点币' },
    { author: '读者', text: '真正的评论' }
  ] });
  assert.deepEqual(filtered.comments, [{ author: '读者', text: '真正的评论' }]);
});

test('local companion bridge accepts only the paired sender', async () => {
  const received = [];
  const bridge = new CompanionBridge(data => received.push(data), 0);
  await bridge.start('a'.repeat(64));
  const send = token => new Promise((resolve, reject) => {
    const body = JSON.stringify({ kind: 'list', url: 'https://www.qidian.com/', books: [{ title: '作品 A', url: 'https://book.qidian.com/info/123/' }] });
    const req = http.request(`http://127.0.0.1:${bridge.port}/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject); req.end(body);
  });
  try {
    assert.equal(await send('wrong'), 403);
    assert.equal(received.length, 0);
    assert.equal(await send('a'.repeat(64)), 200);
    assert.equal(received[0].books[0].id, '123');
    assert.equal(await bridge.openInBackground('https://book.qidian.com/info/123/'), false);
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/control?token=${'a'.repeat(64)}`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.on('message', raw => {
      const request = JSON.parse(raw.toString());
      if (request.type === 'open') ws.send(JSON.stringify({ id: request.id, ok: true }));
    });
    assert.equal(await bridge.openInBackground('https://book.qidian.com/info/123/'), true);
    ws.close();
  } finally { await bridge.stop(); }
});
