// 设计系统守卫测试：保证后续迭代（包括其他 agent 新增的页面和模块）遵守 DESIGN.md。
// 失败信息会指出具体文件和违规内容；修复方式见 DESIGN.md「自动检查」一节。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kit from '../../frontend/ui-kit.js';
import { REQUIREMENT_STATUSES, TASK_STATUSES } from '../../frontend/workflow.js';

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const read = file => fs.readFileSync(path.join(frontend, file), 'utf8');
const walk = dir => fs.readdirSync(path.join(frontend, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
const cssFiles = walk('design').filter(file => file.endsWith('.css')).map(file => file.split(path.sep).join('/'));
const jsFiles = fs.readdirSync(frontend).filter(file => file.endsWith('.js'));
const htmlFiles = fs.readdirSync(frontend).filter(file => file.endsWith('.html'));
const stripComments = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const linkedStyles = html => [...html.matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map(match => match[1]);

// Classes that exist only as structural / JS hooks and intentionally carry no styles.
// Adding to this list requires a reason; prefer styling through an existing component.
const HOOK_CLASSES = new Set([
  'server-error',              // presentError() container marker
  'project-progress',          // wrapper grouping label + progress bar on project cards
  'project-directory-heading', // section-heading variant marker
  'task-requirement-summary',  // item-meta marker in the task list
  'document-code',             // wrapper around a code block in document previews
  'schedule-panel',            // panel marker for the schedule page
  'icon-moon', 'icon-sun',     // theme toggle glyph markers (styled via .theme-toggle)
  'is-read',                   // state marker shared by work items and dots
]);

test('样式按层级引入：令牌 → 基础 → 组件 → 布局 → 页面，且每个样式文件都被主页面与样式指南引入', () => {
  const expectedHead = ['design/tokens.css', 'design/base.css', 'design/components.css', 'design/layout.css'];
  for (const page of ['index.html', 'design-system.html']) {
    const links = linkedStyles(read(page));
    assert.deepEqual(links.slice(0, 4), expectedHead, `${page} 必须按 tokens/base/components/layout 顺序引入基础层`);
    assert.ok(links.slice(4).every(link => link.startsWith('design/pages/')), `${page} 第 5 个之后只能是 design/pages/*.css`);
    for (const file of cssFiles) assert.ok(links.includes(file), `${page} 没有引入 ${file}`);
    for (const link of links) assert.ok(cssFiles.includes(link), `${page} 引入了不存在的样式 ${link}`);
  }
  assert.ok(!fs.existsSync(path.join(frontend, 'ui.css')) && !fs.existsSync(path.join(frontend, 'styles.css')), '不要在 design/ 之外新增全局样式文件');
});

test('颜色只能来自设计令牌：tokens.css 之外的样式和脚本不得出现颜色字面量', () => {
  const colorLiteral = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\((?!\s*var\()/;
  for (const file of cssFiles.filter(file => file !== 'design/tokens.css')) {
    const css = stripComments(read(file)).replace(/url\("data:[^"]*"\)/g, 'url()');
    css.split('\n').forEach((line, index) => assert.doesNotMatch(line, colorLiteral, `${file}:${index + 1} 出现颜色字面量，请改用 var(--令牌)：${line.trim()}`));
  }
  for (const file of jsFiles) {
    const source = read(file);
    assert.doesNotMatch(source, /['"`]#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?['"`]/, `${file} 出现颜色字符串，请改用 var(--令牌) 或 CSS 类`);
    assert.doesNotMatch(source, /(?:fill|stroke|stop-color)="#[0-9a-fA-F]{3,6}"/, `${file} 的 SVG 使用了颜色字面量，请用 currentColor 或 CSS 类`);
    assert.doesNotMatch(source, /style="[^"]*(?:#[0-9a-fA-F]{3,6}|rgba?\()/, `${file} 的内联样式包含颜色`);
  }
});

test('深色主题令牌在两处定义完全一致，且都有浅色默认值', () => {
  const tokens = stripComments(read('design/tokens.css'));
  const blockNames = source => [...source.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]);
  const bodies = selector => { const out = []; let index = 0; while ((index = tokens.indexOf(selector, index)) >= 0) { const open = tokens.indexOf('{', index), close = tokens.indexOf('}', open); out.push(tokens.slice(open + 1, close)); index = close; } return out.join('\n'); };
  const explicitDark = new Set(blockNames(bodies(':root[data-theme="dark"] {')));
  const systemDark = new Set(blockNames(bodies(':root:not([data-theme="light"]) {')));
  assert.deepEqual([...explicitDark].sort(), [...systemDark].sort(), '手动深色与系统深色两处令牌必须同步修改');
  const light = new Set(blockNames(bodies(':root {')));
  for (const name of explicitDark) assert.ok(light.has(name), `深色令牌 ${name} 缺少浅色默认值`);
});

test('模板里使用的类名都有样式定义（结构钩子类需登记在 HOOK_CLASSES）', () => {
  const css = cssFiles.map(file => stripComments(read(file))).join('\n');
  const defined = new Set([...css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1]));
  const missing = new Map();
  for (const file of [...jsFiles, ...htmlFiles]) {
    for (const match of read(file).matchAll(/class="([^"]*)"/g)) {
      const staticPart = match[1].replace(/\$\{[^}]*\}/g, ' ');
      for (const token of staticPart.split(/\s+/)) {
        if (!/^[a-z][\w-]*[a-z0-9]$/i.test(token) || defined.has(token) || HOOK_CLASSES.has(token)) continue;
        if (match[1].includes(token + '${')) continue; // dynamic prefix such as status-${tone}
        missing.set(token, [...(missing.get(token) || []), file]);
      }
    }
  }
  assert.deepEqual([...missing.keys()], [], `以下类名没有样式：${[...missing].map(([name, files]) => `${name}（${[...new Set(files)].join('、')}）`).join('；')}`);
});

test('内联样式只允许写几何量与 CSS 自定义属性，视觉属性必须写进样式文件', () => {
  const allowed = /^(?:--[\w-]+|left|right|top|width|height|flex)$/;
  for (const file of [...jsFiles, ...htmlFiles]) {
    for (const match of read(file).matchAll(/style="([^"]*)"/g)) {
      const declarations = match[1].replace(/\$\{[^}]*\}/g, 'X').split(';').map(item => item.trim()).filter(Boolean);
      for (const declaration of declarations) {
        const property = declaration.split(':')[0].trim();
        assert.match(property, allowed, `${file} 的内联样式 "${match[1]}" 包含 ${property}，请改用 CSS 类`);
      }
    }
  }
});

test('区块间距由容器决定：#view 是纵向栈，不用相邻选择器给区块加外边距', () => {
  const layout = stripComments(read('design/layout.css'));
  assert.match(layout, /#view\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*var\(--gap-block\)/, 'layout.css 中 #view 必须是 gap 为 --gap-block 的纵向栈');
  const blocks = /\.(?:panel|section-block|section-heading|page-heading|metrics-grid|hero|split|stack)\b|\bsection\b|-grid\b|-layout\b|-columns\b/;
  for (const file of cssFiles) {
    for (const [, selector, body] of stripComments(read(file)).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const part of selector.split(',')) {
        if (!part.includes('+') || !/\bmargin/.test(body)) continue;
        const [left, right] = part.split('+');
        assert.ok(!blocks.test(left) && !blocks.test(right), `${file} 的「${part.trim()}」用相邻选择器给区块加外边距；请改用 #view / .stack / .split / 网格 gap`);
      }
      // 页面区块本身不带外边距（页头只允许一个很小的下边距，用来和内容拉开层次）。
      for (const part of selector.split(',').map(item => item.trim())) {
        if (!/^\.(?:panel|metrics-grid|hero|section-heading|section-block|split|stack|project-readonly)$/.test(part)) continue;
        assert.doesNotMatch(body, /(?:^|;)\s*margin(?:-top|-bottom)?\s*:/, `${file} 的 ${part} 声明了外边距；区块间距由容器的 gap 决定`);
      }
    }
  }
});

test('工作流里的每个状态都在 ui-kit 的 STATUS_TONES 中登记了色调', () => {
  for (const status of [...REQUIREMENT_STATUSES, ...TASK_STATUSES]) {
    assert.ok(Object.hasOwn(kit.STATUS_TONES, status), `状态「${status}」未在 ui-kit.js STATUS_TONES 登记色调`);
    assert.ok(kit.TONES.includes(kit.STATUS_TONES[status]), `状态「${status}」的色调不在 TONES 中`);
  }
  const css = read('design/components.css');
  for (const tone of kit.TONES) assert.ok(css.includes(`.status-${tone}`), `components.css 缺少 .status-${tone}`);
});

test('ui-kit 组件转义用户内容并输出约定结构', () => {
  const attack = '"><img src=x onerror=alert(1)>';
  const outputs = [kit.badge('develop', attack), kit.heading(attack, attack, '', attack), kit.empty(attack, attack), kit.metric(attack, attack, attack, 'check'), kit.personChip('u1', attack), kit.panel({ title: attack, bodyHtml: '' }), kit.notice(attack, 'danger'), kit.button({ label: attack, data: { taskId: attack } }), kit.detailList([[attack, attack]]), kit.countLabel(attack)];
  for (const html of outputs) assert.doesNotMatch(html, /<img/);
  assert.match(kit.badge('develop'), /class="badge status-progress">开发中</);
  assert.match(kit.badge('已完成'), /status-done/);
  assert.match(kit.priority('P0', true), /priority-p0[\s\S]*最高/);
  assert.equal(kit.hue('u-manager'), kit.hue('u-manager'));
  assert.match(kit.button({ label: '新建', variant: 'primary', iconName: 'plus', action: 'new-task' }), /^<button type="button" class="btn btn-primary" data-action="new-task"><svg/);
  assert.match(kit.button({ label: '详情', variant: 'text', data: { taskId: 't-1' } }), /class="text-button" data-task-id="t-1"/);
  assert.match(kit.heading('需求池', '说明', '', '项目'), /^<section class="page-heading"><div><span class="scope-pill">项目<\/span><h1>需求池<\/h1>/);
});
