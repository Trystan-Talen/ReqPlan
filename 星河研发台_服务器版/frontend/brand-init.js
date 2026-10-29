import { BRAND_MARK } from './ui-kit.js';

// 独立图标无法继承页面变量：从设计令牌读取固定品牌色，再复用同一图形。
const iconLink = document.querySelector('link[rel~="icon"]');
const styles = getComputedStyle(document.documentElement);
const token = name => styles.getPropertyValue(name).trim();
const colors = {
  background: token('--brand-primary'),
  from: token('--brand-from'),
  to: token('--brand-to'),
  foreground: token('--on-night'),
};

if (iconLink && Object.values(colors).every(Boolean)) {
  const namespace = 'http://www.w3.org/2000/svg';
  const markup = BRAND_MARK.replace('<svg ', `<svg xmlns="${namespace}" `);
  const source = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = source.documentElement;
  svg.removeAttribute('aria-hidden');
  svg.setAttribute('color', colors.foreground);
  svg.querySelector('.brand-stop-from').setAttribute('stop-color', colors.from);
  svg.querySelector('.brand-stop-to').setAttribute('stop-color', colors.to);

  const background = source.createElementNS(namespace, 'rect');
  for (const [name, value] of Object.entries({ width: '32', height: '32', rx: '9', fill: colors.background })) {
    background.setAttribute(name, value);
  }
  svg.insertBefore(background, svg.firstChild);

  // 既有内容安全策略已允许数据图像，无需增加外部资源或修改策略。
  const image = new XMLSerializer().serializeToString(svg);
  iconLink.href = `data:image/svg+xml,${encodeURIComponent(image)}`;
}
