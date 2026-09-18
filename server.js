import http from 'node:http';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, MAX_BYTES, KINDS } from './files.js';
import { checkTransition, availableActions, normalizeStatus, isActive, deriveProgress, splitBalance, taskGranularity, SPLIT, ACTIVE_STATUSES, TERMINATED, STATUSES, FLOW, isTerminable } from './lifecycle.js';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const PORT=Number(process.env.PORT||3210), DB=path.resolve(process.env.DATA_FILE||path.join(ROOT,'data','db.json')), SEED=path.join(ROOT,'data.seed.json');
const FILES=path.resolve(process.env.FILES_DIR||path.join(ROOT,'data','files'));
const store=createStore(FILES);
const sessions=new Map(); let queue=Promise.resolve();
async function ensure(){try{await fs.access(DB)}catch{await fs.mkdir(path.dirname(DB),{recursive:true});await fs.copyFile(SEED,DB)}}
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)?v:'';
// 迁移：给存量数据补齐生命周期字段。纯派生、幂等，老库首次启动即被规范化。
// 关键：status 不再由任务覆盖，而是存下来的既有事实；任务的完成度改由 progress 字段表达。
function normalize(x){x.settings??={aiBaseUrl:'',aiApiKey:'',aiModel:''};x.history??=[];x.projects??=[];x.requirements??=[];x.tasks??=[];
 for(const r of x.requirements){const ts=x.tasks.filter(t=>t.requirementId===r.id);
  r.status=normalizeStatus(r.status||'未确定');r.priority=r.priority||'P1';r.collaboratorIds??=[];r.baseline??=null;r.rescheduleCount??=0;
  if(!day(r.planStart)){const ds=ts.map(t=>day(t.startDate)).filter(Boolean).sort();if(ds.length)r.planStart=ds[0]}
  if(!day(r.planEnd)){const ds=ts.map(t=>day(t.dueDate)).filter(Boolean).sort();if(ds.length)r.planEnd=ds[ds.length-1]}
  for(const t of ts){t.status=t.status||'待开始';t.planStart=t.startDate;t.planEnd=t.dueDate;t.assigneeId=t.ownerId}
  r.progress=deriveProgress(ts)}
 for(const t of x.tasks){t.status=t.status||'待开始';t.planStart=t.planStart||t.startDate;t.planEnd=t.planEnd||t.dueDate}}
async function read(){await ensure();const x=JSON.parse(await fs.readFile(DB,'utf8'));normalize(x);return x}
function save(x){queue=queue.then(async()=>{const t=DB+'.tmp';await fs.writeFile(t,JSON.stringify(x,null,2));await fs.rename(t,DB)});return queue}
const send=(res,status,data,extra={})=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...extra});res.end(typeof data==='string'?data:JSON.stringify(data))};
async function json(req){let s='';for await(const c of req)s+=c;return s?JSON.parse(s):{}}
const newId=p=>`${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
const TODAY=()=>new Date().toISOString().slice(0,10);
// 操作历史是唯一「谁在什么时候把需求推到哪一步」的凭据，任何写操作都必须经这里
function record(db,{requirementId,actor,action,from,to,detail}){db.history.unshift({id:newId('h'),requirementId,at:new Date().toISOString(),date:TODAY(),actorId:actor?.id||'',actorName:actor?.name||'系统',actorRole:actor?.role||'',action,from:from||'',to:to||'',detail:detail||''})}
// 任务完成度 → 需求进度的单向同步：只在「全部任务完成」时推进到已完成，绝不静默回退
function syncProgress(db,r,actor){const ts=db.tasks.filter(t=>t.requirementId===r.id);r.progress=deriveProgress(ts);
 if(ts.length&&ts.every(t=>t.status==='已完成')&&r.status==='测试中'){r.status='已完成';record(db,{requirementId:r.id,actor,action:'流转',from:'测试中',to:'已完成',detail:'全部拆分任务已完成，系统自动收口'})}}
function sessionToken(req){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('xinghe_session='))?.slice('xinghe_session='.length)}
function me(req,db){const id=sessions.get(sessionToken(req));return id?db.users.find(u=>u.id===id&&u.active):undefined}
function publicUser(u){const {password,...x}=u;return x}
function fallback(text){return {documentSummary:`已读取 ${text.length} 个字符，以下是待人工确认的候选分析。`,facts:[],assumptions:['需要产品经理确认项目归属、目标用户和验收口径。'],openQuestions:['这项能力是否属于当前项目？','哪些指标代表完成？'],requirements:[{title:'明确核心用户流程',userValue:'让用户完成主要目标',description:'从文档提取主流程并形成可验收交付物。',projectSuggestion:'待产品确认',certainty:'待评审',priority:'P1',priorityReason:'通常是核心版本的必要组成。',acceptanceCriteria:['主流程可端到端完成'],tasks:[{title:'补充验收标准',type:'产品',estimatePoints:1,dependencies:[]},{title:'前后端实现与测试',type:'开发',estimatePoints:5,dependencies:[]}],totalPoints:5,risks:['文档可能遗漏异常场景']}],schedule:{capacityAssumption:'1 位产品经理 + 3 位全栈开发；按每周约 12 人日有效投入估算。',sequence:['先确认验收标准','再拆分前后端与测试任务'],suggestion:'先进入待评审，不直接形成交付承诺。',rangeDays:{min:3,max:7}},reviewChecklist:['确认项目归属','确认验收标准','确认依赖与风险']}}
async function analyze(text,settings){const base=(settings.aiBaseUrl||process.env.AI_BASE_URL||'').replace(/\/$/,'');const key=settings.aiApiKey||process.env.AI_API_KEY;const model=settings.aiModel||process.env.AI_MODEL||'gpt-4.1-mini';if(!base||!key)return fallback(text);const skill=await fs.readFile(path.join(ROOT,'skills/requirements-analysis/SKILL.md'),'utf8');const prompt=`你必须遵守下面的需求分析 Skill，并只返回合法 JSON，不要 Markdown。\n${skill}\n\n待分析文档：\n${text}`;const r=await fetch(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],temperature:.15,response_format:{type:'json_object'}})});if(!r.ok)throw Error('模型请求失败：'+r.status);const o=await r.json();return JSON.parse(o.choices?.[0]?.message?.content||'{}')}
const MS=864e5;
// 里程碑状态是算出来的：到期未达成即「未达成」，已完成的需求占该节点的达成率
function milestonesOf(p,ts){const targetTs=ts.filter(t=>t.planEnd===p.targetDate||t.dueDate===p.targetDate);
 const donePct=ts.length?ts.filter(t=>t.status==='已完成').length/ts.length:0;
 const now=Date.parse(TODAY());
 const mk=(label,date,kind)=>{const ms=Date.parse(date);const passed=date<=TODAY();
  const reached=kind==='start'?passed:donePct>=1;
  return {label,date,kind,reached,state:reached?'已达成':passed?'未达成':'待达成',pct:Math.round(donePct*100)}};
 return (Array.isArray(p.milestones)&&p.milestones.length?p.milestones:[{label:'项目启动',date:p.startDate,kind:'start'},{label:'目标交付',date:p.targetDate,kind:'target'}]).filter(m=>m.date).map(m=>mk(m.label,m.date,m.kind))}
function timeline(db){const tasks=db.tasks.map(t=>({...t,ownerName:db.users.find(u=>u.id===t.ownerId)?.name||'待分配'}));
const dates=tasks.flatMap(t=>[t.startDate,t.dueDate]).concat(db.projects.flatMap(p=>[p.startDate,p.targetDate])).filter(Boolean).map(d=>Date.parse(d));
const today=Date.parse(new Date().toISOString().slice(0,10));
const min=Math.min(...(dates.length?dates:[today])), max=Math.max(...(dates.length?dates:[today]));
const start=Math.min(min,today), end=Math.max(max,today), span=Math.max(end-start,MS);
const done=tasks.filter(t=>t.status==='已完成');
const overdue=tasks.filter(t=>t.dueDate&&Date.parse(t.dueDate)<today&&t.status!=='已完成');
const weekAhead=today+7*MS, dueSoon=tasks.filter(t=>t.dueDate&&Date.parse(t.dueDate)>=today&&Date.parse(t.dueDate)<=weekAhead&&t.status!=='已完成');
const unassigned=tasks.filter(t=>!db.users.some(u=>u.id===t.ownerId));
const load={};for(const t of tasks){if(!t.ownerId)continue;const k=t.ownerId;(load[k]??={id:k,name:t.ownerName,hours:0,tasks:0,active:0});load[k].hours+=Number(t.estimateHours)||0;load[k].tasks++;if(['开发中','测试中'].includes(t.status))load[k].active++}
const lanes=db.projects.map(p=>{const ts=tasks.filter(t=>t.projectId===p.id);
const late=ts.filter(t=>t.dueDate&&Date.parse(t.dueDate)<today&&t.status!=='已完成');
const afterTarget=p.targetDate&&ts.some(t=>t.dueDate&&Date.parse(t.dueDate)>Date.parse(p.targetDate)&&t.status!=='已完成');
const pct=ts.length?Math.round(ts.filter(t=>t.status==='已完成').length/ts.length*100):0;
const risks=late.map(t=>`「${t.title}」已逾期`).concat(afterTarget?['存在超出项目目标日期的任务']:[]).concat(ts.some(t=>!t.ownerId)?['存在未分配负责人的任务']:[]);
const health=late.length||afterTarget?'风险':pct>=60?'正常':'关注';
return {id:p.id,name:p.name,status:p.status,ownerId:p.ownerId,ownerName:db.users.find(u=>u.id===p.ownerId)?.name||'待指定',startDate:p.startDate,targetDate:p.targetDate,pct,health,risks,
milestones:milestonesOf(p,ts),
bars:ts.map(t=>({id:t.id,title:t.title,status:t.status,ownerName:t.ownerName,startDate:t.startDate,dueDate:t.dueDate,estimateHours:t.estimateHours,late:!!(t.dueDate&&Date.parse(t.dueDate)<today&&t.status!=='已完成'),afterTarget:!!(p.targetDate&&t.dueDate&&Date.parse(t.dueDate)>Date.parse(p.targetDate)&&t.status!=='已完成')})).filter(b=>b.startDate&&b.dueDate)}});
const statuses=['待开始','开发中','测试中','已完成'];
return {range:{start:new Date(start).toISOString().slice(0,10),end:new Date(end).toISOString().slice(0,10),startMs:start,endMs:end,spanMs:span,today:new Date().toISOString().slice(0,10)},
metrics:{projects:db.projects.length,tasks:tasks.length,active:tasks.length-done.length,done:done.length,overdue:overdue.length,dueSoon:dueSoon.length,unassigned:unassigned.length,
onTimeRate:tasks.length?Math.round((tasks.length-overdue.length-tasks.filter(t=>!t.dueDate).length)/(tasks.length-tasks.filter(t=>!t.dueDate).length||1)*100):100,
health:overdue.length>2?'风险':overdue.length?'关注':'正常'},
statuses,lanes,load:Object.values(load).sort((a,b)=>b.hours-a.hours),
risks:overdue.map(t=>`逾期：${t.title}（${t.ownerName}，截止 ${t.dueDate}）`)
 .concat(unassigned.map(t=>`未分配负责人：${t.title}`))
 .concat(lanes.filter(l=>l.health==='风险').map(l=>`项目「${l.name}」存在延期风险`))}}
async function api(req,res,url){const db=await read();
if(req.method==='POST'&&url==='/api/auth/login'){const b=await json(req),u=db.users.find(x=>x.username===b.username&&x.password===b.password&&x.active);if(!u)return send(res,401,{error:'账号或密码错误'});const t=randomBytes(32).toString('base64url');sessions.set(t,u.id);return send(res,200,{user:publicUser(u)},{'set-cookie':`xinghe_session=${t}; HttpOnly; SameSite=Lax; Path=/`})}
if(req.method==='POST'&&url==='/api/auth/logout'){const t=sessionToken(req);if(t)sessions.delete(t);return send(res,200,{ok:true},{'set-cookie':'xinghe_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/'})}
const u=me(req,db);if(!u)return send(res,401,{error:'请先登录'});
if(req.method==='GET'&&url==='/api/auth/me')return send(res,200,{user:publicUser(u)});
if(req.method==='GET'&&url==='/api/bootstrap')return send(res,200,{...db,users:db.users.map(publicUser),settings:u.role==='项目管理'?{aiBaseUrl:db.settings.aiBaseUrl,aiModel:db.settings.aiModel}:undefined,currentUser:publicUser(u)});
if(req.method==='GET'&&url==='/api/meta')return send(res,200,{statuses:STATUSES,flow:FLOW,split:SPLIT});
if(req.method==='GET'&&url==='/api/timeline')return send(res,200,timeline(db));
if(req.method==='POST'&&url==='/api/requirements'){if(!['项目管理','产品'].includes(u.role))return send(res,403,{error:'当前角色不能创建需求'});const b=await json(req);if(!String(b.title||'').trim()||!b.projectId)return send(res,400,{error:'需求标题和项目不能为空'});const x={id:newId('r'),title:String(b.title).trim(),description:String(b.description||''),projectId:b.projectId,source:b.source||'手动录入',status:'未确定',priority:b.priority||'P1',ownerId:u.id,assigneeId:b.assigneeId||'',collaboratorIds:Array.isArray(b.collaboratorIds)?b.collaboratorIds:[],planStart:day(b.planStart),planEnd:day(b.planEnd),createdAt:TODAY(),estimatePoints:Number(b.estimatePoints||3),acceptance:String(b.acceptance||'')};db.requirements.unshift(x);record(db,{requirementId:x.id,actor:u,action:'创建',to:'未确定',detail:`录入需求《${x.title}》`});for(const t of (b.tasks||[])){if(!String(t.title||'').trim())continue;db.tasks.unshift({id:newId('t'),title:String(t.title).trim(),projectId:x.projectId,requirementId:x.id,ownerId:t.assigneeId||t.ownerId||x.assigneeId||'',status:'待开始',startDate:day(t.planStart||t.startDate)||'',dueDate:day(t.planEnd||t.dueDate)||'',estimateHours:Number(t.estimateHours||8)})}syncProgress(db,x,u);await save(db);return send(res,201,x)}
if(req.method==='PATCH'&&url.startsWith('/api/requirements/')){const x=db.requirements.find(x=>x.id===url.split('/').pop());if(!x)return send(res,404,{error:'需求不存在'});if(!['项目管理','产品'].includes(u.role)&&x.assigneeId!==u.id)return send(res,403,{error:'只有产品、项目管理或该需求的主责开发可以修改需求'});
 const b=await json(req),changed=[];
 // status 走专用流转接口，这里静默丢弃，防止绕过状态机与门禁
 const {status:_ignored,history:_h,progress:_p,...patch}=b;
 // 改期：留一次基线快照并累计改期次数，让「计划被推迟了几次」可追溯
 if(('planStart' in patch||'planEnd' in patch)){const ns=patch.planStart===undefined?x.planStart:day(patch.planStart),ne=patch.planEnd===undefined?x.planEnd:day(patch.planEnd);
  if(ns!==x.planStart||ne!==x.planEnd){const pj=db.projects.find(p=>p.id===x.projectId);if(pj?.targetDate&&ne&&ne>pj.targetDate){if(!patch.force)return send(res,409,{error:`计划结束 ${ne} 晚于项目目标交付日 ${pj.targetDate}，请调整日期或带上 force 确认`,code:'OUT_OF_WINDOW'})}
   // 基线只在「本来就有排期、现在要把它改掉」时留存 —— 基线是用来对比偏移的锚点，
   // 首次排期没有可留的旧计划，此时记一条空基线既没意义又会让偏移量算不出来。
   if(x.planStart||x.planEnd){if(!x.baseline)x.baseline={planStart:x.planStart||'',planEnd:x.planEnd||'',capturedAt:TODAY()};x.rescheduleCount=(x.rescheduleCount||0)+1}
   changed.push(`排期 ${x.planStart||'—'} → ${ns||'—'} / ${x.planEnd||'—'} → ${ne||'—'}`);record(db,{requirementId:x.id,actor:u,action:x.planStart||x.planEnd?'改期':'排期',detail:changed[changed.length-1]})}}
 if('assigneeId' in patch&&patch.assigneeId!==x.assigneeId){const who=db.users.find(u=>u.id===patch.assigneeId);record(db,{requirementId:x.id,actor:u,action:'指派',detail:patch.assigneeId?`主责开发：${(db.users.find(y=>y.id===x.assigneeId)?.name||'待分配')} → ${who?.name||patch.assigneeId}`:'取消主责开发指派'})}
 for(const k of ['title','description','projectId','priority','estimatePoints','acceptance','source','assigneeId','collaboratorIds','planStart','planEnd']){
  if(!(k in patch))continue;const v=patch[k];
  if(k==='estimatePoints')x[k]=Number(v)||0;
  else if(k==='planStart'||k==='planEnd')x[k]=day(v);
  else if(k==='collaboratorIds')x[k]=Array.isArray(v)?v:[];
  else if(k==='title'){if(!String(v).trim())return send(res,400,{error:'需求标题不能为空'});x[k]=String(v).trim()}
  else x[k]=v;
  if(['title','description','priority','estimatePoints','acceptance','projectId'].includes(k))changed.push(k)}
 if(changed.length){const label={title:'标题',description:'描述',priority:'优先级',estimatePoints:'工作量',acceptance:'验收标准',projectId:'所属项目'};
  const names=changed.filter(k=>label[k]).map(k=>label[k]);if(names.length)record(db,{requirementId:x.id,actor:u,action:'编辑',detail:'修改了 '+names.join('、')})}
 syncProgress(db,x,u);await save(db);return send(res,200,x)}
if(req.method==='POST'&&url.startsWith('/api/requirements/')&&url.endsWith('/transition')){
 const x=db.requirements.find(x=>x.id===url.split('/').slice(-2)[0]);if(!x)return send(res,404,{error:'需求不存在'});
 const b=await json(req),ts=db.tasks.filter(t=>t.requirementId===x.id),pj=db.projects.find(p=>p.id===x.projectId);
 const ctx={role:u.role,taskCount:ts.length,projectTarget:pj?.targetDate||''};
 if(b.to===TERMINATED&&!b.reason)return send(res,400,{error:'终止需求必须填写原因，便于后续复盘'});
 const chk=checkTransition(x,b.to,ctx);
 if(!chk.ok)return send(res,409,{error:chk.error,gates:chk.gates||[]});
 const from=x.status;x.status=chk.to;
 record(db,{requirementId:x.id,actor:u,action:b.to===TERMINATED?'终止':'流转',from,to:chk.to,detail:String(b.reason||'').trim()||chk.reason||''});
 if(chk.to==='开发中'){const t0=db.tasks.filter(t=>t.requirementId===x.id&&t.status==='待开始');for(const t of t0)if(!t.startDate)t.startDate=TODAY()}
 syncProgress(db,x,u);await save(db);return send(res,200,{requirement:x,available:availableActions(x,ctx)})}
if(req.method==='GET'&&url.startsWith('/api/requirements/')&&url.endsWith('/history')){
 const id=url.slice('/api/requirements/'.length,-'/history'.length);if(!db.requirements.some(r=>r.id===id))return send(res,404,{error:'需求不存在'});
 return send(res,200,{history:db.history.filter(h=>h.requirementId===id)})}
if(req.method==='POST'&&url==='/api/projects'){if(!['项目管理','产品'].includes(u.role))return send(res,403,{error:'当前角色不能创建项目'});const b=await json(req);if(!String(b.name||'').trim())return send(res,400,{error:'项目名称不能为空'});b.name=String(b.name).trim();const x={id:newId('p'),status:'规划中',ownerId:u.id,...b};db.projects.unshift(x);await save(db);return send(res,201,x)}
// 拆分：校验颗粒度（4–24h/任务）并批量落库，一次请求一个完整拆分包，避免半拆状态
if(req.method==='POST'&&url.startsWith('/api/requirements/')&&url.endsWith('/tasks')){
 const x=db.requirements.find(x=>x.id===url.slice('/api/requirements/'.length,-'/tasks'.length));if(!x)return send(res,404,{error:'需求不存在'});
 if(!['项目管理','产品'].includes(u.role)&&x.assigneeId!==u.id)return send(res,403,{error:'只有产品、项目管理或该需求的主责开发可以拆分'});
 if(x.status==='已完成'||x.status===TERMINATED)return send(res,409,{error:`需求已进入「${x.status}」，不能再拆分`});
 const b=await json(req),rows=Array.isArray(b.tasks)?b.tasks:[];if(!rows.length)return send(res,400,{error:'至少需要一条任务'});
 const t0=db.tasks.filter(t=>t.requirementId===x.id);
 // 硬校验只挡「结构性非法」（无标题 / 工时非正数），颗粒度超标降级为提示：
 // 真实研发里必然有细碎的联调任务和偏大的调研任务，强制拦截只会逼人绕过系统。
 const bad=[],warn=[];rows.forEach((t,i)=>{const h=Number(t.estimateHours||8);if(!String(t.title||'').trim())bad.push(`第 ${i+1} 行缺少任务名`);
  if(!Number.isFinite(h)||h<=0)bad.push(`第 ${i+1} 行工时必须是正数`);
  else{const g=taskGranularity(h);if(g.level!=='ok')warn.push(`「${String(t.title||'').trim()}」${g.message}`)}});
 if(bad.length)return send(res,400,{error:'拆分包不完整',details:bad});
 const made=rows.map(t=>({id:newId('t'),title:String(t.title).trim(),projectId:x.projectId,requirementId:x.id,ownerId:t.assigneeId||t.ownerId||x.assigneeId||'',status:'待开始',startDate:day(t.planStart||t.startDate),dueDate:day(t.planEnd||t.dueDate),estimateHours:Number(t.estimateHours||8)}));
 db.tasks.unshift(...made);
 if(!x.assigneeId){const first=made.find(t=>t.ownerId);if(first)x.assigneeId=first.ownerId}
 record(db,{requirementId:x.id,actor:u,action:'拆分',detail:`新增 ${made.length} 条任务（合计 ${made.reduce((s,t)=>s+t.estimateHours,0)}h，${(made.reduce((s,t)=>s+t.estimateHours,0)/SPLIT.MIN_PER_DEV_DAY).toFixed(1)} 人日）`});
 syncProgress(db,x,u);await save(db);return send(res,201,{tasks:made,requirement:x,balance:splitBalance(x.estimatePoints,t0.concat(made)),warnings:warn})}
if(req.method==='POST'&&url==='/api/tasks'){if(!['项目管理','产品','开发','测试'].includes(u.role))return send(res,403,{error:'当前角色不能创建研发任务'});const b=await json(req);if(!b.title||!b.projectId)return send(res,400,{error:'任务标题和项目不能为空'});const x={...b,id:newId('t'),status:'待开始',ownerId:['开发','测试'].includes(u.role)?u.id:b.ownerId,planStart:day(b.startDate),planEnd:day(b.dueDate)};db.tasks.unshift(x);const r=db.requirements.find(r=>r.id===x.requirementId);if(r){syncProgress(db,r,u)}await save(db);return send(res,201,x)}
if(req.method==='PATCH'&&url.startsWith('/api/tasks/')){const x=db.tasks.find(x=>x.id===url.split('/').pop());if(!x)return send(res,404,{error:'任务不存在'});if(['开发','测试'].includes(u.role)&&x.ownerId!==u.id)return send(res,403,{error:'只能更新自己的任务'});
 const b=await json(req);const {status:_s,...rest}=b;
 if('status' in b){const ok=['待开始','开发中','测试中','已完成'].includes(b.status);if(!ok)return send(res,400,{error:'任务状态不合法'});if(x.status!==b.status){record(db,{requirementId:x.requirementId,actor:u,action:'任务流转',from:x.status,to:b.status,detail:`任务「${x.title}」`})}x.status=b.status}
 Object.assign(x,rest);x.planStart=x.startDate||x.planStart;x.planEnd=x.dueDate||x.planEnd;
 const r=db.requirements.find(r=>r.id===x.requirementId);if(r)syncProgress(db,r,u);
 await save(db);return send(res,200,x)}
if(req.method==='DELETE'&&url.startsWith('/api/tasks/')){const i=db.tasks.findIndex(x=>x.id===url.split('/').pop());if(i<0)return send(res,404,{error:'任务不存在'});const x=db.tasks[i];
 if(!['项目管理','产品'].includes(u.role)&&x.ownerId!==u.id)return send(res,403,{error:'只有产品、项目管理或该任务负责人可以删除'});
 db.tasks.splice(i,1);const r=db.requirements.find(r=>r.id===x.requirementId);
 record(db,{requirementId:x.requirementId,actor:u,action:'删除任务',detail:`移除任务「${x.title}」（${x.estimateHours||0}h）`});
 if(r)syncProgress(db,r,u);await save(db);return send(res,200,{ok:true})}
if(req.method==='POST'&&url==='/api/agent/analyze'){const b=await json(req);if(!b.text?.trim())return send(res,400,{error:'请提供 Markdown 文档内容'});try{return send(res,200,await analyze(b.text,db.settings))}catch(e){return send(res,502,{error:e.message})}}
if(req.method==='PUT'&&url==='/api/settings/ai'){if(u.role!=='项目管理')return send(res,403,{error:'只有项目管理可以配置模型'});const b=await json(req);db.settings={aiBaseUrl:String(b.aiBaseUrl||'').replace(/\/$/,''),aiApiKey:String(b.aiApiKey||''),aiModel:String(b.aiModel||'')};await save(db);return send(res,200,{aiBaseUrl:db.settings.aiBaseUrl,aiModel:db.settings.aiModel})}
if(req.method==='GET'&&url==='/api/settings/models'){if(u.role!=='项目管理')return send(res,403,{error:'只有项目管理可以获取模型列表'});if(!db.settings.aiBaseUrl||!db.settings.aiApiKey)return send(res,400,{error:'请先保存 URL 和 Key'});const r=await fetch(db.settings.aiBaseUrl+'/models',{headers:{authorization:'Bearer '+db.settings.aiApiKey}});if(!r.ok)return send(res,502,{error:'获取模型列表失败：'+r.status});const o=await r.json();return send(res,200,{models:(o.data||[]).map(x=>x.id)})}
if(req.method==='POST'&&url==='/api/users'){if(u.role!=='项目管理')return send(res,403,{error:'只有项目管理可以新增账号'});const b=await json(req);if(!b.username||!b.password||!String(b.name||'').trim()||!['项目管理','产品','开发','测试'].includes(b.role))return send(res,400,{error:'账号、密码、姓名、角色不能为空'});if(db.users.some(x=>x.username===b.username))return send(res,409,{error:'账号已存在'});const x={id:newId('u'),username:String(b.username).trim(),password:b.password,name:String(b.name).trim(),role:b.role,title:b.title||b.role,active:true};db.users.push(x);await save(db);return send(res,201,publicUser(x))}
if(req.method==='PATCH'&&url.startsWith('/api/users/')){if(u.role!=='项目管理')return send(res,403,{error:'只有项目管理可以修改账号'});const x=db.users.find(x=>x.id===url.split('/').pop());if(!x)return send(res,404,{error:'账号不存在'});const b=await json(req);if(b.role&&!['项目管理','产品','开发','测试'].includes(b.role))return send(res,400,{error:'角色不合法'});if(b.username&&db.users.some(y=>y.username===b.username&&y.id!==x.id))return send(res,409,{error:'账号已存在'});if(b.name!==undefined&&!String(b.name).trim())return send(res,400,{error:'姓名不能为空'});Object.assign(x,b);await save(db);return send(res,200,publicUser(x))}
if(req.method==='GET'&&url.startsWith('/api/requirements/')&&url.endsWith('/files')){
 const id=url.slice('/api/requirements/'.length,-'/files'.length);
 if(!db.requirements.some(r=>r.id===id))return send(res,404,{error:'需求不存在'});
 return send(res,200,{id,limits:{maxBytes:MAX_BYTES,kinds:Object.keys(KINDS)},...await store.listFor(id)})}
if(req.method==='PUT'&&url.startsWith('/api/requirements/')&&url.includes('/files/')){
 if(!['项目管理','产品','开发','测试'].includes(u.role))return send(res,403,{error:'当前角色不能上传附件'});
 const seg=url.split('/').filter(Boolean); // api requirements :id files :kind :name
 const id=seg[2],kind=seg[4],name=(url.split('/files/'+kind+'/')[1]||'');
 if(!db.requirements.some(r=>r.id===id))return send(res,404,{error:'需求不存在'});
 if(!KINDS[kind])return send(res,400,{error:'只支持 doc（文档）或 proto（原型）'});
 const ext=path.extname(name).toLowerCase();
 if(kind==='doc'&&!['.md','.markdown','.txt'].includes(ext))return send(res,400,{error:'文档只支持 .md / .markdown / .txt'});
 if(kind==='proto'&&ext!=='.html')return send(res,400,{error:'原型只支持单文件 .html'});
 let closed=false; const chunks=[]; let total=0;
 for await(const c of req){total+=c.length;if(total>MAX_BYTES+1){closed=true;req.destroy();break}chunks.push(c)}
 if(closed)return send(res,413,{error:`文件超过 ${Math.round(MAX_BYTES/1048576)}MB 上限`});
 const buf=Buffer.concat(chunks);
 try{const r=await store.write(id,kind,decodeURIComponent(name),buf,{name:u.name||u.username,email:(u.username||'user')+'@xinghe.local'});
 if(r.error)return send(res,400,{error:r.error});
 return send(res,200,{saved:!r.unchanged,unchanged:!!r.unchanged,id,limits:{maxBytes:MAX_BYTES,kinds:Object.keys(KINDS)},...r.list})}
 catch(e){return send(res,500,{error:'保存失败：'+e.message})}}
if(req.method==='GET'&&url.startsWith('/api/requirements/')&&url.includes('/files/')){
 const seg=url.split('/').filter(Boolean);
 const id=seg[2],kind=seg[4],name=decodeURIComponent(url.split('/files/'+kind+'/')[1]||'');
 if(!KINDS[kind])return send(res,404,{error:'附件不存在'});
 const version=new URL('http://x'+req.url).searchParams.get('version')||'';
 const raw=await store.readRaw(id,kind,name,version).catch(()=>null);
 if(!raw)return send(res,404,{error:'文件或该版本不存在'});
 const ext=path.extname(name).toLowerCase();
 // 文档按纯文本返回（前端渲染 Markdown）；原型进入沙箱，allow-scripts 且刻意不给 allow-same-origin
 const isProto=kind==='proto';
 const type=isProto?'text/html; charset=utf-8':'text/plain; charset=utf-8';
 const extra={'content-type':type,'cache-control':'no-store','x-content-type-options':'nosniff'};
 if(isProto)extra['content-security-policy']="sandbox allow-scripts; default-src 'unsafe-inline' 'self' https: data:; script-src 'unsafe-inline' 'unsafe-eval' https:; img-src 'self' data:";
 else extra['content-disposition']='inline';
 res.writeHead(200,extra);res.end(raw.buffer);return}
if(req.method==='DELETE'&&url.startsWith('/api/requirements/')&&url.includes('/files/')){
 if(!['项目管理','产品'].includes(u.role))return send(res,403,{error:'只有项目管理或产品可以移除附件'});
 const seg=url.split('/').filter(Boolean);
 const id=seg[2],kind=seg[4],name=decodeURIComponent(url.split('/files/'+kind+'/')[1]||'');
 if(!KINDS[kind])return send(res,404,{error:'附件不存在'});
 try{const r=await store.remove(id,kind,name,{name:u.name||u.username,email:(u.username||'user')+'@xinghe.local'});
 if(!r)return send(res,400,{error:'文件名不合法'});
 return send(res,200,{removed:true,id,...r.list})}catch(e){return send(res,500,{error:'移除失败：'+e.message})}}
return send(res,404,{error:'接口不存在'})}
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://localhost').pathname;
  if(url.startsWith('/api/'))return await api(req,res,url);
  // lifecycle.js 在仓库根目录（服务端 import 的同一份文件），浏览器也要 import 它，
  // 所以这一条单独映射到 public 之外；其余静态资源一律锁在 public 下，禁止路径穿越。
  const shared=url==='/lifecycle.js'?path.join(ROOT,'lifecycle.js'):null;
  const publicRoot=path.join(ROOT,'public');
  const f=shared||path.resolve(publicRoot,url==='/'?'index.html':'.'+decodeURIComponent(url));
  if(!shared&&!f.startsWith(publicRoot+path.sep))return send(res,403,{error:'禁止访问'});
  if(!['GET','HEAD'].includes(req.method))return send(res,405,{error:'不支持的请求方法'});
  // Read before sending headers: a missing asset must not crash the process.
  const content=await fs.readFile(f);
  res.writeHead(200,{'cache-control':'no-store','content-type':({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'})[path.extname(f)]||'application/octet-stream'});
  res.end(req.method==='HEAD'?undefined:content);
 } catch(e) {
  if(res.headersSent){res.destroy();return}
  const missing=['ENOENT','ENOTDIR','EISDIR'].includes(e.code);
  if(!missing)console.error('[request]',req.method,req.url,e);
  send(res,missing?404:500,{error:missing?'文件不存在':'服务器处理请求失败'});
 }
});ensure().then(()=>store.doctor().then(d=>{if(d.missing.length)console.warn('[files] 以下文件在 git 中有记录但磁盘缺失：\n  '+d.missing.join('\n  '));console.log(`[files] git 仓库 ${FILES} 已跟踪 ${d.tracked} 个文件`)}).catch(e=>console.warn('[files] 仓库自检失败：'+e.message))).then(()=>server.listen(PORT,()=>console.log('http://localhost:'+PORT)));
