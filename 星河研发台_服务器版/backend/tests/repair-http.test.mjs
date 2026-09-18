import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {openDatabase} from '../database.mjs';
import {createApplication} from '../server.mjs';

const password='Isolated-Repair-Http!2026';
async function fixture(t,{backupService=null}={}) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const errors=[];
  const app=createApplication({db,publicOrigin:'http://127.0.0.1:3000',secureCookies:false,backupService,logger:{info(){},error(value){errors.push(value);}}});
  await app.auth.bootstrapAdmin({username:'repair-admin',name:'隔离管理员',password});
  async function call(url,{method='GET',body,cookie,csrf,origin}={}) {
    const req=new PassThrough();req.url=url;req.method=method;req.socket={remoteAddress:'repair-test'};
    req.headers={...(body!==undefined?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),...(origin?{origin}:{})};
    return await new Promise((resolve,reject)=>{
      const headers=new Headers();const res={statusCode:200,headersSent:false,setHeader(key,value){headers.set(key,value);},writeHead(status,values={}){this.statusCode=status;this.headersSent=true;for(const[key,value]of Object.entries(values))headers.set(key,value);},end(value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(value||'');let data;try{data=JSON.parse(bytes.toString('utf8'));}catch{data=bytes.toString('utf8');}resolve({status:this.statusCode,headers,data,bytes});}};
      app.handler(req,res).catch(reject);req.end(body!==undefined?JSON.stringify(body):undefined);
    });
  }
  async function login(username){const result=await call('/api/auth/login',{method:'POST',body:{username,password}});assert.equal(result.status,200);return{cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrfToken,user:result.data.user};}
  const admin=await login('repair-admin');
  const write=(url,body,method='POST',session=admin)=>call(url,{method,body,...session});
  const project=(await write('/api/projects',{name:'隔离验收项目',targetDate:'2026-09-30'})).data;
  const requirementResult=await write('/api/requirements',{projectId:project.id,title:'隔离验收需求',description:'用于接口测试',acceptance:'测试通过',planStart:'2026-09-02',planEnd:'2026-09-10'});assert.equal(requirementResult.status,201);
  async function member(username,{role}={}) {
    const created=await write('/api/users',{username,name:'隔离成员',role:'member'});assert.equal(created.status,201);
    assert.equal((await call('/api/auth/activate',{method:'POST',body:{token:created.data.activationToken,password}})).status,200);
    if(role){const current=app.business.getProject(admin.user,project.id);assert.equal((await write(`/api/projects/${project.id}/members`,{userId:created.data.user.id,role,version:current.version},'PUT')).status,200);}
    return login(username);
  }
  return {db,app,call,write,admin,project,requirement:requirementResult.data,member,errors};
}

test('新增接口统一要求登录，写入校验跨站请求凭证和来源',async t=>{
  const f=await fixture(t);const reads=['/api/work','/api/admin/backup-status','/api/attachments/missing/versions'];
  for(const url of reads)assert.equal((await f.call(url)).status,401);
  const writes=[`/api/requirements/${f.requirement.id}/task-batch`,`/api/projects/${f.project.id}/schedule/preview`,`/api/projects/${f.project.id}/schedule/apply`,`/api/requirements/${f.requirement.id}/attachments`,'/api/work/read','/api/admin/backup-run'];
  for(const url of writes){assert.equal((await f.call(url,{method:'POST',body:{}})).status,401);const missing=await f.call(url,{method:'POST',body:{},cookie:f.admin.cookie});assert.equal(missing.status,403);assert.equal(missing.data.code,'CSRF_REJECTED');}
  const origin=await f.call(`/api/projects/${f.project.id}/schedule/preview`,{method:'POST',body:{changes:[]},...f.admin,origin:'https://untrusted.invalid'});assert.equal(origin.status,403);assert.equal(origin.data.code,'ORIGIN_REJECTED');
  assert.equal((await f.call('/api/work?date=2026-02-30',f.admin)).status,400);
});

test('批量拆分接口重复提交只创建一次，返回逐行错误且整批回滚',async t=>{
  const f=await fixture(t);const url=`/api/requirements/${f.requirement.id}/task-batch`;
  const body={version:f.requirement.version,requestId:'http-batch-retry-001',tasks:[{title:'任务一',estimateHours:1.25},{title:'任务二',estimateHours:32}]};
  const results=await Promise.all([f.write(url,body),f.write(url,body)]);assert.deepEqual(results.map(x=>x.status),[201,201]);assert.deepEqual(results.map(x=>x.data.replayed).sort(),[false,true]);
  assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);assert.equal(results[0].data.tasks[0].id,results[1].data.tasks[0].id);assert.equal(results[0].data.warnings.length,2);
  const reused=await f.write(url,{...body,tasks:[{title:'不同内容',estimateHours:8}]});assert.equal(reused.status,409);assert.equal(reused.data.code,'IDEMPOTENCY_CONFLICT');
  const stale=await f.write(url,{...body,requestId:'http-batch-stale-001'});assert.equal(stale.status,409);assert.equal(stale.data.code,'VERSION_CONFLICT');
  const version=results[0].data.requirement.version;
  const invalid=await f.write(url,{version,requestId:'http-batch-invalid-001',tasks:[{title:'无效负责人',ownerId:'unknown-person',estimateHours:8},{title:'无效工时',estimateHours:-1}]});
  assert.equal(invalid.status,400);assert.equal(invalid.data.code,'BATCH_VALIDATION');assert.deepEqual(invalid.data.details.rows.map(x=>x.row),[1,2]);assert.equal(f.db.prepare('SELECT count(*) n FROM tasks').get().n,2);assert.equal(f.app.business.getRequirement(f.admin.user,f.requirement.id).version,version);
});

test('批量排期接口要求有效预览与超期确认，重复提交不重复改期',async t=>{
  const f=await fixture(t);const base=`/api/projects/${f.project.id}/schedule`;
  const changes=[{requirementId:f.requirement.id,version:f.requirement.version,planStart:'2026-09-03',planEnd:'2026-10-15'}];
  const preview=await f.write(base+'/preview',{changes});assert.equal(preview.status,200);assert.equal(preview.data.requiresConfirmation,true);assert(preview.data.previewToken);
  const body={changes,previewToken:preview.data.previewToken,reason:'接口验收调整'};
  assert.equal((await f.write(base+'/apply',{...body,previewToken:'invalid',force:true})).data.code,'SCHEDULE_PREVIEW_STALE');
  const rejected=await f.write(base+'/apply',body);assert.equal(rejected.status,409);assert.equal(rejected.data.code,'SCHEDULE_CONFIRMATION_REQUIRED');assert.equal(f.app.business.getRequirement(f.admin.user,f.requirement.id).planEnd,'2026-09-10');
  const applied=await f.write(base+'/apply',{...body,force:true});assert.equal(applied.status,200);assert.equal(applied.data.changedCount,1);
  const current=f.app.business.getRequirement(f.admin.user,f.requirement.id);assert.equal(current.planEnd,'2026-10-15');assert.equal(current.rescheduleCount,1);assert.equal(current.baseline.planEnd,'2026-09-10');
  const repeat=await f.write(base+'/apply',{...body,force:true});assert.equal(repeat.status,409);assert.equal(f.app.business.getRequirement(f.admin.user,f.requirement.id).rescheduleCount,1);
});

test('附件接口保存两个版本并保留旧地址字节，版本和项目权限不被绕过',async t=>{
  const f=await fixture(t);const url=`/api/requirements/${f.requirement.id}/attachments`;
  const file=content=>({name:'版本验证.html',mime:'text/html',content:Buffer.from(content).toString('base64')});
  const first=await f.write(url,{...file('<h1>第一版</h1>'),expectedVersion:0});assert.equal(first.status,201);
  const second=await f.write(url,{...file('<h1>第二版</h1>'),logicalId:first.data.logicalId,expectedVersion:first.data.version});assert.equal(second.status,201);assert.equal(second.data.version,2);
  const missing=await f.write(url,file('未带版本号'));assert.equal(missing.status,400);assert.equal(missing.data.code,'VERSION_REQUIRED');
  const stale=await f.write(url,{...file('禁止覆盖'),expectedVersion:1});assert.equal(stale.status,409);assert.equal(stale.data.code,'VERSION_CONFLICT');
  const listed=await f.call(url,f.admin);assert.equal(listed.data.attachments.length,1);assert.equal(listed.data.attachments[0].id,second.data.id);
  const versions=await f.call(`/api/attachments/${first.data.id}/versions`,f.admin);assert.equal(versions.status,200);assert.deepEqual(versions.data.versions.map(x=>x.version),[2,1]);
  const old=await f.call(`/api/attachments/${first.data.id}`,f.admin);assert.equal(old.data,'<h1>第一版</h1>');assert.match(old.headers.get('content-security-policy'),/sandbox/);
  const explicit=await f.call(`/api/attachments/${first.data.logicalId}?version=2`,f.admin);assert.equal(explicit.data,'<h1>第二版</h1>');
  assert.equal((await f.call(`/api/attachments/${first.data.id}?version=bad`,f.admin)).status,400);
  const viewer=await f.member('repair-viewer',{role:'viewer'}),outsider=await f.member('repair-outsider');
  assert.equal((await f.call(`/api/attachments/${first.data.id}/versions`,viewer)).status,200);
  assert.equal((await f.write(url,{...file('只读禁止上传'),expectedVersion:2},'POST',viewer)).status,403);
  assert.equal((await f.call(`/api/attachments/${first.data.id}`,outsider)).status,403);assert.equal((await f.call(`/api/attachments/${first.data.id}/versions`,outsider)).status,403);
  assert.equal(f.db.prepare('SELECT count(*) n FROM attachments').get().n,2);
});

test('待办提醒已读接口只接受当前用户可见提醒，并持久保存已读状态',async t=>{
  const f=await fixture(t);const task=await f.write('/api/tasks',{projectId:f.project.id,requirementId:f.requirement.id,title:'逾期提醒验收',ownerId:f.admin.user.id,dueDate:'2026-09-14',estimateHours:8});assert.equal(task.status,201);
  const snapshot=await f.call('/api/work?date=2026-09-15',f.admin);assert.equal(snapshot.status,200);const reminder=snapshot.data.reminders.find(item=>item.entityId===task.data.id);assert(reminder);assert.equal(reminder.read,false);
  const outsider=await f.member('repair-notice-outsider');const forbidden=await f.write('/api/work/read',{ids:[reminder.id],date:'2026-09-15'},'POST',outsider);assert.equal(forbidden.status,404);
  const read=await f.write('/api/work/read',{ids:[reminder.id],date:'2026-09-15'});assert.equal(read.status,200);assert.equal(read.data.readCount,1);
  const again=await f.call('/api/work?date=2026-09-15',f.admin);assert.equal(again.data.reminders.find(item=>item.id===reminder.id).read,true);assert.equal(again.data.unread,0);
  assert.equal((await f.write('/api/work/read',{ids:['z'.repeat(32)],date:'2026-09-15'})).status,400);
});

test('备份接口限管理员，立即返回接受状态且后台失败不泄露路径', {timeout:5000},async t=>{
  let running=false,runCount=0,rejectRun;const pending=new Promise((_resolve,reject)=>{rejectRun=reject;});
  const backupService={status:()=>({enabled:true,running}),runNow(){runCount++;running=true;return pending;}};
  const f=await fixture(t,{backupService});const member=await f.member('repair-backup-member');
  assert.equal((await f.call('/api/admin/backup-status',member)).status,403);assert.equal((await f.write('/api/admin/backup-run',{},'POST',member)).status,403);assert.equal(runCount,0);
  const status=await f.call('/api/admin/backup-status',f.admin);assert.equal(status.status,200);assert.equal(status.data.running,false);
  const accepted=await f.write('/api/admin/backup-run',{});assert.equal(accepted.status,202);assert.equal(accepted.data.running,true);assert.equal(runCount,1);
  // The request above completed while the backup promise was still pending.
  rejectRun(new Error('/private/secret-path/credentials.sqlite'));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.errors.length,1);assert.deepEqual(f.errors[0],{event:'backup_request_failed'});assert.doesNotMatch(JSON.stringify(f.errors),/secret-path|credentials/);
});

test('备份未配置或关闭时返回明确状态且不触发备份',async t=>{
  const unavailable=await fixture(t);assert.equal((await unavailable.call('/api/admin/backup-status',unavailable.admin)).status,503);
  let calls=0;const disabled=await fixture(t,{backupService:{status:()=>({enabled:false,running:false,lastError:null}),runNow:async()=>{calls++;}}});
  assert.equal((await disabled.call('/api/admin/backup-status',disabled.admin)).status,200);
  const rejected=await disabled.write('/api/admin/backup-run',{});assert.equal(rejected.status,409);assert.equal(rejected.data.code,'BACKUP_DISABLED');assert.equal(calls,0);
});
