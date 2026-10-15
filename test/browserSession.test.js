'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { qidianCookies, edgePath } = require('../src/browserSession');

test('browser session retains only Qidian-domain cookies for SecretStorage', () => {
  const filtered = qidianCookies([
    { name: 'a', value: 'one', domain: '.qidian.com', path: '/', httpOnly: true, secure: true },
    { name: 'b', value: 'two', domain: 'my.qidian.com', path: '/' },
    { name: 'c', value: 'secret', domain: 'qidian.com.evil.test', path: '/' },
  ]);
  assert.deepEqual(filtered.map(cookie => cookie.name), ['a', 'b']);
  assert.equal(filtered[0].httpOnly, true);
});

test('Edge executable is discoverable on this Windows host', { skip: process.platform !== 'win32' }, () => {
  assert.match(edgePath(), /msedge\.exe$/i);
});
