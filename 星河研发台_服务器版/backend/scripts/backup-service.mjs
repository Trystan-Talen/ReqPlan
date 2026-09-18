import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {backupDatabase} from './backup.mjs';

const HOUR=60*60*1000;
const OWN_BACKUP=/^xinghe-auto-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-[a-f0-9-]{36}\.sqlite$/;
function numeric(env,key,fallback,min,max) {
  const value=env[key]==null||env[key]===''?fallback:Number(env[key]);
  if(!Number.isFinite(value)||value<min||value>max)throw Object.assign(new Error('自动备份配置无效。'),{code:'BACKUP_CONFIG_INVALID'});
  return value;
}
export function backupConfiguration(source,env=process.env) {
  const enabled=env.BACKUP_ENABLED!=='0';
  if(env.BACKUP_ENABLED!=null&&env.BACKUP_ENABLED!==''&&!['0','1'].includes(env.BACKUP_ENABLED))throw Object.assign(new Error('自动备份开关必须为 0 或 1。'),{code:'BACKUP_CONFIG_INVALID'});
  const retention=numeric(env,'BACKUP_RETAIN_COUNT',30,1,10000);
  if(!Number.isInteger(retention))throw Object.assign(new Error('自动备份保留份数必须为整数。'),{code:'BACKUP_CONFIG_INVALID'});
  return {enabled,directory:path.resolve(env.BACKUP_DIRECTORY||path.join(path.dirname(source),'backups')),
    secondaryDirectory:env.BACKUP_SECONDARY_DIRECTORY?path.resolve(env.BACKUP_SECONDARY_DIRECTORY):null,
    intervalMs:numeric(env,'BACKUP_INTERVAL_HOURS',24,1/60,24*365)*HOUR,
    retryMs:numeric(env,'BACKUP_RETRY_MINUTES',30,1/60,24*60)*60*1000,
    initialDelayMs:numeric(env,'BACKUP_INITIAL_DELAY_SECONDS',60,0,24*60*60)*1000,retention};
}
function entries(directory) {
  if(!fs.existsSync(directory))return [];
  return fs.readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isFile()&&OWN_BACKUP.test(entry.name))
    .map(entry=>({name:entry.name,time:fs.statSync(path.join(directory,entry.name)).mtimeMs}))
    .sort((a,b)=>b.time-a.time||b.name.localeCompare(a.name));
}
function retain(directory,count,latestName) {
  const candidates=entries(directory).filter(file=>file.name!==latestName);
  // Coarse filesystem timestamps can tie. Always preserve the snapshot just
  // completed, regardless of UUID lexical order, including before mirroring it.
  for(const file of candidates.slice(count-1))fs.unlinkSync(path.join(directory,file.name));
}
function safeCode(error) {
  return ['ENOSPC','EACCES','EPERM','EROFS','ENOENT','EEXIST','BACKUP_CONFIG_INVALID','BACKUP_SOURCE_MISSING','BACKUP_INTEGRITY_FAILED','BACKUP_FOREIGN_KEYS_FAILED'].includes(error?.code)?error.code:'BACKUP_FAILED';
}

function backupInWorker(source,destination) {
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL(import.meta.url),{workerData:{kind:'xinghe-backup',source,destination}});
    let replied=false;
    worker.once('message',result=>{replied=true;if(result.ok)resolve({bytes:result.bytes});else reject(Object.assign(new Error('自动备份未完成。'),{code:result.code}));});
    worker.once('error',()=>reject(Object.assign(new Error('备份工作线程未完成。'),{code:'BACKUP_FAILED'})));
    worker.once('exit',()=>{if(!replied)reject(Object.assign(new Error('备份工作线程提前结束。'),{code:'BACKUP_FAILED'}));});
  });
}
if(!isMainThread&&workerData?.kind==='xinghe-backup'){
  try{const result=await backupDatabase(workerData.source,workerData.destination);parentPort.postMessage({ok:true,bytes:result.bytes});}
  catch(error){parentPort.postMessage({ok:false,code:safeCode(error)});}
  finally{parentPort.close();}
}

// A timer never holds the HTTP service open, and failures never escape a background
// job. Public status and logs deliberately exclude filesystem paths and raw errors.
export function startBackupService({source,env=process.env,logger=console,onStatus=()=>{},
  now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,backup=backupInWorker}={}) {
  let timer=null,inFlight=null,stopped=false,config;
  const state={enabled:false,running:false,lastAttemptAt:null,lastSuccessAt:null,nextRunAt:null,failureCount:0,lastError:null,
    secondaryConfigured:false,secondaryStatus:'unconfigured',secondaryDifferentDevice:null,lastSecondarySuccessAt:null};
  const status=()=>({...state});
  function publish(level,event) {
    try{logger[level]?.({event,...status()});}catch{}
    try{onStatus(status());}catch{}
  }
  try{
    if(typeof source!=='string'||!source||source===':memory:')throw Object.assign(new Error('需要持久化数据库。'),{code:'BACKUP_CONFIG_INVALID'});
    config=backupConfiguration(source,env);state.enabled=config.enabled;state.secondaryConfigured=Boolean(config.secondaryDirectory);
    state.secondaryStatus=config.secondaryDirectory?'pending':'unconfigured';
    if(config.secondaryDirectory===config.directory)throw Object.assign(new Error('第二目的目录必须不同。'),{code:'BACKUP_CONFIG_INVALID'});
  }catch(error){state.lastError=safeCode(error);state.enabled=false;publish('error','backup_configuration_failed');return{status,runNow:async()=>status(),stop:async()=>{}};}
  function schedule(delay) {
    if(stopped||!state.enabled)return;
    if(timer)clearTimer(timer);
    state.nextRunAt=new Date(now()+delay).toISOString();
    const due=now()+delay;
    timer=setTimer(()=>{timer=null;if(now()<due)schedule(due-now());else void runNow();},Math.min(delay,2**31-1));timer?.unref?.();
  }
  function runNow() {
    if(inFlight)return inFlight;
    if(stopped||!state.enabled)return Promise.resolve(status());
    if(timer)clearTimer(timer);timer=null;
    state.running=true;state.nextRunAt=null;state.lastAttemptAt=new Date(now()).toISOString();publish('info','backup_started');
    inFlight=Promise.resolve().then(async()=>{
      let failed=false;
      try{
        const name=`xinghe-auto-${new Date(now()).toISOString().replace(/[:.]/g,'-')}-${randomUUID()}.sqlite`;
        const target=path.join(config.directory,name);
        await backup(source,target);
        state.lastSuccessAt=new Date(now()).toISOString();
        retain(config.directory,config.retention,name);
        // The second copy is made from the completed snapshot, so both destinations
        // contain exactly the same committed state even while the app keeps writing.
        if(config.secondaryDirectory){
          try{
            fs.mkdirSync(config.secondaryDirectory,{recursive:true,mode:0o700});
            state.secondaryDifferentDevice=fs.statSync(config.secondaryDirectory).dev!==fs.statSync(source).dev;
            await backup(target,path.join(config.secondaryDirectory,name));
            retain(config.secondaryDirectory,config.retention,name);
            state.secondaryStatus='ok';state.lastSecondarySuccessAt=new Date(now()).toISOString();
          }catch(error){state.secondaryStatus='failed';throw error;}
        }
        state.failureCount=0;state.lastError=null;publish('info','backup_completed');
      }catch(error){failed=true;state.failureCount++;state.lastError=safeCode(error);publish('error','backup_failed');}
      finally{state.running=false;inFlight=null;schedule(failed?config.retryMs:config.intervalMs);try{onStatus(status());}catch{}}
      return status();
    });
    return inFlight;
  }
  if(state.enabled){
    let delay=config.initialDelayMs;
    try{
      const latest=entries(config.directory)[0];
      if(latest){state.lastSuccessAt=new Date(latest.time).toISOString();delay=Math.max(delay,latest.time+config.intervalMs-now());}
      if(config.secondaryDirectory){
        const mirrored=entries(config.secondaryDirectory)[0];
        if(mirrored)state.lastSecondarySuccessAt=new Date(mirrored.time).toISOString();
        // A missing secondary copy must be retried on startup even if the local
        // copy is recent. Existing files still get checked in the next run.
        if(latest&&!fs.existsSync(path.join(config.secondaryDirectory,latest.name)))delay=config.initialDelayMs;
      }
    }catch(error){state.lastError=safeCode(error);publish('error','backup_schedule_failed');}
    schedule(delay);publish('info','backup_scheduled');
  }
  return {status,runNow,async stop(){stopped=true;if(timer)clearTimer(timer);timer=null;state.nextRunAt=null;await inFlight;}};
}
