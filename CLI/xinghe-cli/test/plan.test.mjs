import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {validatePlan,schedulePlan,workCalendar} from '../src/plan.mjs';

const task={requirement:'r1',owner:'amy',title:'开发',hours:7};
const plan={startDate:'2026-09-21',capacityHours:7,tasks:[task]};
const invalid=value=>assert.throws(()=>validatePlan(value),{code:'INVALID_PLAN'});

test('无效日期和集合字段返回计划错误，而不是底层类型异常',()=>{
  for(const startDate of ['2026-99-99','2026-02-30','2026-09-xx',null,42]) invalid({...plan,startDate});
  for(const tasks of [null,{},'tasks',[null],[[]]]) invalid({...plan,tasks});
  for(const phases of [null,{},'开发',[1],['开发','开发']]) invalid({...plan,phases});
  for(const capacityOverrides of [null,{},'capacity',[null],[[]]]) invalid({...plan,capacityOverrides});
  for(const after of [null,{},'开发',[1]]) invalid({...plan,tasks:[{...task,after}]});
  for(const key of ['holidays','extraWorkdays']) for(const value of [null,{},'2026-09-21',['2026-99-99']]) invalid({...plan,[key]:value});
  assert.equal(validatePlan({...plan,startDate:'2028-02-29'}).startDate,'2028-02-29');
});

test('工时与验收缓冲只接受有效数值，避免字符串累加与无效排期',()=>{
  for(const value of ['7',true,0,-1,Infinity,NaN]) {
    invalid({...plan,capacityHours:value});
    invalid({...plan,tasks:[{...task,hours:value}]});
    invalid({...plan,capacityOverrides:[{from:'2026-09-21',until:'2026-09-22',hours:value}]});
  }
  invalid({...plan,capacityOverrides:[{from:'2026-09-22',until:'2026-09-21',hours:7}]});
  invalid({...plan,capacityOverrides:[{from:'2026-09-21',until:'2026-09-22',hours:7},{from:'2026-09-22',until:'2026-09-23',hours:8}]});
  for(const acceptanceBufferDays of ['1',null,-1,0.5,Infinity,NaN]) invalid({...plan,acceptanceBufferDays});
  invalid({...plan,respectExistingLoad:'false'});
  invalid({...plan,owners:{A:42}});
  invalid({...plan,phaseDeadlines:{unknown:'2026-09-21'}});
  invalid({...plan,phases:['开发'],tasks:[{...task,phase:'开发'}],phaseDeadlines:{开发:'2026-99-99'}});
  assert.equal(validatePlan(plan).acceptanceBufferDays,1);
  assert.equal(validatePlan({...plan,acceptanceBufferDays:0}).acceptanceBufferDays,0);
});

test('阶段顺序、人员产能、调休及前置关系仍共同约束任务研发日期',()=>{
  const input={startDate:'2026-10-01',capacityHours:7,holidays:['2026-10-02'],extraWorkdays:['2026-10-03'],phases:['准备','开发'],
    capacityOverrides:[{from:'2026-10-03',until:'2026-10-03',hours:8}],tasks:[
      {...task,title:'实现',phase:'开发',hours:10,after:['设计']},
      {...task,title:'设计',phase:'准备',owner:'bob',hours:7},
      {...task,title:'收尾',phase:'开发',hours:5},
    ]};
  const original=structuredClone(input),result=schedulePlan(input);
  assert.deepEqual(input,original);
  assert.deepEqual(result.tasks.map(({title,startDate,dueDate})=>({title,startDate,dueDate})),[
    {title:'设计',startDate:'2026-10-01',dueDate:'2026-10-01'},
    {title:'实现',startDate:'2026-10-03',dueDate:'2026-10-05'},
    {title:'收尾',startDate:'2026-10-05',dueDate:'2026-10-05'},
  ]);
  assert.equal(result.requirements[0].planEnd,'2026-10-06');
  assert.deepEqual(result.load.amy,{hours:15,tasks:2,from:'2026-10-03',until:'2026-10-05'});
  const delayed=schedulePlan(input,{busyUntil:{amy:'2026-10-06'}});
  assert.equal(delayed.tasks.find(item=>item.title==='实现').startDate,'2026-10-07');
  assert.equal(schedulePlan({...input,respectExistingLoad:false},{busyUntil:{amy:'2026-10-06'}}).tasks.find(item=>item.title==='实现').startDate,'2026-10-03');
});

test('已有负载超出日历范围时拒绝排期，不回到计划起点',()=>{
  const lastDay=workCalendar(plan.startDate).at(-1);
  for(const date of [lastDay,'2099-01-01']) assert.throws(()=>schedulePlan(plan,{busyUntil:{amy:date}}),{code:'INVALID_PLAN'});
  assert.throws(()=>schedulePlan(plan,{busyUntil:{amy:'2026-99-99'}}),{code:'INVALID_PLAN'});
  assert.equal(schedulePlan({...plan,respectExistingLoad:false},{busyUntil:{amy:lastDay}}).tasks[0].startDate,plan.startDate);
});

test('任务、前置关系及验收缓冲越过日历末尾时均报错，缓冲不得截短',()=>{
  const calendar=workCalendar(plan.startDate),busyUntil={amy:calendar.at(-2)};
  const atEnd=schedulePlan({...plan,acceptanceBufferDays:0},{busyUntil});
  assert.equal(atEnd.tasks[0].dueDate,calendar.at(-1));
  assert.equal(atEnd.requirements[0].planEnd,calendar.at(-1));
  assert.throws(()=>schedulePlan(plan,{busyUntil}),{code:'INVALID_PLAN'});
  assert.throws(()=>schedulePlan({...plan,acceptanceBufferDays:0,tasks:[{...task,hours:8}]},{busyUntil}),{code:'INVALID_PLAN'});
  assert.throws(()=>schedulePlan({...plan,acceptanceBufferDays:0,tasks:[task,{...task,title:'验收',owner:'bob',after:['开发']}]},{busyUntil}),{code:'INVALID_PLAN'});
  assert.throws(()=>schedulePlan({...plan,acceptanceBufferDays:500}),{code:'INVALID_PLAN'});
});

test('极小产能在日历范围内及时失败，不进入无界循环',()=>{
  const moduleUrl=new URL('../src/plan.mjs',import.meta.url).href;
  const script=`import {schedulePlan} from ${JSON.stringify(moduleUrl)};
    try { schedulePlan(${JSON.stringify({...plan,capacityHours:1e-300})}); process.exitCode=1; }
    catch(error) { if(error.code!=='INVALID_PLAN') throw error; }`;
  const result=spawnSync(process.execPath,['--input-type=module','--eval',script],{timeout:3000,encoding:'utf8'});
  assert.equal(result.error,undefined);
  assert.equal(result.status,0,result.stderr);
});

test('工作日历拒绝无效输入及超出四位年份的日期',()=>{
  for(const length of [-1,0.5,NaN,Infinity]) assert.throws(()=>workCalendar(plan.startDate,{},length),{code:'INVALID_PLAN'});
  assert.throws(()=>workCalendar('2026-99-99'),{code:'INVALID_PLAN'});
  assert.throws(()=>workCalendar(plan.startDate,null),{code:'INVALID_PLAN'});
  assert.throws(()=>workCalendar(plan.startDate,{holidays:'2026-09-21'}),{code:'INVALID_PLAN'});
  assert.throws(()=>workCalendar('9999-12-31'),{code:'INVALID_PLAN'});
  assert.deepEqual(workCalendar(plan.startDate,{},0),[]);
});

test('负责人名称与对象继承属性重名时仍能正确计算负载',()=>{
  for(const owner of ['__proto__','constructor']) {
    const result=schedulePlan({...plan,tasks:[{...task,owner}]});
    assert.deepEqual(result.load[owner],{hours:7,tasks:1,from:'2026-09-21',until:'2026-09-21'});
    assert.equal(Object.hasOwn(result.load,owner),true);
  }
  assert.throws(()=>schedulePlan(plan,{ownerOf:()=>undefined}),{code:'INVALID_PLAN'});
});
