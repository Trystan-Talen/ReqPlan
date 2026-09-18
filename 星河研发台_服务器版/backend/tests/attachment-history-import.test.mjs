import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../database.mjs';
import {createAttachmentService} from '../attachments.mjs';
import {importAttachmentHistory} from '../scripts/import-attachment-history.mjs';

function fixture(t,{repoAtData=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-file-history-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const data=path.join(root,'source','data');const files=path.join(data,'files');fs.mkdirSync(path.join(files,'r','doc'),{recursive:true});
  const repo=repoAtData?data:files;
  const git=(...args)=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git('init','-q');git('config','user.name','历史作者');git('config','user.email','fixture@example.invalid');
  let commits=0;
  const commit=(relative,content)=>{
    const file=path.join(files,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);git('add','--',path.relative(repo,file));
    git('commit','-q','-m',`历史 ${++commits}`);return git('rev-parse','HEAD').trim();
  };
  const database=path.join(root,'destination','data.sqlite');const db=openDatabase(database);
  db.exec(`INSERT INTO users(id,username,name,role,status,must_change_password) VALUES('writer','writer','现作者','admin','active',0);
    INSERT INTO projects(id,data) VALUES('p','{}');INSERT INTO requirements(id,project_id,data) VALUES('r','p','{}');`);db.close();
  const service=db=>createAttachmentService(db,{authorizeRead:()=>{},authorizeWrite:()=>({user:{id:'writer'}}),audit:()=>{}});
  return {root,data,files,repo,database,git,commit,service};
}

test('历史试运行不写库，备份后补录保留现版本并支持幂等和旧字节访问',async t=>{
  const f=fixture(t);const firstCommit=f.commit('r/doc/设计.md','历史一');f.commit('r/doc/设计.md','历史二');
  f.commit('missing/doc/无对应需求.md','忽略');f.commit('r/proto/原型.html','<h1>原型</h1>');
  let db=openDatabase(f.database);const current=f.service(db).uploadAttachment({id:'writer'},'r',{name:'设计.md',mime:'text/markdown',contentBuffer:Buffer.from('当前编辑')});db.close();
  const before=fs.readFileSync(f.database);const options={sourceFiles:f.files,database:f.database};
  const dry=await importAttachmentHistory(options);assert.equal(dry.dryRun,true);assert.equal(dry.newVersions,3);assert.equal(dry.unmatchedRequirements,1);
  assert.deepEqual(fs.readFileSync(f.database),before);assert.equal(fs.existsSync(path.join(path.dirname(f.database),'backups')),false);
  const result=await importAttachmentHistory({...options,apply:true});assert.equal(result.newVersions,3);assert(fs.existsSync(result.backup));
  const backup=new DatabaseSync(result.backup,{readOnly:true});assert.equal(backup.prepare('SELECT count(*) n FROM attachments').get().n,1);backup.close();
  db=openDatabase(f.database);const service=f.service(db);const list=service.listAttachments({id:'writer'},'r');
  assert.equal(list.length,2);assert.equal(list.find(x=>x.name==='设计.md').id,current.id);assert.equal(list.find(x=>x.name==='设计.md').version,1);
  const history=service.listAttachmentVersions({id:'writer'},current.id);assert.equal(history.length,3);
  const original=history.find(x=>x.source.commit===firstCommit);assert.equal(original.source.author,'历史作者');assert.equal(original.historical,true);
  assert.equal(service.getAttachment({id:'writer'},original.id).contentBuffer.toString(),'历史一');
  assert.equal(service.getAttachment({id:'writer'},current.id).contentBuffer.toString(),'当前编辑');
  const next=service.uploadAttachment({id:'writer'},'r',{name:'设计.md',mime:'text/markdown',contentBuffer:Buffer.from('下一版'),expectedVersion:current.version});assert.equal(next.version,4);db.close();
  const again=await importAttachmentHistory({...options,apply:true});assert.equal(again.newVersions,0);assert.equal(again.newMappings,0);assert(again.alreadyImported>=3);assert.equal(again.backup,undefined);
});

test('父目录版本库限定只读 files（附件目录），相同内容去重但保留提交元信息',async t=>{
  const f=fixture(t,{repoAtData:true});f.commit('r/doc/设计.md','重复内容');f.commit('r/doc/设计.md','另一内容');f.commit('r/doc/设计.md','重复内容');
  fs.writeFileSync(path.join(f.data,'settings.txt'),'该正文不属于附件');f.git('add','settings.txt');f.git('commit','-q','-m','无关变化');
  const result=await importAttachmentHistory({sourceFiles:f.files,database:f.database,apply:true});assert.equal(result.newVersions,2);assert.equal(result.newMappings,3);
  const db=openDatabase(f.database);const service=f.service(db);const list=service.listAttachments({id:'writer'},'r');assert.equal(list.length,1);assert.equal(list[0].versions.length,2);
  assert.equal(service.getAttachment({id:'writer'},list[0].id).contentBuffer.toString(),'重复内容');assert.equal(list[0].source.commits.length,2);db.close();
});

test('拒绝凭证和符号链接历史，未知需求仅统计而不导出内容',async t=>{
  const f=fixture(t);const secret='synthetic_sensitive_value_12345';
  fs.writeFileSync(path.join(f.data,'db.json'),JSON.stringify({settings:{apiKey:secret},users:[]}));f.commit('r/doc/设计.md',`正文 ${secret}`);
  const before=fs.readFileSync(f.database);
  await assert.rejects(importAttachmentHistory({sourceFiles:f.files,database:f.database,apply:true}),e=>/凭证/.test(e.message)&&!e.message.includes(secret));
  assert.deepEqual(fs.readFileSync(f.database),before);
  const s=fixture(t);fs.symlinkSync('/etc/passwd',path.join(s.files,'r','doc','链接.md'));s.git('add','.');s.git('commit','-q','-m','符号链接');
  await assert.rejects(importAttachmentHistory({sourceFiles:s.files,database:s.database}),/符号链接/);
});

test('导入失败全部回滚，源版本库和备份均保留',async t=>{
  const f=fixture(t);f.commit('r/doc/设计.md','历史一');f.commit('r/doc/设计.md','历史二');
  let db=openDatabase(f.database);db.exec("CREATE TRIGGER fail_second_import BEFORE INSERT ON attachment_imports WHEN (SELECT count(*) FROM attachment_imports)>0 BEGIN SELECT RAISE(ABORT,'fixture_failure'); END;");db.close();
  await assert.rejects(importAttachmentHistory({sourceFiles:f.files,database:f.database,apply:true}),/fixture_failure/);
  db=openDatabase(f.database);assert.equal(db.prepare('SELECT count(*) n FROM attachments').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM attachment_imports').get().n,0);db.close();
  assert.equal(f.git('status','--porcelain').trim(),'');assert.equal(fs.readdirSync(path.join(path.dirname(f.database),'backups')).length,1);
});
