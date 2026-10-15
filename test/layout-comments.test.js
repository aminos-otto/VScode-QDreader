'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { catalogHtml, commentsHtml, readerHtml } = require('../src/reader');
const { parseComments } = require('../edge-companion/comments');
const { normalizeHistory, recordHistory } = require('../src/history');

test('catalog and reader share one view while paragraph comments use a separate view', () => {
  const catalog = catalogHtml({ currentBook: { title: '作品', chapters: [{ title: '第一章', vip: false }] }, books: [], mode: 'discover', loaded: true });
  assert.match(catalog, /openChapter/);
  new vm.Script(catalog.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  const history = catalogHtml({ currentBook: null, mode: 'history', history: [{ bookTitle: '作品', title: '第一章' }], books: [], loaded: true });
  assert.match(history, /作品 · 第一章/);
  assert.match(history, /openHistory/);
  new vm.Script(history.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  const reader = readerHtml({ id: 'chapter', title: '第一章', access: 'readable', paragraphs: [{ index: 0, text: '正文', commentCount: 1 }] });
  assert.doesNotMatch(reader, /id="comments"/);
  assert.match(reader, /focusParagraph/);
  assert.match(reader, /title="上一章"/);
  new vm.Script(reader.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1]);
  const comments = commentsHtml({ index: 2, status: 'available', comments: [{ author: '读者', text: '评论内容' }] });
  assert.match(comments, /第 3 段段评/);
  assert.match(comments, /评论内容/);
  assert.doesNotMatch(comments, /回复|点赞/);
});

test('paragraph comments exclude rewards, dates, reply actions and likes', () => {
  const raw = '评论 2 条\n某人打赏了 869587 起点币\n甲读者\n第一条段评\n3楼·03-03 10:14:13 江苏\n回复\n14\n乙读者\n第二条段评\n1楼·03-03 08:30:31 陕西\n回复\n33';
  assert.deepEqual(parseComments(raw), [
    { author: '甲读者', text: '第一条段评' },
    { author: '乙读者', text: '第二条段评' }
  ]);
  assert.deepEqual(parseComments('评论 1 条\n打赏了 500 起点币'), []);
  const rewardPanel = '评论 7 条\n打赏\n克拉缇亚斯\n打赏了\n869587起点币\n玄天小仙\n打赏了\n100000起点币\n甲读者\n这是实际段评\n3楼·03-03 10:14:13 江苏\n回复\n14';
  assert.deepEqual(parseComments(rewardPanel), [{ author: '甲读者', text: '这是实际段评' }]);
  assert.deepEqual(parseComments('评论 7 条\n打赏\n克拉缇亚斯\n打赏了\n869587起点币\n3楼·03-03 10:14:13 江苏'), []);
});

test('reading history stores chapter metadata only and keeps recent unique entries', () => {
  const url = 'https://www.qidian.com/chapter/123/456/';
  const first = recordHistory([], { url, title: '第一章', bookTitle: '作品' });
  assert.equal(first.length, 1);
  assert.deepEqual(Object.keys(first[0]).sort(), ['bookTitle', 'openedAt', 'title', 'url']);
  assert.equal(recordHistory(first, { url, title: '第一章', bookTitle: '作品' }).length, 1);
  assert.deepEqual(normalizeHistory([{ url: 'https://example.com/chapter/123/456/', title: '无效' }]), []);
});
