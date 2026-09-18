import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { openDatabase, transaction, writeAudit, SCHEMA_VERSION } from '../database.mjs';
import { ATTACHMENT_LIMIT, ATTACHMENT_TYPES, validateAttachment } from '../attachments.mjs';
import { backupDatabase } from './backup.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const within = (root,target) => { const relative=path.relative(root,target);return relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative); };
const MAX_HISTORY_BYTES=50*1024*1024;
const sensitiveKey=/password|token|secret|credential|salt|api.?key/i;
function canonicalDestination(destination) {
  let ancestor=path.resolve(destination);const missing=[];
  while(!fs.existsSync(ancestor)) {const parent=path.dirname(ancestor);if(parent===ancestor)fail('目标路径无法解析');missing.unshift(path.basename(ancestor));ancestor=parent;}
  return path.join(fs.realpathSync(ancestor),...missing);
}
function runGit(directory,args,{binary=false,maxBuffer=16*1024*1024}={}) {
  // No shell, hooks, external filters or text conversion are involved. Never
  // echo git stderr: paths and commit metadata are untrusted source material.
  const result=spawnSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-c','core.pager=cat','-C',directory,...args],{encoding:binary?undefined:'utf8',maxBuffer,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0'}});
  if(result.error||result.status!==0)fail('读取原附件版本库失败；未更改源文件。');
  return result.stdout;
}
function credentialChecker(source) {
  const secrets=new Set();const dataRoot=path.dirname(source);const legacy=path.join(dataRoot,'db.json');
  // Only collect credential values locally for comparison. Nothing from the
  // original database is exported, printed or copied to the destination.
  if(fs.existsSync(legacy)) {
    if(!within(dataRoot,fs.realpathSync(legacy))||!fs.statSync(legacy).isFile()||fs.statSync(legacy).size>50*1024*1024)fail('原凭证检查文件位置或大小不安全');
    let raw;try{raw=JSON.parse(fs.readFileSync(legacy,'utf8'));}catch{fail('无法完成原凭证检查，拒绝补录');}
    const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){if(sensitiveKey.test(key)&&typeof item==='string'&&item)secrets.add(item);else if(item&&typeof item==='object')visit(item);}};
    visit(raw.settings);visit(raw.users);visit(raw.history);
  }
  return value=>{
    const text=Buffer.isBuffer(value)?value.toString('utf8'):value;
    if([...secrets].some(secret=>text.includes(secret))||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["']?[A-Za-z0-9_+\/-]{16,}/i.test(text))fail('附件历史或作者信息含疑似凭证，已拒绝补录；请先在独立副本中脱敏。');
  };
}
function readHistory(sourceFiles,requirements) {
  if(!sourceFiles)fail('必须指定 --source-files 原附件目录');
  const source=fs.realpathSync(path.resolve(sourceFiles));if(!fs.statSync(source).isDirectory())fail('原附件目录不存在');
  const root=fs.realpathSync(runGit(source,['rev-parse','--show-toplevel']).trim());if(!within(root,source))fail('附件目录不在版本库内');
  const prefix=path.relative(root,source).split(path.sep).join('/');
  const sourceKey=sha(source);const check=credentialChecker(source);
  const lines=runGit(root,['log','--all','--reverse','--topo-order','--format=%H%x00%aI%x00%an']).trimEnd().split('\n').filter(Boolean);
  if(lines.length>10000)fail('历史提交超过一万条，请在独立副本中缩小范围后再补录');
  const candidates=[];const blobs=new Map();const previous=new Map();const unmatched=new Set();let bytes=0;let ignoredFiles=0;
  for(const line of lines) {
    const [commit,createdAt,author,...extra]=line.split('\0');
    if(extra.length||!/^[a-f0-9]{40,64}$/.test(commit)||!Number.isFinite(Date.parse(createdAt))||typeof author!=='string'||author.length>200||/[\u0000-\u001f\u007f]/.test(author))fail('版本库提交元信息不安全');
    check(author);
    const entries=runGit(root,['ls-tree','-r','-z',commit,'--',prefix||'.'],{binary:true}).toString('utf8').split('\0').filter(Boolean);
    const seen=new Set();
    for(const entry of entries) {
      const match=/^(\d+) (\w+) ([a-f0-9]{40,64})\t([\s\S]+)$/.exec(entry);if(!match)fail('版本库文件索引格式无效');
      const [,mode,type,blob,filePath]=match;
      if(prefix&&!filePath.startsWith(prefix+'/'))fail('版本库附件路径越界');
      const relative=prefix?filePath.slice(prefix.length+1):filePath;const parts=relative.split('/');
      if(parts.some(part=>!part||part==='.'||part==='..'||part.includes('\\')||/[\u0000-\u001f\u007f]/.test(part))||path.isAbsolute(relative))fail('版本库附件路径不安全');
      if(parts.some(part=>part.startsWith('.'))) {ignoredFiles++;continue;}
      if(parts.length<3||!['doc','proto'].includes(parts[1])||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(parts[0])) {ignoredFiles++;continue;}
      if(!requirements.has(parts[0])) {unmatched.add(parts[0]);continue;}
      if(!['100644','100755'].includes(mode)||type!=='blob')fail('附件历史包含符号链接或非普通文件，拒绝读取');
      const name=parts.at(-1);const mime=ATTACHMENT_TYPES[path.extname(name).toLowerCase()];if(!mime)fail('附件历史包含不支持的文件类型，拒绝遗漏内容');
      check(relative);seen.add(relative);
      if(previous.get(relative)===blob)continue;
      previous.set(relative,blob);
      if(!blobs.has(blob)) {
        const size=Number(runGit(root,['cat-file','-s',blob]).trim());if(!Number.isSafeInteger(size)||size<1||size>ATTACHMENT_LIMIT)fail('历史附件为空或超过 2 兆字节限制');
        bytes+=size;if(bytes>MAX_HISTORY_BYTES)fail('附件历史超过 50 兆字节，请在独立副本中缩小范围');
        const content=runGit(root,['cat-file','blob',blob],{binary:true,maxBuffer:ATTACHMENT_LIMIT+1024});check(content);blobs.set(blob,content);
      }
      const file=validateAttachment({name,mime,contentBuffer:blobs.get(blob)});
      candidates.push({...file,filePath:relative,requirementId:parts[0],commit,createdAt:new Date(createdAt).toISOString(),author,blob,digest:sha(file.contentBuffer)});
    }
    for(const key of previous.keys())if(!seen.has(key))previous.delete(key);
  }
  return {source,root,sourceKey,candidates,unmatchedRequirements:unmatched.size,ignoredFiles};
}
function planImport(db,history) {
  const hasMappings=Boolean(db.prepare("SELECT name FROM sqlite_master WHERE name='attachment_imports'").get());
  const mapped=new Set(hasMappings?db.prepare('SELECT commit_hash,file_path FROM attachment_imports WHERE source_key=?').all(history.sourceKey).map(x=>JSON.stringify([x.commit_hash,x.file_path])):[]);
  const grouped=new Map();const pending=[];let duplicates=0;
  for(const candidate of history.candidates) {
    if(mapped.has(JSON.stringify([candidate.commit,candidate.filePath]))) {duplicates++;continue;}
    const key=JSON.stringify([candidate.requirementId,candidate.name,candidate.mime]);
    if(!grouped.has(key)) {
      const rows=db.prepare('SELECT id,content FROM attachments WHERE requirement_id=? AND name=? AND mime=?').all(candidate.requirementId,candidate.name,candidate.mime);
      grouped.set(key,new Map(rows.map(row=>[sha(Buffer.from(row.content)),row.id])));
    }
    const digests=grouped.get(key);const existingId=digests.get(candidate.digest);
    const attachmentId=existingId||`git-${sha(history.sourceKey+key+candidate.digest).slice(0,48)}`;
    pending.push({...candidate,attachmentId,insert:!existingId});digests.set(candidate.digest,attachmentId);
  }
  return {pending,duplicates,newVersions:pending.filter(x=>x.insert).length};
}

export async function importAttachmentHistory({sourceFiles,database,apply=false,backupPath}={}) {
  if(!database||!fs.existsSync(database))fail('必须指定已经存在的目标数据库');
  const destination=fs.realpathSync(path.resolve(database));
  const inspect=new DatabaseSync(destination,{readOnly:true});let history,plan;
  try {
    if(inspect.prepare('PRAGMA user_version').get().user_version>SCHEMA_VERSION)fail('数据库来自更新的软件版本，拒绝操作');
    const requirements=new Set(inspect.prepare('SELECT id FROM requirements').all().map(x=>x.id));history=readHistory(sourceFiles,requirements);
    if(within(history.root,destination))fail('目标数据库不能位于原附件版本库内');
    plan=planImport(inspect,history);
  } finally {inspect.close();}
  const summary={dryRun:!apply,sourceCommits:new Set(history.candidates.map(x=>x.commit)).size,newVersions:plan.newVersions,newMappings:plan.pending.length,alreadyImported:plan.duplicates,unmatchedRequirements:history.unmatchedRequirements,ignoredFiles:history.ignoredFiles};
  if(!apply||!plan.pending.length)return summary;
  const backup=path.resolve(backupPath||path.join(path.dirname(destination),'backups',`before-attachment-history-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`));
  if(within(history.root,canonicalDestination(backup)))fail('备份路径不能位于原附件版本库内');
  await backupDatabase(destination,backup);
  const db=openDatabase(destination);
  try {
    return transaction(db,()=>{
      plan=planImport(db,history);const chainState=new Map();const newChains=new Map();
      for(const item of plan.pending) {
        const key=JSON.stringify([item.requirementId,item.name,item.mime]);
        let chain=chainState.get(key);
        if(!chain) {
          const current=db.prepare('SELECT logical_id FROM attachments WHERE requirement_id=? AND name=? AND mime=? ORDER BY historical,version DESC LIMIT 1').get(item.requirementId,item.name,item.mime);
          chain={logicalId:current?.logical_id||item.attachmentId,projectId:db.prepare('SELECT project_id FROM requirements WHERE id=?').get(item.requirementId)?.project_id};
          if(!chain.projectId)fail('补录期间需求发生变化，请重新试运行');
          chainState.set(key,chain);if(!current)newChains.set(key,null);
        }
        if(item.insert) {
          const version=(db.prepare('SELECT MAX(version) version FROM attachments WHERE logical_id=?').get(chain.logicalId).version||0)+1;
          db.prepare('INSERT INTO attachments(id,logical_id,requirement_id,project_id,name,mime,content,version,created_at,created_by,source,historical) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,1)').run(item.attachmentId,chain.logicalId,item.requirementId,chain.projectId,item.name,item.mime,item.contentBuffer,version,item.createdAt,JSON.stringify({kind:'git',commit:item.commit,author:item.author,path:item.filePath}));
        }
        db.prepare('INSERT INTO attachment_imports(source_key,commit_hash,file_path,blob_hash,attachment_id,committed_at,author) VALUES(?,?,?,?,?,?,?)').run(history.sourceKey,item.commit,item.filePath,item.blob,item.attachmentId,item.createdAt,item.author);
        if(newChains.has(key))newChains.set(key,item.attachmentId);
      }
      // Only a previously absent chain chooses a current version. Existing
      // uploads retain their current version, address and conflict token.
      for(const attachmentId of newChains.values())db.prepare('UPDATE attachments SET historical=0 WHERE id=?').run(attachmentId);
      writeAudit(db,null,'attachment_history_import','workspace',null,{versions:plan.newVersions,mappings:plan.pending.length,sourceKey:history.sourceKey});
      return {...summary,newVersions:plan.newVersions,newMappings:plan.pending.length,alreadyImported:plan.duplicates,backup};
    });
  } finally {db.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options={};const args=process.argv.slice(2);
    for(let i=0;i<args.length;i++) {
      if(args[i]==='--source-files')options.sourceFiles=args[++i];else if(args[i]==='--database')options.database=args[++i];else if(args[i]==='--backup')options.backupPath=args[++i];else if(args[i]==='--apply')options.apply=true;else if(args[i]==='--dry-run')options.apply=false;else fail('用法：node backend/scripts/import-attachment-history.mjs --source-files 原附件目录 --database 目标数据库 [--apply] [--backup 新备份路径]');
    }
    process.stdout.write(JSON.stringify(await importAttachmentHistory(options))+'\n');
  } catch(error) {process.stderr.write(error.message+'\n');process.exitCode=1;}
}
