import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../database.mjs';
import {backupDatabase} from '../scripts/backup.mjs';
import {importSnapshot} from '../scripts/import-snapshot.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-import-snapshot-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const source=path.join(dir,'source.sqlite'),snapshot=path.join(dir,'snapshot.sqlite');
  const db=openDatabase(source);
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('p-real','{"name":"真实项目"}');
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run('r-real','p-real','{"title":"真实需求"}');
  db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data) VALUES(?,?,?,?)').run('t-real','p-real','r-real','{"title":"真实任务"}');
  db.close();return{dir,source,snapshot,target:path.join(dir,'server','data','xinghe.sqlite')};
}
test('快照导入全新位置后保留原编号与数量，可被服务正常打开',async t=>{
  const f=fixture(t);await backupDatabase(f.source,f.snapshot);
  const result=await importSnapshot(f.snapshot,f.target,{temporaryRoot:f.dir});
  assert.equal(result.counts.projects,1);assert.equal(result.counts.requirements,1);assert.equal(result.counts.tasks,1);
  const db=openDatabase(f.target);
  try{assert.equal(db.prepare('SELECT id FROM tasks').get().id,'t-real');}finally{db.close();}
  assert.equal(fs.statSync(f.target).mode&0o777,0o600);
});
test('目标已有数据库或日志文件时拒绝导入，且不改动已有文件',async t=>{
  const f=fixture(t);await backupDatabase(f.source,f.snapshot);
  fs.mkdirSync(path.dirname(f.target),{recursive:true});
  openDatabase(f.target).close();const before=fs.readFileSync(f.target);
  await assert.rejects(importSnapshot(f.snapshot,f.target,{temporaryRoot:f.dir}),/已存在数据库文件/);
  assert.deepEqual(fs.readFileSync(f.target),before);
  fs.rmSync(f.target);fs.writeFileSync(f.target+'-wal','');
  await assert.rejects(importSnapshot(f.snapshot,f.target,{temporaryRoot:f.dir}),/xinghe\.sqlite-wal/);
  assert.equal(fs.existsSync(f.target),false);
});
test('缺失快照或同一路径时拒绝',async t=>{
  const f=fixture(t);
  await assert.rejects(importSnapshot(path.join(f.dir,'missing.sqlite'),f.target),/存在的快照/);
  await assert.rejects(importSnapshot(f.source,f.source),/同一文件/);
});
