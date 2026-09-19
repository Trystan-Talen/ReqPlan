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
test('真实后端闭环（0.2 新命令）：批量拆分可安全重试、批量改期、文档上传下载、我的工作、归档恢复',async t=>{
  const {store,dir}=await fixture(t),db=openDatabase(':memory:');t.after(()=>db.close());
  const app=createApplication({db,publicOrigin:url,secureCookies:false,logger:{info(){},error(){}}});
  const password='cli-test-only-123';
  await app.auth.bootstrapAdmin({username:'cli-admin',name:'测试管理员',password});
  const exec=args=>run(args,{store,env:{},fetchImpl:handlerFetch(app),passwordReader:async()=>password});
  const actor=(await exec(['auth','login','--username','cli-admin'])).data.user;
  const project=app.business.createProject(actor,{name:'命令行测试',targetDate:'2026-12-31'});
  const req=(await exec(['requirement','create','--project',project.id,'--title','批量拆分需求'])).data;
  const tasksFile=path.join(dir,'tasks.json');
  await fs.writeFile(tasksFile,JSON.stringify([{title:'接口',ownerId:actor.id,estimateHours:8,startDate:'2026-09-21',dueDate:'2026-09-22'},{title:'页面',ownerId:actor.id,estimateHours:6}]));
  const batch=['task','batch','--requirement',req.id,'--version',String(req.version),'--data-file',tasksFile,'--request-id','retry-safe-1'];
  const first=(await exec(batch)).data;assert.equal(first.tasks.length,2);assert.equal(first.requestId,'retry-safe-1');
  const again=(await exec(batch)).data;assert.equal(again.replayed,true);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,2);
  await assert.rejects(exec(['task','batch','--requirement',req.id,'--version','1','--data','[{"title":"x","archived":true}]']),{code:'USAGE'});

  const current=(await exec(['requirement','get',req.id])).data;
  const changes=path.join(dir,'changes.json');
  await fs.writeFile(changes,JSON.stringify({changes:[{requirementId:req.id,version:current.version,planStart:'2026-09-21',planEnd:'2026-09-30'}]}));
  const preview=(await exec(['schedule','preview','--project',project.id,'--data-file',changes])).data;
  assert.match(preview.previewToken,/^[a-f0-9]{64}$/);
  await assert.rejects(exec(['schedule','apply','--project',project.id,'--data-file',changes,'--token',preview.previewToken]),{code:'USAGE'});
  await exec(['schedule','apply','--project',project.id,'--data-file',changes,'--token',preview.previewToken,'--reason','首次排期']);
  const planned=(await exec(['schedule','list','--project',project.id,'--kind','requirement'])).data;
  assert.equal(planned.kind,'requirement');assert.deepEqual(planned.items.map(item=>[item.id,item.dueDate]),[[req.id,'2026-09-30']]);

  const doc=path.join(dir,'需求说明.md');await fs.writeFile(doc,'# 需求说明\n\n## 1. 范围〔SC-1〕\n\n第一版。\n');
  const uploaded=(await exec(['document','upload','--project',project.id,'--file',doc,'--type','PRD','--note','初稿'])).data.document;
  assert.equal(uploaded.version,1);
  const listed=(await exec(['document','list','--project',project.id])).data.documents;assert.equal(listed[0].id,uploaded.id);
  await fs.writeFile(doc,'# 需求说明\n\n## 1. 范围〔SC-1〕\n\n第二版。\n');
  const second=(await exec(['document','upload','--project',project.id,'--document',uploaded.id,'--file',doc])).data.document;assert.equal(second.version,2);
  assert.equal((await exec(['document','versions',uploaded.id])).data.versions.length,2);
  const text=(await exec(['document','download',uploaded.id,'--doc-version','1'])).data;
  assert.equal(text.version,1);assert.equal(text.name,'需求说明.md');assert.match(text.content,/第一版/);
  const output=path.join(dir,'下载.md');
  await exec(['document','download',uploaded.id,'--output',output]);assert.match(await fs.readFile(output,'utf8'),/第二版/);
  await assert.rejects(exec(['document','download',uploaded.id,'--output',output]),{code:'OUTPUT_EXISTS'});

  const work=(await exec(['work','--date','2026-09-21'])).data;assert.ok(work && typeof work==='object');
  const task=(await exec(['task','list','--project',project.id])).data.items[0];
  const archived=(await exec(['task','archive',task.id,'--version',String(task.version)])).data;assert.equal(archived.archived,true);
  const restored=(await exec(['task','restore',task.id,'--version',String(archived.version)])).data;assert.equal(restored.archived,false);
  assert.match(JSON.stringify((await exec(['schema'])).data.requirement.statuses),/已排期/);
});
test('排期计算：跳过周末与节假日、调休上班、冲刺加班、接在已有工作之后、阶段与前置顺序',async()=>{
  const {schedulePlan,workCalendar}=await import('../src/plan.mjs');
  assert.deepEqual(workCalendar('2026-10-01',{holidays:['2026-10-02'],extraWorkdays:['2026-10-03']}).slice(0,3),['2026-10-01','2026-10-03','2026-10-05']);
  const plan={startDate:'2026-09-21',capacityHours:7,capacityOverrides:[{from:'2026-09-21',until:'2026-09-22',hours:8}],phases:['S','N1'],tasks:[
    {requirement:'r2',owner:'A',phase:'N1',hours:7,title:'后排'},
    {requirement:'r1',owner:'A',phase:'S',hours:12,title:'冲刺一'},
    {requirement:'r1',owner:'B',phase:'S',hours:2,title:'草案'},
    {requirement:'r1',owner:'A',phase:'S',hours:3,title:'冲刺二',after:['草案']}]};
  const s=schedulePlan(plan,{ownerOf:x=>x==='A'?'u-a':'u-b'});
  const t=Object.fromEntries(s.tasks.map(x=>[x.title,x]));
  assert.deepEqual([t['冲刺一'].startDate,t['冲刺一'].dueDate],['2026-09-21','2026-09-22']);
  assert.deepEqual([t['冲刺二'].startDate,t['后排'].dueDate],['2026-09-22','2026-09-23']);
  const r1=s.requirements.find(x=>x.requirementId==='r1');assert.equal(r1.assignee,'u-a');assert.deepEqual(r1.collaborators,['u-b']);assert.equal(r1.planEnd,'2026-09-23');
  const busy=schedulePlan(plan,{ownerOf:x=>x==='A'?'u-a':'u-b',busyUntil:{'u-a':'2026-09-25'}});
  assert.equal(busy.tasks.find(x=>x.title==='冲刺一').startDate,'2026-09-28');
  assert.equal(schedulePlan({...plan,respectExistingLoad:false},{ownerOf:x=>x,busyUntil:{A:'2026-09-25'}}).tasks.find(x=>x.title==='冲刺一').startDate,'2026-09-21');
  assert.throws(()=>schedulePlan({...plan,tasks:[...plan.tasks,{requirement:'r1',owner:'A',phase:'S',hours:1,title:'冲刺一'}]}),{code:'INVALID_PLAN'});
  assert.throws(()=>schedulePlan({...plan,tasks:[{requirement:'r1',owner:'A',phase:'X',hours:1,title:'x'}]}),/阶段 X/);
});
test('真实后端闭环：批量导入需求（去重、章节校验）→ 确认 → 自动排期拆任务 → 重跑不重复',async t=>{
  const {store,dir}=await fixture(t),db=openDatabase(':memory:');t.after(()=>db.close());
  const app=createApplication({db,publicOrigin:url,secureCookies:false,logger:{info(){},error(){}}});
  const password='cli-test-only-123';
  await app.auth.bootstrapAdmin({username:'cli-admin',name:'测试管理员',password});
  const exec=args=>run(args,{store,env:{},fetchImpl:handlerFetch(app),passwordReader:async()=>password});
  const actor=(await exec(['auth','login','--username','cli-admin'])).data.user;
  const project=app.business.createProject(actor,{name:'新项目',targetDate:'2026-10-09'});
  let version=project.version;
  for(const [username,role] of [['lead-a','lead'],['dev-b','developer']]) {
    const account=app.auth.createUser(actor,{username,name:username,role:'member'});await app.auth.redeemToken({token:account.activation.token,password});
    version=app.business.setMember(actor,project.id,{version,userId:account.user.id,role}).version ?? app.business.getProject(actor,project.id).version;
  }
  const prd=path.join(dir,'M1-网关.md');await fs.writeFile(prd,'# 网关\n\n## 对外接口〔GW-2〕\n\n## 请求处理〔GW-3〕\n');
  await exec(['document','upload','--project',project.id,'--file',prd,'--type','PRD']);
  const reqFile=path.join(dir,'reqs.json');
  await fs.writeFile(reqFile,JSON.stringify([
    {key:'gw',title:'文本协议网关',description:'覆盖 GW-2、GW-3',acceptance:'按 GW-AC-01 验收',priority:'P0',docRefs:[{document:'M1-网关.md',type:'PRD',sections:['GW-2','GW-9']}],acceptanceCases:['GW-AC-01']},
    {key:'ui',title:'控制台',description:'控制台页面',acceptance:'页面可用'}]));
  const preview=(await exec(['requirement','import','--project',project.id,'--data-file',reqFile,'--dry-run'])).data;
  assert.equal(preview.create.length,2);assert.match(preview.warnings.join(),/找不到章节 GW-9/);
  const imported=(await exec(['requirement','import','--project',project.id,'--data-file',reqFile])).data;
  assert.equal(imported.created,2);
  const again=(await exec(['requirement','import','--project',project.id,'--data-file',reqFile])).data;
  assert.equal(again.created,0);assert.equal(again.existing,2);
  const ids=Object.fromEntries(imported.items.map(item=>[item.key,item.id]));
  assert.deepEqual((await exec(['requirement','get',ids.gw])).data.docRefs[0].sections,['GW-2','GW-9']);
  for(const id of Object.values(ids)) for(const status of ['待评审','已确定']) {const current=(await exec(['requirement','get',id])).data;await exec(['requirement','update',id,'--version',String(current.version),'--status',status]);}
  const planFile=path.join(dir,'plan.json');
  const plan={startDate:'2026-09-21',capacityHours:7,phases:['S'],owners:{A:'lead-a',B:'dev-b'},tasks:[
    {requirement:ids.gw,owner:'A',phase:'S',hours:20,title:'Chat 协议与错误码'},{requirement:ids.gw,owner:'A',phase:'S',hours:16,title:'Messages 协议'},
    {requirement:ids.ui,owner:'B',phase:'S',hours:20,title:'控制台框架与概览'}]};
  await fs.writeFile(planFile,JSON.stringify(plan));
  const planned=(await exec(['plan','preview','--project',project.id,'--data-file',planFile])).data;
  assert.equal(planned.tasks,3);assert.equal(planned.load['lead-a'].hours,36);
  const gw=planned.requirements.find(item=>item.requirementId===ids.gw);assert.equal(gw.planStart,'2026-09-21');assert.equal(gw.planEnd,'2026-09-29');
  const applied=(await exec(['plan','apply','--project',project.id,'--data-file',planFile])).data;
  assert.deepEqual(applied.items.map(item=>[item.result,item.status]),[['scheduled','已排期'],['scheduled','已排期']]);
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,3);
  const rerun=(await exec(['plan','apply','--project',project.id,'--data-file',planFile])).data;
  assert.ok(rerun.items.every(item=>item.createdTasks===0));assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,3);
  // 另一个计划：接在已有工作之后；超出项目目标日期需要 --force
  const next={...plan,tasks:[{requirement:ids.ui,owner:'A',phase:'S',hours:40,title:'追加'}]};
  await fs.writeFile(planFile,JSON.stringify(next));
  const skipped=(await exec(['plan','preview','--project',project.id,'--data-file',planFile])).data;
  assert.match(skipped.skipped.join(),/已有 1 个其他任务/);
  const project2=app.business.createProject(actor,{name:'另一个',targetDate:'2026-09-30'});
  await assert.rejects(exec(['plan','preview','--project',project2.id,'--data-file',planFile]),{code:'INVALID_PLAN'});
  const extra=(await exec(['requirement','create','--project',project.id,'--title','超长需求'])).data;
  await fs.writeFile(planFile,JSON.stringify({...plan,tasks:[{requirement:extra.id,owner:'B',phase:'S',hours:42,title:'超长一'},{requirement:extra.id,owner:'B',phase:'S',hours:42,title:'超长二'}]}));
  const longPreview=(await exec(['plan','preview','--project',project.id,'--data-file',planFile])).data;
  assert.equal(longPreview.load['dev-b'].startsAfterExisting,'2026-09-23');assert.equal(longPreview.load['dev-b'].from,'2026-09-24');
  assert.equal(longPreview.late.length,1);assert.match(longPreview.notConfirmed.join(),/未确定/);
  await assert.rejects(exec(['plan','apply','--project',project.id,'--data-file',planFile]),{code:'CONFIRMATION_REQUIRED'});
  assert.equal(db.prepare('SELECT count(*) n FROM tasks').get().n,3);
  const forced=(await exec(['plan','apply','--project',project.id,'--data-file',planFile,'--force'])).data;
  assert.equal(forced.items[0].status,'未确定');assert.equal(forced.items[0].planEnd,'2026-10-12');
});
