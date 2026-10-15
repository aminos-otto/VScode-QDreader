'use strict';

function parseComments(content) {
  const lines = content.replace(/^评论\s*\d+\s*条\s*/, '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  const comments = [];
  let start = 0;
  for (let i = 0; i < lines.length && comments.length < 100; i++) {
    if (!/^\d+\s*楼\s*[·•\-]?\s*\d{1,2}-\d{1,2}(?:\s+\d{1,2}:\d{2})?/.test(lines[i])) continue;
    const block = lines.slice(start, i).filter(line => !/^(回复|点赞|举报|展开|收起|查看更多|请先登录|登录后发表评论|发表评论|\d+)$/.test(line));
    start = i + 1;
    if (block.includes('打赏')) {
      const lastReward = block.findLastIndex(line => /打赏了|赠送了|起点币/.test(line));
      if (lastReward < 0) continue;
      block.splice(0, lastReward + 1);
    }
    while (block.length && /\d+\s*起点币|打赏了|赠送了|^月票$|^推荐票$/.test(block[0])) block.shift();
    if (block.length < 2) continue;
    const author = block[0];
    const text = block.slice(1).join('\n').trim();
    if (!author || author.length > 80 || !text || text.length > 12000 || /^(打赏|打赏了|赠送了|月票|推荐票)$/.test(author) || /(^|\n)打赏了(\n|$)/.test(text)) continue;
    comments.push({ author, text });
  }
  return comments;
}

if (typeof module !== 'undefined') module.exports = { parseComments };
