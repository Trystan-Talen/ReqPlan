import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startBackupService,backupConfiguration} from '../scripts/backup-service.mjs';
import {backupDatabase} from '../scripts/backup.mjs';

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinghe-schedule-test-'));
  const source=path.join(dir,'source.sqlite'),directory=path.join(dir,'backups'),secondary=path.join(dir,'secondary');
  const db=new DatabaseSync(source);db.exec("PRAGMA journal_mode=WAL;CREATE TABLE evidence(value TEXT);INSERT INTO evidence VALUES('仅测试');");
  const logs=[],timers=new Set();let time=Date.now();
  const options={source,env:{BACKUP_DIRECTORY:directory},now:()=>time,
    logger:{info:value=>logs.push(value),error:value=>logs.push(value)},
    setTimer(callback,delay){const timer={callback,delay,unref(){}};timers.add(timer);return timer;},clearTimer(timer){timers.delete(timer);}};
  const services=[];
  const service=overrides=>{const instance=startBackupService({...options,...overrides});services.push(instance);return instance;};
  t.after(async()=>{for(const instance of services)await instance.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});});
  return{dir,source,directory,secondary,db,logs,timers,options,service,advance(ms){time+=ms;},time:()=>time};
}
test('默认首轮一分钟、每日一次，生成可验证完整快照并在停止后取消定时器',async t=>{
  const f=fixture(t),service=f.service();
  assert.equal([...f.timers][0].delay,60_000);
  const pending=[...f.timers][0];f.advance(60_000);pending.callback();
  const state=await service.runNow();assert.equal(state.lastError,null);assert.equal(state.running,false);
  assert.equal(new Date(state.nextRunAt)-f.time(),24*60*60*1000);
  assert.equal(fs.readdirSync(f.directory).length,1);
  const file=path.join(f.directory,fs.readdirSync(f.directory)[0]);
  const db=new DatabaseSync(file,{readOnly:true});assert.equal(db.prepare('SELECT value FROM evidence').get().value,'仅测试');db.close();
  await service.stop();assert.equal(service.status().nextRunAt,null);
});
test('只清理自动文件，保留指定份数和手动备份，并把同一快照复制到第二目录',async t=>{
  const f=fixture(t);fs.mkdirSync(f.directory);fs.writeFileSync(path.join(f.directory,'manual.sqlite'),'手动保留');
  const service=f.service({env:{...f.options.env,BACKUP_RETAIN_COUNT:'2',BACKUP_SECONDARY_DIRECTORY:f.secondary}});
  for(let i=0;i<4;i++){f.db.prepare('INSERT INTO evidence VALUES(?)').run('测试'+i);await service.runNow();f.advance(1_000);}
  const names=fs.readdirSync(f.directory).filter(name=>name.startsWith('xinghe-auto-'));
  assert.equal(names.length,2);assert.deepEqual(fs.readdirSync(f.secondary).sort(),names.sort());
  assert.equal(fs.readFileSync(path.join(f.directory,'manual.sqlite'),'utf8'),'手动保留');
  for(const name of names){
    const first=new DatabaseSync(path.join(f.directory,name),{readOnly:true}),second=new DatabaseSync(path.join(f.secondary,name),{readOnly:true});
    try{assert.deepEqual(first.prepare('SELECT * FROM evidence').all(),second.prepare('SELECT * FROM evidence').all());}
    finally{first.close();second.close();}
  }
  assert.equal(service.status().secondaryStatus,'ok');assert.equal(service.status().secondaryDifferentDevice,false);
  assert.equal(service.status().secondaryConfigured,true);
});
test('失败不会逃出后台任务；按间隔重试，日志不泄漏异常文本、路径或凭证',async t=>{
  const f=fixture(t);let calls=0;
  const service=f.service({backup:async(source,target)=>{calls++;if(calls===1)throw Object.assign(new Error('secret-token /private/customer.sqlite'),{code:'ENOSPC'});return backupDatabase(source,target);}});
  const failed=await service.runNow();assert.equal(failed.lastError,'ENOSPC');assert.equal(failed.failureCount,1);
  assert.equal(new Date(failed.nextRunAt)-f.time(),30*60*1000);
  const recovered=await service.runNow();assert.equal(recovered.lastError,null);assert.equal(recovered.failureCount,0);
  assert.doesNotMatch(JSON.stringify(f.logs),/secret-token|customer\.sqlite|xinghe-schedule-test-/);
});
test('第二目录不可写时保留本地快照、记录失败并重试，持续失败仍执行本地保留策略',async t=>{
  const f=fixture(t);fs.writeFileSync(f.secondary,'第二目录被文件占用');
  const service=f.service({env:{...f.options.env,BACKUP_RETAIN_COUNT:'2',BACKUP_SECONDARY_DIRECTORY:f.secondary}});
  for(let i=0;i<3;i++)await service.runNow();
  assert.equal(service.status().secondaryStatus,'failed');assert.equal(service.status().failureCount,3);
  assert.equal(fs.readdirSync(f.directory).length,2);assert.ok(service.status().lastSuccessAt);
  assert.equal(new Date(service.status().nextRunAt)-f.time(),30*60*1000);
  fs.unlinkSync(f.secondary);await service.runNow();assert.equal(service.status().secondaryStatus,'ok');assert.equal(service.status().lastError,null);
});
test('重复触发复用进行中的备份，停止等待该备份完成',async t=>{
  const f=fixture(t);let release,started;const startedPromise=new Promise(resolve=>{started=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});let calls=0;
  const service=f.service({backup:async(source,target)=>{calls++;started();await gate;return backupDatabase(source,target);}});
  const first=service.runNow(),second=service.runNow();assert.equal(first,second);await startedPromise;
  let stopped=false;const stopping=service.stop().then(()=>{stopped=true;});await Promise.resolve();assert.equal(stopped,false);
  release();await stopping;assert.equal(calls,1);assert.equal(service.status().nextRunAt,null);
  await service.runNow();assert.equal(calls,1);
});
test('重启按最近备份时间续排，缺少第二份时提前补做',async t=>{
  const f=fixture(t),first=f.service();await first.runNow();await first.stop();
  const second=f.service();assert.ok(new Date(second.status().nextRunAt)-f.time()>23*60*60*1000);await second.stop();
  const mirrored=f.service({env:{...f.options.env,BACKUP_SECONDARY_DIRECTORY:f.secondary}});
  assert.equal(new Date(mirrored.status().nextRunAt)-f.time(),60_000);
});
test('禁用、非法配置和同步失败均安全处理，不阻止业务服务',async t=>{
  const f=fixture(t),disabled=f.service({env:{BACKUP_ENABLED:'0'}});assert.equal(disabled.status().enabled,false);await disabled.runNow();assert.equal(fs.existsSync(f.directory),false);
  for(const env of [{BACKUP_RETAIN_COUNT:'0'},{BACKUP_INTERVAL_HOURS:'NaN'},{BACKUP_RETAIN_COUNT:'1.5'},{BACKUP_ENABLED:'false'}]){
    const service=f.service({env});assert.equal(service.status().lastError,'BACKUP_CONFIG_INVALID');assert.equal(service.status().enabled,false);
  }
  const synchronous=f.service({backup(){throw new Error('私密值');}});await synchronous.runNow();await synchronous.runNow();assert.equal(synchronous.status().failureCount,2);
  assert.throws(()=>backupConfiguration(f.source,{BACKUP_RETRY_MINUTES:'-1'}),/配置无效/);
});

test('文件时间精度导致时间相同时，保留最新生成快照且第二目的地复制成功',async t=>{
  const f=fixture(t);let latest;
  const service=f.service({env:{...f.options.env,BACKUP_RETAIN_COUNT:'1',BACKUP_SECONDARY_DIRECTORY:f.secondary},backup:async(source,target)=>{
    const result=await backupDatabase(source,target);fs.utimesSync(target,new Date(0),new Date(0));if(path.dirname(target)===f.directory)latest=path.basename(target);return result;
  }});
  for(let i=0;i<3;i++)await service.runNow();
  assert.deepEqual(fs.readdirSync(f.directory),[latest]);assert.deepEqual(fs.readdirSync(f.secondary),[latest]);assert.equal(service.status().lastError,null);
});
