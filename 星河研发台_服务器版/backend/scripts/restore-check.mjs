import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../database.mjs';
import {backupDatabase,verifyDatabase} from './backup.mjs';

const quote=value=>'"'+value.replaceAll('"','""')+'"';
function schema(db) {
  return db.prepare("SELECT name,type,tbl_name,sql FROM sqlite_schema WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%'").all();
}
const sorted=value=>JSON.stringify(value.map(item=>JSON.stringify(item)).sort());
const columns=(db,table)=>db.prepare(`PRAGMA table_info(${quote(table)})`).all().map(({name,type,notnull,pk})=>({name,type,notnull,pk}));
const foreignKeys=(db,table)=>db.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all().map(({seq,table:target,from,to,on_update,on_delete,match})=>({seq,target,from,to,on_update,on_delete,match}));
const normalizeSql=value=>String(value).replace(/\s+/g,' ').trim().toLowerCase();
const tableIntroducedIn={attachment_imports:2};

// This is a recovery rehearsal, never a replacement of the running database. Both
// migration probes and write checks run exclusively inside an isolated temp dir.
export async function checkRestore(source,{temporaryRoot=os.tmpdir()}={}) {
  if(typeof source!=='string'||!source||!fs.existsSync(source))throw new Error('请指定一份存在的备份文件。');
  const temporary=fs.mkdtempSync(path.join(temporaryRoot,'xinghe-restore-check-'));
  const restored=path.join(temporary,'restored.sqlite');
  let db,expected;
  try{
    await backupDatabase(source,restored);
    db=new DatabaseSync(restored,{readOnly:true});verifyDatabase(db);
    const beforeVersion=db.prepare('PRAGMA user_version').get().user_version;
    const countsBefore={};
    for(const item of schema(db).filter(item=>item.type==='table'))countsBefore[item.name]=db.prepare(`SELECT COUNT(*) AS total FROM ${quote(item.name)}`).get().total;
    db.close();db=null;
    // Exercise the same opening/migration path used by the service, on the copy.
    db=openDatabase(restored);expected=openDatabase(':memory:');
    const expectedVersion=expected.prepare('PRAGMA user_version').get().user_version;
    if(beforeVersion<1||beforeVersion>expectedVersion)throw new Error('备份数据库版本不受支持。');
    const actual=new Map(schema(db).map(item=>[`${item.type}:${item.name}`,item]));
    const counts={};
    for(const item of schema(expected)){
      const structure=actual.get(`${item.type}:${item.name}`);
      if(!structure||structure.tbl_name!==item.tbl_name)throw new Error('恢复副本缺少必要的数据库结构。');
      if(item.type!=='table'&&normalizeSql(structure.sql)!==normalizeSql(item.sql))throw new Error('恢复副本的索引或触发器结构不匹配。');
      if(item.type!=='table')continue;
      const introducedByUpgrade=!(item.name in countsBefore)&&beforeVersion<(tableIntroducedIn[item.name]||0);
      if(!(item.name in countsBefore)&&!introducedByUpgrade)throw new Error('备份缺少必要的数据表，不能判定为可恢复。');
      const requiredColumns=columns(expected,item.name),actualColumns=columns(db,item.name);
      const matchingColumns=actualColumns.filter(column=>requiredColumns.some(required=>required.name===column.name));
      if(sorted(requiredColumns)!==sorted(matchingColumns))throw new Error('恢复副本的字段类型或约束不匹配。');
      if(sorted(foreignKeys(expected,item.name))!==sorted(foreignKeys(db,item.name)))throw new Error('恢复副本的外键结构不匹配。');
      const strict=db.prepare('PRAGMA table_list').all().find(table=>table.name===item.name)?.strict;
      if(strict!==expected.prepare('PRAGMA table_list').all().find(table=>table.name===item.name)?.strict)throw new Error('恢复副本的严格类型约束不匹配。');
      counts[item.name]=db.prepare(`SELECT COUNT(*) AS total FROM ${quote(item.name)}`).get().total;
      // Upgrading an older backup to version 3 records the role migration in one audit entry.
      const upgradeAudit=item.name==='audit'&&beforeVersion<3?1:0;
      if(counts[item.name]<(introducedByUpgrade?0:countsBefore[item.name])||counts[item.name]>(introducedByUpgrade?0:countsBefore[item.name])+upgradeAudit)throw new Error('恢复前后数据数量不一致。');
    }
    verifyDatabase(db);
    db.exec('BEGIN IMMEDIATE');
    try{db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(`restore-check-${Date.now()}`,'isolated');}
    finally{db.exec('ROLLBACK');}
    return{ok:true,schemaVersion:expectedVersion,counts,bytes:fs.statSync(restored).size};
  }finally{expected?.close();db?.close();fs.rmSync(temporary,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(!process.argv[2])throw new Error('用法：node backend/scripts/restore-check.mjs <备份文件路径>。');
    const result=await checkRestore(path.resolve(process.argv[2]));
    console.info('恢复演练通过：完整性、外键、结构及数据数量均已核验，原数据库未被替换。');
    console.info(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
