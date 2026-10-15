'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { safeUrl, extractBooks, extractChapters, extractChapter } = require('../src/qidian');
const { readerHtml } = require('../src/reader');

test('only approved HTTPS Qidian hosts are accepted', () => {
  assert.equal(safeUrl('//book.qidian.com/info/123').hostname, 'book.qidian.com');
  assert.throws(() => safeUrl('http://book.qidian.com/info/123'));
  assert.throws(() => safeUrl('https://qidian.com.evil.test/info/123'));
});

test('books and chapters are deduplicated and kept on Qidian', () => {
  const books = extractBooks('<a href="https://book.qidian.com/info/123/">作品 A</a><a href="/book/123">作品 A</a><a href="https://evil.test/book/444">恶意</a>', 'https://www.qidian.com/');
  assert.deepEqual(books.map(book => book.id), ['123']);
  const chapters = extractChapters('<a href="https://read.qidian.com/chapter/a/b/">第一章</a><a href="https://vipreader.qidian.com/chapter/a/c/">第二章</a>', 'https://book.qidian.com/info/123/');
  assert.equal(chapters.length, 2);
  assert.equal(chapters[1].vip, true);
});

test('paid chapter without full text stays locked; readable body is escaped', () => {
  const locked = extractChapter('<h1>VIP 第二章</h1><div class="read-content">订阅本章</div>', 'https://vipreader.qidian.com/chapter/a/b', '123');
  assert.equal(locked.access, 'locked');
  const vipWithPreview = extractChapter('<h1>VIP 第三章</h1><div class="read-content"><p>这是一个较长的试读片段，不能仅凭它判断当前账号已购买该章节。这里继续添加足够多的文字用于覆盖长度阈值，避免把付费预览误判为完整已购正文。</p><p>第二段试读仍然不是购买权益证明，插件必须把这种情况保持锁定状态，直到取得可靠的权益信息。</p></div>', 'https://vipreader.qidian.com/chapter/a/c', '123');
  assert.equal(vipWithPreview.access, 'locked');
  const readable = extractChapter('<h1>第一章</h1><div class="read-content"><p>这是一个足够长的段落，用来检查在正常页面上获得的正文是否完整。这里继续加入一些文字，使它达到阅读内容的最小长度，并且再写一小段叙述以模拟小说正文。</p><p>&lt;script&gt;alert(1)&lt;/script&gt; 第二段也有足够的文本供测试，后面继续延伸一些内容，让两个段落合计超过基本的完整性门槛。</p></div>', 'https://read.qidian.com/chapter/a/b', '123');
  assert.equal(readable.access, 'readable');
  const html = readerHtml(readable);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.equal(readable.paragraphs[1].index, 1);
});

test('current Qidian reader markup retains paragraph anchors and comment counts', () => {
  const html = '<div id="app"><div class="print"><h1 class="title">章节标题</h1><main id="c-891035561" data-type="cjk"><p><span class="content-text" data-count="0" data-index="2">第一段测试正文，包含一部分文字作为页面结构样本。这里加入额外句子确保解析器能确认内容足够长，并保留原始段落顺序。</span></p><p><span class="content-text" data-count="3" data-index="3">第二段测试正文继续展开，包含另一部分文字。该段有三条段评，但测试不请求评论详情或任何登录凭证。</span></p></main></div></div>';
  const chapter = extractChapter(html, 'https://www.qidian.com/chapter/1032768092/891035561/', '1032768092');
  assert.equal(chapter.access, 'readable');
  assert.equal(chapter.title, '章节标题');
  assert.equal(chapter.paragraphs[0].sourceIndex, 2);
  assert.equal(chapter.paragraphs[1].commentCount, 3);
  assert.match(readerHtml(chapter), /💬 3/);
  const script = readerHtml(chapter).match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
});

test('VIP reader content requires an authenticated browser and full chapter coverage', () => {
  const paragraphs = Array.from({ length: 7 }, (_, i) => `<p><span class="content-text" data-index="${i}" data-count="0">${'这是一段用于验证完整章节的数据。'.repeat(6)}</span></p>`).join('');
  const html = `<div id="app" data-p="vipread"><div class="print"><h1 class="title">已购章节</h1><div class="metadata">630字</div><main id="c-1">${paragraphs}</main></div></div>`;
  const url = 'https://www.qidian.com/chapter/123/456/';
  assert.equal(extractChapter(html, url, '123').access, 'locked');
  assert.equal(extractChapter(html, url, '123', { authenticated: true }).access, 'readable');
  assert.equal(extractChapter(html.replace('630字', '9000字'), url, '123', { authenticated: true }).access, 'locked');
});
