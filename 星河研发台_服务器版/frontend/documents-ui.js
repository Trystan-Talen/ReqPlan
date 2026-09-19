// 项目文档：列表页、文档阅读器（章节 ↔ 需求）、需求详情中的关联文档。只输出 HTML，事件在 app.js 中处理。
import { esc, icon, toneBadge, panel, empty, countLabel } from './ui-kit.js';
import { DOCUMENT_TYPES, referencedSections, sectionCoverage, affectedSections } from './doc-sections.js';

const typeBadge = type => toneBadge('', type, { plain: true });
const primaryBadge = () => toneBadge('review', '主文档');
const shortDate = value => value ? String(value).slice(0, 10) : '—';

function coverageSummary(document, requirements) {
  const coverage = sectionCoverage(document, requirements);
  if (!coverage.size) return { linked: 0, covered: 0, total: 0 };
  const linked = requirements.filter(item => referencedSections(item, document).length).length;
  const covered = [...coverage.values()].filter(list => list.length).length;
  return { linked, covered, total: coverage.size };
}

/** 项目主文档卡片：项目文档页与项目概览共用。linkHtml 为标题栏右侧的链接（可选）。 */
export function primaryDocumentPanel(primary, linkHtml = '') {
  return panel({ title: '项目主文档', actionsHtml: linkHtml, padded: true,
    bodyHtml: `<div class="doc-primary"><div><button class="item-title" data-open-document="${esc(primary.id)}">${esc(primary.title)}</button><p class="item-meta">${esc(primary.name)} · v${primary.version} · ${esc(shortDate(primary.versionCreatedAt))} 更新 · ${primary.sections.length} 个章节</p></div><div class="doc-actions"><button class="btn btn-secondary btn-small" data-download-document="${esc(primary.id)}">下载</button><button class="btn btn-secondary btn-small" data-open-document="${esc(primary.id)}">${icon('document')} 阅读</button></div></div>` });
}

export function renderDocumentsPage({ documents, requirements, canUpload, nameOf }) {
  if (!documents.length) return `<section class="panel">${empty('还没有项目文档', canUpload ? '上传 PRD、技术方案或验收用例后，需求可以按章节关联到文档。' : '产品经理上传文档后会显示在这里。', canUpload ? 'upload-document' : '', '上传文档')}</section>`;
  const primary = documents.find(item => item.primary);
  const row = document => {
    const summary = coverageSummary(document, requirements);
    const coverage = summary.total ? `<span class="doc-coverage${summary.covered < summary.total ? ' has-gap' : ''}">${summary.covered} / ${summary.total}</span>` : '<span class="muted">—</span>';
    return `<tr><td><span class="doc-name">${icon('document')}<span><button class="item-title" data-open-document="${esc(document.id)}">${esc(document.title)}</button>${document.primary ? ' ' + primaryBadge() : ''}<span class="item-meta">${esc(document.name)}</span></span></span></td><td>${typeBadge(document.type)}</td><td class="num-cell">v${document.version}</td><td class="num-cell">${summary.linked || '<span class="muted">—</span>'}</td><td class="num-cell">${coverage}</td><td><span class="item-meta">${esc(shortDate(document.versionCreatedAt))} · ${esc(nameOf(document.versionCreatedBy))}</span></td><td class="doc-row-actions"><button class="text-button" data-open-document="${esc(document.id)}">阅读</button><button class="text-button" data-download-document="${esc(document.id)}">下载</button></td></tr>`;
  };
  const ordered = DOCUMENT_TYPES.flatMap(type => documents.filter(item => item.type === type));
  const primaryPanel = primary ? primaryDocumentPanel(primary) : '';
  const table = `<div class="table-wrap"><table class="data-table"><thead><tr><th>文档</th><th>类型</th><th class="num-cell">版本</th><th class="num-cell">关联需求</th><th class="num-cell">章节覆盖</th><th>最近更新</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${ordered.map(row).join('')}</tbody></table></div>`;
  return primaryPanel + panel({ title: '全部文档', count: documents.length, bodyHtml: table, noteHtml: `${icon('link')}章节覆盖 = 被需求引用的章节 ÷ 文档章节数（引用子章节或父章节都算）。没有被任何需求引用的文档不统计覆盖。` });
}

export function renderDocumentReader({ document, version, contentHtml, requirements, nameOf, canUpload, versionCount, fromRequirement = null }) {
  const coverage = sectionCoverage(document, requirements);
  const covered = [...coverage.values()].filter(list => list.length).length;
  const sections = version.sections || [];
  const changed = new Set(version.changedSections || []);
  const outline = sections.length ? `<aside class="doc-outline" aria-label="章节"><h3>章节${coverage.size ? ` <span class="muted small">已关联 ${covered} / ${coverage.size}</span>` : ''}</h3><ol>${sections.map(section => {
    const linked = coverage.get(section.code) || [];
    const uncovered = coverage.size && !linked.length;
    return `<li class="doc-outline-item doc-level-${Math.min(Number(section.level) || 2, 4)}${uncovered ? ' is-uncovered' : ''}"><button type="button" data-doc-section="${esc(section.code)}"><code>${esc(section.code)}</code><span>${esc(section.title)}</span>${changed.has(section.code) ? '<em>本版修改</em>' : ''}</button>${linked.length ? `<p class="doc-outline-links">${linked.slice(0, 3).map(item => `<button class="text-button" data-requirement="${esc(item.id)}">${esc(item.title)}</button>`).join('')}${linked.length > 3 ? `<span class="muted small">等 ${linked.length} 条</span>` : ''}</p>` : uncovered ? '<p class="doc-outline-links"><span class="muted small">未关联需求</span></p>' : ''}</li>`;
  }).join('')}</ol></aside>` : '';
  const meta = `<div class="doc-meta">${typeBadge(document.type)}${document.primary ? primaryBadge() : ''}<span>${esc(document.name)}</span><span>v${version.version}${version.version !== document.version ? `（最新为 v${document.version}）` : ''}</span><span>${esc(shortDate(version.createdAt))} · ${esc(nameOf(version.createdBy))}${version.source === 'import' ? ' · 导入' : ''}</span>${versionCount > 1 ? `<button class="text-button" data-document-history="${esc(document.id)}">${versionCount} 个版本</button>` : ''}</div>${version.note ? `<p class="field-help">版本说明：${esc(version.note)}</p>` : ''}${changed.size ? `<p class="doc-changed">本版修改了 ${changed.size} 个章节：${[...changed].slice(0, 12).map(code => `<button class="doc-chip is-changed" data-doc-section="${esc(code)}">${esc(code)}</button>`).join('')}${changed.size > 12 ? ' …' : ''}</p>` : ''}`;
  return { body: `<div class="dialog-body doc-reader" data-document-id="${esc(document.id)}"${fromRequirement ? ` data-from-requirement="${esc(fromRequirement.id)}"` : ''}>${meta}<div class="doc-viewer${outline ? '' : ' is-single'}">${outline}<div class="doc-content">${contentHtml}</div></div></div>`,
    footer: `${fromRequirement ? `<button class="btn btn-secondary" data-requirement="${esc(fromRequirement.id)}">返回需求</button>` : `<button class="btn btn-secondary" data-action="close-dialog">关闭</button>`}<button class="btn btn-secondary" data-download-document="${esc(document.id)}" data-doc-version="${version.version}">下载</button>${canUpload ? `<button class="btn btn-primary" data-upload-version="${esc(document.id)}">${icon('plus')} 上传新版本</button>` : ''}` };
}

export function renderDocumentVersions(document, versions, nameOf) {
  return `<div class="dialog-body"><p class="form-intro">「${esc(document.title)}」的全部版本。每个版本独立保留，导入命令只在内容变化时生成新版本。</p><div class="history-list">${versions.map(item => `<div class="attachment-version"><div><strong>v${item.version}</strong>${item.version === document.version ? ' ' + toneBadge('done', '当前') : ''}<p>${esc(shortDate(item.createdAt))} · ${esc(nameOf(item.createdBy))}${item.source === 'import' ? ' · 导入' : ' · 上传'}${item.note ? ` · ${esc(item.note)}` : ''}</p>${item.changedSections.length ? `<p>修改章节：${item.changedSections.slice(0, 20).map(esc).join('、')}${item.changedSections.length > 20 ? ' …' : ''}</p>` : item.version > 1 ? '<p>章节结构未变化</p>' : ''}</div><div class="attachment-actions"><button class="text-button" data-open-document="${esc(document.id)}" data-doc-version="${item.version}">查看</button><button class="text-button" data-download-document="${esc(document.id)}" data-doc-version="${item.version}">下载</button></div></div>`).join('')}</div></div>`;
}

export function renderRequirementDocuments(requirement, documents) {
  const refs = requirement.docRefs || [];
  if (!refs.length) return '<p class="muted small">这条需求还没有关联文档章节。</p>';
  const names = [...new Set(refs.map(ref => ref.document))];
  return `<div class="doc-refs">${names.map(name => {
    const document = documents.find(item => item.projectId === requirement.projectId && item.name === name);
    if (!document) return `<div class="doc-ref is-missing">${icon('document')}<span>${esc(name)}</span><span class="muted small">文档尚未上传</span></div>`;
    const codes = referencedSections(requirement, document), changed = new Set(affectedSections(requirement, document));
    const titles = new Map(document.sections.map(item => [item.code, item.title]));
    return `<div class="doc-ref"><div class="doc-ref-head">${icon('document')}<button class="item-title" data-open-document="${esc(document.id)}">${esc(document.title)}</button>${typeBadge(document.type)}<span class="muted small">v${document.version}</span>${countLabel(codes.length, document.type === '验收用例' ? '条用例' : '个章节')}<span class="doc-ref-actions"><button class="text-button" data-open-document="${esc(document.id)}">查看全文</button><button class="text-button" data-download-document="${esc(document.id)}">下载</button></span></div>${changed.size ? `<p class="doc-changed">v${document.version} 修改了本需求关联的 ${changed.size} 个${document.type === '验收用例' ? '用例' : '章节'}</p>` : ''}<div class="doc-chips">${codes.map(code => `<button type="button" class="doc-chip${changed.has(code) ? ' is-changed' : ''}" data-open-document="${esc(document.id)}" data-doc-section="${esc(code)}" title="${esc(titles.get(code) || code)}">${esc(code)}</button>`).join('')}</div></div>`;
  }).join('')}</div>`;
}
