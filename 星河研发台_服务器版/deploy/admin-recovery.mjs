import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {openDatabase} from '../backend/database.mjs';
import {issueAdminRecoveryFromCli} from '../backend/auth.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stateFile=path.join(root,'backend/var/local-server.json');

export function validateRecoveryUrl(value,{local=false}={}) {
  const url=new URL(value);
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||url.protocol==='http:'&&loopback)||local&&url.hostname!=='127.0.0.1')throw new Error('恢复地址必须是实际站点的加密地址，或本机服务地址，且不含其他路径或凭证。');
  return url.origin;
}

export function readRecoveryTarget({env=process.env,options={},readState=()=>JSON.parse(fs.readFileSync(stateFile,'utf8'))}={}) {
  let state;
  if(!options.url){
    try{state=readState();}catch{throw new Error('尚未找到运行中的项目。请先双击“启动星河研发台.command”，保持服务运行后再打开密码恢复入口。');}
    if(typeof state.instanceId!=='string'||!state.instanceId)throw new Error('运行状态不完整，请重新启动项目后再恢复密码。');
  } else if(!options.db)throw new Error('指定站点地址时必须同时指定对应数据库路径。');
  return {
    url:validateRecoveryUrl(options.url||state.url,{local:!options.url}),
    databasePath:path.resolve(root,options.db||env.DATABASE_PATH||state?.databasePath||'backend/var/xinghe.sqlite'),
    instanceId:state?.instanceId,
    username:options.username
  };
}

export async function verifyRecoveryTarget(target,fetcher=fetch) {
  let response;
  try{response=await fetcher(target.url+'/api/health',{redirect:'error',signal:AbortSignal.timeout(5000)});}
  catch{throw new Error('无法连接当前项目，请确认启动窗口仍然开着，再运行密码恢复入口。');}
  let health;try{health=await response.json();}catch{throw new Error('当前地址未返回项目服务状态，尚未生成恢复链接。');}
  if(!response.ok||health.status!=='ok'||target.instanceId&&health.instanceId!==target.instanceId)throw new Error('当前端口与项目启动实例不匹配，尚未生成恢复链接。请重新启动项目后再试。');
}

function issueRecovery(target) {
  if(!fs.existsSync(target.databasePath))throw new Error('项目数据库不存在，尚未生成恢复链接。');
  const db=openDatabase(target.databasePath);
  try{return issueAdminRecoveryFromCli(db,{username:target.username});}
  finally{db.close();}
}

function openRecoveryBrowser(url) {
  return new Promise((resolve,reject)=>{
    const command=process.platform==='darwin'?'/usr/bin/open':process.platform==='win32'?'rundll32':'xdg-open';
    const args=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];
    const child=spawn(command,args,{stdio:'ignore'});
    const timer=setTimeout(()=>{child.kill();reject(new Error('无法自动打开浏览器。'));},5000);
    child.once('error',()=>{clearTimeout(timer);reject(new Error('无法自动打开浏览器。'));});
    child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('无法自动打开浏览器。'));});
  });
}

export async function recoverAdmin({env=process.env,options={},resolveTarget=readRecoveryTarget,verifyTarget=verifyRecoveryTarget,issue=issueRecovery,openUrl=openRecoveryBrowser,logger=console}={}) {
  const target=resolveTarget({env,options});
  await verifyTarget(target);
  const result=issue(target);
  const fragment=new URLSearchParams({activate:result.token,purpose:'admin-reset',username:result.username});
  const url=target.url+'/#'+fragment.toString();
  logger.info(`正在恢复管理员账号：${result.username}。请在网页设置至少 6 位的新密码；项目内容保持不变。`);
  logger.info('恢复链接 30 分钟内有效，仅可使用一次；旧登录凭证已撤销。');
  if(options.printLink)logger.info(url);
  else {
    try{await openUrl(url);}
    catch{logger.info('浏览器未能自动打开。请复制以下一次性链接，在浏览器中打开；不要分享此链接。');logger.info(url);}
  }
  return {username:result.username,expiresAt:result.expiresAt};
}

export function parseRecoveryArguments(args) {
  const options={};
  const keys={'--db':'db','--url':'url','--username':'username'};
  for(let index=0;index<args.length;index++) {
    const arg=args[index];
    if(arg==='--print-link'&&!options.printLink){options.printLink=true;continue;}
    const key=keys[arg];
    if(!key||options[key]!==undefined||!args[index+1]||args[index+1].startsWith('--'))throw new Error('参数无效。可选 --username（账号）；服务器模式同时指定 --db（数据库）与 --url（实际站点），使用 --print-link（显示一次性链接）。');
    options[key]=args[++index];
  }
  return options;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  recoverAdmin({options:parseRecoveryArguments(process.argv.slice(2))}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
