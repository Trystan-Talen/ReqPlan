import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
import {fileURLToPath} from 'node:url';

export function verifyDatabase(db) {
  if(db.prepare('PRAGMA integrity_check').all().some(row=>row.integrity_check!=='ok')) throw Object.assign(new Error('数据库完整性检查未通过。'),{code:'BACKUP_INTEGRITY_FAILED'});
  if(db.prepare('PRAGMA foreign_key_check').all().length) throw Object.assign(new Error('数据库关联完整性检查未通过。'),{code:'BACKUP_FOREIGN_KEYS_FAILED'});
}

export async function backupDatabase(source,destination) {
  if(!fs.existsSync(source)) throw Object.assign(new Error('数据库不存在。'),{code:'BACKUP_SOURCE_MISSING'});
  if(path.resolve(source)===path.resolve(destination)||fs.existsSync(destination)) throw new Error('目标文件已存在，请使用新的备份路径。');
  fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
  // Publish only a verified copy. A hard link atomically rejects an existing target,
  // including files created by another process after the initial path check.
  const temporary=fs.mkdtempSync(path.join(path.dirname(destination),'.xinghe-backup-'));
  const temporaryFile=path.join(temporary,'snapshot.sqlite');
  let db;
  try {
    db=new DatabaseSync(source,{readOnly:true,timeout:5000});
    if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok') throw new Error('源数据库完整性检查未通过。');
    await backup(db,temporaryFile);
    fs.chmodSync(temporaryFile,0o600);
    const check=new DatabaseSync(temporaryFile,{timeout:5000});
    try {
      // The online snapshot inherits the source journal mode. Convert only the
      // private copy to a standalone file before publication, so inspecting it
      // later never needs to create WAL/SHM sidecars beside a retained backup.
      check.exec('PRAGMA journal_mode=DELETE');
      verifyDatabase(check);
    }finally{check.close();}
    const handle=fs.openSync(temporaryFile,'r');
    try{fs.fsyncSync(handle);}finally{fs.closeSync(handle);}
    try{fs.linkSync(temporaryFile,destination);}catch(error){
      if(error.code==='EEXIST')throw Object.assign(new Error('目标文件已存在，请使用新的备份路径。'),{code:'EEXIST'});
      throw error;
    }
    return {destination,bytes:fs.statSync(destination).size};
  } finally {db?.close();fs.rmSync(temporary,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const source=process.env.DATABASE_PATH||path.resolve('backend/var/xinghe.sqlite');
  const target=process.argv[2]||path.join(path.dirname(source),'backups',`xinghe-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
  try {const result=await backupDatabase(source,path.resolve(target));console.info(`备份已完成且通过完整性检查：${result.destination}（${result.bytes} 字节）`);}catch(error){console.error(error.message);process.exitCode=1;}
}
