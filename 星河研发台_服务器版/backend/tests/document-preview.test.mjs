import test from 'node:test';
import assert from 'node:assert/strict';
import {renderDocumentPreview} from '../../frontend/document-preview.js';

test('文档预览显示标题目录、唯一锚点、段落、列表及代码而不触发片段路由',()=>{
  const html=renderDocumentPreview('# 第一章\n\n说明包含 **重点** 和 `code <tag>`。\n\n## 重复标题\n\n- 一级\n  - 二级\n    - 三级\n- 下一项\n\n3. 第三项\n4. 第四项\n\n## 重复标题\n\n```js\nconst raw = "<script>";\n```');
  assert.match(html,/<nav[^>]*aria-label="文档目录"/);assert.doesNotMatch(html,/href="#/);
  const targets=[...html.matchAll(/data-document-anchor="([^"]+)"/g)].map(x=>x[1]);
  const ids=[...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map(x=>x[1]);assert.deepEqual(targets,ids);assert.equal(new Set(ids).size,3);
  assert.match(html,/<strong>重点<\/strong>/);assert.match(html,/<code>code &lt;tag&gt;<\/code>/);assert.match(html,/<ol start="3">/);assert.equal((html.match(/<ul>/g)||[]).length,3);
  assert.match(html,/<pre><code>const raw = &quot;&lt;script&gt;&quot;;<\/code><\/pre>/);assert.doesNotMatch(html,/<script>/);
});

test('表格保持转义管道与代码管道，引用可包含段落和列表',()=>{
  const html=renderDocumentPreview('| 字段 | 含义 |\n| :--- | ---: |\n| a\\|b | `x|y` |\n| **重点** | 值 |\n\n> 引用说明\n>\n> - 引用列表\n> - 第二项');
  assert.match(html,/<table>/);assert.match(html,/<th scope="col" class="document-align-left">字段/);assert.match(html,/<td class="document-align-left">a\|b<\/td>/);assert.match(html,/<code>x\|y<\/code>/);
  assert.match(html,/<blockquote><p>引用说明<\/p>/);assert.match(html,/<li><p>引用列表<\/p><\/li>/);
});

test('原始网页、脚本、危险协议和图片均不会形成可执行内容或外部图片请求',()=>{
  const input=['# <img src=x onerror=alert(1)>','<script>alert(1)</script>','<iframe src="https://evil.invalid"></iframe>','[脚本](javascript:alert(1)) [数据](data:text/html;base64,PHNjcmlwdD4=)','[混合](JaVaScRiPt:evil) [实体](javascript&#58;evil) [相对](//evil.invalid) [内链](#section)','![远程图片](https://evil.invalid/image.png) ![脚本图片](data:image/svg+xml,evil)','[正常](https://example.invalid/path?q=1&v=2) [普通](http://example.invalid/)','[带账号](https://user:password@example.invalid/)','[属性](https://example.invalid/\"onmouseover=\"evil)'].join('\n\n');
  const html=renderDocumentPreview(input);
  assert.doesNotMatch(html,/<(?:script|iframe|img|svg|object|style)\b/i);assert.doesNotMatch(html,/\s(?:onerror|onload|onmouseover|src|srcdoc)="/i);
  const hrefs=[...html.matchAll(/href="([^"]+)"/g)].map(x=>x[1]);assert(hrefs.length>=2);assert(hrefs.every(href=>/^https?:\/\//.test(href)));assert(hrefs.every(href=>!href.includes('user:password')));
  assert.match(html,/rel="noopener noreferrer"/);assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);assert.match(html,/预览不加载图片/);assert.match(html,/链接未启用/);
  assert.doesNotMatch(html,/href="(?:javascript|data|#|\/\/)/i);
});

test('标题中的链接不会在目录形成嵌套链接，代码区中的标题不进入目录',()=>{
  const html=renderDocumentPreview('# [说明](https://example.invalid/)\n\n~~~text\n# 这不是标题\n[不是链接](javascript:evil)\n~~~\n\n# [说明](https://example.invalid/)');
  const nav=html.match(/<nav[\s\S]*?<\/nav>/)?.[0];assert(nav);assert.doesNotMatch(nav,/<a /);assert.equal((nav.match(/data-document-anchor=/g)||[]).length,2);assert.match(nav,/>说明<\/button>/);assert.doesNotMatch(nav,/这不是标题/);
});

test('长文截断保留完整结构及有效导航，明确说明阅读限制',()=>{
  const html=renderDocumentPreview('# 长文\n'+Array.from({length:4500},(_,i)=>`第 ${i+1} 行`).join('\n'));
  assert.match(html,/当前仅展示部分内容/);assert.match(html,/4000 行/);assert.match(html,/请下载原文件查看全文/);assert.doesNotMatch(html,/第 4500 行/);assert(html.length<=1000000);assert(html.endsWith('</div></div>'));
  const expanded=renderDocumentPreview('# 扩展转义\n'+ '"'.repeat(200000));assert(expanded.length<=1000000);assert.match(expanded,/预览最多处理/);assert(expanded.endsWith('</div></div>'));
  const many=renderDocumentPreview(Array.from({length:220},(_,i)=>`# 标题 ${i}`).join('\n'));assert.equal((many.match(/data-document-anchor=/g)||[]).length,200);assert.equal((many.match(/<h1 id=/g)||[]).length,220);assert.match(many,/目录仅列出前 200 个标题/);
});

test('畸形标记、未闭合围栏、深层缩进及非文本输入不会崩溃',()=>{
  const examples=[null,undefined,42,{text:'不是字符串'},'', '\uFEFF# 标题\r\n\r\n正文\u0000末尾', '`没有闭合', '文字 '+ '`'.repeat(100000), '```unknown<bad>\n<script>未闭合', '['.repeat(12000),'> '.repeat(15)+'深层引用', '**未闭合 [链接](javascript:evil', '| 表格 |\n| :---: |\n| <img> |'];
  for(const input of examples){const html=renderDocumentPreview(input);assert.equal(typeof html,'string');assert(html.startsWith('<div class="document-preview">'));assert.doesNotMatch(html,/<script|<img>/);}
  assert.match(renderDocumentPreview(null),/文档为空/);assert.match(renderDocumentPreview({}),/内容不是文本/);
});
