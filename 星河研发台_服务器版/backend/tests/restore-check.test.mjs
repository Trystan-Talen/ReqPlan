import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../database.mjs';
import {backupDatabase} from '../scripts/backup.mjs';
import {checkRestore} from '../scripts/restore-check.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-restore-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.sqlite'),snapshot=path.join(dir,'snapshot.sqlite');
  const db=openDatabase(source);
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('p-isolated','{"name":"隔离测试项目"}');
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run('r-isolated','p-isolated','{"title":"测试需求"}');
  db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data) VALUES(?,?,?,?)').run('t-isolated','p-isolated','r-isolated','{"title":"测试任务"}');
  db.prepare('INSERT INTO attachments(id,requirement_id,project_id,name,mime,content) VALUES(?,?,?,?,?,?)').run('a-isolated','r-isolated','p-isolated','测试附件','text/plain',Buffer.from('隔离附件正文'));
  db.close();return{dir,source,snapshot};
}
test('恢复演练核对结构与全部表数量，可启动写入后回滚，原数据库与备份字节不变',async t=>{
  const f=fixture(t);await backupDatabase(f.source,f.snapshot);
  const liveBefore=fs.readFileSync(f.source),snapshotBefore=fs.readFileSync(f.snapshot),filesBefore=fs.readdirSync(f.dir).sort();
  const result=await checkRestore(f.snapshot,{temporaryRoot:f.dir});
  assert.equal(result.ok,true);for(const table of ['projects','requirements','tasks','attachments'])assert.equal(result.counts[table],1);
  assert.equal(result.counts.users,0);assert.deepEqual(fs.readFileSync(f.source),liveBefore);assert.deepEqual(fs.readFileSync(f.snapshot),snapshotBefore);
  assert.deepEqual(fs.readdirSync(f.dir).sort(),filesBefore);
  assert.doesNotMatch(JSON.stringify(result),/隔离附件正文|测试需求/);
});
test('不兼容版本、缺失业务表和损坏文件均拒绝，失败后清理演练副本',async t=>{
  const f=fixture(t);await backupDatabase(f.source,f.snapshot);
  let db=new DatabaseSync(f.snapshot);db.exec('PRAGMA user_version=999');db.close();
  await assert.rejects(checkRestore(f.snapshot,{temporaryRoot:f.dir}),/更新的软件版本|不受支持/);
  db=new DatabaseSync(f.snapshot);db.exec('PRAGMA foreign_keys=OFF;PRAGMA user_version=1;DROP TABLE attachments');db.close();
  await assert.rejects(checkRestore(f.snapshot,{temporaryRoot:f.dir}),/缺少必要的数据表/);
  fs.writeFileSync(f.snapshot,'损坏的备份');await assert.rejects(checkRestore(f.snapshot,{temporaryRoot:f.dir}));
  assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('xinghe-restore-check-')),false);
});
test('不存在的输入不会创建新库，也不触碰现有项目',async t=>{
  const f=fixture(t),missing=path.join(f.dir,'missing.sqlite'),before=fs.readFileSync(f.source);
  await assert.rejects(checkRestore(missing,{temporaryRoot:f.dir}),/存在的备份文件/);
  assert.equal(fs.existsSync(missing),false);assert.deepEqual(fs.readFileSync(f.source),before);
});

test('仅有相同表名和数据数量但缺少字段及外键约束的副本不能通过恢复演练',async t=>{
  const f=fixture(t);await backupDatabase(f.source,f.snapshot);
  const db=new DatabaseSync(f.snapshot);db.exec('PRAGMA foreign_keys=OFF;ALTER TABLE tasks RENAME TO old_tasks;CREATE TABLE tasks AS SELECT * FROM old_tasks;');db.close();
  await assert.rejects(checkRestore(f.snapshot,{temporaryRoot:f.dir}),/约束不匹配|结构不匹配/);
  assert.equal(fs.readdirSync(f.dir).some(name=>name.startsWith('xinghe-restore-check-')),false);
});

test('支持第一版备份在隔离副本升级新增附件补录表，原备份不改写',async t=>{
  const f=fixture(t);await backupDatabase(f.source,f.snapshot);
  const db=new DatabaseSync(f.snapshot);db.exec('DROP TABLE attachment_imports;PRAGMA user_version=1;');db.close();
  const original=fs.readFileSync(f.snapshot);
  const result=await checkRestore(f.snapshot,{temporaryRoot:f.dir});
  assert.equal(result.schemaVersion,3);assert.equal(result.counts.attachment_imports,0);assert.equal(result.counts.attachments,1);
  assert.deepEqual(fs.readFileSync(f.snapshot),original);
});
