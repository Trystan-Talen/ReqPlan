import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {run,parse} from '../src/cli.mjs';
import {Client,Store,normalizeUrl} from '../src/client.mjs';
import {pathToFileURL} from 'node:url';
const serverRoot=process.env.XINGHE_SERVER_ROOT ? path.resolve(process.env.XINGHE_SERVER_ROOT) : fileURLToPath(new URL('../../../星河研发台_服务器版/',import.meta.url));
const {openDatabase}=await import(pathToFileURL(path.join(serverRoot,'backend/database.mjs')));
const {createApplication}=await import(pathToFileURL(path.join(serverRoot,'backend/server.mjs')));

const url='http://127.0.0.1:59999';
async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'xinghe-cli-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new Store(dir);
  await store.write('profile-default.json',{url});
  return {dir,store};
}
async function session(store,profile='default',server=url) {
  await store.saveSession(profile,server,{cookie:'xinghe_session='+ 'a'.repeat(43),csrfToken:'b'.repeat(64),expiresAt:new Date(Date.now()+60000).toISOString()});
}
test('地址支持本机动态端口、远程加密地址及子路径，拒绝明文远程和含凭证地址',()=>{
  assert.equal(normalizeUrl(url+'/'),url);
  assert.equal(normalizeUrl('https://example.com/platform/'),'https://example.com/platform');
  assert.equal(normalizeUrl('http://[::1]:54321'),'http://[::1]:54321');
  for(const value of ['http://example.com','https://u:p@example.com','https://example.com?token=x','file:///tmp','https://example.com/#token']) assert.throws(()=>normalizeUrl(value));
});
test('未知参数和重复参数立即失败',()=>{
  assert.throws(()=>parse(['--password','secret']),{code:'USAGE'});
  assert.throws(()=>parse(['--url','x','--url','y']),{code:'USAGE'});
  assert.throws(()=>parse(['--title']),{code:'USAGE'});
});
test('地址优先级、环境独立和配置文件权限',async t=>{
  const {store,dir}=await fixture(t);
  const exec=args=>run(args,{store,env:{XINGHE_URL:'https://env.example.com'}});
  assert.equal((await exec(['config','show'])).data.url,'https://env.example.com');
  assert.equal((await exec(['config','show','--url','https://flag.example.com'])).data.url,'https://flag.example.com');
  await run(['config','set-url','https://prod.example.com','--profile','prod'],{store,env:{}});
  assert.equal((await run(['config','show'],{store,env:{}})).data.url,url);
  assert.equal((await fs.stat(path.join(dir,'profile-prod.json'))).mode & 0o777,0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777,0o700);
});
test('切换地址或环境不转发旧凭证；同一地址恢复原配置可继续用有效会话',async t=>{
  const {store}=await fixture(t);await session(store);
  let calls=0;
  const fetchImpl=async()=>{calls++;return Response.json({user:{id:'u'}});};
  for(const args of [['auth','me','--url','https://other.example.com'],['auth','me','--profile','prod','--url',url]]) await assert.rejects(run(args,{store,env:{},fetchImpl}),{code:'LOGIN_REQUIRED'});
  assert.equal(calls,0);
  await run(['auth','me'],{store,env:{},fetchImpl});assert.equal(calls,1);
});
test('重定向不跟随，凭证不会发送到跳转地址',async t=>{
  const {store}=await fixture(t);await session(store);let count=0;
  const client=new Client({url,store,fetchImpl:async(_,options)=>{count++;assert.equal(options.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://other.example.com'}});}});
  await assert.rejects(client.request('/api/bootstrap'),{code:'REDIRECT_BLOCKED'});assert.equal(count,1);
});
test('写请求网络错误不重试，并明确提示核对结果',async t=>{
  const {store}=await fixture(t);await session(store);let calls=0;
  const client=new Client({url,store,fetchImpl:async()=>{calls++;throw Error('lost');}});
  await assert.rejects(client.request('/api/tasks',{method:'POST',body:{}}),e=>e.code==='NETWORK_ERROR' && e.message.includes('可能已经执行'));
  assert.equal(calls,1);
});
test('过期会话不发送，服务端撤销返回 401 后移除本地会话',async t=>{
  const {store}=await fixture(t);await session(store);
  const client=new Client({url,store,fetchImpl:async()=>Response.json({code:'UNAUTHENTICATED',error:'已失效'},{status:401})});
  await assert.rejects(client.request('/api/bootstrap'),{status:401});assert.equal(await store.session('default',url),null);
  await store.saveSession('default',url,{expiresAt:'2000-01-01'});
  await assert.rejects(client.request('/api/bootstrap'),{code:'LOGIN_REQUIRED'});
});
test('预览不登录不发送，文件内容及版本精确保留，日期和不支持字段提前拒绝',async t=>{
  const {store,dir}=await fixture(t);let count=0;
  const exec=args=>run(args,{store,env:{},fetchImpl:async()=>{count++;throw Error('不应调用');}});
  const file=path.join(dir,'req.json');await fs.writeFile(file,JSON.stringify({projectId:'p-a',title:'中文需求',acceptance:'通过验收'}));
  const preview=await exec(['requirement','create','--data-file',file,'--dry-run']);
  assert.equal(preview.data.body.acceptance,'通过验收');assert.equal(preview.data.serverValidated,false);
  const scheduled=await exec(['task','schedule','t-a','--version','3','--start','2028-02-29','--end','2028-03-01','--dry-run']);
  assert.equal(scheduled.data.body.version,3);assert.equal(scheduled.data.body.startDate,'2028-02-29');
  for(const args of [
    ['task','update','t-a','--title','x'],
    ['task','schedule','t-a','--version','3','--start','2026-02-29','--end','2026-03-01'],
    ['task','create','--project','p-a','--title','x','--data','{"archived":true}'],
    ['task','create','--project','p-a','--title','x','--data','{"title":"y"}']
  ]) await assert.rejects(exec(args));
  assert.equal(count,0);
});
test('排期按区间相交过滤，并单列日期不完整任务',async t=>{
  const {store}=await fixture(t);await session(store);
  const tasks=[{id:'t-1',projectId:'p-a',startDate:'2026-09-01',dueDate:'2026-09-20'}, {id:'t-2',projectId:'p-a'}, {id:'t-3',projectId:'p-a',startDate:'2026-10-01',dueDate:'2026-10-02'}];
  const r=await run(['schedule','list','--project','p-a','--from','2026-09-15','--to','2026-09-30'],{store,env:{},fetchImpl:async()=>Response.json({tasks})});
  assert.deepEqual(r.data.items.map(x=>x.id),['t-1']);assert.deepEqual(r.data.unscheduled.map(x=>x.id),['t-2']);
});
test('可执行入口：帮助、错误输出和退出码',()=>{
  const entry=fileURLToPath(new URL('../bin/xinghe.mjs',import.meta.url));
  const help=spawnSync(process.execPath,[entry,'--help'],{encoding:'utf8'});assert.equal(help.status,0);assert.match(help.stdout,/星河命令行工具/);
  const error=spawnSync(process.execPath,[entry,'--unknown'],{encoding:'utf8'});assert.equal(error.status,1);assert.equal(error.stdout,'');assert.equal(JSON.parse(error.stderr).ok,false);
});

// Transport-only adapter: actual HTTP handler, authentication and business/database
// logic run unchanged. No socket or production database is involved.
function handlerFetch(app) {
  return async (address,options={})=>{
    const target=new URL(address),req=new PassThrough();
    req.url=target.pathname+target.search;req.method=options.method || 'GET';req.socket={remoteAddress:'127.0.0.1'};
    req.headers=Object.fromEntries(Object.entries(options.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
    return new Promise((resolve,reject)=>{
      const headers=new Headers();
      const res={statusCode:200,headersSent:false,setHeader(k,v){headers.set(k,v);},writeHead(status,values){this.statusCode=status;this.headersSent=true;for(const[k,v]of Object.entries(values || {}))headers.set(k,v);},end(body){resolve(new Response(body,{status:this.statusCode,headers}));}};
      app.handler(req,res).catch(reject);req.end(options.body);
    });
  };
}
test('真实后端闭环：登录、成员、录入、改期、并发冲突、角色拒绝、审计和退出',async t=>{
  const {store}=await fixture(t),db=openDatabase(':memory:');t.after(()=>db.close());
  const app=createApplication({db,publicOrigin:url,secureCookies:false,logger:{info(){},error(){}}});
  const password='cli-test-only-123';
  await app.auth.bootstrapAdmin({username:'cli-admin',name:'测试管理员',password});
  const deps={store,env:{},fetchImpl:handlerFetch(app),passwordReader:async()=>password};
  const exec=args=>run(args,deps);
  const login=await exec(['auth','login','--username','cli-admin']);
  assert.equal(login.data.user.username,'cli-admin');assert.doesNotMatch(JSON.stringify(login),/csrfToken|xinghe_session|cli-test-only/);
  const actor=login.data.user;
  const project=app.business.createProject(actor,{name:'命令行测试',targetDate:'2026-12-31'});
  assert.equal((await exec(['project','list'])).data.count,1);
  assert.ok((await exec(['project','members',project.id])).data.members.length);
  const req=(await exec(['requirement','create','--project',project.id,'--title','真实接口需求','--priority','P1'])).data;
  assert.equal(req.status,'未确定');
  const task=(await exec(['task','create','--project',project.id,'--requirement',req.id,'--title','开发实现','--hours','8'])).data;
  const scheduled=(await exec(['task','schedule',task.id,'--version',String(task.version),'--start','2026-09-20','--end','2026-09-22'])).data;
  assert.equal(scheduled.dueDate,'2026-09-22');
  await assert.rejects(exec(['task','update',task.id,'--version',String(task.version),'--title','过期覆盖']),{code:'VERSION_CONFLICT',status:409});
  assert.equal((await exec(['task','get',task.id])).data.title,'开发实现');
  const reqScheduled=(await exec(['requirement','schedule',req.id,'--version',String(req.version),'--start','2026-09-20','--end','2026-09-22'])).data;
  assert.equal(reqScheduled.planEnd,'2026-09-22');
  assert.ok((await exec(['requirement','history',req.id])).data.entries.length>=2);
  const account=app.auth.createUser(actor,{username:'cli-viewer',name:'只读成员',role:'member'});
  await app.auth.redeemToken({token:account.activation.token,password});
  app.business.setMember(actor,project.id,{version:project.version,userId:account.user.id,role:'viewer'});
  await exec(['auth','login','--username','cli-viewer']);
  await assert.rejects(exec(['requirement','create','--project',project.id,'--title','拒绝越权']),{code:'FORBIDDEN',status:403});
  assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n,1);
  const me=await exec(['auth','me']);assert.equal(me.data.user.username,'cli-viewer');assert.doesNotMatch(JSON.stringify(me),/csrfToken|xinghe_session/);
  await exec(['auth','logout']);await assert.rejects(exec(['project','list']),{code:'LOGIN_REQUIRED'});
});
