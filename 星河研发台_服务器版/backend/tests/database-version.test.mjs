import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../database.mjs';
import {DatabaseSync} from 'node:sqlite';

test('数据库结构版本持久保存，拒绝降级打开未来版本',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-schema-'));
  const file=path.join(dir,'data.sqlite');
  try{
    let db=openDatabase(file);assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);db.close();
    db=openDatabase(file);db.exec('PRAGMA user_version=5');db.close();
    assert.throws(()=>openDatabase(file),/不能降级/);
    const future=new DatabaseSync(file,{readOnly:true});assert.equal(future.prepare('PRAGMA user_version').get().user_version,5);future.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('第一版附件安全升级，同名同类型成链且旧地址字节不变',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-migrate-'));const file=path.join(dir,'data.sqlite');
  try{
    const old=new DatabaseSync(file);
    old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,name TEXT,role TEXT,status TEXT,password_hash TEXT,must_change_password INTEGER,auth_version INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT,version INTEGER,archived INTEGER,created_at TEXT,updated_at TEXT);
      CREATE TABLE requirements(id TEXT PRIMARY KEY,project_id TEXT,data TEXT,version INTEGER,archived INTEGER,created_at TEXT,updated_at TEXT,UNIQUE(id,project_id));
      CREATE TABLE attachments(id TEXT PRIMARY KEY,requirement_id TEXT,project_id TEXT,name TEXT,mime TEXT,content BLOB,version INTEGER,created_at TEXT,created_by TEXT);
      INSERT INTO projects VALUES('p','{}',1,0,'','');INSERT INTO requirements VALUES('r','p','{}',1,0,'','');
      PRAGMA user_version=1;`);
    const insert=old.prepare('INSERT INTO attachments VALUES(?,?,?,?,?,?,1,?,NULL)');
    insert.run('first','r','p','设计.md','text/markdown',Buffer.from('第一版'),'2026-01-01');
    insert.run('second','r','p','设计.md','text/markdown',Buffer.from('第二版'),'2026-01-02');
    insert.run('proto','r','p','设计.md','text/html',Buffer.from('原型'),'2026-01-03');old.close();
    let db=openDatabase(file);
    const rows=db.prepare('SELECT * FROM attachments ORDER BY created_at').all();
    assert.deepEqual(rows.map(x=>[x.id,x.logical_id,x.version,Buffer.from(x.content).toString()]),[['first','first',1,'第一版'],['second','first',2,'第二版'],['proto','proto',1,'原型']]);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);db.close();
    db=openDatabase(file);assert.equal(db.prepare("SELECT version FROM attachments WHERE id='second'").get().version,2);db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
