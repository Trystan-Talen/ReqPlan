import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { importLegacy, DEFAULT_SEED } from '../scripts/import-legacy.mjs';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const put = db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES(?,?,?,?, 'active',0)");
  for (const [id, role] of [['admin','admin'],['product','member'],['lead','member'],['dev','member'],['dev2','member'],['other','member'],['viewer','member'],['tester','member'],['boss','member']]) put.run(id,id,id,role);
  db.prepare("UPDATE users SET executive=1 WHERE id='boss'").run();
  const b = createBusiness(db); const actor = Object.fromEntries(['admin','product','lead','dev','dev2','other','viewer','tester','boss'].map(id=>[id,{id}]));
  let p = b.createProject(actor.admin,{name:'权限项目',targetDate:'2026-12-15',ownerId:'product'});
  for (const [userId,role] of [['lead','lead'],['dev','developer'],['dev2','developer'],['viewer','viewer'],['tester','tester']]) p=b.setMember(actor.admin,p.id,{userId,role,version:p.version}).project;
  const q=b.createProject(actor.admin,{name:'另一项目'});
  const requirement=b.createRequirement(actor.product,{projectId:p.id,title:'需求',description:'目标',acceptance:'验收',ownerId:'product',planStart:'2026-09-15',planEnd:'2026-10-15'});
  // Historical confirmed requirements are not rewritten until a relevant write.
  requirement.deliveryWorkflow=false;
  db.prepare('UPDATE requirements SET data=? WHERE id=?').run(JSON.stringify(requirement),requirement.id);
  return {db,b,actor,p,q,requirement};
}
function status(code) { return error=>error.status===code; }
const assign=(b,actor,r,extra={})=>b.updateRequirement(actor.lead,r.id,{version:r.version,assigneeId:'dev',...extra});

test('按项目成员隔离读写，开发不能改他人任务，强制改密不能访问业务', t=>{
  const {db,b,actor,p,q,requirement}=fixture(t);
  assert.throws(()=>b.getProject(actor.other,p.id),status(403));
  assert.throws(()=>b.listRequirements(actor.dev,{projectId:q.id}),status(403));
  assert.deepEqual(b.bootstrap(actor.other).projects,[]);
  assert.throws(()=>b.createRequirement(actor.viewer,{projectId:p.id,title:'只读不能创建'}),status(403));
  assert.throws(()=>b.createRequirement(actor.product,{projectId:q.id,title:'跨项目创建'}),status(403));
  assert.throws(()=>b.updateRequirement(actor.product,requirement.id,{version:requirement.version,projectId:q.id}),status(400));
  const task=b.createTask(actor.lead,{projectId:p.id,requirementId:requirement.id,title:'开发二的任务',ownerId:'dev2'});
  assert.throws(()=>b.updateTask(actor.dev,task.id,{version:task.version,title:'越权修改'}),status(403));
  assert.throws(()=>b.createTask(actor.dev,{projectId:p.id,requirementId:requirement.id,title:'转派别人',ownerId:'dev2'}),status(403));
  db.prepare('UPDATE users SET must_change_password=1 WHERE id=?').run('viewer');
  assert.throws(()=>b.bootstrap(actor.viewer),error=>error.status===403&&error.code==='PASSWORD_CHANGE_REQUIRED');
});

test('管理层不加入项目也能只读查看全部项目，任何写入都被拒绝', t=>{
  const {b,actor,p,q,requirement}=fixture(t);
  assert.deepEqual(b.listProjects(actor.boss).map(item=>item.id).sort(),[p.id,q.id].sort());
  assert.equal(b.getRequirement(actor.boss,requirement.id).id,requirement.id);
  assert(b.bootstrap(actor.boss).requirements.some(item=>item.id===requirement.id));
  assert.throws(()=>b.createRequirement(actor.boss,{projectId:p.id,title:'管理层不能创建'}),status(403));
  assert.throws(()=>b.updateRequirement(actor.boss,requirement.id,{version:requirement.version,status:'待评审'}),status(403));
  assert.throws(()=>b.createTask(actor.boss,{projectId:p.id,requirementId:requirement.id,title:'管理层不能建任务',ownerId:'dev'}),status(403));
  assert.throws(()=>b.previewSchedule(actor.boss,p.id,{changes:[{requirementId:requirement.id,version:requirement.version,planEnd:'2026-10-20'}]}),status(403));
  assert.throws(()=>b.setMember(actor.boss,p.id,{userId:'other',role:'developer',version:p.version}),status(403));
  assert.throws(()=>b.updateProject(actor.boss,p.id,{version:p.version,description:'不能改'}),status(403));
});

test('任务只从需求长出：主开发拆分派发，开发只能在参与的需求下给自己补任务，产品和测试不建任务', t=>{
  const {b,actor,p,requirement}=fixture(t);
  assert.throws(()=>b.createTask(actor.lead,{projectId:p.id,title:'未关联需求'}),status(400));
  assert.throws(()=>b.createTask(actor.product,{projectId:p.id,requirementId:requirement.id,title:'产品不派任务',ownerId:'dev'}),status(403));
  assert.throws(()=>b.createTask(actor.tester,{projectId:p.id,requirementId:requirement.id,title:'测试不建任务',ownerId:'tester'}),status(403));
  assert.throws(()=>b.createTask(actor.dev,{projectId:p.id,requirementId:requirement.id,title:'未参与的需求',ownerId:'dev'}),status(403));
  const split=b.createTaskBatch(actor.lead,requirement.id,{version:requirement.version,requestId:'lead-split-1',tasks:[{title:'接口',ownerId:'dev',estimateHours:8},{title:'页面',ownerId:'dev2',estimateHours:6}]});
  assert.deepEqual(split.tasks.map(task=>[task.ownerId,task.createdBy]),[['dev','lead'],['dev2','lead']]);
  const own=b.createTask(actor.dev,{projectId:p.id,requirementId:requirement.id,title:'补充的联调',ownerId:'dev',estimateHours:4});
  assert.equal(own.createdBy,'dev');
  assert.throws(()=>b.createTaskBatch(actor.dev,requirement.id,{version:split.requirement.version,requestId:'dev-split-1',tasks:[{title:'派给别人',ownerId:'dev2',estimateHours:4}]}),error=>error.code==='BATCH_VALIDATION'&&error.errors[0].status===403);
  let task=split.tasks[0];
  assert.throws(()=>b.updateTask(actor.dev,task.id,{version:task.version,ownerId:'dev2'}),status(403));
  task=b.updateTask(actor.dev,task.id,{version:task.version,title:'接口（含鉴权）',dueDate:'2026-10-01'});
  task=b.updateTask(actor.lead,task.id,{version:task.version,ownerId:'dev2'});assert.equal(task.ownerId,'dev2');
  assert.throws(()=>b.updateTask(actor.product,task.id,{version:task.version,title:'产品不能改任务'}),status(403));
  assert.throws(()=>b.updateTask(actor.dev,own.id,{version:own.version,status:'terminated',reason:'不做了'}),status(403));
  const ended=b.updateTask(actor.lead,own.id,{version:own.version,status:'terminated',reason:'合并到接口任务'});assert.equal(ended.status,'terminated');
  assert.throws(()=>b.archiveTask(actor.product,ended.id,{version:ended.version}),status(403));
  assert.equal(b.archiveTask(actor.admin,ended.id,{version:ended.version}).archived,true);
});

test('主开发只能调整主责开发、协作人和排期，需求内容由产品经理维护，产品不能指定主责开发', t=>{
  const {b,actor,requirement}=fixture(t);
  assert.throws(()=>b.createRequirement(actor.product,{projectId:requirement.projectId,title:'产品指定开发',assigneeId:'dev'}),status(403));
  assert.throws(()=>b.updateRequirement(actor.product,requirement.id,{version:requirement.version,assigneeId:'dev'}),status(403));
  assert.throws(()=>b.updateRequirement(actor.lead,requirement.id,{version:requirement.version,title:'主开发改标题'}),status(403));
  let r=b.updateRequirement(actor.lead,requirement.id,{version:requirement.version,title:requirement.title,assigneeId:'dev',collaboratorIds:['dev2'],planEnd:'2026-10-20'});
  assert.deepEqual([r.assigneeId,r.collaboratorIds,r.planEnd],['dev',['dev2'],'2026-10-20']);
  assert.throws(()=>b.updateRequirement(actor.dev,r.id,{version:r.version,planEnd:'2026-10-30'}),status(403));
  r=b.updateRequirement(actor.product,r.id,{version:r.version,title:'产品改标题',assigneeId:'dev'});assert.equal(r.title,'产品改标题');
});

test('乐观锁冲突不覆盖，失败修改和审计一起回滚', t=>{
  const {db,b,actor,requirement}=fixture(t);
  const changed=b.updateRequirement(actor.product,requirement.id,{version:requirement.version,title:'先保存'});
  assert.equal(changed.version,requirement.version+1);
  const count=db.prepare('SELECT count(*) n FROM audit').get().n;
  assert.throws(()=>b.updateRequirement(actor.product,requirement.id,{version:requirement.version,title:'后覆盖'}),error=>error.status===409&&error.code==='VERSION_CONFLICT');
  assert.equal(b.getRequirement(actor.product,requirement.id).title,'先保存');
  assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n,count);
  assert.throws(()=>b.updateRequirement(actor.product,requirement.id,{version:changed.version,planStart:'2026-11-01',planEnd:'2026-10-01'}),status(400));
  assert.equal(b.getRequirement(actor.product,requirement.id).version,changed.version);
});

test('未列入项目成员的全局管理员可分配自己，普通非成员仍被拒绝', t=>{
  const {db,b,actor,p}=fixture(t);
  db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES('admin2','admin2','另一管理员','admin','active',0)").run();
  const admin2={id:'admin2'};
  assert.equal(db.prepare('SELECT count(*) n FROM memberships WHERE user_id=?').get(admin2.id).n,0);
  const requirement=b.createRequirement(admin2,{projectId:p.id,title:'管理员分配给自己',description:'背景',acceptance:'验收',ownerId:admin2.id,assigneeId:admin2.id,collaboratorIds:[admin2.id]});
  assert.equal(requirement.ownerId,admin2.id);
  const task=b.createTask(admin2,{projectId:p.id,requirementId:requirement.id,title:'管理员的任务',ownerId:admin2.id});assert.equal(task.ownerId,admin2.id);
  assert(b.bootstrap(actor.viewer).users.some(user=>user.id===admin2.id));
  assert.throws(()=>b.createRequirement(actor.product,{projectId:p.id,title:'禁止分配普通非成员',ownerId:'other'}),status(400));
});

test('历史确认需求在任务写入时自动流转，工时点数独立、人工验收及归档恢复', t=>{
  const {b,actor,p,requirement}=fixture(t); let r=requirement;
  assert.throws(()=>b.updateRequirement(actor.product,r.id,{version:r.version,status:'已完成'}),status(409));
  assert.throws(()=>b.updateRequirement(actor.product,r.id,{version:r.version,status:'待评审'}),error=>error.code==='PROPOSAL_WORKFLOW_REQUIRED');
  assert.throws(()=>b.updateRequirement(actor.lead,r.id,{version:r.version,status:'待排期'}),error=>error.code==='AUTOMATIC_WORKFLOW');
  assert.throws(()=>b.updateRequirement(actor.product,r.id,{version:r.version,status:'待排期'}),error=>error.code==='AUTOMATIC_WORKFLOW');
  r=assign(b,actor,r);
  let task=b.createTask(actor.lead,{projectId:p.id,requirementId:r.id,title:'研发交付',ownerId:'dev',estimateHours:16,estimatePoints:3,startDate:'2026-09-15',dueDate:'2026-10-15'});
  const unestimated=b.createTask(actor.lead,{projectId:p.id,requirementId:r.id,title:'未估时',ownerId:'dev2'});
  assert.equal(b.getRequirement(actor.lead,r.id).status,'已确定');
  assert.throws(()=>b.updateTask(actor.dev,task.id,{version:task.version,status:'develop'}),error=>error.code==='TRANSITION_GATE');
  b.updateTask(actor.lead,unestimated.id,{version:unestimated.version,status:'terminated',reason:'合并'});
  r=b.getRequirement(actor.lead,r.id);assert.equal(r.status,'已排期');
  task=b.updateTask(actor.dev,task.id,{version:task.version,status:'develop'});
  assert.equal(b.getRequirement(actor.lead,r.id).status,'开发中');
  task=b.updateTask(actor.dev,task.id,{version:task.version,status:'test'});
  r=b.getRequirement(actor.lead,r.id);assert.equal(r.status,'测试中');
  assert.throws(()=>b.updateRequirement(actor.admin,r.id,{version:r.version,status:'已完成'}),error=>error.code==='TRANSITION_GATE');
  assert.throws(()=>b.updateRequirement(actor.tester,r.id,{version:r.version,status:'开发中'}),error=>error.code==='WORKFLOW_ACTION_REQUIRED');
  assert.throws(()=>b.updateTask(actor.dev,task.id,{version:task.version,status:'done'}),status(403));  // 不能验收自己负责的任务
  assert.throws(()=>b.updateTask(actor.tester,task.id,{version:task.version,title:'测试不能改他人正文',status:'done'}),status(403));
  task=b.updateTask(actor.tester,task.id,{version:task.version,status:'done'});
  assert(task.completedAt); assert.equal(task.estimateHours,16); assert.equal(task.estimatePoints,3);
  assert.throws(()=>b.updateRequirement(actor.viewer,r.id,{version:r.version,status:'已完成'}),status(403));
  r=b.updateRequirement(actor.product,r.id,{version:r.version,status:'已完成'});
  assert.throws(()=>b.archiveRequirement(actor.lead,r.id,{version:r.version}),status(403));
  r=b.archiveRequirement(actor.product,r.id,{version:r.version});
  assert.equal(b.getTask(actor.dev,task.id).archived,true);
  r=b.archiveRequirement(actor.product,r.id,{version:r.version,archived:false});
  assert.equal(b.getTask(actor.dev,task.id).archived,true);
  task=b.getTask(actor.dev,task.id);assert.throws(()=>b.archiveTask(actor.admin,task.id,{version:task.version,archived:false}),error=>error.code==='STATE_TRANSITION');
  b.reopenRequirement(actor.product,r.id,{version:r.version,reason:'恢复归档交付任务'});
  task=b.archiveTask(actor.admin,task.id,{version:task.version,archived:false});assert.equal(task.archived,false);
});

test('成员管理限于项目负责人和系统管理员，负责人必须是产品经理或主开发，项目归档阻止写入', t=>{
  const {b,actor,p,requirement}=fixture(t);
  assert.throws(()=>b.setMember(actor.lead,p.id,{userId:'other',role:'developer',version:p.version}),status(403));
  assert.throws(()=>b.setMember(actor.admin,p.id,{userId:'other',role:'manager',version:p.version}),status(400));
  assert.throws(()=>b.setMember(actor.admin,p.id,{userId:'product',role:'developer',version:p.version}),status(409));
  const added=b.setMember(actor.product,p.id,{userId:'other',role:'developer',version:p.version}).project;
  assert.throws(()=>b.removeMember(actor.admin,p.id,'product',{version:added.version}),status(409));
  const archived=b.archiveProject(actor.product,p.id,{version:added.version});
  assert.equal(b.listProjects(actor.product).length,0);
  assert.equal(b.listProjects(actor.product,{includeArchived:true}).length,1);
  assert.throws(()=>b.updateRequirement(actor.product,requirement.id,{version:requirement.version,title:'已归档不能改'}),error=>error.code==='ARCHIVED');
  assert.equal(b.archiveProject(actor.admin,p.id,{version:archived.version,archived:false}).archived,false);
});

test('转移项目负责人需要新负责人已是产品经理或主开发，且不暗中改变任何成员角色', t=>{
  const {b,actor,p}=fixture(t);
  assert.throws(()=>b.updateProject(actor.admin,p.id,{version:p.version,ownerId:'dev'}),status(409));
  const changed=b.updateProject(actor.product,p.id,{version:p.version,ownerId:'lead'});
  assert.equal(b.listMembers(actor.lead,p.id).find(item=>item.userId==='lead').role,'lead');
  assert.equal(b.listMembers(actor.lead,p.id).find(item=>item.userId==='product').role,'product');
  assert.throws(()=>b.setMember(actor.admin,p.id,{version:changed.version,userId:'lead',role:'viewer'}),status(409));
  assert.throws(()=>b.updateProject(actor.product,p.id,{version:changed.version,description:'前负责人不能再维护'}),status(403));
  assert.equal(b.updateProject(actor.lead,p.id,{version:changed.version,description:'负责人可以维护项目'}).description,'负责人可以维护项目');
  const created=b.createProject(actor.admin,{name:'主开发负责',ownerId:'lead',ownerRole:'lead'});
  assert.equal(b.listMembers(actor.admin,created.id).find(item=>item.userId==='lead').role,'lead');
  assert.throws(()=>b.createProject(actor.admin,{name:'负责人角色无效',ownerId:'lead',ownerRole:'developer'}),status(400));
});

test('项目负责人能查询基本账号目录并添加新成员，只读成员看不到无关账号', t=>{
  const {db,b,actor,p}=fixture(t);
  db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES('new-member','new-member','待加入项目的新成员','member','pending',1)").run();
  assert(!b.bootstrap(actor.viewer).users.some(user=>user.id==='new-member'));
  assert(!b.bootstrap(actor.lead).users.some(user=>user.id==='new-member'));
  const directory=b.bootstrap(actor.product).users;
  const candidate=directory.find(user=>user.id==='new-member');assert(candidate);
  assert.deepEqual(Object.keys(candidate).sort(),['executive','id','name','role','status','username']);
  assert.equal(candidate.status,'pending');
  const added=b.setMember(actor.product,p.id,{userId:candidate.id,role:'developer',version:p.version});
  assert(added.members.some(member=>member.userId===candidate.id&&member.role==='developer'));
  assert(b.bootstrap(actor.viewer).users.some(user=>user.id===candidate.id));
  assert(!b.bootstrap(actor.viewer).users.some(user=>user.id==='other'));
});

test('附件存数据库、跨项目下载拒绝、路径和类型及体积校验', t=>{
  const {db,b,actor,requirement}=fixture(t);const html=Buffer.from('<h1>保留原型</h1>');
  const file=b.uploadAttachment(actor.product,requirement.id,{name:'原型.html',mime:'text/html',contentBuffer:html});
  assert.deepEqual(b.getAttachment(actor.viewer,file.id).contentBuffer,html);
  assert.throws(()=>b.getAttachment(actor.other,file.id),status(403));
  assert.throws(()=>b.listAttachments(actor.other,requirement.id),status(403));
  assert.throws(()=>b.uploadAttachment(actor.viewer,requirement.id,{name:'a.md',mime:'text/markdown',contentBuffer:html}),status(403));
  assert.throws(()=>b.uploadAttachment(actor.dev,requirement.id,{name:'a.md',mime:'text/markdown',contentBuffer:html}),status(403));
  assert.equal(b.uploadAttachment(actor.lead,requirement.id,{name:'技术方案.md',mime:'text/markdown',contentBuffer:html}).name,'技术方案.md');
  assert.throws(()=>b.uploadAttachment(actor.product,requirement.id,{name:'../a.html',mime:'text/html',contentBuffer:html}),status(400));
  assert.throws(()=>b.uploadAttachment(actor.product,requirement.id,{name:'a.html',mime:'text/plain',contentBuffer:html}),status(400));
  assert.throws(()=>b.uploadAttachment(actor.product,requirement.id,{name:'a.txt',mime:'text/plain',contentBuffer:Buffer.alloc(2*1024*1024+1)}),status(413));
  assert.equal(db.prepare('SELECT count(*) n FROM attachments').get().n,2);
  assert.equal(b.listHistory(actor.other).length,0);
  assert(b.listHistory(actor.viewer,{projectId:requirement.projectId}).some(item=>item.action==='upload'));
});

test('真实快照精确保留3/55/79全部业务字段、6账号待激活、2附件与脱敏元数据', t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());const snapshot=JSON.parse(readFileSync(DEFAULT_SEED,'utf8'));
  const imported=importLegacy(db);assert.deepEqual([imported.projects,imported.requirements,imported.tasks,imported.users,imported.attachments],[3,55,79,6,2]);
  for(const table of ['projects','requirements','tasks']){
    const rows=db.prepare(`SELECT id,data FROM ${table}`).all();assert.equal(rows.length,snapshot[table].length);
    for(const original of snapshot[table])assert.deepEqual(JSON.parse(rows.find(row=>row.id===original.id).data),original);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM users WHERE password_hash IS NOT NULL OR status!=\'pending\' OR role!=\'member\'').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships').get().n,18);
  for(const project of snapshot.projects)assert(['product','lead'].includes(db.prepare('SELECT role FROM memberships WHERE project_id=? AND user_id=?').get(project.id,project.ownerId).role));
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key=?').get('legacy_users').value),snapshot.users);
  assert.deepEqual(JSON.parse(db.prepare('SELECT value FROM app_meta WHERE key=?').get('legacy_history').value),snapshot.history);
  for(const task of db.prepare('SELECT data FROM tasks').all())assert.equal(JSON.parse(task.data).completedAt,undefined);
  for(const file of snapshot.attachments){const actual=db.prepare('SELECT content FROM attachments WHERE id=?').get(file.id);assert.deepEqual(Buffer.from(actual.content),readFileSync(new URL('../seed/'+file.file,import.meta.url)));}
  const item=JSON.parse(db.prepare('SELECT data FROM requirements WHERE id=?').get('r-n1').data);item.title='导入后编辑';db.prepare('UPDATE requirements SET data=?,version=2 WHERE id=?').run(JSON.stringify(item),'r-n1');
  assert.equal(importLegacy(db).alreadyImported,true);assert.equal(JSON.parse(db.prepare('SELECT data FROM requirements WHERE id=?').get('r-n1').data).title,'导入后编辑');
  const changed=structuredClone(snapshot);changed.projects[0].name='不同来源';assert.throws(()=>importLegacy(db,changed),/拒绝覆盖/);
});

test('迁移拒绝非空库、秘密字段和悬空关联，预检不写数据库', t=>{
  const {db}=fixture(t);assert.throws(()=>importLegacy(db),/空数据库/);
  const snapshot=JSON.parse(readFileSync(DEFAULT_SEED,'utf8'));snapshot.users[0].password='不得导入';assert.throws(()=>importLegacy(null,snapshot,{dryRun:true}),/凭证/);
  delete snapshot.users[0].password;snapshot.tasks[0].requirementId='r-missing';assert.throws(()=>importLegacy(null,snapshot,{dryRun:true}),/缺失或跨项目/);
  const dry=importLegacy(null,DEFAULT_SEED,{dryRun:true});assert.equal(dry.dryRun,true);assert.equal(dry.tasks,79);
});

test('任务删除和恢复仅系统管理员可用：主开发仍可编辑和转派，删除检查依赖与版本', t=>{
  const {b,actor,p,requirement}=fixture(t);
  let task=b.createTask(actor.lead,{projectId:p.id,requirementId:requirement.id,title:'建错的任务',description:'原始内容',ownerId:'lead'});
  task=b.updateTask(actor.lead,task.id,{version:task.version,title:'修正后的任务',description:'修正交付要求',ownerId:'dev2'});
  assert.equal(task.ownerId,'dev2');assert.equal(task.description,'修正交付要求');
  assert.throws(()=>b.updateTask(actor.dev,task.id,{version:task.version,description:'越权修改'}),status(403));
  for(const role of ['lead','dev2','product','tester','viewer','boss','other'])assert.throws(()=>b.archiveTask(actor[role],task.id,{version:task.version}),status(403));
  let dependent=b.createTask(actor.lead,{projectId:p.id,requirementId:requirement.id,title:'依赖任务',ownerId:'dev',dependencyIds:[task.id]});
  assert.throws(()=>b.archiveTask(actor.admin,task.id,{version:task.version}),error=>error.code==='TASK_IN_USE');
  assert.equal(b.getTask(actor.lead,task.id).version,task.version);
  dependent=b.updateTask(actor.lead,dependent.id,{version:dependent.version,dependencyIds:[]});
  assert.throws(()=>b.archiveTask(actor.admin,task.id,{version:task.version-1}),error=>error.code==='VERSION_CONFLICT');
  const deleted=b.archiveTask(actor.admin,task.id,{version:task.version});
  assert.equal(deleted.archived,true);assert.equal(deleted.description,task.description);
  assert.ok(!b.listTasks(actor.lead,{projectId:p.id}).some(item=>item.id===task.id));
  assert.throws(()=>b.updateTask(actor.lead,task.id,{version:deleted.version,title:'已删除不能编辑'}),error=>error.code==='ARCHIVED');
  const restored=b.archiveTask(actor.admin,task.id,{version:deleted.version,archived:false});
  assert.equal(restored.archived,false);assert.equal(restored.id,task.id);assert.equal(restored.ownerId,'dev2');
  assert.equal(restored.requirementId,requirement.id);assert.equal(restored.description,'修正交付要求');
  assert.equal(b.getTask(actor.lead,dependent.id).archived,false);
  const actions=b.listHistory(actor.lead,{entityType:'task',entityId:task.id}).map(entry=>entry.action);
  for(const action of ['create','update','archive','restore'])assert.ok(actions.includes(action));
});
