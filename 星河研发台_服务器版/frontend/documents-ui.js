// 项目文档：列表页、文档阅读器（章节 ↔ 需求）、需求详情中的关联文档。只输出 HTML，事件在 app.js 中处理。
import { esc, icon, badge, button, segmented, toneBadge, panel, empty, countLabel } from './ui-kit.js';
import { DOCUMENT_TYPES, referencedSections, affectedSections, documentAssociationSummary } from './doc-sections.js';

const typeBadge = type => toneBadge('', type, { plain: true });
const primaryBadge = () => toneBadge('review', '主文档');
const shortDate = value => value ? String(value).slice(0, 10) : '—';

const CONFIRMATION_FILTERS = [{ value: 'all', label: '全部' }, { value: 'confirmed', label: '已确认需求' }, { value: 'unconfirmed', label: '未确认需求' }, { value: 'unlinked', label: '未关联' }];
const classificationBadges = summary => summary.classification.map(value => value === 'confirmed' ? toneBadge('done', '已确认需求') : value === 'unconfirmed' ? toneBadge('review', '未确认需求') : toneBadge('plan', '未关联')).join('');
const associationLink = item => button({ label: item.entity.title || item.id, variant: 'text', data: { [item.kind]: item.id } });
const contextId = value => typeof value === 'string' ? value : value?.id;

/** 项目主文档卡片：项目文档页与项目概览共用。linkHtml 为标题栏右侧的链接（可选）。 */
export function primaryDocumentPanel(primary, linkHtml = '') {
  return panel({ title: '项目主文档', actionsHtml: linkHtml, padded: true,
    bodyHtml: `<div class="doc-primary"><div>${button({ label: primary.title, variant: 'text', data: { openDocument: primary.id } })}<p class="item-meta">${esc(primary.name)} · v${primary.version} · ${esc(shortDate(primary.versionCreatedAt))} 更新 · ${(primary.sections || []).length} 个章节</p></div><div class="doc-actions">${button({ label: '下载', size: 'small', data: { downloadDocument: primary.id } })}${button({ label: '阅读', size: 'small', iconName: 'document', data: { openDocument: primary.id } })}</div></div>` });
}

export function renderDocumentsPage({ documents = [], requirements = [], proposals = [], confirmation = 'all', canUpload, nameOf = () => '—' }) {
  const visible = documents.filter(item => !item.archived);
  if (!visible.length) return panel({ bodyHtml: empty('还没有项目文档', canUpload ? '上传 PRD（产品需求文档）、技术方案或验收用例后，可以关联全文或具体章节。' : '产品经理上传文档后会显示在这里。', canUpload ? 'upload-document' : '', '上传文档') });
  const summaries = new Map(visible.map(document => [document, documentAssociationSummary(document, requirements, proposals)]));
  const current = CONFIRMATION_FILTERS.some(item => item.value === confirmation) ? confirmation : 'all';
  const filtered = visible.filter(document => current === 'all' || summaries.get(document).classification.includes(current));
  const filters = CONFIRMATION_FILTERS.map(item => ({ ...item, label: `${item.label} ${item.value === 'all' ? visible.length : visible.filter(document => summaries.get(document).classification.includes(item.value)).length}` }));
  const toolbar = `<div class="table-toolbar doc-filters">${segmented(filters, current, 'document-confirmation', '按关联需求的确认状态筛选')}<span class="muted small">分类随关联自动更新，可同时属于两类</span></div>`;
  const row = document => {
    const summary = summaries.get(document);
    const coverage = summary.total ? `<span class="doc-coverage${summary.covered < summary.total ? ' has-gap' : ''}">${summary.covered} / ${summary.total}</span>` : '<span class="muted">—</span>';
    return `<tr><td><span class="doc-name">${icon('document')}<span>${button({ label: document.title, variant: 'text', data: { openDocument: document.id } })}${document.primary ? ' ' + primaryBadge() : ''}<span class="item-meta">${esc(document.name)}</span><span class="doc-classifications">${classificationBadges(summary)}</span></span></span></td><td>${typeBadge(document.type)}</td><td class="num-cell">v${document.version}</td><td class="num-cell">${summary.linked || '<span class="muted">—</span>'}</td><td class="num-cell">${coverage}</td><td><span class="item-meta">${esc(shortDate(document.versionCreatedAt))} · ${esc(nameOf(document.versionCreatedBy))}</span></td><td class="doc-row-actions">${button({ label: '阅读', variant: 'text', data: { openDocument: document.id } })}${button({ label: '下载', variant: 'text', data: { downloadDocument: document.id } })}</td></tr>`;
  };
  const ordered = [...filtered].sort((a, b) => DOCUMENT_TYPES.indexOf(a.type) - DOCUMENT_TYPES.indexOf(b.type));
  const primary = filtered.find(item => item.primary);
  const table = ordered.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>文档与关联分类</th><th>类型</th><th class="num-cell">版本</th><th class="num-cell">关联需求 / 提议</th><th class="num-cell">章节覆盖</th><th>最近更新</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${ordered.map(row).join('')}</tbody></table></div>` : empty('此分类下没有文档', '切换分类可查看其他文档；分类由未归档的需求与提议关联自动生成。');
  return (primary ? primaryDocumentPanel(primary) : '') + panel({ title: '项目文档', count: filtered.length, bodyHtml: toolbar + table, noteHtml: `${icon('link')}全文参考计入关联数量，不计为逐章覆盖。章节覆盖只统计明确引用的章节（普通文档包含父子章节，验收用例按编号精确匹配）。已转入需求池的提议不重复计算。` });
}

export function renderDocumentReader({ document, version, contentHtml, requirements = [], proposals = [], nameOf = () => '—', canUpload, versionCount, fromRequirement = null, fromProposal = null }) {
  const sections = version.sections || [];
  const summary = documentAssociationSummary({ ...document, sections }, requirements, proposals);
  const { coverage } = summary;
  const changed = new Set(version.changedSections || []);
  const outline = sections.length ? `<aside class="doc-outline" aria-label="章节"><h3>章节${coverage.size ? ` <span class="muted small">已关联 ${summary.covered} / ${coverage.size}</span>` : ''}</h3><ol>${sections.map(section => {
    const linked = coverage.get(section.code) || [];
    const uncovered = coverage.size && !linked.length;
    return `<li class="doc-outline-item doc-level-${Math.min(Math.max(Number(section.level) || 2, 2), 4)}${uncovered ? ' is-uncovered' : ''}">${button({ label: `${section.code} · ${section.title}`, variant: 'text', data: { docSection: section.code } })}${changed.has(section.code) ? '<span class="doc-section-change">本版修改</span>' : ''}${linked.length ? `<div class="doc-outline-links">${linked.map(item => `<span>${associationLink(item)} ${badge(item.status)}</span>`).join('')}</div>` : uncovered ? '<p class="doc-outline-links"><span class="muted small">未关联需求或提议</span></p>' : ''}</li>`;
  }).join('')}</ol></aside>` : '';
  const meta = `<div class="doc-meta">${typeBadge(document.type)}${document.primary ? primaryBadge() : ''}${classificationBadges(summary)}<span>${esc(document.name)}</span><span>v${version.version}${version.version !== document.version ? `（最新为 v${document.version}）` : ''}</span><span>${esc(shortDate(version.createdAt))} · ${esc(nameOf(version.createdBy))}${version.source === 'import' ? ' · 导入' : ''}</span>${versionCount > 1 ? button({ label: `${versionCount} 个版本`, variant: 'text', data: { documentHistory: document.id } }) : ''}</div>${version.note ? `<p class="field-help">版本说明：${esc(version.note)}</p>` : ''}${changed.size ? `<div class="doc-changed"><span>本版修改了 ${changed.size} 个章节：</span>${[...changed].slice(0, 12).map(code => button({ label: code, variant: 'text', data: { docSection: code } })).join('')}${changed.size > 12 ? ' …' : ''}</div>` : ''}`;
  const associations = summary.linked ? `<section class="doc-associations" aria-label="关联需求与提议"><h3>关联需求与提议 ${countLabel(summary.linked, '项')}</h3><ul>${summary.associations.map(item => `<li><div>${associationLink(item)} ${badge(item.status)}</div><p class="muted small">${item.kind === 'requirement' ? '已确认需求' : '未确认需求'}${item.wholeDocument ? ' · 全文参考' : ''}${item.sections.length ? ` · ${item.sections.length} 个${document.type === '验收用例' ? '用例' : '章节'}` : ''}</p></li>`).join('')}</ul></section>` : '<p class="field-help">这份文档尚未关联未归档的需求或提议。</p>';
  const proposalId = contextId(fromProposal), requirementId = proposalId ? '' : contextId(fromRequirement);
  return { body: `<div class="dialog-body doc-reader" data-document-id="${esc(document.id)}"${proposalId ? ` data-from-proposal="${esc(proposalId)}"` : requirementId ? ` data-from-requirement="${esc(requirementId)}"` : ''}>${meta}${associations}<div class="doc-viewer${outline ? '' : ' is-single'}">${outline}<div class="doc-content">${contentHtml}</div></div></div>`,
    footer: button(proposalId ? { label: '返回提议', data: { proposal: proposalId } } : requirementId ? { label: '返回需求', data: { requirement: requirementId } } : { label: '关闭', action: 'close-dialog' }) + button({ label: '下载', data: { downloadDocument: document.id, docVersion: version.version } }) + (canUpload ? button({ label: '上传新版本', variant: 'primary', iconName: 'plus', data: { uploadVersion: document.id } }) : '') };
}

export function renderDocumentVersions(document, versions, nameOf, { fromProposal = null, fromRequirement = null } = {}) {
  const proposalId = contextId(fromProposal), requirementId = proposalId ? '' : contextId(fromRequirement);
  const context = proposalId ? { fromProposal: proposalId } : requirementId ? { fromRequirement: requirementId } : {};
  const contextAttribute = proposalId ? ` data-from-proposal="${esc(proposalId)}"` : requirementId ? ` data-from-requirement="${esc(requirementId)}"` : '';
  return `<div class="dialog-body"${contextAttribute}><p class="form-intro">「${esc(document.title)}」的全部版本。每个版本独立保留，导入命令只在内容变化时生成新版本。</p><div class="history-list">${versions.map(item => `<div class="attachment-version"><div><strong>v${item.version}</strong>${item.version === document.version ? ' ' + toneBadge('done', '当前') : ''}<p>${esc(shortDate(item.createdAt))} · ${esc(nameOf(item.createdBy))}${item.source === 'import' ? ' · 导入' : ' · 上传'}${item.note ? ` · ${esc(item.note)}` : ''}</p>${item.changedSections.length ? `<p>修改章节：${item.changedSections.slice(0, 20).map(esc).join('、')}${item.changedSections.length > 20 ? ' …' : ''}</p>` : item.version > 1 ? '<p>章节结构未变化</p>' : ''}</div><div class="attachment-actions">${button({ label: '查看', variant: 'text', data: { openDocument: document.id, docVersion: item.version, ...context } })}${button({ label: '下载', variant: 'text', data: { downloadDocument: document.id, docVersion: item.version } })}</div></div>`).join('')}</div></div>`;
}

export function renderRequirementDocuments(requirement, documents, { fromProposal = null } = {}) {
  const refs = requirement.docRefs || [];
  if (!refs.length) return `<p class="muted small">这条${fromProposal ? '提议' : '需求'}还没有关联文档。</p>`;
  const names = [...new Set(refs.map(ref => ref.document))];
  const context = fromProposal ? { fromProposal: contextId(fromProposal) || requirement.id } : { fromRequirement: requirement.id };
  return `<div class="doc-refs">${names.map(name => {
    const document = documents.find(item => !item.archived && item.projectId === requirement.projectId && item.name === name);
    if (!document) return `<div class="doc-ref is-missing">${icon('document')}<span>${esc(name)}</span><span class="muted small">文档尚未上传或已归档</span></div>`;
    const codes = referencedSections(requirement, document), changed = new Set(affectedSections(requirement, document));
    const wholeDocument = refs.some(ref => ref.document === name && !(ref.sections || []).length);
    const titles = new Map((document.sections || []).map(item => [item.code, item.title]));
    const openData = { openDocument: document.id, ...context };
    return `<div class="doc-ref"><div class="doc-ref-head">${icon('document')}${button({ label: document.title, variant: 'text', data: openData })}${typeBadge(document.type)}<span class="muted small">v${document.version}</span>${wholeDocument ? toneBadge('plan', '全文参考') : ''}${codes.length ? countLabel(codes.length, document.type === '验收用例' ? '条用例' : '个章节') : ''}<span class="doc-ref-actions">${button({ label: '查看全文', variant: 'text', data: openData })}${button({ label: '下载', variant: 'text', data: { downloadDocument: document.id } })}</span></div>${wholeDocument && document.version > 1 ? `<p class="field-help">全文参考文档已更新至 v${document.version}，请结合最新全文复核。</p>` : ''}${changed.size ? `<p class="doc-changed">v${document.version} 修改了本${fromProposal ? '提议' : '需求'}关联的 ${changed.size} 个${document.type === '验收用例' ? '用例' : '章节'}</p>` : ''}${codes.length ? `<div class="doc-chips">${codes.map(code => button({ label: `${code}${changed.has(code) ? ' · 本版修改' : ''}`, size: 'small', data: { ...openData, docSection: code }, title: titles.get(code) || code })).join('')}</div>` : ''}</div>`;
  }).join('')}</div>`;
}
