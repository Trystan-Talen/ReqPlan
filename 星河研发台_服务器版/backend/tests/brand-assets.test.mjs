import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { workbenchWelcome } from '../../frontend/ui-kit.js';

test('品牌图片按显示尺寸选择轻量透明资源，内容变化会改变长期缓存地址', () => {
  const html = workbenchWelcome({ title: '团队工作台' });
  const src = html.match(/<img[^>]*\ssrc="([^"]+)"/)?.[1];
  const srcset = html.match(/\ssrcset="([^"]+)"/)?.[1];
  assert.ok(srcset, '工作台需要响应式图片，不能在手机继续下载原始大图');
  const candidates = srcset.split(',').map(value => {
    const [url, descriptor] = value.trim().split(/\s+/);
    assert.match(descriptor, /^\d+w$/);
    return { url, width: Number(descriptor.slice(0, -1)) };
  });
  assert.ok(candidates.some(item => item.url === src), '默认图片也必须使用受预算约束的资源');
  assert.ok(candidates.some(item => item.width <= 256), '手机需有独立的小图');
  assert.ok(candidates.some(item => item.width >= 420), '桌面需覆盖两倍像素密度');
  assert.match(html, /sizes="\(max-width: 560px\) 88px, \(max-width: 1240px\) 180px, 210px"/);
  assert.doesNotMatch(html, /src(?:set)?="[^"<>]*\.png/);
  for (const { url, width } of candidates) {
    const hash = url.match(/^\/assets\/[\w-]+\.([0-9a-f]{12})\.webp$/)?.[1];
    assert.ok(hash, '长期缓存资源需有内容摘要，不覆盖旧图片地址');
    const bytes = fs.readFileSync(new URL(`../../frontend${url}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex').slice(0, 12), hash);
    assert.ok(bytes.length <= (width <= 256 ? 16_000 : 40_000), '图片超出加载预算');
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.toString('ascii', 8, 16), 'WEBPVP8X');
    assert.ok(bytes[20] & 0x10, '品牌图片必须保留透明背景');
    assert.equal(bytes.readUIntLE(24, 3) + 1, width);
    assert.equal(bytes.readUIntLE(27, 3) + 1, width);
  }
});
