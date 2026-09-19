import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {PassThrough} from 'node:stream';
import {openDatabase} from '../database.mjs';
import {createApplication} from '../server.mjs';
import {importLegacy} from '../scripts/import-legacy.mjs';
import {createTimelineState,moveTimeline,renderTimeline,resolveTimelineRange} from '../../frontend/timeline.js';
import * as workflow from '../../frontend/workflow.js';
import * as reviewUI from '../../frontend/review-ui.js';
import * as batchUI from '../../frontend/task-batch.js';
import * as workUI from '../../frontend/work-ui.js';
import {renderDocumentPreview} from '../../frontend/document-preview.js';
import * as uiKit from '../../frontend/ui-kit.js';
import {webcrypto} from 'node:crypto';

// This harness checks the actual frontend's rendering and request functions
// against the real request handler and database. It does not emulate layout or
// claim to replace a browser: DOM nodes here are intentionally small test doubles.
async function fixture(t,{initialize=true,setupToken='',hash='#/team',recoveryLink=false,recoveryUsername='manager',recoveryPurpose='admin-reset'}={}){
  const db=openDatabase(':memory:');importLegacy(db);
  const app=createApplication({db,publicOrigin:'http://127.0.0.1:3000',secureCookies:false,setupToken,logger:{info(){},error(){}}});
  const admin=initialize?await app.auth.bootstrapAdmin({username:'manager',name:'项目管理员',password:'Frontend-Test-Only!2026'}):null;
  const session=initialize?await app.auth.login({username:'manager',password:'Frontend-Test-Only!2026',ip:'test'}):null;
  const recovery=recoveryLink?app.auth.resetPassword(admin,admin.id):null;
  if(recovery)hash='#'+new URLSearchParams({activate:recovery.token,purpose:recoveryPurpose,username:recoveryUsername});
  let cookie=session?.cookie.split(';')[0]||'',csrf=session?.csrfToken||'';
  t.after(()=>db.close());
  async function request(url,{method='GET',body,headers:extraHeaders={}}={}){
    const req=new PassThrough();req.url=url;req.method=method;req.headers={cookie,'x-csrf-token':csrf,...Object.fromEntries(Object.entries(extraHeaders).map(([key,value])=>[key.toLowerCase(),value])),...(body!==undefined?{'content-type':'application/json'}:{})};req.socket={remoteAddress:'test'};
    return await new Promise((resolve,reject)=>{
      const headers=new Headers();const res={statusCode:200,headersSent:false,setHeader(k,v){headers.set(k,v);},writeHead(status,values={}){this.statusCode=status;this.headersSent=true;for(const[k,v]of Object.entries(values))headers.set(k,v);},end(value){const bytes=Buffer.isBuffer(value)?value:Buffer.from(value||'');let data;try{data=JSON.parse(bytes.toString());}catch{data=undefined;}if(headers.get('set-cookie'))cookie=headers.get('set-cookie').split(';')[0];if(data?.csrfToken)csrf=data.csrfToken;resolve({status:this.statusCode,ok:this.statusCode<400,headers,bytes,data});}};
      app.handler(req,res).catch(reject);req.end(body!==undefined?JSON.stringify(body):undefined);
    });
  }
  const elements=new Map(),listeners={};
  function element(key){if(!elements.has(key))elements.set(key,{innerHTML:'',dataset:{},hidden:false,open:false,value:'',disabled:false,style:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},querySelector:selector=>element(selector),querySelectorAll:()=>[],setAttribute(){},focus(){},select(){},click(){},showModal(){this.open=true;},close(){this.open=false;},getBoundingClientRect(){return{left:0,top:0,right:100,bottom:100};}});return elements.get(key);}
  class MockForm {constructor(kind,entries,id=''){this.dataset={kind,id,projectId:'p-exec'};this.entries=Object.entries(entries);this.id='entity-form';}querySelector(selector){return element(selector);}}
  class MockFormData {constructor(form){this.values=form.entries;}[Symbol.iterator](){return this.values[Symbol.iterator]();}getAll(key){return this.values.filter(entry=>entry[0]===key).map(entry=>entry[1]);}}
  const api=async(path,options={})=>{const result=await request('/api'+path,options);if(!result.ok)throw Object.assign(new Error(result.data.error),{status:result.status,code:result.data.code});return result.data;};
  const context=vm.createContext({...uiKit,...workflow,...reviewUI,...batchUI,...workUI,renderDocumentPreview,crypto:webcrypto,sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},createTimelineState,moveTimeline,renderTimeline,resolveTimelineRange,document:{querySelector:element,querySelectorAll:()=>[],addEventListener(name,fn){listeners[name]=fn;},visibilityState:'visible',body:element('body'),activeElement:element('active'),createElement:element},window:{addEventListener(){},scrollY:0,scrollTo(){}},location:{origin:'http://127.0.0.1:3000',pathname:'/',search:'',hash},history:{replaceState(_state,_title,url){const parsed=new URL(url,'http://127.0.0.1:3000');context.location.hash=parsed.hash;context.location.search=parsed.search;}},URL,URLSearchParams,TextDecoder,TextEncoder,Blob,Uint8Array,atob,btoa,console,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,requestAnimationFrame:fn=>fn(),navigator:{clipboard:{writeText:async()=>{}}},HTMLFormElement:MockForm,FormData:MockFormData,api,rows:(v,key)=>Array.isArray(v)?v:v?.[key]||[],setCsrf(value){csrf=value;},fetch:async(url,options={})=>{const response=await request(url,options);return {...response,json:async()=>response.data,arrayBuffer:async()=>response.bytes.buffer.slice(response.bytes.byteOffset,response.bytes.byteOffset+response.bytes.byteLength),blob:async()=>new Blob([response.bytes],{type:response.headers.get('content-type')})};}});
  const source=fs.readFileSync(new URL('../../frontend/app.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/\nboot\(\);\s*$/,'');
  vm.runInContext(source,context);
  if(admin){
    context.fixtureState=JSON.stringify({...app.business.bootstrap(admin,{includeArchived:true}),currentUser:admin});
    vm.runInContext('data=JSON.parse(fixtureState);user=data.currentUser;selectedProject="p-exec";route={view:"overview",projectId:"p-exec"};',context);
  }
  const become=async(id)=>{
    const target=app.auth.listUsers(admin).find(item=>item.id===id);
    const reset=app.auth.resetPassword(admin,id);await app.auth.redeemToken({token:reset.token,password:'Assigned-Role-Test!2026'});
    const login=await app.auth.login({username:target.username,password:'Assigned-Role-Test!2026',ip:'test'});cookie=login.cookie.split(';')[0];csrf=login.csrfToken;
    context.fixtureState=JSON.stringify({...app.business.bootstrap(login.user,{includeArchived:true}),currentUser:login.user});
    vm.runInContext('data=JSON.parse(fixtureState);user=data.currentUser;',context);
  };
  return{app,db,context,elements,element,MockForm,listeners,become,recovery,run:code=>vm.runInContext(code,context),api,request};
}

test('实际前端用原中文任务状态统计与筛选，项目选择在所属功能上方',async t=>{
  const f=await fixture(t);f.run('renderShell()');
  const shell=f.element('#app').innerHTML;
  assert.ok(shell.indexOf('id="project-switch"')<shell.indexOf('aria-label="当前项目功能"'));
  assert.match(shell,/自研 API 聚合平台/);
  assert.equal(f.run('data.tasks.filter(item=>taskStage(item.status)==="done").length'),11);
  assert.equal(f.run('data.tasks.filter(item=>taskStage(item.status)==="develop").length'),4);
  f.run('route.view="tasks";ui.status="done";');
  assert.ok(f.run('filtered("tasks").length')>0);
  f.run('route={view:"team",projectId:""};renderShell()');
  assert.ok(!f.element('#app').innerHTML.includes('<strong>项目概览</strong>'));
});

test('团队待办排除已终止任务与归档项目，完成率明确使用非终止任务',async t=>{
  const f=await fixture(t);
  f.context.fixtureTasks=[
    {id:'closed-test',projectId:'p-exec',ownerId:'u-manager',title:'不应出现在待办的已终止任务',status:'已终止',dueDate:'2020-01-01'},
    {id:'live-test',projectId:'p-exec',ownerId:'u-manager',title:'仍需完成的工作',status:'待开始',dueDate:'2030-01-02'},
    {id:'archived-test',projectId:'p-res',ownerId:'u-manager',title:'已归档项目的工作',status:'待开始',dueDate:'2020-01-01'}
  ];
  f.run('data.tasks=fixtureTasks;data.projects.find(p=>p.id==="p-res").archived=true;route={view:"team",projectId:""};');
  const team=f.run('teamView()');
  assert.match(team,/仍需完成的工作/);assert.doesNotMatch(team,/不应出现在待办的已终止任务|已归档项目的工作/);
  assert.match(team,/未完成且未终止的任务/);
  f.run('route={view:"overview",projectId:"p-exec"};');
  const overview=f.run('overviewView()');
  assert.doesNotMatch(overview,/不应出现在待办的已终止任务/);assert.match(overview,/非终止任务/);
  assert.match(f.run('projectCard(projectOf(),0)'),/0% · 0 \/ 1/);
});

test('项目卡显示负责人和完成率口径，空项目不显示虚构百分比，概览不显示无效搜索',async t=>{
  const f=await fixture(t);
  const card=f.run('projectCard(projectOf(),0)');
  assert.match(card,/负责人|我的角色|目标交付/);assert.match(card,/任务完成率/);
  f.run('data.tasks=[];');assert.match(f.run('projectCard(projectOf(),0)'),/暂无任务/);
  f.run('route={view:"overview",projectId:"p-exec"};renderShell();');
  assert.doesNotMatch(f.element('#app').innerHTML,/id="search"/);
  f.run('route.view="tasks";renderShell();');
  assert.match(f.element('#app').innerHTML,/aria-label="搜索任务"/);
  assert.match(f.element('#app').innerHTML,/aria-label="项目空间"/);
});

test('排期页面接通全局视图、缩放档位、自定义日期与独立项目状态，切换项目保留排期设置',async t=>{
  const f=await fixture(t);
  const click=async dataset=>{const button={dataset,disabled:false,setAttribute(){}};await f.listeners.click({target:{closest:()=>button}});};
  f.run('route={view:"timeline",projectId:"p-exec"};renderShell();');
  const html=f.element('#view').innerHTML;
  assert.match(html,/data-timeline-fit/);assert.match(html,/data-timeline-zoom="in"/);assert.match(html,/data-timeline-zoom="out"/);
  await click({timelineFit:''});assert.equal(f.run('timelineState().fit'),true);
  assert.match(f.element('#view').innerHTML,/data-timeline-fit aria-pressed="true"/);
  await click({timelineFit:''});assert.equal(f.run('timelineState().fit'),false);assert.equal(f.run('timelineState().mode'),'month');
  await click({timelineZoom:'in'});
  await click({timelineMode:'custom'});
  for(const [key,value] of [['start','2025-02-01'],['end','2027-03-31']])await f.listeners.change({target:{dataset:{timelineDate:key},value}});
  assert.equal(f.run('timelineState().mode'),'custom');
  assert.equal(f.run('resolveTimelineRange(timelineState(),timelineContext()).end'),'2027-03-31');
  await click({timelineMode:'quarter'});assert.equal(f.run('timelineState().mode'),'quarter');assert.equal(f.run('timelineState().zoom'),null);
  await click({timelineFit:''});
  await click({switchProject:'p-res'});
  assert.equal(f.context.location.hash,'#/p/p-res/timeline');
  f.run('readRoute();renderShell();');assert.equal(f.run('timelineState().mode'),'month');assert.ok(!f.run('timelineState().fit'));
  await click({switchProject:'p-exec'});
  f.run('readRoute();renderShell();');assert.equal(f.run('timelineState().fit'),true);
  await f.listeners.change({target:{dataset:{timelineFilter:'status'},value:'develop'}});
  assert.equal(f.run('timelineState().status'),'develop');
  await click({action:'timeline-reset'});assert.equal(f.run('timelineState().status'),'all');
});

test('实际前端新建与编辑表单通过服务器校验并保留未修改的旧状态',async t=>{
  const f=await fixture(t);
  f.context.form=new f.MockForm('projects',{name:'前端表单验收',description:'测试表单到服务器',ownerId:f.run('user.id'),status:'规划中',startDate:'2026-09-15',targetDate:'2026-10-15',milestones:'验收完成 | 2026-10-15'});
  await f.run('saveEntity(form)');
  const p=f.app.business.bootstrap(f.run('user')).projects.find(item=>item.name==='前端表单验收');
  assert.equal(p.milestones[0].label,'验收完成');assert.equal(p.milestones[0].kind,'checkpoint');
  f.context.form=new f.MockForm('requirements',{title:'前端创建需求',description:'验收背景',acceptance:'通过即可',priority:'P1',status:'未确定',assigneeId:'',estimatePoints:'3',planStart:'',planEnd:'',source:'测试'});
  await f.run('saveEntity(form)');
  const req=f.app.business.bootstrap(f.run('user')).requirements.find(item=>item.title==='前端创建需求');assert.ok(req);assert.equal(req.assigneeId,'');
  const old=f.run('data.tasks.find(item=>item.projectId==="p-exec"&&item.status==="待开始")');
  f.context.form=new f.MockForm('tasks',{title:old.title+'（表单验收）',requirementId:old.requirementId,ownerId:old.ownerId,status:'wait',startDate:old.startDate||'',dueDate:old.dueDate||'',estimateHours:String(old.estimateHours)},old.id);
  await f.run('saveEntity(form)');
  const updated=f.app.business.getTask(f.run('user'),old.id);assert.equal(updated.status,'待开始');assert.equal(updated.estimateHours,old.estimateHours);
});

test('实际前端读取二进制旧附件并以受限正文显示',async t=>{
  const f=await fixture(t);
  await f.run('attachment("legacy-r-q1-doc")');
  assert.match(f.element('#dialog').innerHTML,/服务质量|履约口径|attachment-text/);
  await f.run('attachment("legacy-r-q1-proto")');
  assert.match(f.element('#dialog').innerHTML,/sandbox=""/);
  assert.match(f.element('#prototype-frame').srcdoc,/default-src 'none'/);
});

test('实际账号表单支持开户、停用未激活账号及重新发激活链接',async t=>{
  const f=await fixture(t);
  f.context.form=new f.MockForm('users',{name:'表单账号',username:'form-member',role:'member'});
  await f.run('saveEntity(form)');
  assert.match(f.element('#dialog').innerHTML,/#activate=/);
  assert.doesNotMatch(f.element('#dialog').innerHTML,/\?token=/);
  const account=f.app.auth.listUsers(f.run('user')).find(item=>item.username==='form-member');assert.equal(account.status,'pending');
  f.context.form=new f.MockForm('users',{name:account.name,username:account.username,role:'member',status:'disabled'},account.id);
  await f.run('saveEntity(form)');
  assert.equal(f.app.auth.listUsers(f.run('user')).find(item=>item.id===account.id).status,'disabled');
  f.context.form=new f.MockForm('users',{name:account.name,username:account.username,role:'member',status:'active'},account.id);
  await f.run('saveEntity(form)');
  assert.equal(f.app.auth.listUsers(f.run('user')).find(item=>item.id===account.id).status,'pending');
  assert.match(f.element('#dialog').innerHTML,/重新启用账号的激活链接/);
  const token=f.run('transientToken');assert.ok(token);
  await f.api('/auth/activate',{method:'POST',body:{token,password:'Member-Activation!2026'}});
  assert.equal((await f.app.auth.login({username:account.username,password:'Member-Activation!2026',ip:'test'})).user.id,account.id);
});

test('本人重置密码先保留一次性链接，关闭后才返回登录',async t=>{
  const f=await fixture(t),adminId=f.run('user.id');
  const button={dataset:{action:'confirm-reset',userId:adminId},disabled:false,setAttribute(){}};
  await f.listeners.click({target:{closest(){return button;}}});
  assert.ok(f.run('user'));
  assert.match(f.element('#dialog').innerHTML,/#activate=/);
  const token=f.run('transientToken');assert.ok(token);
  await assert.rejects(f.app.auth.login({username:'manager',password:'Frontend-Test-Only!2026',ip:'test'}));
  f.run('closeDialog()');assert.equal(f.run('user'),null);
  await f.api('/auth/activate',{method:'POST',body:{token,password:'Reset-Account-Only!2026'}});
  assert.equal((await f.app.auth.login({username:'manager',password:'Reset-Account-Only!2026',ip:'test'})).user.id,adminId);
});

test('开发人员通过实际表单流转本人需求，只修改允许字段',async t=>{
  const f=await fixture(t);
  const req=f.run('data.requirements.find(item=>item.status==="开发中"&&data.memberships.some(m=>m.projectId===item.projectId&&m.userId===item.assigneeId&&m.role==="developer"))');
  assert.ok(req,'真实快照中需有指派给开发的进行中需求');
  if(!req.acceptance)f.app.business.updateRequirement(f.run('user'),req.id,{version:req.version,acceptance:'验收满足原目标'});
  // A requirement enters testing only after every live task has been submitted for testing.
  for(let task of f.run('data.tasks').filter(item=>item.requirementId===req.id&&!item.archived)){
    for(const next of ({wait:['develop','test'],'待开始':['develop','test'],develop:['test'],'开发中':['test']}[task.status]||[]))task=f.app.business.updateTask(f.run('user'),task.id,{version:task.version,status:next});
  }
  await f.become(req.assigneeId);
  f.context.form=new f.MockForm('requirements',{status:'测试中',reason:'提交验收'},req.id);
  await f.run('saveEntity(form)');
  const saved=f.app.business.getRequirement(f.run('user'),req.id);
  assert.equal(saved.status,'测试中');assert.equal(saved.title,req.title);assert.equal(saved.assigneeId,req.assigneeId);
});

test('主开发通过实际表单只提交允许字段，产品看不到建任务入口，管理层身份在界面标明',async t=>{
  const f=await fixture(t);
  const req=f.run('data.requirements.find(item=>item.projectId==="p-exec"&&item.status==="已确定"&&!item.archived)')||f.run('data.requirements.find(item=>item.projectId==="p-exec"&&!item.archived)');
  const project=f.app.business.getProject(f.run('user'),'p-exec');
  const lead=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  f.app.business.setMember(f.run('user'),'p-exec',{userId:lead,role:'lead',version:project.version});
  await f.become(lead);
  assert.equal(f.run('projectRole("p-exec")'),'lead');
  assert.equal(f.run('canCreateTask("p-exec")'),true);assert.equal(f.run('canEdit("p-exec")'),false);
  f.context.form=new f.MockForm('requirements',{title:'主开发不能改标题',description:'不能改',status:req.status,assigneeId:lead,planStart:'2026-10-01',planEnd:'2026-10-20'},req.id);
  await f.run('saveEntity(form)');
  const saved=f.app.business.getRequirement(f.run('user'),req.id);
  assert.equal(saved.title,req.title);assert.equal(saved.description,req.description);assert.equal(saved.assigneeId,lead);assert.equal(saved.planEnd,'2026-10-20');
  const product=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="product").userId');
  await f.become(product);
  assert.equal(f.run('canCreateTask("p-exec")'),false);
  f.run('route={view:"tasks",projectId:"p-exec"}');
  assert.doesNotMatch(f.run('tasksView()'),/data-action="new-task"/);
  f.run('user={...user,executive:true}');assert.equal(f.run('roleLabel("p-exec")'),'产品经理');
  f.run('data.memberships=data.memberships.filter(m=>m.userId!==user.id)');assert.equal(f.run('roleLabel("p-exec")'),'管理层 · 只读');assert.equal(f.run('projectRole("p-exec")'),'executive');
});

test('网页初始化仅在缺少管理员且携带启动入口令牌时显示，令牌不进入页面内容',async t=>{
  const token='s'.repeat(43);
  const f=await fixture(t,{initialize:false,setupToken:token,hash:'#setup='+token});
  assert.equal(f.context.location.hash,'');
  await f.run('boot()');
  const html=f.element('#app').innerHTML;
  assert.match(html,/创建首个管理员账号/);
  assert.match(html,/data-kind="setup"/);
  for(const name of ['username','name','newPassword','confirmPassword'])assert.ok(html.includes('name="'+name+'"'));
  assert.match(html,/minlength="6"/);assert.doesNotMatch(html,/minlength="12"/);
  assert.doesNotMatch(html,new RegExp(token));
  assert.equal(f.run('setupAllowed'),true);
  const anonymous=await f.request('/api/setup/status');
  assert.equal(anonymous.data.required,true);
  assert.equal(Object.hasOwn(anonymous.data,'suggestedName'),false);
  assert.equal(Object.hasOwn(anonymous.data,'suggestedUsername'),false);
});

test('没有启动令牌或初始化未启用时，网页仅显示初始化入口说明',async t=>{
  const missing=await fixture(t,{initialize:false,setupToken:'s'.repeat(43)});
  await missing.run('boot()');
  assert.match(missing.element('#app').innerHTML,/请从应用启动入口打开初始化页面/);
  assert.doesNotMatch(missing.element('#app').innerHTML,/data-kind="setup"/);
  assert.doesNotMatch(missing.element('#app').innerHTML,/name="newPassword"/);
  assert.equal(missing.run('setupAllowed'),false);
  const disabled=await fixture(t,{initialize:false,hash:'#setup=unavailable-setup-token'});
  await disabled.run('boot()');
  assert.match(disabled.element('#app').innerHTML,/初始化入口暂未启用/);
  assert.doesNotMatch(disabled.element('#app').innerHTML,/data-kind="setup"/);
});

test('网页初始化提交六位密码后创建管理员并自动登录，沿用原管理员人员记录',async t=>{
  const token='s'.repeat(43);
  const f=await fixture(t,{initialize:false,setupToken:token,hash:'#setup='+token});
  await f.run('boot()');
  const before=f.db.prepare('SELECT count(*) AS count FROM users').get().count;
  const form=new f.MockForm('setup',{username:'manager',name:'网页管理员',newPassword:'Ab1234',confirmPassword:'Ab1234'});form.id='auth-form';
  await f.listeners.submit({target:form,preventDefault(){}});
  assert.equal(f.run('user.role'),'admin');
  assert.equal(f.run('user.username'),'manager');
  assert.equal(f.run('user.name'),'网页管理员');
  assert.equal(f.run('route.view'),'team');
  assert.equal(f.run('setupAllowed'),false);assert.equal(f.run('setupToken'),'');
  assert.equal(f.db.prepare('SELECT count(*) AS count FROM users').get().count,before);
  assert.match(f.element('#app').innerHTML,/团队工作台/);
  assert.equal((await f.request('/api/auth/me')).status,200);
  assert.equal((await f.request('/api/setup/status')).data.required,false);
});

test('初始化密码不足六位或两次不一致不会创建账号，已有管理员不会被初始化覆盖',async t=>{
  const token='s'.repeat(43);
  const f=await fixture(t,{initialize:false,setupToken:token,hash:'#setup='+token});
  await f.run('boot()');
  for(const [password,confirmation,message] of [['Ab123','Ab123','至少 6 个字符'],['Ab1234','Ab1235','不一致']]){
    const form=new f.MockForm('setup',{username:'manager',name:'网页管理员',newPassword:password,confirmPassword:confirmation});form.id='auth-form';
    await f.listeners.submit({target:form,preventDefault(){}});
    assert.ok(f.element('#auth-error').innerHTML.includes(message));
    assert.equal((await f.request('/api/setup/status')).data.required,true);
  }
  const existing=await fixture(t,{setupToken:token,hash:'#setup='+token});
  const originalName=existing.run('user.name');
  await existing.run('boot()');
  assert.equal(existing.run('setupAllowed'),false);assert.equal(existing.run('setupToken'),'');
  assert.doesNotMatch(existing.element('#app').innerHTML,/data-kind="setup"/);
  assert.equal(existing.run('user.name'),originalName);
  const denied=await existing.request('/api/setup/admin',{method:'POST',body:{username:'manager',name:'不得覆盖',password:'Ab1234',setupToken:token}});
  assert.equal(denied.status,409);
  assert.equal((await existing.app.auth.login({username:'manager',password:'Frontend-Test-Only!2026',ip:'test'})).user.name,originalName);
});

test('激活页、强制改密页和本人改密弹窗均使用六位最低长度',async t=>{
  const f=await fixture(t);
  for(const kind of ['activate','password']){
    f.run('renderAuth('+JSON.stringify(kind)+')');
    const html=f.element('#app').innerHTML;
    assert.match(html,/minlength="6"/);assert.match(html,/至少 6 个字符/);
    assert.doesNotMatch(html,/minlength="12"|至少 12 位/);
  }
  f.run('passwordDialog()');
  assert.match(f.element('#dialog').innerHTML,/minlength="6"/);
  assert.doesNotMatch(f.element('#dialog').innerHTML,/minlength="12"|至少 12 位/);
});

test('初始化令牌错误时网页不再保留可提交表单，且不会创建管理员',async t=>{
  const f=await fixture(t,{initialize:false,setupToken:'s'.repeat(43),hash:'#setup='+'x'.repeat(43)});
  await f.run('boot()');
  const form=new f.MockForm('setup',{username:'manager',name:'网页管理员',newPassword:'Ab1234',confirmPassword:'Ab1234'});form.id='auth-form';
  await f.listeners.submit({target:form,preventDefault(){}});
  assert.equal(f.run('setupAllowed'),false);assert.equal(f.run('setupToken'),'');
  assert.match(f.element('#app').innerHTML,/初始化链接无效/);
  assert.doesNotMatch(f.element('#app').innerHTML,/data-kind="setup"/);
  assert.equal((await f.request('/api/setup/status')).data.required,true);
});

test('网页与服务器均按统一字符计数：五个补充字符不够，六个可以初始化',async t=>{
  const token='s'.repeat(43),f=await fixture(t,{initialize:false,setupToken:token,hash:'#setup='+token});
  await f.run('boot()');
  const short='😀'.repeat(5),long='😀'.repeat(6);
  const invalid=new f.MockForm('setup',{username:'manager',name:'字符计数验证',newPassword:short,confirmPassword:short});invalid.id='auth-form';
  await f.listeners.submit({target:invalid,preventDefault(){}});
  assert.match(f.element('#auth-error').innerHTML,/密码至少 6 个字符/);
  assert.equal((await f.request('/api/setup/status')).data.required,true);
  const valid=new f.MockForm('setup',{username:'manager',name:'字符计数验证',newPassword:long,confirmPassword:long});valid.id='auth-form';
  await f.listeners.submit({target:valid,preventDefault(){}});
  assert.equal(f.run('user.role'),'admin');
  assert.equal((await f.app.auth.login({username:'manager',password:long,ip:'test'})).user.id,f.run('user.id'));
});

test('管理员已创建但工作台载入失败时返回登录，保留账号和会话且不重新初始化',async t=>{
  const token='s'.repeat(43),f=await fixture(t,{initialize:false,setupToken:token,hash:'#setup='+token});
  await f.run('boot()');
  let setupPosts=0,clearedCsrf=false;
  const setCsrf=f.context.setCsrf;
  f.context.setCsrf=value=>{if(value==='')clearedCsrf=true;setCsrf(value);};
  f.context.api=async(path,options={})=>{
    if(path==='/setup/admin')setupPosts++;
    if(path.startsWith('/bootstrap'))throw new Error('模拟工作台载入失败');
    return f.api(path,options);
  };
  const form=new f.MockForm('setup',{username:'manager',name:'载入失败验证',newPassword:'Ab1234',confirmPassword:'Ab1234'});form.id='auth-form';
  await f.listeners.submit({target:form,preventDefault(){}});
  assert.equal(setupPosts,1);
  assert.equal(f.run('user'),null);assert.equal(clearedCsrf,true);
  assert.equal(f.run('setupAllowed'),false);assert.equal(f.run('setupToken'),'');
  const html=f.element('#app').innerHTML;
  assert.match(html,/data-kind="login"/);assert.doesNotMatch(html,/data-kind="setup"/);
  assert.match(html,/管理员账号已创建，但工作台载入失败。请使用刚设置的账号和密码登录。/);
  assert.equal((await f.request('/api/setup/status')).data.required,false);
  assert.equal((await f.request('/api/auth/me')).status,200,'初始化成功的会话cookie未被删除');
  f.context.api=f.api;
  const login=new f.MockForm('login',{username:'manager',password:'Ab1234'});login.id='auth-form';
  await f.listeners.submit({target:login,preventDefault(){}});
  assert.equal(f.run('user.role'),'admin');
  assert.match(f.element('#app').innerHTML,/团队工作台/);
});


test('未登录页面提供管理员忘记密码入口和本机、服务器恢复说明',async t=>{
  const f=await fixture(t);
  await f.api('/auth/logout',{method:'POST'});f.run('user=null');
  await f.run('boot()');
  const html=f.element('#app').innerHTML;
  assert.match(html,/data-action="recover-admin"/);
  assert.match(html,/忘记管理员密码？/);
  assert.match(html,/没有账号或忘记成员密码/);
  const button={dataset:{action:'recover-admin'},disabled:false,setAttribute(){}};
  await f.listeners.click({target:{closest(){return button;}}});
  const help=f.element('#dialog').innerHTML;
  assert.match(help,/重置管理员密码\.command/);
  assert.match(help,/浏览器会打开设置新密码页面/);
  assert.match(help,/拥有服务器访问权限/);
  assert.equal(f.element('#dialog').open,true);
  assert.doesNotMatch(help,/name="password"|name="newPassword"/);
});

test('管理员恢复链接在网页校验六位密码并重设真实账号，旧密码失效且新密码可登录',async t=>{
  const f=await fixture(t,{recoveryLink:true});f.run('user=null');
  assert.equal(f.context.location.hash,'');
  await f.run('boot()');
  const html=f.element('#app').innerHTML;
  assert.match(html,/<h2>重置管理员密码<\/h2>/);
  assert.match(html,/<strong>manager<\/strong>/);
  assert.match(html,/name="newPassword"/);assert.match(html,/name="confirmPassword"/);
  assert.match(html,/minlength="6"/);assert.doesNotMatch(html,new RegExp(f.recovery.token));
  for(const [password,confirmation,message]of [['Ab123','Ab123','至少 6 个字符'],['Ab1234','Ab1235','不一致']]){
    const form=new f.MockForm('activate',{newPassword:password,confirmPassword:confirmation});form.id='auth-form';
    await f.listeners.submit({target:form,preventDefault(){}});
    assert.ok(f.element('#auth-error').innerHTML.includes(message));
    assert.ok(f.db.prepare('SELECT 1 FROM account_tokens').get());
  }
  const submitted=[];
  f.context.api=async(path,options={})=>{if(path==='/auth/activate')submitted.push(options.body);return f.api(path,options);};
  const form=new f.MockForm('activate',{newPassword:'Ab1234',confirmPassword:'Ab1234'});form.id='auth-form';
  await f.listeners.submit({target:form,preventDefault(){}});
  assert.equal(submitted.length,1);
  assert.equal(Object.hasOwn(submitted[0],'username'),false,'恢复账号只由后端令牌决定');
  assert.equal(f.run('activationToken'),'');
  const loginHtml=f.element('#app').innerHTML;
  assert.match(loginHtml,/data-kind="login"/);
  assert.match(loginHtml,/name="username" value="manager"/);
  assert.match(loginHtml,/管理员密码已重置，请使用下方账号和新密码登录/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM account_tokens').get().n,0);
  await assert.rejects(f.app.auth.login({username:'manager',password:'Frontend-Test-Only!2026',ip:'test'}));
  const login=new f.MockForm('login',{username:'manager',password:'Ab1234'});login.id='auth-form';
  await f.listeners.submit({target:login,preventDefault(){}});
  assert.equal(f.run('user.username'),'manager');assert.equal(f.run('user.role'),'admin');
  assert.match(f.element('#app').innerHTML,/团队工作台/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM projects').get().n,3);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM requirements').get().n,55);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM tasks').get().n,79);
  assert.equal((await f.request('/api/auth/activate',{method:'POST',body:{token:f.recovery.token,password:'Second-Reset!'}})).status,400);
});

test('恢复链接的账号提示被转义，密码保存后使用后端返回的真实账号预填登录',async t=>{
  const hint='"><img src=x onerror=alert(1)>&';
  const f=await fixture(t,{recoveryLink:true,recoveryUsername:hint});f.run('user=null');
  await f.run('boot()');
  const html=f.element('#app').innerHTML;
  assert.doesNotMatch(html,/<img|onerror=alert\(1\)>/);
  assert.match(html,/&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;/);
  const form=new f.MockForm('activate',{newPassword:'Ab1234',confirmPassword:'Ab1234'});form.id='auth-form';
  await f.listeners.submit({target:form,preventDefault(){}});
  assert.match(f.element('#app').innerHTML,/name="username" value="manager"/);
  assert.doesNotMatch(f.element('#app').innerHTML,/onerror=alert/);
  assert.equal((await f.app.auth.login({username:'manager',password:'Ab1234',ip:'test'})).user.role,'admin');
});

test('普通一次性激活或重置链接保留原有页面和提交路径',async t=>{
  const f=await fixture(t,{recoveryLink:true,recoveryPurpose:''});f.run('user=null');
  await f.run('boot()');
  assert.match(f.element('#app').innerHTML,/激活账号 \/ 重置密码/);
  assert.doesNotMatch(f.element('#app').innerHTML,/<h2>重置管理员密码<\/h2>/);
  const form=new f.MockForm('activate',{newPassword:'Ab1234',confirmPassword:'Ab1234'});form.id='auth-form';
  await f.listeners.submit({target:form,preventDefault(){}});
  assert.match(f.element('#app').innerHTML,/密码已设置，请使用账号和新密码登录/);
  assert.equal((await f.app.auth.login({username:'manager',password:'Ab1234',ip:'test'})).user.username,'manager');
});

test('个人工作、站内提醒、交付报表接通真实接口并只在管理员导航显示备份',async t=>{
  const f=await fixture(t);
  for(const view of ['personal','notifications','reports']) {
    f.context.targetView=view;f.run('route={view:targetView,projectId:""};');
    await f.run('workView()');
    assert.doesNotMatch(f.element('#view').innerHTML,/内容未能载入/);
  }
  assert.match(f.element('#view').innerHTML,/跨项目交付风险|最近八周变化/);
  f.run('renderShell()');assert.match(f.element('#app').innerHTML,/href="#\/operations"/);
  await f.become('u-dev1');f.run('route={view:"team",projectId:""};renderShell()');
  assert.doesNotMatch(f.element('#app').innerHTML,/href="#\/operations"/);
  assert.match(f.element('#app').innerHTML,/href="#\/personal"|href="#\/notifications"/);
});

test('前端需求和任务编辑暴露依赖选择，未完成前置任务时不提供开工状态',async t=>{
  const f=await fixture(t);
  const task=f.run('data.tasks.find(item=>item.projectId==="p-exec"&&taskStage(item.status)==="wait")');
  f.context.taskId=task.id;
  f.run('editTask(taskId)');assert.match(f.element('#dialog').innerHTML,/前置任务|name="dependencyIds"/);
  assert.doesNotMatch(f.run('taskOptions("wait","p-exec",{dependencyIds:["missing-task"]})'),/value="develop"/);
  f.context.reqId=f.run('data.requirements.find(item=>item.projectId==="p-exec").id');
  f.run('editRequirement(reqId)');assert.match(f.element('#dialog').innerHTML,/前置需求|name="dependencyIds"/);
});

test('自动同步：只读页面拉取他人修改后重绘，打开弹窗或正在输入时只更新数据不打断',async t=>{
  const f=await fixture(t);
  f.run('route={view:"overview",projectId:"p-exec"};renderShell();');
  await f.run('reload()');f.element('#project-menu').hidden=true;
  const rename=name=>{const row=f.db.prepare("SELECT data FROM projects WHERE id='p-exec'").get();f.db.prepare("UPDATE projects SET data=?,version=version+1 WHERE id='p-exec'").run(JSON.stringify({...JSON.parse(row.data),name}));};
  rename('同事改过的项目名');
  await f.run('autoRefresh()');
  assert.match(f.element('#app').innerHTML,/同事改过的项目名/);
  assert.match(f.element('[data-sync-note]').textContent,/数据更新于 \d{2}:\d{2}/);
  f.element('#dialog').open=true;rename('弹窗期间的新名字');
  await f.run('autoRefresh()');
  assert.doesNotMatch(f.element('#app').innerHTML,/弹窗期间的新名字/);
  assert.equal(f.run('projectOf("p-exec").name'),'同事改过的项目名');
  f.element('#dialog').open=false;f.run('route={view:"requirements",projectId:"p-exec"};');
  assert.equal(f.run('canAutoRefresh()'),false);
});
