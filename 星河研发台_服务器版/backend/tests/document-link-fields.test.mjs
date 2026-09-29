import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDocumentLinkFields, readDocumentLinkFields } from '../../frontend/document-link-fields.js';

const document = { id: 'doc-1', projectId: 'p-1', name: '导出需求.md', title: '导出需求说明', type: 'PRD', sections: [{ code: 'EXPORT-1', title: '导出范围' }, { code: 'EXPORT-2', title: '下载记录' }] };
const cases = { id: 'doc-cases', projectId: 'p-1', name: '导出验收.feature', title: '导出验收', type: '验收用例', sections: [{ code: 'EXPORT-AC-1', title: '导出范围正确' }] };
const item = { projectId: 'p-1', docRefs: [{ document: document.name, type: 'PRD', sections: ['EXPORT-1', 'REMOVED-1'] }, { document: '尚未上传.md', sections: ['OLD-1'] }], acceptanceCases: ['LEGACY-AC-1'] };
const mode = doc => `documentLinkMode:${encodeURIComponent(`id:${doc.id}`)}`;
const section = (doc, code) => `documentLinkSections:${encodeURIComponent(`id:${doc.id}`)}:${encodeURIComponent(code)}`;
// 与页面事件测试相同，只要求 getAll，不依赖宿主浏览器的表单对象。
const values = entries => ({ getAll: name => entries.filter(([key]) => key === name).map(([, value]) => value) });
const selected = entries => values([['documentLinksPresent', '1'], ...entries]);

test('关联选择器仅显示本项目文档，整体折叠且范围明确，不打开未保存表单外的文档', () => {
  const html = renderDocumentLinkFields(item, [document, cases, { ...document, id: 'other-project', projectId: 'p-2', title: '其他项目不应出现' }]);
  assert.match(html, /<details id="field-document-links" class="document-link-picker">/);
  assert.match(html, /已保存 2 份关联 · 2 份文档可选/);
  assert.match(html, /不关联|全文|指定章节/);
  assert.match(html, /REMOVED-1/);
  assert.match(html, /历史章节（当前版本未找到）/);
  assert.match(html, /尚未上传.md/);
  assert.doesNotMatch(html, /其他项目不应出现|data-open-document|data-download-document|<a\b/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(ids.length, new Set(ids).size, '所有输入控件有唯一编号');
  const noSections = renderDocumentLinkFields({ projectId: 'p-1' }, [{ ...document, sections: [] }]);
  assert.doesNotMatch(noSections, /<option value="sections"/);
  assert.doesNotMatch(renderDocumentLinkFields({}, [document]), /导出需求说明/);
});

test('缺选择器标记或整个选择器只读时保留所有原关联', () => {
  assert.deepEqual(readDocumentLinkFields(values([]), item, [document]), { docRefs: item.docRefs, acceptanceCases: item.acceptanceCases });
  assert.deepEqual(readDocumentLinkFields(null, item, [document]), { docRefs: item.docRefs, acceptanceCases: item.acceptanceCases });
  const html = renderDocumentLinkFields(item, [document], { disabled: true });
  const controls = html.match(/<(?:input|select)\b[^>]*>/g);
  assert.ok(controls.every(control => / disabled(?:\s|>)/.test(control)));
});

test('全文与章节按明确范围保存，新验收用例保存在章节，旧用例编号保留', () => {
  const entries = selected([[mode(document), 'full'], [section(document, 'EXPORT-1'), 'EXPORT-1'], [mode(cases), 'sections'], [section(cases, 'EXPORT-AC-1'), 'EXPORT-AC-1']]);
  const result = readDocumentLinkFields(entries, item, [document, cases]);
  assert.deepEqual(result.docRefs, [{ document: '尚未上传.md', sections: ['OLD-1'] }, { document: document.name, type: 'PRD', sections: [] }, { document: cases.name, type: '验收用例', sections: ['EXPORT-AC-1'] }]);
  assert.deepEqual(result.acceptanceCases, ['LEGACY-AC-1']);
});

test('已缺失的文档与历史章节默认可保留，显式不关联不影响独立旧用例', () => {
  const preserved = readDocumentLinkFields(selected([[mode(document), 'sections'], [section(document, 'EXPORT-1'), 'EXPORT-1'], [section(document, 'REMOVED-1'), 'REMOVED-1']]), item, [document]);
  assert.deepEqual(preserved.docRefs.find(ref => ref.document === document.name).sections, ['EXPORT-1', 'REMOVED-1']);
  assert.deepEqual(readDocumentLinkFields(selected([]), item, [document]), { docRefs: [item.docRefs[1], item.docRefs[0]], acceptanceCases: item.acceptanceCases }, '个别控件缺失时不清空已有内容');
  const removed = readDocumentLinkFields(selected([[mode(document), 'none']]), item, [document]);
  assert.deepEqual(removed, { docRefs: [item.docRefs[1]], acceptanceCases: item.acceptanceCases });
  const forged = readDocumentLinkFields(selected([[mode(document), 'sections'], [section(document, 'EXPORT-2'), 'EXPORT-2'], [section(document, 'UNKNOWN-1'), 'UNKNOWN-1']]), { projectId: 'p-1' }, [document]);
  assert.deepEqual(forged.docRefs[0].sections, ['EXPORT-2']);
});

test('指定章节至少一项，并遵循 50 份文档与 200 个章节的后端上限', () => {
  assert.throws(() => readDocumentLinkFields(selected([[mode(document), 'sections']]), { projectId: 'p-1' }, [document]), /至少一个章节/);
  const manyDocs = Array.from({ length: 51 }, (_, index) => ({ ...document, id: `doc-${index}`, name: `文档${index}.md` }));
  assert.throws(() => readDocumentLinkFields(selected(manyDocs.map(doc => [mode(doc), 'full'])), { projectId: 'p-1' }, manyDocs), /最多关联 50 份文档/);
  const largeDoc = { ...document, sections: Array.from({ length: 201 }, (_, index) => ({ code: `S-${index}`, title: '章节' })) };
  const selectedSections = largeDoc.sections.map(entry => [section(largeDoc, entry.code), entry.code]);
  assert.throws(() => readDocumentLinkFields(selected([[mode(largeDoc), 'sections'], ...selectedSections]), { projectId: 'p-1' }, [largeDoc]), /最多关联 200 个章节/);
  assert.deepEqual(readDocumentLinkFields(selected([[mode(largeDoc), 'full'], ...selectedSections]), { projectId: 'p-1' }, [largeDoc]).docRefs[0].sections, []);
});

test('文档名称、标题、章节和历史关联均转义', () => {
  const attack = '\"><img src=x onerror=alert(1)>';
  const unsafe = { ...document, id: attack, name: attack, title: attack, type: attack, sections: [{ code: attack, title: attack }] };
  const html = renderDocumentLinkFields({ projectId: 'p-1', docRefs: [{ document: attack, sections: [attack] }, { document: attack + '旧', sections: [attack] }], acceptanceCases: [attack] }, [unsafe]);
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /&lt;img/);
});
