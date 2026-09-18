import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';

export const ATTACHMENT_LIMIT = 2 * 1024 * 1024;
export const ATTACHMENT_TYPES = Object.freeze({ '.txt':'text/plain', '.md':'text/markdown', '.markdown':'text/markdown', '.html':'text/html', '.htm':'text/html', '.json':'application/json' });
function fail(status, message, code = 'VALIDATION_ERROR') {
  const error = new Error(message); Object.assign(error,{status,statusCode:status,code}); throw error;
}
function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) fail(400,'记录编号格式不正确');
  return value;
}
export function validateAttachment({name,mime,contentBuffer}) {
  if (typeof name !== 'string' || !name.trim() || name.length > 200 || /[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) || ['.','..'].includes(name.trim())) fail(400,'文件名不能包含路径、控制字符或超过长度限制');
  name = name.trim();
  if (typeof mime !== 'string' || mime.length > 100) fail(400,'文件类型格式不正确');
  mime = mime.toLowerCase().split(';')[0].trim();
  const extension = /\.[^.]+$/.exec(name)?.[0].toLowerCase();
  if (!ATTACHMENT_TYPES[extension] || ATTACHMENT_TYPES[extension] !== mime) fail(400,'仅支持类型匹配的文本、Markdown（标记文档）、HTML（网页）或 JSON（结构化数据）文件');
  if (!Buffer.isBuffer(contentBuffer) || !contentBuffer.length || contentBuffer.length > ATTACHMENT_LIMIT) fail(413,'附件应为非空文件且不超过 2 兆字节','FILE_TOO_LARGE');
  try { if (new TextDecoder('utf-8',{fatal:true}).decode(contentBuffer).includes('\0')) throw new Error(); }
  catch { fail(400,'附件必须为有效的 UTF-8（统一字符编码）文本'); }
  return {name,mime,contentBuffer};
}

// Authorization callbacks must apply the same membership, archive and edit rules
// as requirements. They run inside the upload transaction before any mutation.
export function createAttachmentService(db,{authorizeRead,authorizeWrite,audit}) {
  if (typeof authorizeRead !== 'function' || typeof authorizeWrite !== 'function' || typeof audit !== 'function') throw new Error('附件服务必须配置权限与审计');
  const get = (sql,...args) => db.prepare(sql).get(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  function record(table,id) {
    const row = get(`SELECT * FROM ${table} WHERE id=?`,identifier(id));
    if (!row) fail(404,'记录不存在','NOT_FOUND'); return row;
  }
  function meta(row) {
    const commits = all('SELECT commit_hash,committed_at,author FROM attachment_imports WHERE attachment_id=? ORDER BY committed_at,commit_hash',row.id).map(x=>({commit:x.commit_hash,createdAt:x.committed_at,author:x.author}));
    const source = JSON.parse(row.source);
    return {id:row.id,logicalId:row.logical_id,requirementId:row.requirement_id,projectId:row.project_id,name:row.name,mime:row.mime,version:row.version,size:row.size ?? row.content?.length,createdAt:row.created_at,createdBy:row.created_by,actor:row.created_by ? {id:row.created_by,name:get('SELECT name FROM users WHERE id=?',row.created_by)?.name || ''} : (source.author ? {id:null,name:source.author} : null),source:commits.length ? {...source,commits} : source,historical:Boolean(row.historical)};
  }
  const metadataColumns = 'id,logical_id,requirement_id,project_id,name,mime,version,length(content) size,created_at,created_by,source,historical';
  function history(logicalId) { return all(`SELECT ${metadataColumns} FROM attachments WHERE logical_id=? ORDER BY version DESC`,logicalId).map(meta); }
  function listAttachments(actor,requirementId) {
    const requirement = record('requirements',requirementId); authorizeRead(actor,requirement);
    return all(`SELECT ${metadataColumns} FROM attachments a WHERE requirement_id=? AND historical=0 AND version=(SELECT MAX(version) FROM attachments b WHERE b.logical_id=a.logical_id AND b.historical=0) ORDER BY created_at,id`,requirementId).map(row=>({...meta(row),versions:history(row.logical_id)}));
  }
  function listAttachmentVersions(actor,attachmentId) {
    const row = record('attachments',attachmentId); authorizeRead(actor,record('requirements',row.requirement_id)); return history(row.logical_id);
  }
  function uploadAttachment(actor,requirementId,input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key=>!['name','mime','contentBuffer','logicalId','expectedVersion'].includes(key))) fail(400,'附件提交包含不支持的字段');
    return transaction(db,()=>{
      const requirement = record('requirements',requirementId); const access = authorizeWrite(actor,requirement);
      const file = validateAttachment(input);
      let latest;
      if (input.logicalId !== undefined) {
        identifier(input.logicalId);
        latest = get('SELECT * FROM attachments WHERE logical_id=? AND historical=0 ORDER BY version DESC LIMIT 1',input.logicalId);
        if (!latest) fail(404,'附件版本链不存在','NOT_FOUND');
        if (latest.requirement_id !== requirementId || latest.name !== file.name || latest.mime !== file.mime) fail(400,'新版本的需求、文件名和类型必须与原附件一致');
      } else latest = get('SELECT * FROM attachments WHERE requirement_id=? AND name=? AND mime=? AND historical=0 ORDER BY version DESC LIMIT 1',requirementId,file.name,file.mime);
      if (latest) {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) fail(400,'上传新版本必须提交当前版本号','VERSION_REQUIRED');
        if (input.expectedVersion !== latest.version) fail(409,'附件已有新版本，请重新载入后再上传','VERSION_CONFLICT');
      } else if (input.expectedVersion !== undefined && input.expectedVersion !== 0) fail(409,'附件当前版本不存在，请重新载入','VERSION_CONFLICT');
      const attachmentId = `f-${randomUUID()}`; const logicalId = latest?.logical_id || attachmentId;
      const version = (get('SELECT MAX(version) version FROM attachments WHERE logical_id=?',logicalId)?.version || 0)+1;
      db.prepare('INSERT INTO attachments(id,logical_id,requirement_id,project_id,name,mime,content,version,created_at,created_by,source) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(attachmentId,logicalId,requirementId,requirement.project_id,file.name,file.mime,file.contentBuffer,version,new Date().toISOString(),access.user.id,JSON.stringify({kind:'upload'}));
      audit(access.user,latest ? 'attachment_version' : 'upload','attachment',attachmentId,requirement.project_id,{requirementId,name:file.name,mime:file.mime,bytes:file.contentBuffer.length,logicalId,version,previousVersion:latest?.version || null});
      return {...meta(record('attachments',attachmentId)),versions:history(logicalId)};
    });
  }
  function getAttachment(actor,attachmentId,options={}) {
    let row = record('attachments',attachmentId); authorizeRead(actor,record('requirements',row.requirement_id));
    if (options.version !== undefined) {
      if (!Number.isSafeInteger(options.version) || options.version < 1) fail(400,'附件版本号必须为正整数');
      row = get('SELECT * FROM attachments WHERE logical_id=? AND version=?',row.logical_id,options.version);
      if (!row) fail(404,'附件版本不存在','NOT_FOUND');
    }
    return {...meta(row),contentBuffer:Buffer.from(row.content)};
  }
  return Object.freeze({listAttachments,listAttachmentVersions,uploadAttachment,getAttachment});
}
