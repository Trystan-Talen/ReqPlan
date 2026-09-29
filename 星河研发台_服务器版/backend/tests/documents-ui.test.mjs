import test from 'node:test';
import assert from 'node:assert/strict';
import { isDocumentReferenced, referencedSections, sectionCoverage, documentAssociationSummary, affectedSections } from '../../frontend/doc-sections.js';
import { renderDocumentsPage, renderDocumentReader, renderDocumentVersions, renderRequirementDocuments } from '../../frontend/documents-ui.js';

const document = { id: 'doc-1', projectId: 'p-1', name: '方案.md', title: '交付方案', type: 'PRD', version: 2, sections: [{ code: 'A', title: '目标', level: 2 }, { code: 'A.1', title: '边界', level: 3 }, { code: 'B', title: '验证', level: 2 }], changedSections: ['A', 'A.1'] };
const ref = (sections = []) => [{ document: document.name, type: document.type, sections }];
const requirement = (id, sections = [], more = {}) => ({ id, projectId: document.projectId, title: `需求 ${id}`, status: '已确定', docRefs: ref(sections), ...more });
const proposal = (id, sections = [], more = {}) => ({ ...requirement(id, sections), title: `提议 ${id}`, status: '待评估', ...more });
const currentVersion = { version: 2, sections: document.sections, changedSections: document.changedSections };

test('整篇关联计入需求分类与数量，不把全文参考当作全部章节覆盖；同名文档严格隔离项目', () => {
  const whole = requirement('r-1');
  assert.equal(isDocumentReferenced(whole, document), true);
  assert.equal(isDocumentReferenced({ ...whole, projectId: 'p-2' }, document), false);
  assert.equal(isDocumentReferenced({ ...whole, projectId: undefined }, document), false);
  assert.deepEqual(referencedSections(whole, document), []);
  assert.equal(sectionCoverage(document, [whole]).size, 0);
  const summary = documentAssociationSummary(document, [whole, requirement('foreign', ['B'], { projectId: 'p-2' }), requirement('archived', ['B'], { archived: true })]);
  assert.equal(summary.linked, 1);
  assert.equal(summary.confirmed[0].wholeDocument, true);
  assert.deepEqual(summary.classification, ['confirmed']);
  assert.equal(summary.covered, 0);
  assert.equal(summary.total, 0);
  assert.deepEqual(documentAssociationSummary(document, [], [proposal('archived', [], { archived: true })]).classification, ['unlinked']);
});

test('同文档双分类；历史早期需求与提议覆盖去重，已采纳和归档的提议不再当未确认需求', () => {
  const requirements = [requirement('confirmed', ['A']), requirement('legacy', ['B'], { status: '待评审' }), requirement('orphan', [], { status: '未确定' }), requirement('archived-legacy', ['A'], { status: '未确定' })];
  const proposals = [proposal('overlay', ['B'], { legacyRequirementId: 'legacy', status: '不采纳' }), proposal('converted', ['A'], { status: '已转需求', requirementId: 'confirmed' }), proposal('archived-overlay', ['A'], { legacyRequirementId: 'archived-legacy', archived: true })];
  const summary = documentAssociationSummary(document, requirements, proposals);
  assert.deepEqual(summary.classification, ['confirmed', 'unconfirmed']);
  assert.equal(summary.linked, 3);
  assert.deepEqual(summary.confirmed.map(item => item.id), ['confirmed']);
  assert.deepEqual(summary.unconfirmed.map(item => [item.id, item.status]), [['orphan', '待评估'], ['overlay', '不采纳']]);
  assert.deepEqual(summary.coverage.get('B').map(item => [item.id, item.kind]), [['overlay', 'proposal']]);
  assert.deepEqual(summary.coverage.get('A.1').map(item => item.id), ['confirmed']);
  assert.equal(summary.covered, 3);
  assert.equal(summary.total, 3);
});

test('验收用例兼容旧 acceptanceCases（验收用例编号）与新文档章节选择，按编号精确覆盖与变更提示', () => {
  const doc = { ...document, name: '验证.feature', type: '验收用例', sections: [{ code: 'AC-1' }, { code: 'AC-1.1' }, { code: 'AC-2' }], changedSections: ['AC-1.1'] };
  const item = requirement('r-1', [], { docRefs: [{ document: doc.name, sections: ['AC-1', 'OLD-CHAPTER', 'AC-2'] }], acceptanceCases: ['AC-1', 'MISSING'] });
  assert.deepEqual(referencedSections(item, doc), ['AC-1', 'AC-2']);
  assert.equal(sectionCoverage(doc, [item]).get('AC-1.1').length, 0);
  assert.deepEqual(affectedSections(item, doc), []);
  assert.deepEqual(referencedSections({ ...item, docRefs: [{ document: doc.name, sections: ['OLD-CHAPTER'] }] }, doc), ['AC-1']);
});

test('文档列表按派生分类筛选并保留双标签、整篇关联计数和空分类切换入口', () => {
  const unlinked = { ...document, id: 'doc-2', name: '未关联.md', title: '未关联文档' };
  const props = { documents: [document, unlinked, { ...document, id: 'doc-archived', title: '已归档文档', archived: true }], requirements: [requirement('r-1')], proposals: [proposal('q-1', [], { status: '不采纳' })] };
  const confirmed = renderDocumentsPage({ ...props, confirmation: 'confirmed' });
  assert.match(confirmed, /data-document-confirmation="confirmed" aria-pressed="true"/);
  assert.match(confirmed, /status-done">已确认需求<.*status-review">未确认需求</);
  assert.match(confirmed, /<td class="num-cell">2<\/td>/);
  assert.match(confirmed, /全文参考计入关联数量/);
  assert.doesNotMatch(confirmed, /data-open-document="doc-2"|已归档文档/);
  const unconfirmed = renderDocumentsPage({ ...props, confirmation: 'unconfirmed' });
  assert.match(unconfirmed, /data-open-document="doc-1"/);
  assert.doesNotMatch(unconfirmed, /data-open-document="doc-2"/);
  const onlyUnlinked = renderDocumentsPage({ ...props, confirmation: 'unlinked' });
  assert.match(onlyUnlinked, /data-open-document="doc-2"/);
  assert.doesNotMatch(onlyUnlinked, /data-open-document="doc-1"/);
  const empty = renderDocumentsPage({ ...props, proposals: [], confirmation: 'unconfirmed' });
  assert.match(empty, /此分类下没有文档/);
  assert.match(empty, /data-document-confirmation="all"/);
  assert.doesNotMatch(empty, /<select|type="radio"/);
});

test('阅读器包含全文参考和章节关联，区分已确认入口与提议入口并展示不采纳原状态', () => {
  const rejected = proposal('q-1', ['A'], { status: '不采纳' });
  const reader = renderDocumentReader({ document, version: currentVersion, contentHtml: '<p>正文</p>', requirements: [requirement('r-1')], proposals: [rejected], fromProposal: rejected });
  assert.match(reader.body, /data-from-proposal="q-1"/);
  assert.match(reader.body, /data-requirement="r-1"/);
  assert.match(reader.body, /data-proposal="q-1"/);
  assert.match(reader.body, /status-terminated">不采纳</);
  assert.match(reader.body, /已确认需求 · 全文参考/);
  assert.match(reader.body, /已关联 2 \/ 3/);
  assert.match(reader.body, /data-doc-section="A.1"/);
  assert.match(reader.footer, /data-proposal="q-1">返回提议/);
  assert.doesNotMatch(reader.body, /待办|待评估/);
  assert.doesNotMatch(reader.footer, /返回需求/);
});

test('阅读旧版本只用该版本章节计算覆盖，未出现的章节引用仍保留关联清单', () => {
  const reader = renderDocumentReader({ document, version: { version: 1, sections: [{ code: 'B', title: '验证' }] }, contentHtml: '', requirements: [requirement('r-1', ['A'])], fromRequirement: { id: 'r-1' } });
  assert.match(reader.body, /data-requirement="r-1"/);
  assert.match(reader.body, /最新为 v2/);
  assert.doesNotMatch(reader.body, /已关联 2 \/ 3|data-doc-section="A"/);
  assert.match(reader.footer, /data-requirement="r-1">返回需求/);
});

test('文档历史的每个查看入口保留原需求或提议上下文，提议优先并转义标识', () => {
  const versions = [currentVersion, { version: 1, changedSections: [] }];
  const fromProposal = renderDocumentVersions(document, versions, () => '产品经理', { fromProposal: { id: 'q-1' }, fromRequirement: { id: 'r-1' } });
  assert.match(fromProposal, /^<div class="dialog-body" data-from-proposal="q-1">/);
  for (const version of [1, 2]) assert.ok(fromProposal.includes(`data-open-document="doc-1" data-doc-version="${version}" data-from-proposal="q-1"`));
  assert.doesNotMatch(fromProposal, /data-from-requirement/);
  const fromRequirement = renderDocumentVersions(document, versions, () => '产品经理', { fromRequirement: 'r-1' });
  assert.match(fromRequirement, /data-open-document="doc-1" data-doc-version="1" data-from-requirement="r-1"/);
  assert.doesNotMatch(renderDocumentVersions(document, versions, () => '产品经理'), /data-from-proposal|data-from-requirement/);
  const escaped = renderDocumentVersions(document, versions, () => '产品经理', { fromProposal: '\"><img src=x>' });
  assert.doesNotMatch(escaped, /<img/);
  assert.match(escaped, /data-from-proposal="&quot;&gt;&lt;img src=x&gt;"/);
});

test('需求和提议详情文档入口保留返回上下文；全文参考不显示零章节并提示新版本复核', () => {
  const item = proposal('q-1');
  const html = renderRequirementDocuments(item, [document], { fromProposal: item });
  assert.match(html, /data-open-document="doc-1" data-from-proposal="q-1"/);
  assert.match(html, /全文参考/);
  assert.match(html, /全文参考文档已更新至 v2/);
  assert.doesNotMatch(html, /0 个章节|data-from-requirement/);
  const chapter = renderRequirementDocuments(requirement('r-1', ['A.1']), [document]);
  assert.match(chapter, /data-open-document="doc-1" data-from-requirement="r-1" data-doc-section="A.1"/);
  assert.match(chapter, /本版修改/);
  assert.match(renderRequirementDocuments(item, [{ ...document, projectId: 'p-2' }]), /文档尚未上传或已归档/);
});

test('文档分类与关联清单转义用户文本和标识，空项目使用既有上传权限', () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const item = proposal(attack, [], { title: attack });
  const reader = renderDocumentReader({ document: { ...document, name: attack }, version: currentVersion, contentHtml: '<p>可信正文</p>', proposals: [{ ...item, docRefs: [{ document: attack, sections: [] }] }], fromProposal: item });
  assert.doesNotMatch(reader.body + reader.footer, /<img/);
  assert.match(reader.body, /&lt;img/);
  assert.match(renderDocumentsPage({ documents: [], canUpload: true }), /data-action="upload-document"/);
  assert.doesNotMatch(renderDocumentsPage({ documents: [], canUpload: false }), /data-action="upload-document"/);
});
