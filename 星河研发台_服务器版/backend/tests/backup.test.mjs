import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {backupDatabase} from '../scripts/backup.mjs';

test('备份包含尚在预写日志中的已提交数据，且拒绝覆盖',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-backup-'));
  const source=path.join(dir,'source.sqlite'),destination=path.join(dir,'backup.sqlite');
  const db=new DatabaseSync(source);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE evidence(id TEXT); INSERT INTO evidence VALUES (\'真实记录\');');
  try {
    await backupDatabase(source,destination);
    const copy=new DatabaseSync(destination);assert.equal(copy.prepare('SELECT id FROM evidence').get().id,'真实记录');copy.close();
    await assert.rejects(backupDatabase(source,destination),/已存在/);
    assert.equal(fs.statSync(destination).mode & 0o777,0o600);
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('两个并发备份争用同一路径时只发布一份完整快照，不覆盖胜出的文件',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-backup-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.sqlite'),destination=path.join(dir,'race.sqlite');
  const db=new DatabaseSync(source);db.exec("CREATE TABLE evidence(id TEXT);INSERT INTO evidence VALUES('隔离测试');");db.close();
  const results=await Promise.allSettled([backupDatabase(source,destination),backupDatabase(source,destination)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.filter(result=>result.status==='rejected').length,1);
  const check=new DatabaseSync(destination,{readOnly:true});assert.equal(check.prepare('SELECT count(*) AS n FROM evidence').get().n,1);check.close();
  assert.equal(fs.readdirSync(dir).some(file=>file.startsWith('.xinghe-backup-')),false);
});

test('损坏或外键断裂的数据库不会发布备份，也不会留下临时快照',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-backup-invalid-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'invalid.sqlite'),destination=path.join(dir,'never.sqlite');
  const db=new DatabaseSync(source);db.exec('PRAGMA foreign_keys=OFF;CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER REFERENCES parent(id));INSERT INTO child VALUES(99)');db.close();
  await assert.rejects(backupDatabase(source,destination),/关联完整性/);
  assert.equal(fs.existsSync(destination),false);
  fs.writeFileSync(source,'这不是数据库');await assert.rejects(backupDatabase(source,destination));
  assert.equal(fs.existsSync(destination),false);assert.deepEqual(fs.readdirSync(dir),['invalid.sqlite']);
});
