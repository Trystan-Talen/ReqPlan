import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareLegacy } from '../scripts/prepare-legacy.mjs';
import { importLegacy } from '../scripts/import-legacy.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'xinghe-prepare-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=join(root,'project/data/db.json');const output=join(root,'prepared/legacy.json');mkdirSync(dirname(source),{recursive:true});
  const raw={projects:[{id:'p-real',name:'原项目',ownerId:'u-original',extra:'完整保留'}],requirements:[{id:'r-real',projectId:'p-real',title:'原需求',ownerId:'u-original',planStart:'2026-09-05',baseline:{startDate:'2026-08-17',dueDate:'2026-08-25'}}],tasks:[{id:'t-real',projectId:'p-real',requirementId:'r-real',title:'原任务',ownerId:'u-original',status:'已完成',estimateHours:8}],users:[{id:'u-original',username:'original',name:'原用户',role:'项目管理',title:'业务负责人',active:true,password:'never-copy-password'}],settings:{aiModel:'example-model',aiBaseUrl:'https://example.invalid/v1',aiApiKey:'never-copy-secret-key'},history:[{id:'h-1',detail:{password:'never-copy-password',token:'never-copy-token',key:'never-copy-key',apiKeyValue:'never-copy-alternate-credential',action:'正常操作'},text:'never-copy-password'}]};
  writeFileSync(source,JSON.stringify(raw));const file=join(dirname(source),'files/r-real/doc/原文.md');mkdirSync(dirname(file),{recursive:true});const content=Buffer.from('\ufeff# 原始文档\r\n保留空格  \r\n');writeFileSync(file,content);
  mkdirSync(join(dirname(source),'files/.git'));writeFileSync(join(dirname(source),'files/.git/secret'),'技术文件不进入快照');
  return {root,source,output,raw,file,content};
}
test('准备快照剔除秘密，原业务字段及附件字节保留，源文件不变且能预检导入',t=>{
  const f=fixture(t);const before=readFileSync(f.source);const result=prepareLegacy(f);assert.equal(result.attachments,1);
  const encoded=readFileSync(f.output,'utf8');const prepared=JSON.parse(encoded);
  assert.doesNotMatch(encoded,/never-copy|password|aiApiKey|"token"|"key"/);
  for(const key of ['projects','requirements','tasks'])assert.deepEqual(prepared[key],f.raw[key]);
  assert.deepEqual(prepared.users[0],{id:'u-original',username:'original',name:'原用户',role:'项目管理',title:'业务负责人',active:true});
  assert.deepEqual(readFileSync(join(dirname(f.output),prepared.attachments[0].file)),f.content);
  assert.deepEqual(readFileSync(f.source),before);assert.deepEqual(readFileSync(f.file),f.content);
  assert.equal(importLegacy(null,f.output,{dryRun:true}).tasks,1);
});
test('拒绝覆盖既有目录或输出文件，预检不创建输出目录',t=>{
  const f=fixture(t);assert.equal(prepareLegacy({...f,dryRun:true}).dryRun,true);assert(!existsSync(dirname(f.output)));
  prepareLegacy(f);const before=readFileSync(f.output);assert.throws(()=>prepareLegacy(f),/拒绝覆盖/);assert.deepEqual(readFileSync(f.output),before);
});
test('外部符号链接、未知需求关联和超限附件均拒绝且不留下输出',t=>{
  const f=fixture(t);const external=join(f.root,'external.md');writeFileSync(external,'外部文件');const link=join(dirname(f.file),'link.md');symlinkSync(external,link);
  assert.throws(()=>prepareLegacy(f),/外部路径/);assert(!existsSync(dirname(f.output)));rmSync(link);
  const unknown=join(dirname(f.source),'files/r-unknown/doc');mkdirSync(unknown,{recursive:true});writeFileSync(join(unknown,'x.txt'),'未知关联');assert.throws(()=>prepareLegacy(f),/未知需求/);rmSync(join(dirname(f.source),'files/r-unknown'),{recursive:true});
  writeFileSync(f.file,Buffer.alloc(2*1024*1024+1,65));assert.throws(()=>prepareLegacy(f),/2 兆字节/);assert(!existsSync(dirname(f.output)));
});
test('模型地址中的凭证移除，业务正文引用真实秘密时拒绝且保留源文件',t=>{
  const f=fixture(t);f.raw.settings.aiBaseUrl='https://person:private-value@example.invalid/v1?api_key=private-token';writeFileSync(f.source,JSON.stringify(f.raw));
  prepareLegacy(f);const prepared=JSON.parse(readFileSync(f.output,'utf8'));assert.equal(prepared.settings.aiBaseUrl,'https://example.invalid/v1');
  rmSync(dirname(f.output),{recursive:true});f.raw.requirements[0].description='误粘贴 never-copy-secret-key';writeFileSync(f.source,JSON.stringify(f.raw));const before=readFileSync(f.source);assert.throws(()=>prepareLegacy(f),/原始凭证值/);assert.deepEqual(readFileSync(f.source),before);
});
