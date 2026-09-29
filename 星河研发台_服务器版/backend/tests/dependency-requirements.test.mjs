import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { requirementDeliveryState } from '../../frontend/workflow.js';

function fixture(t) {
  const db=openDatabase(':memory:'); t.after(()=>db.close());
  const actor=Object.fromEntries(['admin','product','lead','dev','tester','viewer'].map(id=>[id,{id}]));
  for(const id of Object.keys(actor))db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES(?,?,?,?,'active',0)").run(id,id,id,id==='admin'?'admin':'member');
  const b=createBusiness(db);
  let project=b.createProject(actor.admin,{name:'需求依赖项目'});
  for(const [userId,role] of [['product','product'],['lead','lead'],['dev','developer'],['tester','tester'],['viewer','viewer']])project=b.setMember(actor.admin,project.id,{userId,role,version:project.version}).project;
  const other=b.createProject(actor.admin,{name:'隐藏项目'});
  // Legacy confirmed rows adopt automatic stages on their next relevant write.
  const create=(title,extra={})=>{const requirement=b.createRequirement(actor.product,{projectId:project.id,title,description:'背景目标',acceptance:'验收标准',planStart:'2026-09-16',planEnd:'2026-09-30',...extra});requirement.deliveryWorkflow=false;db.prepare('UPDATE requirements SET data=? WHERE id=?').run(JSON.stringify(requirement),requirement.id);return requirement;};
  const move=(requirement,status,who='product',extra={})=>b.updateRequirement(actor[who],requirement.id,{version:requirement.version,status,...extra});
  const schedule=requirement=>{
    requirement=b.updateRequirement(actor.lead,requirement.id,{version:requirement.version,assigneeId:'dev'});
    const task=b.createTask(actor.lead,{projectId:project.id,requirementId:requirement.id,title:'关联任务',ownerId:'dev',estimateHours:8,startDate:'2026-09-16',dueDate:'2026-09-30'});
    requirement=b.getRequirement(actor.lead,requirement.id);
    return {requirement,task};
  };
  const complete=({requirement,task})=>{
    task=b.updateTask(actor.dev,task.id,{version:task.version,status:'develop'});
    task=b.updateTask(actor.dev,task.id,{version:task.version,status:'test'});
    b.updateTask(actor.tester,task.id,{version:task.version,status:'done'});
    return move(b.getRequirement(actor.tester,requirement.id),'已完成','tester');
  };
  return {db,b,actor,project,other,create,move,schedule,complete};
}

test('需求依赖默认空数组，合法同项目引用去重且字段格式严格校验',t=>{
  const {b,actor,project,create}=fixture(t),before=create('前置需求');
  assert.deepEqual(before.dependencyIds,[]);
  const after=create('后续需求',{dependencyIds:[before.id,before.id]});
  assert.deepEqual(after.dependencyIds,[before.id]);
  for(const dependencyIds of [null,'',{},[null],['../invalid'],Array(101).fill(before.id)])assert.throws(()=>create('无效引用',{dependencyIds}),error=>error.status===400);
  assert.throws(()=>b.createRequirement(actor.viewer,{projectId:project.id,title:'无权创建',dependencyIds:[before.id]}),error=>error.status===403);
  assert.throws(()=>b.updateRequirement(actor.dev,after.id,{version:after.version,dependencyIds:[]}),error=>error.status===403);
});

test('需求依赖不泄露跨项目编号存在性，归档或不存在记录不可新引用',t=>{
  const {b,actor,other,create}=fixture(t);
  const hidden=b.createRequirement(actor.admin,{projectId:other.id,title:'隐藏需求',description:'背景',acceptance:'验收'});
  let archived=create('归档需求');archived=b.archiveRequirement(actor.product,archived.id,{version:archived.version});
  for(const dependencyId of [hidden.id,archived.id,'missing-requirement'])assert.throws(()=>create('非法引用',{dependencyIds:[dependencyId]}),error=>error.code==='INVALID_DEPENDENCY'&&error.message==='前置需求必须是本项目现有的未归档需求');
});

test('需求自依赖和多层循环被拒绝，失败不改数据版本或审计',t=>{
  const {db,b,actor,create}=fixture(t);
  const a=create('甲'),c=create('丙',{dependencyIds:[a.id]}),bReq=create('乙',{dependencyIds:[c.id]});
  const auditCount=db.prepare('SELECT count(*) n FROM audit').get().n;
  for(const dependencyIds of [[a.id],[bReq.id]])assert.throws(()=>b.updateRequirement(actor.product,a.id,{version:a.version,dependencyIds}),error=>error.code==='DEPENDENCY_CYCLE');
  assert.equal(b.getRequirement(actor.product,a.id).version,a.version);
  assert.deepEqual(b.getRequirement(actor.product,a.id).dependencyIds,[]);
  assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n,auditCount);
});

test('恢复归档需求时重新检查依赖，拒绝激活经过归档节点的循环',t=>{
  const {db,b,actor,create}=fixture(t);
  let bReq=create('乙'),a=create('甲',{dependencyIds:[bReq.id]});
  const c=create('丙',{dependencyIds:[a.id]});
  a=b.archiveRequirement(actor.product,a.id,{version:a.version});
  bReq=b.updateRequirement(actor.product,bReq.id,{version:bReq.version,dependencyIds:[c.id]});
  const auditCount=db.prepare('SELECT count(*) n FROM audit').get().n;
  assert.throws(()=>b.archiveRequirement(actor.product,a.id,{version:a.version,archived:false}),error=>error.code==='DEPENDENCY_CYCLE');
  assert.equal(b.getRequirement(actor.product,a.id).archived,true);
  assert.equal(b.getRequirement(actor.product,a.id).version,a.version);
  assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n,auditCount);
  b.updateRequirement(actor.product,bReq.id,{version:bReq.version,dependencyIds:[]});
  assert.equal(b.archiveRequirement(actor.product,a.id,{version:a.version,archived:false}).archived,false);
});

test('已排期需求在前置需求验收完成后才可开工，原验收角色规则保持',t=>{
  const {b,actor,create,move,schedule,complete}=fixture(t);
  const predecessor=schedule(create('前置交付'));
  const scheduled=schedule(create('后续交付',{dependencyIds:[predecessor.requirement.id]}));let dependent=scheduled.requirement;
  assert.equal(dependent.status,'已排期');
  assert.throws(()=>b.updateTask(actor.dev,scheduled.task.id,{version:scheduled.task.version,status:'develop'}),error=>error.status===409&&error.code==='DEPENDENCY_GATE');
  const completed=complete(predecessor);assert.equal(completed.status,'已完成');
  let task=b.updateTask(actor.dev,scheduled.task.id,{version:scheduled.task.version,status:'develop'});assert.equal(b.getRequirement(actor.dev,dependent.id).status,'开发中');b.updateTask(actor.dev,task.id,{version:task.version,status:'test'});
  dependent=b.getRequirement(actor.lead,dependent.id);assert.equal(dependent.status,'测试中');
  assert.throws(()=>move(dependent,'已完成','product'),error=>error.code==='TRANSITION_GATE');
  assert.throws(()=>move(dependent,'已完成','tester'),error=>error.code==='TRANSITION_GATE');
  assert.deepEqual(b.getRequirement(actor.viewer,dependent.id).dependencyIds,[completed.id]);
});

test('终止前置需求不等于完成，经理或产品可以显式解除依赖',t=>{
  const {b,actor,create,move,schedule}=fixture(t);
  let predecessor=create('取消需求');
  const scheduled=schedule(create('后续需求',{dependencyIds:[predecessor.id]})),dependent=scheduled.requirement;
  predecessor=move(predecessor,'已终止','product',{reason:'范围取消'});
  assert.throws(()=>b.updateTask(actor.dev,scheduled.task.id,{version:scheduled.task.version,status:'develop'}),error=>error.code==='DEPENDENCY_GATE');
  const cleared=b.updateRequirement(actor.product,dependent.id,{version:dependent.version,dependencyIds:[]});
  b.updateTask(actor.dev,scheduled.task.id,{version:scheduled.task.version,status:'develop'});
  assert.equal(b.getRequirement(actor.dev,cleared.id).status,'开发中');
});

test('旧需求缺失依赖字段读操作不改库且无依赖流程继续兼容',t=>{
  const {db,b,actor,create,move,schedule}=fixture(t);
  const scheduled=schedule(create('旧版需求')),requirement=scheduled.requirement;
  const data=JSON.parse(db.prepare('SELECT data FROM requirements WHERE id=?').get(requirement.id).data);delete data.dependencyIds;
  const original=JSON.stringify(data);db.prepare('UPDATE requirements SET data=? WHERE id=?').run(original,requirement.id);
  b.bootstrap(actor.dev);b.getRequirement(actor.dev,requirement.id);
  assert.equal(db.prepare('SELECT data FROM requirements WHERE id=?').get(requirement.id).data,original);
  b.updateTask(actor.dev,scheduled.task.id,{version:scheduled.task.version,status:'develop'});
  const updated=b.getRequirement(actor.dev,requirement.id);assert.equal(updated.status,'开发中');assert.deepEqual(updated.dependencyIds||[],[]);
});

test('前后端共享需求门禁按关联编号解析依赖，缺失或归档记录不可绕过',()=>{
  const requirement={status:'已排期',assigneeId:'dev',planStart:'2026-09-16',planEnd:'2026-09-30',acceptance:'标准',dependencyIds:['before']};
  const tasks=[{status:'wait',ownerId:'dev',estimateHours:8,startDate:'2026-09-16',dueDate:'2026-09-30'}];
  for(const dependencies of [[],[null],[{id:'other',status:'已完成'}],[{id:'before',status:'已终止'}],[{id:'before',status:'已完成',archived:true}]]){
    assert.equal(requirementDeliveryState(requirement,tasks,dependencies).startAllowed,false);
    assert.deepEqual(requirementDeliveryState(requirement,tasks,dependencies).pendingDependencies,['before']);
  }
  const dependencies=[{id:'before',status:'已完成'}];
  assert.equal(requirementDeliveryState(requirement,tasks,dependencies).startAllowed,true);
  assert.deepEqual(requirementDeliveryState(requirement,tasks,dependencies).pendingDependencies,[]);
  assert.equal(requirementDeliveryState(requirement,[],dependencies).startAllowed,false);
});
