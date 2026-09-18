import path from 'node:path';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {openDatabase} from '../backend/database.mjs';
import {importLegacy} from '../backend/scripts/import-legacy.mjs';
import {validateLocalPorts,waitForMessage,stopChild} from './dev.mjs';
export {validateLocalPorts};

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const statePath=path.join(root,'backend/var/local-server.json');

export function prepareLocalData(databasePath) {
  const db=openDatabase(databasePath);
  try {
    const count=table=>db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    let imported=false;
    if(['users','projects','requirements','tasks','memberships','attachments'].every(table=>count(table)===0)) {importLegacy(db);imported=true;}
    const existingAdmin=db.prepare("SELECT username,name FROM users WHERE role='admin' LIMIT 1").get();
    const originalManager=db.prepare("SELECT username,name FROM users WHERE id='u-manager' AND status='pending' AND password_hash IS NULL").get();
    return {imported,projects:count('projects'),requirements:count('requirements'),tasks:count('tasks'),needsAdmin:!existingAdmin,admin:existingAdmin||originalManager||{username:'workspace-admin',name:'项目管理员'}};
  } finally {db.close();}
}

export function writeLocalState(value,file=statePath) {
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=`${file}.${value.instanceId}.tmp`;
  try{fs.writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});fs.renameSync(temporary,file);}
  finally{fs.rmSync(temporary,{force:true});}
}
export function removeLocalState(instanceId,file=statePath) {
  try{if(JSON.parse(fs.readFileSync(file,'utf8')).instanceId===instanceId)fs.rmSync(file,{force:true});}catch{}
}

function openBrowser(url) {
  return new Promise((resolve,reject)=>{
    const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
    const child=spawn(command,args,{stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('浏览器未能自动打开。'));},5000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('浏览器未能自动打开。'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('浏览器未能自动打开。'));});
  });
}

export async function launchLocal({env=process.env,prepare=prepareLocalData,spawnProcess=spawn,makeToken=()=>randomBytes(32).toString('base64url'),makeInstanceId=randomUUID,openUrl=openBrowser,writeState=writeLocalState,removeState=removeLocalState,logger=console,timeoutMs=25000,signal}={}) {
  const {web,api}=validateLocalPorts(env);
  const databasePath=path.resolve(root,env.DATABASE_PATH||'backend/var/xinghe.sqlite');
  const state=prepare(databasePath);
  logger.info(`${state.imported?'已导入真实项目':'继续使用现有数据库'}：${state.projects} 个项目、${state.requirements} 条需求、${state.tasks} 个任务。`);
  logger.info(state.needsAdmin?'首次管理员将在浏览器中初始化。':'使用已有账号和原密码登录。');
  const setupToken=state.needsAdmin?makeToken():'';
  const instanceId=makeInstanceId();
  let child,closing=false,resolveClosed;
  const closed=new Promise(resolve=>{resolveClosed=resolve;});
  const stop=async(code=0)=>{
    if(closing)return closed;
    closing=true;signal?.removeEventListener('abort',aborted);
    await stopChild(child,5000);removeState(instanceId);resolveClosed(code);return code;
  };
  const aborted=()=>{void stop(0);};
  signal?.addEventListener('abort',aborted,{once:true});
  try {
    if(signal?.aborted)throw Object.assign(new Error('启动已取消。'),{code:'ABORT_ERR'});
    child=spawnProcess(process.execPath,['deploy/dev.mjs'],{cwd:root,stdio:['inherit','inherit','inherit','ipc'],env:{...env,DATABASE_PATH:databasePath,WEB_PORT:String(web),API_PORT:String(api),XINGHE_LOCAL_RUN_ID:instanceId,XINGHE_SETUP_TOKEN:setupToken}});
    const ready=await waitForMessage(child,{type:'ready',instanceId,timeoutMs,signal});
    if(child.exitCode!==null&&child.exitCode!==undefined||child.signalCode)throw new Error('服务在就绪后立即退出。');
    const parsed=new URL(ready.url);
    const webPort=Number(parsed.port||80),apiPort=ready.apiPort;
    if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||!Number.isInteger(webPort)||webPort<1||webPort>65535||!Number.isInteger(apiPort)||apiPort<1||apiPort>65535||webPort===apiPort)throw new Error('启动器返回了无效服务地址。');
    const url=parsed.origin;
    child.once('exit',code=>{if(!closing)void stop(code||1);});
    child.on('error',()=>{if(!closing)void stop(1);});
    if(signal?.aborted)throw Object.assign(new Error('启动已取消。'),{code:'ABORT_ERR'});
    writeState({url,webPort,apiPort,databasePath,pid:child.pid,launcherPid:process.pid,instanceId,startedAt:new Date().toISOString()});
    logger.info(`服务已就绪：${url}。请保持此窗口打开；按 Control+C（控制键加 C）停止。`);
    try{await openUrl(url+(setupToken?`/#setup=${setupToken}`:''));}
    catch{logger.info(state.needsAdmin?'浏览器未能自动打开。请先按 Control+C（控制键加 C）停止本次服务，再运行启动文件以打开管理员初始化页面。':`浏览器未能自动打开，请手动访问 ${url}。`);}
    return {url,apiPort,instanceId,child,stop,closed};
  } catch(error) {await stop(1);throw error;}
}

export async function main() {
  const controller=new AbortController(),abort=()=>controller.abort();
  process.once('SIGINT',abort);process.once('SIGTERM',abort);
  try{const running=await launchLocal({signal:controller.signal});process.exitCode=await running.closed;}
  catch(error){console.error(error.code==='EPERM'?'启动未完成：当前环境不允许监听本机端口。':error.code==='ABORT_ERR'?'启动已取消。':`启动未完成：${error.message}`);process.exitCode=error.code==='ABORT_ERR'?0:1;}
  finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void main();
