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
import {renderDocumentPreview,renderFeaturePreview} from '../../frontend/document-preview.js';
import * as docSections from '../../frontend/doc-sections.js';
import * as portfolioUI from '../../frontend/portfolio.js';
import * as taskGroupsUI from '../../frontend/task-groups.js';
import * as requirementUI from '../../frontend/requirements-ui.js';
import * as documentsUI from '../../frontend/documents-ui.js';
import * as documentLinkFields from '../../frontend/document-link-fields.js';
import * as uiKit from '../../frontend/ui-kit.js';
import * as projectDirectoryUI from '../../frontend/project-directory.js';
import * as workbenchModel from '../../frontend/workbench-model.js';
import * as workbenchUI from '../../frontend/workbench-ui.js';
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
  class MockForm {
    constructor(kind,entries,id='') {
      this.dataset={kind,id,projectId:'p-exec'};this.entries=Object.entries(entries);this.id='entity-form';
      // Capture the entity version when the form is created, never when it is saved.
      if(id&&['projects','requirements','tasks'].includes(kind)) {
        const item=vm.runInContext('data',context)[kind].find(record=>record.id===id);
        if(item)this.dataset.version=String(item.version);
      }
    }
    querySelector(selector){return element(selector);}
  }
  class MockFormData {constructor(form){this.values=form.entries;}[Symbol.iterator](){return this.values[Symbol.iterator]();}getAll(key){return this.values.filter(entry=>entry[0]===key).map(entry=>entry[1]);}}
  const api=async(path,options={})=>{const result=await request('/api'+path,options);if(!result.ok)throw Object.assign(new Error(result.data.error),{status:result.status,code:result.data.code});return result.data;};
  const context=vm.createContext({...uiKit,...projectDirectoryUI,...workbenchModel,...workbenchUI,...taskGroupsUI,...requirementUI,...documentsUI,...documentLinkFields,...docSections,...portfolioUI,...workflow,...reviewUI,...batchUI,...workUI,renderDocumentPreview,renderFeaturePreview,crypto:webcrypto,sessionStorage:{getItem(){return null;},setItem(){},removeItem(){}},createTimelineState,moveTimeline,renderTimeline,resolveTimelineRange,document:{querySelector:element,querySelectorAll:()=>[],addEventListener(name,fn){listeners[name]=fn;},visibilityState:'visible',body:element('body'),activeElement:element('active'),createElement:element},window:{addEventListener(){},scrollY:0,scrollTo(){}},location:{origin:'http://127.0.0.1:3000',pathname:'/',search:'',hash},history:{replaceState(_state,_title,url){const parsed=new URL(url,'http://127.0.0.1:3000');context.location.hash=parsed.hash;context.location.search=parsed.search;}},URL,URLSearchParams,TextDecoder,TextEncoder,Blob,Uint8Array,atob,btoa,console,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,requestAnimationFrame:fn=>fn(),navigator:{clipboard:{writeText:async()=>{}}},HTMLFormElement:MockForm,FormData:MockFormData,api,rows:(v,key)=>Array.isArray(v)?v:v?.[key]||[],setCsrf(value){csrf=value;},fetch:async(url,options={})=>{const response=await request(url,options);return {...response,json:async()=>response.data,text:async()=>response.bytes.toString(),arrayBuffer:async()=>response.bytes.buffer.slice(response.bytes.byteOffset,response.bytes.byteOffset+response.bytes.byteLength),blob:async()=>new Blob([response.bytes],{type:response.headers.get('content-type')})};}});
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
  const team=f.run('teamView(false,{date:today(),personal:{tasks:data.tasks,splits:[],reviews:[]},reminders:[]})');
  assert.match(team,/仍需完成的工作/);assert.doesNotMatch(team,/不应出现在待办的已终止任务|已归档项目的工作/);
  assert.match(team,/待我处理/);
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

test('登录页无项目菜单时键盘输入不被拦截，隐藏菜单也不处理导航键',async t=>{
  const f=await fixture(t,{initialize:false});
  const query=f.context.document.querySelector;
  f.context.document.querySelector=selector=>selector==='#project-menu'?null:query(selector);
  f.context.document.activeElement={tagName:'INPUT'};
  for(const key of ['a','/','Tab','Escape','ArrowDown','ArrowUp','Home','End']){
    let prevented=false;const event={key,preventDefault(){prevented=true;}};
    assert.doesNotThrow(()=>f.listeners.keydown(event));
    assert.equal(prevented,false,`无项目菜单时不应阻止 ${key}`);
    f.context.menuKeyEvent=event;
    assert.equal(f.run('projectMenuKey(menuKeyEvent)'),false);
  }
  f.context.document.querySelector=query;
  f.element('#project-menu').hidden=true;
  f.element('#project-menu').querySelectorAll=()=>{throw new Error('隐藏菜单不应读取选项');};
  let prevented=false;f.context.menuKeyEvent={key:'ArrowDown',preventDefault(){prevented=true;}};
  assert.doesNotThrow(()=>f.listeners.keydown(f.context.menuKeyEvent));
  assert.equal(f.run('projectMenuKey(menuKeyEvent)'),false);
  assert.equal(prevented,false);
});

test('展开的项目菜单保留方向键循环、首尾定位、退出和正常制表键行为',async t=>{
  const f=await fixture(t);
  const menu=f.element('#project-menu'),toggle=f.element('#project-switch');
  const items=Array.from({length:3},()=>({focus(){f.context.document.activeElement=this;}}));
  menu.querySelectorAll=()=>items;menu.hidden=false;
  f.context.document.activeElement=items[0];
  const keydown=key=>{let prevented=false;f.listeners.keydown({key,preventDefault(){prevented=true;}});return prevented;};
  assert.equal(keydown('ArrowDown'),true);assert.equal(f.context.document.activeElement,items[1]);
  assert.equal(keydown('End'),true);assert.equal(f.context.document.activeElement,items[2]);
  assert.equal(keydown('ArrowDown'),true);assert.equal(f.context.document.activeElement,items[0]);
  assert.equal(keydown('ArrowUp'),true);assert.equal(f.context.document.activeElement,items[2]);
  assert.equal(keydown('Home'),true);assert.equal(f.context.document.activeElement,items[0]);
  toggle.focus=()=>{f.context.document.activeElement=toggle;};
  assert.equal(keydown('Escape'),true);assert.equal(menu.hidden,true);assert.equal(f.context.document.activeElement,toggle);
  menu.hidden=false;f.context.document.activeElement=items[0];
  assert.equal(keydown('Tab'),false);assert.equal(menu.hidden,true);assert.equal(f.context.document.activeElement,items[0]);
});

test('项目目录两种显示共用全文搜索、归档范围和任务统计，切换不改筛选或工作台',async t=>{
  const f=await fixture(t);
  f.context.directoryFixture=JSON.stringify({
    projects:[{id:'p-exec',name:'当前项目',description:'说明命中资源关键字',status:'进行中'},{id:'p-empty',name:'空项目',description:'另一个项目'},{id:'p-res',name:'归档项目',description:'归档也命中资源关键字',archived:true}],
    requirements:[{id:'confirmed',projectId:'p-exec',status:'已确定'},{id:'proposal',projectId:'p-exec',status:'未确定'},{id:'archived',projectId:'p-exec',status:'已完成',archived:true}],
    tasks:[{id:'done',projectId:'p-exec',status:'已完成'},{id:'wait',projectId:'p-exec',status:'wait'},{id:'closed',projectId:'p-exec',status:'已终止'},{id:'old',projectId:'p-exec',status:'已完成',archived:true}]
  });
  f.run('Object.assign(data,JSON.parse(directoryFixture));route={view:"projects",projectId:""};');
  const ids=html=>[...html.matchAll(/href="#\/p\/([^"/]+)\/overview"/g)].map(match=>match[1]);
  const teamBefore=f.run('teamView(false)');
  const cards=f.run('teamView(true)');
  assert.deepEqual(ids(cards),['p-exec','p-empty']);
  assert.match(cards,/50% · 1 \/ 2/);assert.match(cards,/1 项需求 · 3 个任务/);
  assert.match(cards,/data-project-layout="card" aria-pressed="true"/);
  const requests=[];f.context.api=async(...args)=>{requests.push(args);throw new Error('显示切换不应请求后端');};
  const click=async value=>{const target={dataset:{projectLayout:value},disabled:false,setAttribute(){}};await f.listeners.click({target:{closest:()=>target}});};
  await click('list');
  const list=f.element('#view').innerHTML;
  assert.deepEqual(ids(list),ids(cards));assert.match(list,/50% · 1 \/ 2/);assert.match(list,/1 项 \/ 3 个/);
  assert.match(list,/暂无任务/);assert.equal(f.run('teamView(false)'),teamBefore);
  f.run('ui.search="资源关键字";ui.page=3;');
  const before=f.run('JSON.stringify(ui)');
  await click('card');assert.equal(f.run('JSON.stringify(ui)'),before);
  assert.deepEqual(ids(f.element('#view').innerHTML),['p-exec']);
  f.run('ui.archived=true;');
  const archivedBefore=f.run('JSON.stringify(ui)');
  await click('list');assert.equal(f.run('JSON.stringify(ui)'),archivedBefore);
  assert.deepEqual(ids(f.element('#view').innerHTML),['p-res']);
  assert.match(f.element('#view').innerHTML,/已归档项目/);
  f.run('ui.search="不存在的关键词";');
  assert.match(f.run('teamView(true)'),/没有符合条件的项目/);
  f.run('ui.search="";data.projects=data.projects.filter(project=>!project.archived);');
  const noArchive=f.run('teamView(true)');assert.match(noArchive,/暂无归档项目/);assert.doesNotMatch(noArchive,/创建第一个项目|还没有可访问的项目/);
  assert.deepEqual(requests,[]);
});

test('项目目录卡片与列表沿用服务器授权项目和角色，不给成员新增管理操作',async t=>{
  const f=await fixture(t);await f.become('u-dev1');
  f.run('route={view:"projects",projectId:""};');
  const expected=JSON.parse(f.run('JSON.stringify(data.projects.filter(project=>!project.archived).map(project=>project.id))'));
  assert.ok(expected.length>0);
  const directory=layout=>{f.context.directoryLayout=layout;f.run('projectLayoutPreferences.set(user.id,directoryLayout);');return f.run('teamView(true)');};
  for(const layout of ['card','list']){
    const html=directory(layout);
    assert.deepEqual([...html.matchAll(/href="#\/p\/([^"/]+)\/overview"/g)].map(match=>match[1]),expected);
    assert.doesNotMatch(html,/data-action="new-project"|data-action="edit-project"/);
    assert.match(html,/我的角色/);
  }
  f.run('user={id:"different-account",role:"viewer"};');
  assert.match(f.run('teamView(true)'),/data-project-layout="card" aria-pressed="true"/);
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

test('编辑需求表单不允许通过旧状态字段静默推进流程',async t=>{
  const f=await fixture(t);
  const req=f.run('data.requirements.find(item=>item.status==="开发中"&&data.memberships.some(m=>m.projectId===item.projectId&&m.userId===item.assigneeId&&m.role==="developer"))');
  assert.ok(req,'真实快照中需有指派给开发的进行中需求');
  if(!req.acceptance)f.app.business.updateRequirement(f.run('user'),req.id,{version:req.version,acceptance:'验收满足原目标'});
  // A requirement enters testing only after every live task has been submitted for testing.
  for(let task of f.run('data.tasks').filter(item=>item.requirementId===req.id&&!item.archived)){
    for(const next of ({wait:['develop','test'],'待开始':['develop','test'],develop:['test'],'开发中':['test']}[task.status]||[]))task=f.app.business.updateTask(f.run('user'),task.id,{version:task.version,status:next});
  }
  await f.become(req.assigneeId);
  f.context.form=new f.MockForm('requirements',{status:'已完成',reason:'旧表单伪造状态'},req.id);
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
  assert.equal(f.run('canAutoRefresh()'),true);
  f.element('active').tagName='INPUT';assert.equal(f.run('canAutoRefresh()'),false);
});

function deferredResponse() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function holdWorkspaceResponses(f) {
  const requests = [];
  const original = f.context.api;
  f.context.api = (path, options) => {
    if (!path.startsWith('/bootstrap')) return original(path, options);
    const request = deferredResponse();
    requests.push(request);
    return request.promise;
  };
  return requests;
}

const versionedEntityCases = [
  { kind: 'projects', editor: 'editProject', update: 'updateProject', get: 'getProject', title: 'name' },
  { kind: 'requirements', editor: 'editRequirement', update: 'updateRequirement', get: 'getRequirement', title: 'title' },
  { kind: 'tasks', editor: 'editTask', update: 'updateTask', get: 'getTask', title: 'title' },
];

function editableEntityForm(f, kind, item, description) {
  let fields;
  if (kind === 'projects') fields = {
    name: item.name, description, ownerId: item.ownerId, status: item.status,
    startDate: item.startDate || '', targetDate: item.targetDate || '',
    milestones: (item.milestones || []).map(mark => `${mark.name || mark.label} | ${mark.date || ''}`).join('\n'),
  };
  else if (kind === 'requirements') fields = {
    title: item.title, description, acceptance: item.acceptance || '', priority: item.priority,
    assigneeId: item.assigneeId || '', estimatePoints: item.estimatePoints || 0,
    planStart: item.planStart || '', planEnd: item.planEnd || '', source: item.source || '',
  };
  else fields = {
    title: item.title, description, requirementId: item.requirementId, ownerId: item.ownerId,
    status: f.run('taskStage')(item.status), startDate: item.startDate || '', dueDate: item.dueDate || '', estimateHours: item.estimateHours || 0,
  };
  const form = new f.MockForm(kind, fields, item.id);
  for (const key of ['dependencyIds', 'collaboratorIds']) for (const id of item[key] || []) form.entries.push([key, id]);
  // Verify the actual rendered form carries the same captured version as the DOM double.
  const emitted = /<form[^>]*data-version="([^"]*)"/.exec(f.element('#dialog').innerHTML)?.[1];
  assert.equal(emitted, String(item.version));
  assert.equal(form.dataset.version, emitted);
  return form;
}

for (const definition of versionedEntityCases) test(`${definition.kind} 旧表单遇在途刷新仍拒绝覆盖他人数据，重新打开后可正常保存`, async t => {
  for (const source of ['automatic', 'manual']) {
    const f = await fixture(t), { kind, editor, update, get, title } = definition;
    f.run('route={view:"overview",projectId:"p-exec"};renderShell();');
    f.element('#project-menu').hidden = true;
    const actor = f.run('user');
    const entity = f.run('data')[kind].find(item => (kind === 'projects' ? item.id === 'p-exec' : item.projectId === 'p-exec') && !item.archived && (kind !== 'requirements' || !['未确定', '待评审'].includes(item.status)));
    const before = f.app.business[get](actor, entity.id);
    const originalApi = f.context.api, requests = holdWorkspaceResponses(f);
    const refreshing = source === 'automatic' ? f.run('autoRefresh()') : f.run('reload()');
    f.context.editingEntityId = before.id;
    f.run(`${editor}(editingEntityId)`);
    const formHtml = f.element('#dialog').innerHTML;
    f.context.staleEntityForm = editableEntityForm(f, kind, before, '本次仅修改说明');
    const after = f.app.business[update](actor, before.id, { version: before.version, [title]: '同事刚保存的新标题' });
    requests[0].resolve(await originalApi('/bootstrap?includeArchived=1'));
    await refreshing;
    assert.equal(f.element('#dialog').innerHTML, formHtml, '刷新不能重置正在填写的表单');
    assert.equal(f.context.staleEntityForm.dataset.version, String(before.version));
    f.context.api = originalApi;
    await assert.rejects(f.run('saveEntity(staleEntityForm)'), { code: 'VERSION_CONFLICT' }, `${source} 刷新后必须保留原表单的版本校验`);
    const saved = f.app.business[get](actor, before.id);
    assert.equal(saved.version, after.version);
    assert.equal(saved[title], after[title]);
    assert.equal(saved.description, after.description);
    assert.equal(f.element('#dialog').open, true, '冲突保留表单和未保存输入');
    await f.run('reload()');
    f.run(`${editor}(editingEntityId)`);
    f.context.freshEntityForm = editableEntityForm(f, kind, saved, '核对后保存的说明');
    await f.run('saveEntity(freshEntityForm)');
    const updated = f.app.business[get](actor, before.id);
    assert.equal(updated[title], after[title]);
    assert.equal(updated.description, '核对后保存的说明');
    assert.ok(updated.version > after.version);
  }
});

test('已有项目需求和任务缺少或携带无效表单版本时不发起写请求', async t => {
  const f = await fixture(t);
  for (const { kind, editor } of versionedEntityCases) {
    const item = f.run('data')[kind].find(item => (kind === 'projects' ? item.id === 'p-exec' : item.projectId === 'p-exec') && !item.archived);
    f.context.editingEntityId = item.id;
    f.run(`${editor}(editingEntityId)`);
    const form = editableEntityForm(f, kind, item, item.description || '');
    let calls = 0;
    f.context.api = () => { calls++; throw new Error('无效版本不应发请求'); };
    f.context.invalidVersionForm = form;
    for (const value of [undefined, '', '0', '-1', '1.5', 'not-a-version', '9007199254740992']) {
      if (value === undefined) delete form.dataset.version; else form.dataset.version = value;
      await assert.rejects(f.run('saveEntity(invalidVersionForm)'), /编辑版本缺失或无效/);
    }
    const collections = f.run('data'), before = collections[kind];
    collections[kind] = before.filter(record => record.id !== item.id);
    delete form.dataset.version;
    try { await assert.rejects(f.run('saveEntity(invalidVersionForm)'), /编辑版本缺失或无效/, '记录从当前集合消失后仍不能跳过版本校验'); }
    finally { collections[kind] = before; }
    assert.equal(calls, 0);
  }
});

test('保存后的刷新发起新请求，较晚到达的旧快照不覆盖项目和同步标记', async t => {
  const f = await fixture(t);
  const before = await f.api('/bootstrap?includeArchived=1');
  const requests = holdWorkspaceResponses(f);
  const earlier = assert.rejects(f.run('reload()'), { code: 'STALE_REFRESH' });
  const actor = f.run('user');
  const project = f.app.business.getProject(actor, 'p-exec');
  f.app.business.updateProject(actor, project.id, { version: project.version, name: '保存后的项目名称' });
  const after = await f.api('/bootstrap?includeArchived=1');
  const latest = f.run('reload()');
  assert.equal(requests.length, 2, '保存后不能复用保存前的请求');
  requests[1].resolve(after);
  await latest;
  const signature = f.run('dataSignature'), synced = f.run('lastSynced');
  requests[0].resolve(before);
  await earlier;
  assert.equal(f.run('projectOf("p-exec").name'), '保存后的项目名称');
  assert.equal(f.run('dataSignature'), signature);
  assert.equal(f.run('lastSynced'), synced);
  assert.equal(f.run('pendingReload'), null);
});

test('前台刷新进行中自动同步不插队，最新请求失败也不接受旧快照', async t => {
  const f = await fixture(t);
  f.run('route={view:"overview",projectId:"p-exec"};renderShell();');
  f.element('#project-menu').hidden = true;
  const snapshot = await f.api('/bootstrap?includeArchived=1');
  const requests = holdWorkspaceResponses(f);
  const earlier = assert.rejects(f.run('reload()'), { code: 'STALE_REFRESH' });
  await f.run('autoRefresh()');
  assert.equal(requests.length, 1);
  const latest = assert.rejects(f.run('reload()'), /模拟网络失败/);
  requests[1].reject(new Error('模拟网络失败'));
  await latest;
  requests[0].resolve(snapshot);
  await earlier;
  assert.equal(f.run('lastSynced'), 0);
  assert.equal(f.run('dataSignature'), '');
  assert.equal(f.run('pendingReload'), null);
});

test('已被替代的悬挂请求不阻止新快照之后的自动同步', async t => {
  for (const source of ['manual', 'automatic']) {
    const f = await fixture(t);
    f.run('route={view:"overview",projectId:"p-exec"};renderShell();');
    f.element('#project-menu').hidden = true;
    const snapshot = await f.api('/bootstrap?includeArchived=1');
    const requests = holdWorkspaceResponses(f);
    const earlier = source === 'manual'
      ? assert.rejects(f.run('reload()'), { code: 'STALE_REFRESH' })
      : f.run('autoRefresh()');
    const latest = f.run('reload()');
    requests[1].resolve(snapshot);
    await latest;
    const automatic = f.run('autoRefresh()');
    assert.equal(requests.length, 3, '已过期但未完成的请求不能锁住后续同步');
    requests[2].resolve(snapshot);
    await automatic;
    requests[0].resolve(snapshot);
    await earlier;
    assert.equal(f.run('pendingReload'), null);
  }
});

test('退出后迟到的工作区响应不更新数据或同步标记', async t => {
  const f = await fixture(t);
  const snapshot = await f.api('/bootstrap?includeArchived=1');
  snapshot.projects.find(project => project.id === 'p-exec').name = '退出后不应显示';
  const requests = holdWorkspaceResponses(f);
  const pending = assert.rejects(f.run('reload()'), { code: 'STALE_REFRESH' });
  f.run('user=null;renderAuth();');
  const loginHtml = f.element('#app').innerHTML;
  requests[0].resolve(snapshot);
  await pending;
  assert.equal(f.run('user'), null);
  assert.notEqual(f.run('projectOf("p-exec").name'), '退出后不应显示');
  assert.equal(f.run('lastSynced'), 0);
  assert.equal(f.element('#app').innerHTML, loginHtml);
});

test('同账号新会话不受旧刷新成功或旧认证错误影响', async t => {
  for (const outcome of ['success', 'unauthorized']) {
    const f = await fixture(t);
    const snapshot = await f.api('/bootstrap?includeArchived=1');
    const requests = holdWorkspaceResponses(f);
    const pending = f.run('reload().catch(error=>{presentError(error);return error.code;})');
    f.run('user={...user};renderShell();');
    const currentUser = f.run('user'), currentHtml = f.element('#app').innerHTML;
    if (outcome === 'success') requests[0].resolve(snapshot);
    else requests[0].reject(Object.assign(new Error('旧会话已结束'), { status: 401 }));
    assert.equal(await pending, 'STALE_REFRESH');
    assert.equal(f.run('user'), currentUser);
    assert.equal(f.element('#app').innerHTML, currentHtml);
    assert.equal(f.run('lastSynced'), 0);
  }
});

test('切换账号后不应用旧账号的完整工作区数据', async t => {
  const f = await fixture(t);
  const snapshot = await f.api('/bootstrap?includeArchived=1');
  const requests = holdWorkspaceResponses(f);
  const pending = assert.rejects(f.run('reload()'), { code: 'STALE_REFRESH' });
  await f.become('u-dev1');
  const state = f.run('JSON.stringify(data)'), currentUser = f.run('user');
  requests[0].resolve(snapshot);
  await pending;
  assert.equal(f.run('JSON.stringify(data)'), state);
  assert.equal(f.run('user'), currentUser);
});

test('任务列表不生成隐藏的看板卡片，切回看板仍显示全部筛选任务', async t => {
  const f = await fixture(t);
  f.run('route={view:"tasks",projectId:"p-exec"};ui.taskLayout="list";');
  const originalCard = f.run('taskCard');
  let cardCalls = 0;
  f.context.cardSpy = task => { cardCalls++; return originalCard(task); };
  f.run('taskCard=cardSpy;');
  const list = f.run('tasksView()');
  assert.match(list, /data-table/);
  assert.equal(cardCalls, 0, '列表不能生成未显示的看板卡片');
  const expected = f.run('filtered("tasks").length');
  f.run('ui.taskLayout="board";');
  const board = f.run('tasksView()');
  assert.match(board, /class="board"/);
  assert.equal(cardCalls, expected);
});

test('工作台迟到响应不能跨越同账号的新会话重新绘制页面', async t => {
  const f = await fixture(t);
  const work = deferredResponse();
  f.context.api = () => work.promise;
  f.run('route={view:"personal",projectId:""};');
  const pending = f.run('workView()');
  f.run('user={...user};');
  f.element('#view').innerHTML = '新会话页面';
  work.resolve({});
  await pending;
  assert.equal(f.element('#view').innerHTML, '新会话页面');
  assert.equal(f.run('workSnapshot'), null);
});

test('主开发编辑转派并查看修改记录，只有管理员看到删除入口且可确认删除恢复',async t=>{
  const f=await fixture(t),admin=f.run('user');
  const project=f.app.business.getProject(admin,'p-exec');
  const lead=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  f.app.business.setMember(admin,'p-exec',{userId:lead,role:'lead',version:project.version});
  const req=f.app.business.createRequirement(admin,{projectId:'p-exec',title:'任务编辑验证需求',description:'已确认的工作',acceptance:'交付验收通过'});
  await f.become(lead);
  let task=f.app.business.createTask({id:lead},{projectId:'p-exec',requirementId:req.id,title:'待修正任务',description:'原始任务内容',ownerId:lead});
  await f.run('reload()');f.context.taskId=task.id;f.run('route={view:"tasks",projectId:"p-exec"};');
  const click=async dataset=>{const target={dataset,disabled:false,setAttribute(){}};await f.listeners.click({target:{closest:()=>target}});};
  for(const layout of ['board','list']){
    f.context.layout=layout;f.run('ui.taskLayout=layout;');const html=f.run('tasksView()');
    assert.ok(html.includes(`data-task="${task.id}"`));assert.ok(!html.includes(`data-archive-id="${task.id}"`));
    assert.doesNotMatch(html,/查看任务|编辑任务|删除任务/);
  }
  await click({task:task.id});
  assert.match(f.element('#dialog').innerHTML,/编辑任务/);
  assert.doesNotMatch(f.element('#dialog').innerHTML,/id="task-more"/);
  await click({editTask:task.id});
  assert.match(f.element('#dialog').innerHTML,/任务内容/);assert.match(f.element('#dialog').innerHTML,/原始任务内容/);
  assert.match(f.element('#dialog').innerHTML,new RegExp(`<option value="${lead}" selected>`));
  const other=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  assert.ok(f.element('#dialog').innerHTML.includes(`<option value="${other}">`));
  f.context.form=new f.MockForm('tasks',{title:'修改后的任务',description:'具体工作与验收要求',requirementId:req.id,ownerId:other,status:'wait',estimateHours:'6'},task.id);
  await f.run('saveEntity(form)');task=f.app.business.getTask({id:lead},task.id);
  assert.equal(task.title,'修改后的任务');assert.equal(task.description,'具体工作与验收要求');assert.equal(task.ownerId,other);
  assert.match(f.element('#dialog').innerHTML,/任务详情|修改记录/);
  assert.match(f.element('#task-history').innerHTML,/具体工作与验收要求/);
  assert.match(f.element('#task-history').innerHTML,/负责人/);
  assert.equal((await f.request('/api/tasks/'+task.id,{method:'PATCH',body:{version:task.version,archived:true}})).status,403);
  await f.become(admin.id);
  assert.doesNotMatch(f.run('taskCard(data.tasks.find(task=>task.id===taskId))'),/查看任务|编辑任务|删除任务/);
  await click({task:task.id});
  assert.match(f.element('#dialog').innerHTML,/<details class="task-more" id="task-more"><summary aria-label="更多任务操作">更多<\/summary>/);
  assert.match(f.element('#dialog').innerHTML,/删除任务/);
  await click({editTask:task.id});
  assert.doesNotMatch(f.element('#dialog').innerHTML,/删除任务/);
  await click({archiveKind:'tasks',archiveId:task.id});
  assert.match(f.element('#dialog').innerHTML,/删除后移出当前看板与排期/);assert.equal(f.element('#dialog').className,'is-center');
  assert.equal(f.app.business.getTask({id:lead},task.id).archived,false);
  await click({action:'close-dialog'});assert.equal(f.app.business.getTask({id:lead},task.id).archived,false);
  await click({archiveKind:'tasks',archiveId:task.id});
  await click({action:'confirm-archive',kind:'tasks',id:task.id,version:String(task.version),archived:'true'});
  assert.equal(f.app.business.getTask({id:lead},task.id).archived,true);
  assert.ok(!f.run('filtered("tasks").some(task=>task.id===taskId)'));
  f.run('ui.archived=true');await f.run('showTask(taskId)');
  assert.match(f.element('#dialog').innerHTML,/恢复任务/);assert.doesNotMatch(f.element('#dialog').innerHTML,/type="submit"/);
  task=f.app.business.getTask({id:lead},task.id);
  await click({archiveKind:'tasks',archiveId:task.id});
  await click({action:'confirm-archive',kind:'tasks',id:task.id,version:String(task.version),archived:'false'});
  task=f.app.business.getTask({id:lead},task.id);assert.equal(task.archived,false);assert.equal(task.description,'具体工作与验收要求');
  await f.become(other);
  assert.equal(f.run('taskRemovalButton(data.tasks.find(task=>task.id===taskId))'),'');
  f.context.form=new f.MockForm('tasks',{title:'开发补充',description:'本人补充内容',ownerId:lead,status:'wait',estimateHours:'6'},task.id);
  await f.run('saveEntity(form)');task=f.app.business.getTask({id:other},task.id);
  assert.equal(task.ownerId,other);assert.equal(task.description,'本人补充内容');
});

test('全局甘特图首次渲染测量实际轨道宽度；溢出时允许拖动，全览无溢出时不拖动',async t=>{
  const f=await fixture(t);
  f.run('route={view:"portfolio",projectId:""};');
  const view=f.element('#view'),scroll=f.element('.schedule-scroll'),chart=f.element('.schedule-chart');
  view.clientWidth=1400;
  assert.equal(f.run('timelineWidth()'),1118); // 280px name column, not the project schedule's 240px.
  let html='',renders=0;
  Object.defineProperty(view,'innerHTML',{get:()=>html,set:value=>{
    html=value;renders++;
    for(const key of ['extent-start','extent-days','px','fit-px','max-px','fit','today']){
      const match=value.match(new RegExp('data-'+key+'="([^\"]*)"'));
      if(match)chart.dataset[key.replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=match[1];
    }
    scroll.clientWidth=1000;f.element('.schedule-name').offsetWidth=280;
    f.element('.schedule-chart .schedule-name').offsetWidth=280;
  }});
  f.run('renderView()');
  assert.equal(renders,2);assert.ok(Math.abs(Number(chart.dataset.px)*Number(chart.dataset.extentDays)-720)<0.01);
  scroll.scrollWidth=1200;scroll.scrollLeft=100;scroll.setPointerCapture=()=>{};
  scroll.classList.contains=key=>key==='is-fit';
  f.listeners.pointerdown({target:{closest:selector=>selector==='.schedule-scroll'?scroll:null},button:0,pointerType:'mouse',clientX:200,pointerId:1});
  f.listeners.pointermove({pointerId:1,clientX:150});assert.equal(scroll.scrollLeft,150);
  f.listeners.pointerup({pointerId:1});
  scroll.scrollWidth=1000;
  f.listeners.pointerdown({target:{closest:selector=>selector==='.schedule-scroll'?scroll:null},button:0,pointerType:'mouse',clientX:200,pointerId:2});
  assert.equal(f.run('timelineDrag'),null);
});

test('任务历史接口按项目鉴权，保留修改人姓名与前后内容，详情转义用户内容',async t=>{
  const f=await fixture(t),admin=f.run('user');
  const req=f.app.business.createRequirement(admin,{projectId:'p-exec',title:'历史验证',description:'已确认的工作',acceptance:'交付验收通过'});
  let task=f.app.business.createTask(admin,{projectId:'p-exec',requirementId:req.id,title:'修改前标题',description:'修改前内容'});
  task=f.app.business.updateTask(admin,task.id,{version:task.version,title:'修改后标题',description:'<script>不应执行</script>',reason:'修正任务范围'});
  // Audit snapshots retain the name even after the account is renamed.
  f.db.prepare('UPDATE users SET name=? WHERE id=?').run('后来改名',admin.id);
  const history=await f.request('/api/tasks/'+task.id+'/history');
  assert.equal(history.status,200);assert.equal(history.data.entries.length,2);
  assert.equal(history.data.entries[0].actorName,admin.name);
  assert.equal(history.data.entries[0].detail.before.description,'修改前内容');
  assert.equal(history.data.entries[0].detail.reason,'修正任务范围');
  await f.run('reload()');f.context.taskId=task.id;await f.run('showTask(taskId)');
  assert.match(f.element('#dialog').innerHTML,/任务详情|修改记录/);
  assert.match(f.element('#task-history').innerHTML,/任务内容|修改前内容|修正任务范围/);
  assert.doesNotMatch(f.element('#task-history').innerHTML,/<script>/);
  assert.equal((await f.request('/api/tasks/missing-task/history')).status,404);
  const member=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  await f.become(member);assert.equal((await f.request('/api/tasks/'+task.id+'/history')).status,200);
  assert.equal(f.run('taskRemovalButton(data.tasks.find(t=>t.id===taskId))'),'');
  f.db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run('p-exec',member);
  assert.equal((await f.request('/api/tasks/'+task.id+'/history')).status,403);
});

test('真实提交事件拦截默认导航：开发新建提议到产品确认转入详情，保留提出人',async t=>{
  const f=await fixture(t),admin=f.run('user');
  const developer=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  await f.become(developer);await f.run('reload()');
  f.run('route={view:"proposals",projectId:"p-exec"};renderShell()');
  assert.match(f.element('#view').innerHTML,/提交提议/);
  f.run('editProposal()');assert.doesNotMatch(f.element('#dialog').innerHTML,/name="status"|name="decisionReason"/);
  const createForm=new f.MockForm('proposals',{title:'支持导出报表',description:'客户需要离线分析',priority:'P1',proposerName:'客户代表',source:'客户反馈'});
  createForm.id='proposal-form';createForm.dataset={id:'',projectId:'p-exec',version:'',approve:'0'};
  let preventedCreate=false;
  const pendingCreate=f.listeners.submit({target:createForm,preventDefault(){preventedCreate=true;}});
  assert.equal(preventedCreate,true,'提议新建必须同步阻止浏览器默认提交，避免表单内容进入网址');
  await pendingCreate;
  const proposal=f.run('data.proposals.find(p=>p.title==="支持导出报表")');
  assert.ok(proposal,'真实提交事件必须创建提议并刷新初始化数据');
  assert.equal(proposal.createdBy,developer);assert.equal(proposal.proposerName,'客户代表');
  assert.match(f.element('#dialog').innerHTML,/需求提议|支持导出报表/);
  f.context.proposalId=proposal.id;
  assert.doesNotMatch(f.element('#dialog').innerHTML,/确认转入需求池/);
  assert.equal((await f.request(`/api/proposals/${proposal.id}/approve`,{method:'POST',body:{version:proposal.version,acceptance:'导出内容完整'}})).status,403);
  await f.become(admin.id);await f.run('reload()');f.run('editProposal(proposalId,true)');
  assert.match(f.element('#dialog').innerHTML,/确认转入需求池/);
  const form=new f.MockForm('proposals',{title:proposal.title,description:proposal.description,acceptance:'导出内容完整',priority:'P1',source:proposal.source,decisionReason:'评估有明确价值'},proposal.id);
  form.id='proposal-form';form.dataset={id:proposal.id,projectId:'p-exec',version:String(proposal.version),approve:'1'};
  let preventedApproval=false;
  const pendingApproval=f.listeners.submit({target:form,preventDefault(){preventedApproval=true;}});
  assert.equal(preventedApproval,true,'提议确认必须同步阻止浏览器默认提交');
  await pendingApproval;
  const converted=f.run('data.requirements.find(r=>r.title==="支持导出报表")');
  assert.equal(converted.status,'已确定');assert.equal(converted.deliveryWorkflow,true);
  assert.equal(converted.originSubmittedBy,developer);assert.equal(converted.originProposalId,proposal.id);
  const approved=f.app.proposals.read(admin,proposal.id);
  assert.equal(approved.proposerName,'客户代表','评估表单未重填提出人时仍保留原始来源');
  assert.equal(approved.createdBy,developer);assert.equal(approved.requirementId,converted.id);
  assert.match(f.element('#dialog').innerHTML,/需求详情|支持导出报表|需求生命周期/);
  f.run('route={view:"requirements",projectId:"p-exec"};');
  const pool=f.run('requirementsView()');assert.match(pool,/支持导出报表/);
  const legacy=f.run('data.requirements.find(r=>r.projectId==="p-exec"&&["未确定","待评审"].includes(r.status))');
  if(legacy)assert.ok(!pool.includes(`data-requirement="${legacy.id}"`));
  f.context.reqId=converted.id;f.run('editRequirement(reqId)');assert.doesNotMatch(f.element('#dialog').innerHTML,/<select[^>]*name="status"/);
});

test('主开发在任务模块指定主责与排期，无需提交计划即可自动推进需求并保留承诺',async t=>{
  const f=await fixture(t),admin=f.run('user');
  const lead=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  f.app.business.setMember(admin,'p-exec',{userId:lead,role:'lead',version:f.app.business.getProject(admin,'p-exec').version});
  let req=f.app.business.createRequirement(admin,{projectId:'p-exec',title:'任务驱动前端闭环',description:'明确背景',acceptance:'逐项符合标准',planStart:'2026-09-20',planEnd:'2026-10-01'});
  await f.become(lead);await f.run('reload()');f.context.reqId=req.id;
  f.run('openRequirementTasks(reqId)');
  assert.equal(f.run('route.view'),'tasks');assert.equal(f.run('ui.taskLayout'),'group');
  assert.match(f.element('#view').innerHTML,/任务驱动前端闭环|按需求/);
  assert.doesNotMatch(f.element('#view').innerHTML,/提交研发计划|启用自动流转/);
  f.run('editDevelopment(reqId)');assert.match(f.element('#dialog').innerHTML,/主责开发|前置需求/);
  const settings=new f.MockForm('requirements',{assigneeId:lead},req.id);settings.id='development-form';settings.dataset={id:req.id,version:String(req.version)};
  let prevented=false;const saved=f.listeners.submit({target:settings,preventDefault(){prevented=true;}});assert.equal(prevented,true);await saved;
  req=f.app.business.getRequirement({id:lead},req.id);assert.equal(req.assigneeId,lead);
  f.context.form=new f.MockForm('tasks',{title:'交付工作',description:'完成业务功能',requirementId:req.id,ownerId:lead,status:'wait',estimateHours:'8'});
  await f.run('saveEntity(form)');
  let task=f.app.business.listTasks({id:lead},{projectId:'p-exec'}).find(item=>item.requirementId===req.id);
  req=f.app.business.getRequirement({id:lead},req.id);assert.equal(req.status,'待排期');
  f.context.form=new f.MockForm('tasks',{title:task.title,description:task.description,requirementId:req.id,ownerId:lead,status:'wait',estimateHours:'8',startDate:'2026-09-28',dueDate:'2026-10-02'},task.id);
  await f.run('saveEntity(form)');
  req=f.app.business.getRequirement({id:lead},req.id);assert.equal(req.status,'已排期');
  assert.equal(req.planStart,'2026-09-20');assert.equal(req.planEnd,'2026-10-01');
  await f.run('reload()');assert.match(f.run('requirementScheduleSummary(data.requirements.find(req=>req.id===reqId))'),/预计晚于承诺 1 天/);
  task=f.app.business.getTask({id:lead},task.id);
  for(const status of ['develop','test','done'])task=f.app.business.updateTask({id:lead},task.id,{version:task.version,status});
  req=f.app.business.getRequirement({id:lead},req.id);assert.equal(req.status,'测试中');
  await f.run('reload()');f.element('.dialog-body').dataset.detailId=req.id;await f.run('requirementDetails(reqId)');
  assert.match(f.element('#dialog').innerHTML,/等待需求验收|确认验收通过/);
  assert.doesNotMatch(f.element('#dialog').innerHTML,/提交研发计划|启用自动流转/);
  assert.match(f.element('#requirement-history').innerHTML,/自动流转|触发任务/);
  const acceptanceForm=new f.MockForm('requirements',{},req.id);acceptanceForm.id='requirement-operation-form';acceptanceForm.dataset={id:req.id,version:String(req.version),operation:'complete'};
  let preventedAcceptance=false;await f.listeners.submit({target:acceptanceForm,preventDefault(){preventedAcceptance=true;}});
  assert.equal(preventedAcceptance,true);assert.equal(f.app.business.getRequirement({id:lead},req.id).status,'已完成');
});

test('按需求任务分组搜索保留空需求，筛选不改变完整进度且观察者不能研发设置',async t=>{
  const f=await fixture(t),admin=f.run('user');
  const req=f.app.business.createRequirement(admin,{projectId:'p-exec',title:'等待拆分的空需求',description:'完整背景',acceptance:'整体通过'});
  f.app.business.createTask(admin,{projectId:'p-exec',requirementId:req.id,title:'关联工作一',estimateHours:5,ownerId:admin.id});
  const empty=f.app.business.createRequirement(admin,{projectId:'p-exec',title:'另一个待拆分需求',description:'背景',acceptance:'通过'});
  await f.run('reload()');f.run('route={view:"tasks",projectId:"p-exec"};ui.taskLayout="group";');
  assert.ok(f.run('tasksView()').includes(empty.title));
  f.context.title=req.title;f.run('ui.search=title;');assert.match(f.run('tasksView()'),/关联工作一/);
  f.run('ui.search="";ui.status="done";');assert.doesNotMatch(f.run('tasksView()'),/另一个待拆分需求/);
  const viewer=f.run('data.memberships.find(m=>m.projectId==="p-exec"&&m.role==="developer").userId');
  f.app.business.setMember(admin,'p-exec',{userId:viewer,role:'viewer',version:f.app.business.getProject(admin,'p-exec').version});
  await f.become(viewer);await f.run('reload()');f.run('ui.status="all";');
  assert.doesNotMatch(f.run('tasksView()'),/data-manage-development|data-linked-task|data-batch-requirement/);
  f.context.reqId=req.id;assert.throws(()=>f.run('editDevelopment(reqId)'),/不能调整研发设置/);
});

test('任务筛选后仍保留隐藏需求组的展开状态',async t=>{
  const f=await fixture(t);
  f.run('route={view:"tasks",projectId:"p-exec"};taskGroupStates.set(taskGroupKey(),new Set(["hidden","visible"]));');
  f.context.document.querySelectorAll=selector=>selector==='details.requirement-task-group'?[
    {open:false,querySelector:()=>({dataset:{taskGroup:'visible'}})},
    {open:true,querySelector:()=>({dataset:{taskGroup:'newly-open'}})},
  ]:[];
  assert.deepEqual([...f.run('rememberTaskGroups()')].sort(),['hidden','newly-open']);
});


test('提议与需求共用文档选择器，确认转入保留关联并同步文档分类及返回入口',async t=>{
  const f=await fixture(t),admin=f.run('user');
  const doc=f.app.business.uploadDocument(admin,'p-exec',{name:'文档联动测试.md',title:'文档联动测试',type:'PRD',contentBuffer:Buffer.from('# 方案\n## 1. 内容〔D-1〕\n具体方案。')}).document;
  await f.run('reload()');f.run('route={view:"proposals",projectId:"p-exec"};editProposal();');
  assert.match(f.element('#dialog').innerHTML,/需求标题|关联文档|尚未确认开发/);
  const mode='documentLinkMode:'+encodeURIComponent('id:'+doc.id),section='documentLinkSections:'+encodeURIComponent('id:'+doc.id)+':D-1';
  const form=new f.MockForm('proposals',{title:'有完整文档仍待确认',description:'背景完备',acceptance:'整体结果准确',priority:'P1',proposerName:'业务负责人',source:'产品规划',documentLinksPresent:'1',[mode]:'sections',[section]:'D-1'});
  form.id='proposal-form';form.dataset={id:'',projectId:'p-exec',approve:'0'};
  await f.listeners.submit({target:form,preventDefault(){}});
  const proposal=f.run('data.proposals.find(item=>item.title==="有完整文档仍待确认")');
  assert.equal(proposal.status,'待评估');assert.equal(proposal.docRefs[0].document,doc.name);assert.deepEqual([...proposal.docRefs[0].sections],['D-1']);
  assert.match(f.element('#dialog').innerHTML,/文档联动测试|data-from-proposal=/);
  f.context.proposalId=proposal.id;f.context.documentId=doc.id;
  f.run('route={view:"documents",projectId:"p-exec"};ui.documentConfirmation="unconfirmed";');
  assert.match(f.run('documentsView()'),/文档联动测试/);
  f.run('ui.documentConfirmation="confirmed";');assert.ok(!f.run('documentsView()').includes('data-open-document="'+doc.id+'"'));
  await f.run('openDocument(documentId,{fromProposal:proposalId})');assert.match(f.element('#dialog').innerHTML,/返回提议|data-proposal=/);
  const approve=new f.MockForm('proposals',{title:proposal.title,description:proposal.description,acceptance:proposal.acceptance,priority:'P1',proposerName:proposal.proposerName,source:proposal.source},proposal.id);
  approve.id='proposal-form';approve.dataset={id:proposal.id,projectId:'p-exec',version:String(proposal.version),approve:'1'};
  await f.listeners.submit({target:approve,preventDefault(){}});
  const converted=f.run('data.requirements.find(item=>item.title==="有完整文档仍待确认")');
  assert.equal(converted.status,'已确定');assert.equal(JSON.stringify(converted.docRefs),JSON.stringify(proposal.docRefs));
  assert.equal(f.app.business.listDocuments(admin,'p-exec').filter(item=>item.name===doc.name).length,1);
  f.run('ui.documentConfirmation="confirmed";');assert.match(f.run('documentsView()'),/文档联动测试/);
  f.run('ui.documentConfirmation="unconfirmed";');assert.ok(!f.run('documentsView()').includes('data-open-document="'+doc.id+'"'));
  f.context.reqId=converted.id;f.run('editRequirement(reqId)');assert.match(f.element('#dialog').innerHTML,/关联文档|指定章节|交付承诺与协作/);
  const reqForm=new f.MockForm('requirements',{title:converted.title,description:converted.description,acceptance:converted.acceptance,priority:'P1',source:converted.source,estimatePoints:'0',documentLinksPresent:'1',[mode]:'none'},converted.id);
  f.context.form=reqForm;await f.run('saveEntity(form)');
  const cleared=f.app.business.getRequirement(admin,converted.id);assert.equal(cleared.docRefs.length,0);
  f.run('ui.documentConfirmation="unlinked";');assert.match(f.run('documentsView()'),/文档联动测试/);
});


test('工作台复用工作服务并隔离搜索、目录偏好和业务数据，关注事项可打开原详情',async t=>{
  const f=await fixture(t);f.run('route={view:"team",projectId:""};');
  const before=f.run('JSON.stringify(data)');
  const requests=[];
  f.context.api=async(...args)=>{requests.push(args);return f.api(...args);};
  await f.run('loadWorkbench()');
  assert.equal(requests.filter(([url])=>url.startsWith('/work?')).length,1);
  assert.equal(f.run('JSON.stringify(data)'),before);
  assert.match(f.element('#view').innerHTML,/项目推进|待我处理/);
  assert.doesNotMatch(f.element('#view').innerHTML,/class="project-card"/);
  const metrics=f.run('JSON.stringify(buildWorkbench({data,user,date:today(),work:currentWorkbenchWork()}).metrics)');
  f.run('ui.search="不会匹配的项目";renderView();');
  await f.run('loadWorkbench()');
  assert.equal(requests.filter(([url])=>url.startsWith('/work?')).length,1);
  assert.equal(f.run('JSON.stringify(buildWorkbench({data,user,date:today(),work:currentWorkbenchWork()}).metrics)'),metrics);
  assert.match(f.element('#view').innerHTML,/没有符合|没有匹配|未找到/);
  f.run('openWorkbenchRisk("p-exec")');
  assert.match(f.element('#dialog').innerHTML,/项目推进与关注事项/);
  assert.doesNotMatch(f.element('#dialog').innerHTML,/data-archive|type="submit"/);
  assert.ok(requests.every(([,options])=>!options?.method||options.method==='GET'));
});

test('工作台载入失败不伪装零待办，重试恢复；迟到响应不能覆盖其他页面或账号',async t=>{
  const f=await fixture(t);f.run('route={view:"team",projectId:""};');
  f.context.api=async()=>{throw new Error('测试网络中断');};
  await f.run('loadWorkbench()');
  assert.equal(f.run('currentWorkbenchWork()'),null);
  assert.equal(f.run('currentWorkbenchError()'),true);
  assert.match(f.element('#view').innerHTML,/data-action="refresh-workbench"/);
  assert.match(f.element('#view').innerHTML,/—/);
  f.context.api=f.api;
  await f.run('loadWorkbench(true)');
  assert.equal(f.run('currentWorkbenchError()'),false);
  assert.ok(f.run('currentWorkbenchWork()'));
  let resolveRequest;
  f.context.api=()=>new Promise(resolve=>{resolveRequest=resolve;});
  const pending=f.run('loadWorkbench(true)');
  f.run('route={view:"projects",projectId:""};');
  f.element('#view').innerHTML='保留项目目录';
  resolveRequest({date:f.run('today()'),personal:{tasks:[],splits:[],reviews:[]},reminders:[]});
  await pending;
  assert.equal(f.element('#view').innerHTML,'保留项目目录');
  f.run('route={view:"team",projectId:""};');
  const oldSession=f.run('loadWorkbench(true)');
  f.run('user={...user,id:"new-account"};');
  f.element('#view').innerHTML='新账号页面';
  resolveRequest({date:f.run('today()'),personal:{tasks:[{id:'secret-old-task'}]},reminders:[]});
  await oldSession;
  assert.equal(f.element('#view').innerHTML,'新账号页面');
  assert.equal(f.run('currentWorkbenchWork()'),null);
});

test('六项需求最终验收可从工作台完整待办抽屉全部进入原详情',async t=>{
  const f=await fixture(t);
  f.run(`
    route={view:'team',projectId:''};
    user={id:'reviewer',role:'member',name:'测试人员'};
    data={projects:[{id:'p',name:'验收项目'}],memberships:[{userId:user.id,projectId:'p',role:'tester'}],users:[],documents:[],
      requirements:Array.from({length:6},(_,i)=>({id:'r'+i,projectId:'p',title:'需求验收'+i,status:'测试中',assigneeId:'dev',acceptance:'通过验收'})),
      tasks:Array.from({length:6},(_,i)=>({id:'t'+i,projectId:'p',requirementId:'r'+i,title:'已完成任务'+i,ownerId:'dev',status:'已完成'}))};
    workbenchState={actor:user,data,date:today(),error:false,pending:null,result:{date:today(),personal:{tasks:[],splits:[],reviews:[]},
      reminders:data.requirements.map(item=>({entityType:'requirement',entityId:item.id,kind:'review'}))}};
  `);
  const before=f.run('JSON.stringify(data)');
  const page=f.run('teamView()');
  assert.match(page,/查看全部 6 项/);
  assert.equal((page.match(/data-requirement="r\d"/g)||[]).length,5);
  const control=f.element('workbench-todos-control');control.dataset={action:'workbench-todos'};
  await f.listeners.click({target:{closest:selector=>selector==='button,[data-action]'?control:null},preventDefault(){}});
  const drawer=f.element('#dialog').innerHTML;
  for(let i=0;i<6;i++)assert.match(drawer,new RegExp(`data-requirement="r${i}"`));
  assert.doesNotMatch(drawer,/type="submit"|data-archive/);
  assert.equal(f.run('JSON.stringify(data)'),before);
});
