// 提议与确认需求共用文档选择器；只选择关联，不在未保存表单内打开阅读器。
import { esc, field, input, select, options, toneBadge } from './ui-kit.js';

const MARKER = 'documentLinksPresent';
const MODE_PREFIX = 'documentLinkMode:';
const SECTION_PREFIX = 'documentLinkSections:';
const keyOf = document => encodeURIComponent(document.id ? `id:${document.id}` : `name:${document.name}`);
const projectDocuments = (item, documents) => item.projectId ? documents.filter(document => document.projectId === item.projectId && !document.archived) : [];
const linksOf = item => ({ docRefs: Array.isArray(item?.docRefs) ? item.docRefs : [], acceptanceCases: Array.isArray(item?.acceptanceCases) ? item.acceptanceCases : [] });
const unique = values => [...new Set(values)];
const refsFor = (item, document) => linksOf(item).docRefs.filter(ref => ref.document === document.name);
const sectionsOf = document => (document.sections || []).filter(section => typeof section.code === 'string' && section.code);
const sectionName = (key, code) => `${SECTION_PREFIX}${key}:${encodeURIComponent(code)}`;

/** 返回 form-grid 的子字段。项目编号必填；每份文档显式选择不关联、全文或指定章节。 */
export function renderDocumentLinkFields(item = {}, documents = [], { disabled = false } = {}) {
  item = item || {};
  const available = projectDocuments(item, documents), { docRefs, acceptanceCases } = linksOf(item);
  const disabledAttr = disabled ? ' disabled' : '';
  const documentFields = available.map(document => {
    const key = keyOf(document), refs = refsFor(item, document), codes = unique(refs.flatMap(ref => ref.sections || []));
    const full = refs.some(ref => !(ref.sections || []).length), sections = sectionsOf(document);
    const missingCodes = codes.filter(code => !sections.some(section => section.code === code));
    const choicesList = [...sections, ...missingCodes.map(code => ({ code, title: '历史章节（当前版本未找到）' }))];
    const mode = full ? 'full' : refs.length ? 'sections' : 'none';
    const modes = choicesList.length ? ['none', 'full', 'sections'] : ['none', 'full'];
    const choices = choicesList.length ? `<details class="document-link-sections"><summary>选择${document.type === '验收用例' ? '用例' : '章节'} · 已保存 ${codes.length} 项</summary><p class="field-help">仅在关联范围为“指定章节”时保存以下选择。</p><div class="document-link-options">${choicesList.map(section => `<label class="document-link-option">${input(sectionName(key, section.code), section.code, `type="checkbox"${codes.includes(section.code) ? ' checked' : ''}${disabledAttr}`)}<span><code>${esc(section.code)}</code> ${esc(section.title || section.code)}</span></label>`).join('')}</div></details>` : '<p class="field-help">这份文档没有可选章节，可关联全文。</p>';
    return `<div class="document-link-item"><div class="document-link-heading"><span><strong>${esc(document.title || document.name)}</strong><small>${esc(document.name)}</small></span>${toneBadge('', document.type || '其他', { plain: true })}</div>${field('关联范围', `${MODE_PREFIX}${key}`, select(`${MODE_PREFIX}${key}`, options(modes, mode, { none: '不关联', full: '全文', sections: '指定章节' }), `${disabledAttr} aria-label="${esc(document.title || document.name)}的关联范围"`))}${choices}${missingCodes.length ? '<p class="document-link-preserved">历史章节默认保留；取消勾选或改为不关联后才会移除。</p>' : ''}</div>`;
  }).join('');
  const missing = docRefs.filter(ref => !available.some(document => document.name === ref.document));
  const preserved = missing.length ? `<div class="document-link-preserved"><strong>保留原有关联</strong>${missing.map(ref => `<p>${esc(ref.document)}${ref.sections?.length ? ` · ${ref.sections.map(esc).join('、')}` : ' · 全文'}（文档尚未上传或当前不可选）</p>`).join('')}</div>` : '';
  const legacyCases = acceptanceCases.length ? `<p class="document-link-preserved">原有验收用例编号已保留：${acceptanceCases.map(esc).join('、')}。</p>` : '';
  const content = `${input(MARKER, '1', `type="hidden"${disabledAttr}`)}<details id="field-document-links" class="document-link-picker"><summary>已保存 ${unique(docRefs.map(ref => ref.document)).length} 份关联 · ${available.length} 份文档可选</summary><div class="document-link-list">${documentFields || '<p class="field-help">暂无可选项目文档。可先保存内容，上传项目文档后再关联。</p>'}${preserved}${legacyCases}</div></details>`;
  return field('关联文档', 'document-links', content, true, '展开后选择每份文档的关联范围；指定章节时至少选择一项。最多关联 50 份文档，每份最多 200 个章节。');
}

/**
 * entries 是 FormData 或提供 getAll(name) 的等价对象，无控件标记时完整保留关联。
 * 独立验收用例编号和未上传文档引用不由这个选择器删除。
 */
export function readDocumentLinkFields(entries, item = {}, documents = []) {
  item = item || {};
  const original = linksOf(item);
  if (!entries?.getAll || !entries.getAll(MARKER).includes('1')) return original;
  const available = projectDocuments(item, documents);
  const docRefs = original.docRefs.filter(ref => !available.some(document => document.name === ref.document));
  for (const document of available) {
    const key = keyOf(document), refs = refsFor(item, document), sections = sectionsOf(document);
    const mode = entries.getAll(`${MODE_PREFIX}${key}`)[0];
    if (mode === undefined) { docRefs.push(...refs); continue; }
    if (mode === 'none') continue;
    if (!['full', 'sections'].includes(mode)) throw new Error('文档关联范围无效，请重新选择。');
    const allowedCodes = unique([...sections.map(section => section.code), ...refs.flatMap(ref => ref.sections || [])]);
    const codes = allowedCodes.filter(code => entries.getAll(sectionName(key, code)).includes(code));
    if (mode === 'sections' && !codes.length) throw new Error(`请为「${document.title || document.name}」选择至少一个章节，或改为关联全文。`);
    if (mode === 'sections' && codes.length > 200) throw new Error('每份文档最多关联 200 个章节，请减少选择后重试。');
    docRefs.push({ document: document.name, ...(document.type ? { type: document.type } : {}), sections: mode === 'full' ? [] : codes });
  }
  if (docRefs.length > 50) throw new Error('最多关联 50 份文档，请减少选择后重试。');
  return { docRefs, acceptanceCases: original.acceptanceCases };
}
