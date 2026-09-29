import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {auditChanges,escapeHtml,renderAuditEntry,renderBaseline,renderErrorDetails,renderTextComparison} from '../../frontend/review-ui.js';
import {blankTask,readBatchForm,renderBatchRows,renderBatchSummary} from '../../frontend/task-batch.js';

test('修改历史展示人员、状态与空值的实际差异，并转义正文和操作说明',()=>{
  const attack='\"><img src=x onerror=alert(1)>&';
  const entry={detail:{before:{title:'旧标题',ownerId:'u1',status:'develop',collaboratorIds:[],description:''},after:{title:attack,ownerId:'u2',status:'test',collaboratorIds:['u1'],description:'新背景'},reason:attack}};
  const nameOf=id=>({u1:'成员甲',u2:'成员乙'}[id]||id);
  const changes=auditChanges(entry,nameOf);
  assert(changes.some(x=>x.label==='负责人'&&x.before==='成员甲'&&x.after==='成员乙'));
  assert(changes.some(x=>x.label==='状态'&&x.before==='开发中'&&x.after==='测试中'));
  assert(changes.some(x=>x.label==='背景与说明'&&x.before==='未设置'&&x.after==='新背景'));
  assert(changes.some(x=>x.label==='协作成员'&&x.before==='无'&&x.after==='成员甲'));
  const html=renderAuditEntry(entry,{actor:attack,summary:attack,stamp:attack,nameOf});
  assert.doesNotMatch(html,/<img|<script/);assert(html.includes(escapeHtml(attack)));assert.match(html,/查看修改内容/);
  assert.deepEqual(auditChanges({detail:{before:{title:'相同'},after:{title:'相同'}}}),[]);
  const legacy=renderAuditEntry({legacy:true,from:'<原状态>',to:'<新状态>',detail:attack},{summary:'旧系统说明'});
  assert.match(legacy,/原系统记录/);assert.match(legacy,/&lt;原状态&gt; → &lt;新状态&gt;/);assert.doesNotMatch(legacy,/<img/);
});

test('旧排期基线兼容跨月偏移，缺失与无效日期不伪造天数',()=>{
  const legacy=renderBaseline({baseline:{startDate:'2024-02-28',dueDate:'2024-03-05'},planStart:'2024-03-01',planEnd:'2024-03-03',rescheduleCount:2});
  assert.match(legacy,/推迟 2 天/);assert.match(legacy,/提前 2 天/);assert.match(legacy,/已调整 2 次/);assert.match(legacy,/2024-02-28/);assert.match(legacy,/交付承诺基线对比/);
  const partial=renderBaseline({baseline:{planStart:'2024-02-30',planEnd:'2024-03-05',capturedAt:'<img onerror=x>'},planStart:'2024-03-01',planEnd:'2024-03-05'});
  assert.match(partial,/无法计算/);assert.match(partial,/未偏移/);assert.doesNotMatch(partial,/NaN|<img/);
  assert.match(renderBaseline({baseline:null}),/尚未调整交付承诺/);
});

test('逐行错误、流程条件和文本版本对照均展示细节且不执行附件内容',()=>{
  const attack='<script>alert(1)</script>';
  const errors=renderErrorDetails({rows:[{row:2,message:'负责人不属于项目'},{row:3,error:attack}]});
  assert.match(errors,/第 2 行：负责人不属于项目/);assert.match(errors,/第 3 行：&lt;script&gt;/);assert.doesNotMatch(errors,/<script/);
  assert.match(renderErrorDetails({gates:['缺少验收标准']}),/缺少验收标准/);assert.equal(renderErrorDetails(undefined),'');
  const comparison=renderTextComparison(`相同\n${attack}\n删除行`,'相同\n新内容');
  assert.equal((comparison.match(/class="changed-line"/g)||[]).length,2);assert.match(comparison,/删除行/);assert.doesNotMatch(comparison,/<script/);
  const capped=renderTextComparison(Array(2001).fill('原行').join('\n'),'');
  assert.match(capped,/前 2000 行/);assert.equal((capped.match(/<th scope="row">/g)||[]).length,2000);
});

test('批量输入保留小数工时与固定负责人，并正确转义任务和成员名称',()=>{
  const attack='\" autofocus onfocus=alert(1) <img>';
  const html=renderBatchRows([{...blankTask('u'),title:attack,estimateHours:0.25}],[{id:'u',name:attack}],{fixedOwner:'u'});
  assert.match(html,/value="0.25"/);assert.match(html,/<select[^>]* disabled>/);assert.doesNotMatch(html,/<img|value="" autofocus/);assert(html.includes(escapeHtml(attack)));
  const controls=[['title','实现接口'],['ownerId','u'],['estimateHours','0.25'],['startDate','2026-01-01'],['dueDate','2026-01-02']].map(([field,value])=>({dataset:{batchField:field},value,disabled:field==='ownerId'}));
  const form={querySelectorAll:()=>[{querySelectorAll:()=>controls}]};
  assert.deepEqual(readBatchForm(form),[{title:'实现接口',ownerId:'u',estimateHours:0.25,startDate:'2026-01-01',dueDate:'2026-01-02'}]);
  assert.match(renderBatchSummary([{estimateHours:0.25},{estimateHours:1.75}]),/2 个任务 · 合计 2 小时/);
});

// Exercise the shipped batch handlers. The surrounding DOM and transport are
// small test doubles; this does not claim browser/layout or production-data QA.
function batchFixture() {
  const app=fs.readFileSync(new URL('../../frontend/app.js',import.meta.url),'utf8');
  const start=app.indexOf('let batchDraft = null;'),end=app.indexOf('async function attachmentHistory(',start);
  assert(start>=0&&end>start);
  const stored=new Map(),requests=[],shownErrors=[];let sequence=0,context,form;
  const errorBox={innerHTML:'',hidden:true,focus(){}};
  const requirement={id:'r',projectId:'p',title:'隔离测试需求',version:7,assigneeId:'u'};
  const environment={
    user:{id:'u'},data:{requirements:[requirement]},crypto:{randomUUID:()=>`request-${++sequence}-fixture`},
    sessionStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value),removeItem:key=>stored.delete(key)},
    blankTask,readBatchForm,renderBatchRows,renderBatchSummary,esc:escapeHtml,encode:encodeURIComponent,
    canEdit:()=>true,canEditEntity:()=>true,canSplit:()=>true,can:()=>true,projectUsers:()=>[{id:'u',name:'隔离成员'}],
    $:selector=>selector==='#task-batch-form'?form:selector==='#form-error'?errorBox:null,
    openDialog(_title,html){environment.lastHtml=html;const tasks=JSON.parse(vm.runInContext('JSON.stringify(batchDraft.tasks)',context));form={querySelectorAll:()=>form.rows,rows:tasks.map(task=>{const controls=Object.entries(task).map(([key,value])=>({dataset:{batchField:key},value:String(value)}));return {controls,querySelectorAll:()=>controls};})};},
    closeDialog(){environment.closed=true;},reload:async()=>{},renderShell(){},requirementDetails:async()=>{},toast(){},
    presentError(error,container){shownErrors.push(error);container.hidden=false;container.innerHTML=escapeHtml(error.message);},
    api:async(endpoint,options)=>{requests.push({endpoint,...JSON.parse(JSON.stringify(options))});throw Object.assign(new Error('模拟网络中断'),{code:'NETWORK'});}
  };
  context=vm.createContext(environment);vm.runInContext(app.slice(start,end),context);
  const run=code=>vm.runInContext(code,context);
  const edit=(field,value)=>{form.rows[0].controls.find(x=>x.dataset.batchField===field).value=value;};
  return {context,environment,stored,requests,shownErrors,errorBox,run,edit,get form(){return form;}};
}

test('实际批量提交网络失败保留完整草稿及提交编号，重试成功后才清除',async()=>{
  const f=batchFixture();f.run('openTaskBatch("r")');f.edit('title','网络失败也要保留');f.edit('estimateHours','1.25');f.run('collectBatchDraft(true)');
  const draft=JSON.parse(f.stored.get('xinghe:batch:u:r'));assert.equal(draft.tasks[0].title,'网络失败也要保留');assert.equal(draft.tasks[0].estimateHours,1.25);
  f.context.form=f.form;await f.run('submitTaskBatch(form)');await f.run('submitTaskBatch(form)');
  assert.equal(f.requests.length,2);assert.equal(f.requests[0].body.requestId,f.requests[1].body.requestId);assert.deepEqual(JSON.parse(f.stored.get('xinghe:batch:u:r')),draft);assert.equal(f.shownErrors.length,2);
  f.context.api=async(_endpoint,options)=>({tasks:options.body.tasks,replayed:true,warnings:[]});
  await f.run('submitTaskBatch(form)');assert.equal(f.stored.has('xinghe:batch:u:r'),false);assert.equal(f.run('batchDraft'),null);assert.equal(f.environment.closed,true);
});

test('实际批量版本冲突保留草稿，重新打开仍持有原版本以防静默覆盖',async()=>{
  const f=batchFixture();f.run('openTaskBatch("r")');f.edit('title','冲突草稿');f.run('collectBatchDraft(true)');
  f.context.api=async()=>{throw Object.assign(new Error('旧版本'),{code:'VERSION_CONFLICT',status:409,details:{rows:[{row:1,message:'版本冲突'}]}});};
  f.context.form=f.form;await f.run('submitTaskBatch(form)');
  assert.match(f.errorBox.innerHTML,/草稿已保留/);assert.match(f.errorBox.innerHTML,/reload-batch-version/);
  f.context.data.requirements[0].version=8;f.run('openTaskBatch("r")');assert.equal(f.run('batchDraft.version'),7);assert.equal(f.run('batchDraft.tasks[0].title'),'冲突草稿');
  assert.equal(f.shownErrors[0].details.rows[0].row,1);
});

test('项目成员审计展示角色修改和首次加入的前后值',()=>{
  assert.deepEqual(auditChanges({action:'set_member',entityType:'project',detail:{userId:'u',before:'developer',after:'tester'}}),[{label:'成员角色',before:'开发',after:'测试'}]);
  assert.deepEqual(auditChanges({action:'set_member',entityType:'project',detail:{userId:'u',before:null,after:'viewer'}}),[{label:'成员角色',before:'未加入',after:'观察者'}]);
});

test('损坏的本机批量草稿不会永久阻止打开任务拆分',()=>{
  const f=batchFixture();
  f.stored.set('xinghe:batch:u:r',JSON.stringify({requirementId:'r',version:7,requestId:'bad-draft-1234',tasks:[null]}));
  assert.doesNotThrow(()=>f.run('openTaskBatch("r")'));
  assert.equal(f.run('batchDraft.tasks.length'),1);
  assert.equal(f.run('batchDraft.tasks[0].title'),'');
});
