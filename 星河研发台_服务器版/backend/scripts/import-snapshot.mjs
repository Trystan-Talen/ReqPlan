import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openDatabase} from '../database.mjs';
import {backupDatabase} from './backup.mjs';
import {checkRestore} from './restore-check.mjs';

// Moves a verified snapshot (from `npm run backup`) into a server's empty data
// location. It never replaces an existing database: the target and its WAL/SHM
// sidecars must be absent, so a running or previously initialised instance is
// left untouched.
export async function importSnapshot(snapshot,target,{temporaryRoot}={}) {
  if(typeof snapshot!=='string'||!snapshot||!fs.existsSync(snapshot))throw new Error('请指定一份存在的快照文件。');
  if(typeof target!=='string'||!target||target===':memory:')throw new Error('请指定目标数据库路径。');
  snapshot=path.resolve(snapshot);target=path.resolve(target);
  if(snapshot===target)throw new Error('快照与目标数据库不能是同一文件。');
  for(const file of [target,target+'-wal',target+'-shm'])
    if(fs.existsSync(file))throw new Error(`目标位置已存在数据库文件（${path.basename(file)}），为避免覆盖现有数据已停止。请确认目标是全新的空数据卷。`);
  // Rehearse the full opening/migration path on an isolated copy first.
  const rehearsal=await checkRestore(snapshot,temporaryRoot?{temporaryRoot}:{});
  await backupDatabase(snapshot,target);
  const db=openDatabase(target);
  try{
    const count=table=>db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
    const counts={users:count('users'),projects:count('projects'),requirements:count('requirements'),tasks:count('tasks'),attachments:count('attachments'),documentVersions:count('document_versions'),proposals:count('proposals')};
    for(const [key,value] of Object.entries(counts)){
      const expected=rehearsal.counts[{documentVersions:'document_versions'}[key]||key];
      if(expected!==undefined&&value!==expected)throw new Error('导入后数据数量与快照不一致，请保留快照并联系维护人员。');
    }
    return {target,schemaVersion:db.prepare('PRAGMA user_version').get().user_version,counts};
  }finally{db.close();}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(!process.argv[2])throw new Error('用法：node backend/scripts/import-snapshot.mjs <快照文件> [目标数据库路径，默认 DATABASE_PATH]。');
    const target=process.argv[3]||process.env.DATABASE_PATH;
    if(!target)throw new Error('请指定目标数据库路径，或设置 DATABASE_PATH。');
    const result=await importSnapshot(process.argv[2],target);
    console.info('快照已导入并通过完整性、结构与数量核对：');
    console.info(JSON.stringify(result,null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
