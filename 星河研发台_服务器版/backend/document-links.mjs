import { DOCUMENT_TYPES } from '../frontend/doc-sections.js';

const fail = message => { throw Object.assign(new Error(message), { status: 400, statusCode: 400, code: 'VALIDATION_ERROR' }); };

// Requirements and proposals use the same references. A filename may precede its
// upload; an empty sections list refers to the full document, without copying it.
export function normalizeDocumentLinks({ docRefs = [], acceptanceCases = [] } = {}) {
  const code = (value, label) => {
    if (typeof value !== 'string' || !/^[§A-Za-z0-9][\w.§-]{0,79}$/u.test(value)) fail(`${label}编号格式不正确：${String(value).slice(0, 40)}`);
    return value;
  };
  if (!Array.isArray(docRefs) || docRefs.length > 50) fail('关联文档应为最多 50 项的列表');
  const references = docRefs.map(ref => {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) fail('关联文档格式不正确');
    let document = ref.document ?? '';
    if (typeof document !== 'string' || document.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(document)) fail('关联文档名称格式不正确或超过长度限制');
    document = document.trim(); if (!document) fail('请填写关联文档名称');
    if (ref.type !== undefined && !DOCUMENT_TYPES.includes(ref.type)) fail('关联文档类型不是允许的选项');
    if (!Array.isArray(ref.sections || []) || (ref.sections || []).length > 200) fail('关联章节应为最多 200 项的列表');
    return { document, ...(ref.type ? { type: ref.type } : {}), sections: [...new Set((ref.sections || []).map(value => code(value, '章节')))] };
  });
  if (!Array.isArray(acceptanceCases) || acceptanceCases.length > 500) fail('验收用例应为最多 500 项的列表');
  return { docRefs: references, acceptanceCases: [...new Set(acceptanceCases.map(value => code(value, '验收用例')))] };
}
