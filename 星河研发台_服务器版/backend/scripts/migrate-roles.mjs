import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openDatabase,planRoleMigration,ROLE_MIGRATION_KEY,SCHEMA_VERSION} from '../database.mjs';
import {backupDatabase} from './backup.mjs';

const HERE=path.dirname(fileURLToPath(import.meta.url));
const LABELS={manager:'项目经理（旧）',product:'产品经理',lead:'主开发',developer:'开发',tester:'测试',viewer:'观察者'};
const BUSINESS_TABLES=['projects','requirements','tasks','attachments','users'];

function readPlan(file) {
  let plan;
  try{plan=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new Error(`无法读取迁移计划：${file}`);}
  if(!plan||typeof plan!=='object'||!Array.isArray(plan.memberships))throw new Error('迁移计划缺少 memberships 列表。');
  return {executives:Array.isArray(plan.executives)?plan.executives:[],memberships:plan.memberships.map(({projectId,userId,role})=>({projectId,userId,role}))};
}
const counts=db=>Object.fromEntries(BUSINESS_TABLES.map(table=>[table,db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));

// Preview never writes. Apply takes a verified backup first, stores the plan and lets
// the normal database opening path perform the upgrade inside one transaction.
export async function migrateRoles({database,planFile,apply=false,backupDirectory,now=new Date()}) {
  if(!fs.existsSync(database))throw new Error('数据库不存在。');
  const plan=readPlan(planFile);
  const inspect=new DatabaseSync(database,{readOnly:true});
  let preview,before,version;
  try{
    version=inspect.prepare('PRAGMA user_version').get().user_version;
    if(version>SCHEMA_VERSION)throw new Error('数据库来自更新的软件版本，拒绝操作。');
    preview=planRoleMigration(inspect,plan);before=counts(inspect);
  }finally{inspect.close();}
  if(version>=SCHEMA_VERSION)return{alreadyMigrated:true,version};
  const ready=!preview.errors.length&&!preview.unmapped.length;
  if(!apply||!ready)return{alreadyMigrated:false,applied:false,ready,version,preview,counts:before};
  const stamp=now.toISOString().replace(/[:.]/g,'-');
  const backup=await backupDatabase(database,path.join(backupDirectory||path.join(path.dirname(database),'backups'),`before-role-migration-${stamp}.sqlite`));
  const writer=new DatabaseSync(database,{timeout:5000});
  try{writer.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(ROLE_MIGRATION_KEY,JSON.stringify(plan));}
  finally{writer.close();}
  const db=openDatabase(database);
  try{
    const after=counts(db);
    if(JSON.stringify(after)!==JSON.stringify(before))throw new Error(`迁移后业务数据数量不一致，请用备份恢复：${backup.destination}`);
    const roles=db.prepare('SELECT role,COUNT(*) AS n FROM memberships GROUP BY role').all();
    return{alreadyMigrated:false,applied:true,ready,version:db.prepare('PRAGMA user_version').get().user_version,preview,counts:after,roles,backup:backup.destination};
  }finally{db.close();}
}

function report(result) {
  if(result.alreadyMigrated)return`数据库已是第 ${result.version} 版，无需迁移。`;
  const {preview}=result,lines=[];
  lines.push(result.applied?'角色迁移已完成。':'角色迁移预检（未写入任何数据）');
  lines.push('','角色变更：');
  for(const item of preview.changes)lines.push(`  ${item.projectName} · ${item.userName}：${LABELS[item.from]||item.from} → ${LABELS[item.to]||item.to}`);
  if(!preview.changes.length)lines.push('  无');
  lines.push(`保持不变的成员角色：${preview.unchanged} 条`);
  lines.push(`增加管理层身份：${preview.executives.map(item=>item.userName).join('、')||'无'}`);
  if(preview.unmapped.length){lines.push('','以下「项目经理」尚未指定新角色，迁移不会执行：');for(const item of preview.unmapped)lines.push(`  ${item.projectName} · ${item.userName}`);}
  if(preview.errors.length){lines.push('','计划中的问题：');for(const message of preview.errors)lines.push(`  ${message}`);}
  lines.push('',`业务数据数量：${Object.entries(result.counts).map(([key,value])=>`${key} ${value}`).join('，')}`);
  if(result.applied)lines.push(`迁移前备份：${result.backup}`,'迁移后数量与迁移前一致。');
  else if(result.ready)lines.push('','预检通过。停止服务后加上 --apply 执行迁移。');
  return lines.join('\n');
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const option=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
  try{
    const database=path.resolve(option('--db')||process.env.DATABASE_PATH||path.join(HERE,'..','var','xinghe.sqlite'));
    const planFile=path.resolve(option('--plan')||path.join(HERE,'..','migrations','role-migration-2026-09.json'));
    const result=await migrateRoles({database,planFile,apply:args.includes('--apply'),backupDirectory:option('--backup-dir')&&path.resolve(option('--backup-dir'))});
    console.info(report(result));
    if(!result.alreadyMigrated&&!result.ready)process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
