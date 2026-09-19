import { randomUUID, createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { DOCUMENT_TYPES, DOCUMENT_EXTENSIONS, parseSections, changedSections } from '../frontend/doc-sections.js';

export const DOCUMENT_LIMIT = 2 * 1024 * 1024;
function fail(status, message, code = 'VALIDATION_ERROR') {
  const error = new Error(message); Object.assign(error, { status, statusCode: status, code }); throw error;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) fail(400, '记录编号格式不正确');
  return value;
}
function fileName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value) || ['.', '..'].includes(value.trim())) fail(400, '文件名不能包含路径、控制字符或超过长度限制');
  const name = value.trim(), extension = /\.[^.]+$/.exec(name)?.[0].toLowerCase();
  if (!DOCUMENT_EXTENSIONS[extension]) fail(400, '仅支持 Markdown（.md）、文本（.txt）、验收用例（.feature）、网页原型（.html）或 JSON 文件');
  return { name, mime: DOCUMENT_EXTENSIONS[extension] };
}
function title(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, '文档标题格式不正确');
  return value.trim() || fallback;
}
function content(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > DOCUMENT_LIMIT) fail(413, '文档应为非空文件且不超过 2 兆字节', 'FILE_TOO_LARGE');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { fail(400, '文档必须为有效的 UTF-8（统一字符编码）文本'); }
  if (text.includes('\0')) fail(400, '文档必须为有效的 UTF-8（统一字符编码）文本');
  return text;
}
const json = value => { try { return JSON.parse(value); } catch { return []; } };

// Documents belong to one project. A file used by several projects is uploaded to each of
// them; the import command keeps those copies in step (see 改版方案 §五).
// authorize(actor, projectId, write, type) must apply membership, archive and role rules.
export function createDocumentService(db, { authorize, audit }) {
  if (typeof authorize !== 'function' || typeof audit !== 'function') throw new Error('文档服务必须配置权限与审计');
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  function documentRow(id) {
    const row = get('SELECT * FROM documents WHERE id=?', identifier(id));
    if (!row) fail(404, '文档不存在', 'NOT_FOUND'); return row;
  }
  function versionMeta(row) {
    return { id: row.id, version: row.version, mime: row.mime, size: row.size, sections: json(row.sections), changedSections: json(row.changed_sections), note: row.note, source: row.source, createdAt: row.created_at, createdBy: row.created_by };
  }
  const versionColumns = 'id,document_id,version,mime,length(content) size,content_hash,sections,changed_sections,note,source,created_at,created_by';
  function describe(row) {
    const current = get(`SELECT ${versionColumns} FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1`, row.id);
    const meta = current ? versionMeta(current) : null;
    return { id: row.id, projectId: row.project_id, name: row.name, title: row.title, type: row.type, primary: Boolean(row.is_primary), createdAt: row.created_at, updatedAt: row.updated_at,
      version: meta?.version || 0, mime: meta?.mime || '', size: meta?.size || 0, sections: meta?.sections || [], changedSections: meta?.changedSections || [], note: meta?.note || '', versionCreatedAt: meta?.createdAt || '', versionCreatedBy: meta?.createdBy || '' };
  }
  function listForProjects(projectIds) {
    const ids = [...projectIds]; if (!ids.length) return [];
    return all(`SELECT * FROM documents WHERE project_id IN (${ids.map(() => '?').join(',')}) ORDER BY is_primary DESC, type, name`, ...ids).map(describe);
  }
  function listDocuments(actor, projectId) { authorize(actor, projectId, false); return listForProjects([projectId]); }
  function listVersions(actor, documentId) {
    const row = documentRow(documentId); authorize(actor, row.project_id, false);
    return all(`SELECT ${versionColumns} FROM document_versions WHERE document_id=? ORDER BY version DESC`, row.id).map(versionMeta);
  }
  function getContent(actor, documentId, version) {
    const row = documentRow(documentId); authorize(actor, row.project_id, false);
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) fail(400, '文档版本号必须为正整数');
    const file = version === undefined
      ? get('SELECT * FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1', row.id)
      : get('SELECT * FROM document_versions WHERE document_id=? AND version=?', row.id, version);
    if (!file) fail(404, '文档版本不存在', 'NOT_FOUND');
    return { name: row.name, mime: file.mime, version: file.version, contentBuffer: Buffer.from(file.content) };
  }
  function clearPrimary(projectId, exceptId) { db.prepare('UPDATE documents SET is_primary=0 WHERE project_id=? AND id<>?').run(projectId, exceptId); }

  /**
   * 上传文档或新版本。documentId 指定时为该文档的新版本；否则按项目内文件名匹配，已存在则追加版本。
   * 内容与当前版本相同时不生成新版本（unchanged: true），导入命令据此跳过未修改的文件。
   */
  function uploadDocument(actor, projectId, input) {
    const allowed = ['name', 'title', 'type', 'primary', 'contentBuffer', 'documentId', 'expectedVersion', 'note', 'source'];
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !allowed.includes(key))) fail(400, '文档提交包含不支持的字段');
    return transaction(db, () => {
      const file = fileName(input.name); const text = content(input.contentBuffer);
      let row = input.documentId !== undefined ? documentRow(input.documentId) : get('SELECT * FROM documents WHERE project_id=? AND name=?', identifier(projectId), file.name);
      if (row && row.project_id !== projectId) fail(400, '文档不属于该项目');
      const type = input.type === undefined ? row?.type || 'PRD' : input.type;
      if (!DOCUMENT_TYPES.includes(type)) fail(400, '文档类型不是允许的选项');
      if (row && file.mime !== get('SELECT mime FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1', row.id)?.mime) fail(400, '新版本的文件类型必须与原文档一致');
      const access = authorize(actor, projectId, true, type);
      if (row && type !== row.type) authorize(actor, projectId, true, row.type);
      const latest = row && get('SELECT version,content_hash,sections FROM document_versions WHERE document_id=? ORDER BY version DESC LIMIT 1', row.id);
      if (latest && input.expectedVersion !== undefined && input.expectedVersion !== latest.version) fail(409, '文档已有新版本，请重新载入后再上传', 'VERSION_CONFLICT');
      const hash = createHash('sha256').update(input.contentBuffer).digest('hex');
      const stamp = new Date().toISOString();
      if (!row) {
        const id = `d-${randomUUID()}`;
        db.prepare('INSERT INTO documents(id,project_id,name,title,type,is_primary,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, projectId, file.name, title(input.title, file.name), type, input.primary ? 1 : 0, stamp, stamp);
        row = documentRow(id);
      } else {
        db.prepare('UPDATE documents SET title=?,type=?,is_primary=?,updated_at=? WHERE id=?').run(title(input.title, row.title), type, input.primary === undefined ? row.is_primary : input.primary ? 1 : 0, stamp, row.id);
      }
      if (input.primary) clearPrimary(projectId, row.id);
      const sections = parseSections(file.name, text);
      if (latest && latest.content_hash === hash) {
        // Sections are derived data: refresh them in place when the parser improves, without a new version.
        if (latest.sections !== JSON.stringify(sections)) db.prepare('UPDATE document_versions SET sections=? WHERE document_id=? AND version=?').run(JSON.stringify(sections), row.id, latest.version);
        return { document: describe(documentRow(row.id)), unchanged: true };
      }
      const changed = latest ? changedSections(json(latest.sections), sections) : [];
      const version = (latest?.version || 0) + 1, versionId = `dv-${randomUUID()}`;
      const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : '';
      const source = input.source === 'import' ? 'import' : 'upload';
      db.prepare('INSERT INTO document_versions(id,document_id,version,mime,content,content_hash,sections,changed_sections,note,source,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(versionId, row.id, version, file.mime, input.contentBuffer, hash, JSON.stringify(sections), JSON.stringify(changed), note, source, stamp, access.user.id);
      audit(access.user, version === 1 ? 'document_create' : 'document_version', 'document', row.id, projectId, { name: file.name, type, version, bytes: input.contentBuffer.length, changedSections: changed.slice(0, 200), source });
      return { document: describe(documentRow(row.id)), unchanged: false };
    });
  }
  function updateDocument(actor, documentId, input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['title', 'type', 'primary'].includes(key))) fail(400, '文档修改包含不支持的字段');
    return transaction(db, () => {
      const row = documentRow(documentId); const type = input.type ?? row.type;
      if (!DOCUMENT_TYPES.includes(type)) fail(400, '文档类型不是允许的选项');
      const access = authorize(actor, row.project_id, true, row.type); if (type !== row.type) authorize(actor, row.project_id, true, type);
      db.prepare('UPDATE documents SET title=?,type=?,is_primary=?,updated_at=? WHERE id=?').run(title(input.title, row.title), type, input.primary === undefined ? row.is_primary : input.primary ? 1 : 0, new Date().toISOString(), row.id);
      if (input.primary) clearPrimary(row.project_id, row.id);
      audit(access.user, 'document_update', 'document', row.id, row.project_id, { title: input.title, type, primary: input.primary });
      return describe(documentRow(row.id));
    });
  }
  return Object.freeze({ listForProjects, listDocuments, listVersions, getContent, uploadDocument, updateDocument });
}
