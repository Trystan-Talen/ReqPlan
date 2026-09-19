import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { createWorkService } from '../work-service.mjs';

const TODAY = '2026-09-16';
function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const actor = Object.fromEntries(['admin','product','lead','dev','tester','viewer','outsider'].map(id => [id, {id}]));
  for (const id of Object.keys(actor)) db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES(?,?,?,?,'active',0)").run(id,id,id,id==='admin'?'admin':'member');
  const b = createBusiness(db), work = createWorkService(db,b);
  let project = b.createProject(actor.admin,{name:'可见项目'});
  for (const [userId,role] of [['product','product'],['lead','lead'],['dev','developer'],['tester','tester'],['viewer','viewer']]) project = b.setMember(actor.admin,project.id,{userId,role,version:project.version}).project;
  const other = b.createProject(actor.admin,{name:'不可见项目'});
  const patch = (table,item,changes) => {
    const data = JSON.parse(db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(item.id).data);
    db.prepare(`UPDATE ${table} SET data=?,archived=? WHERE id=?`).run(JSON.stringify({...data,...changes}),changes.archived?1:0,item.id);
    return {...item,...changes};
  };
  // Tasks always grow from a requirement; the shared parent has no creation date so trends ignore it.
  const parents = new Map();
  const parent = projectId => { if (!parents.has(projectId)) parents.set(projectId, patch('requirements', b.createRequirement(actor.admin,{projectId,title:'任务所属需求',ownerId:'admin'}), {createdAt:''})); return parents.get(projectId).id; };
  const task = (title,changes={}) => {
    const {status='wait',createdAt='2026-09-01',completedAt='',archived=false,projectId=project.id,...input}=changes;
    const item=b.createTask(actor.admin,{projectId,requirementId:parent(projectId),title,ownerId:projectId===project.id?'dev':'admin',...input});
    return patch('tasks',item,{status,createdAt,completedAt,archived});
  };
  const requirement = (title,changes={}) => {
    const {status='未确定',createdAt='2026-09-01',archived=false,projectId=project.id,...input}=changes;
    const item=b.createRequirement(actor.admin,{projectId,title,ownerId:'product',...input});
    return patch('requirements',item,{status,createdAt,archived});
  };
  const ids = items => items.map(item=>item.id).sort();
  return {db,b,work,actor,project,other,patch,task,requirement,ids};
}

test('工作台继承真实业务快照的项目隔离与账号状态检查', t => {
  const {db,work,actor,project,other,task}=fixture(t);
  const visible=task('本项目任务',{dueDate:'2026-09-15'});
  task('不可见任务',{projectId:other.id,dueDate:'2026-09-15'});
  const result=work.snapshot(actor.dev,TODAY);
  assert.deepEqual(result.health.map(item=>item.projectId),[project.id]);
  assert.deepEqual(result.personal.tasks.map(item=>item.id),[visible.id]);
  assert(result.reminders.every(item=>item.projectId===project.id));
  assert(!JSON.stringify(result).includes('不可见任务'));
  const outsider=work.snapshot(actor.outsider,TODAY);
  assert.deepEqual(outsider.health,[]);assert.deepEqual(outsider.reminders,[]);assert.deepEqual(outsider.personal,{tasks:[],requirements:[],reviews:[],splits:[],isLead:false});
  assert.equal(work.snapshot(actor.admin,TODAY).health.length,2);
  db.prepare("UPDATE users SET status='disabled' WHERE id='dev'").run();
  assert.throws(()=>work.snapshot(actor.dev,TODAY),error=>error.status===401);
  db.prepare("UPDATE users SET must_change_password=1 WHERE id='tester'").run();
  assert.throws(()=>work.snapshot(actor.tester,TODAY),error=>error.code==='PASSWORD_CHANGE_REQUIRED');
});

test('个人待办涵盖自己负责和协作的需求，结束和归档记录排除，验收按角色展示', t => {
  const {b,work,actor,task,requirement,ids}=fixture(t);
  const own=task('我的工作');
  const review=task('等待验收',{ownerId:'product',status:'测试中'});
  task('别人工作',{ownerId:'product'});
  task('已完成工作',{status:'已完成'});task('已终止工作',{status:'terminated'});task('归档工作',{archived:true});
  const assigned=requirement('主责需求',{assigneeId:'dev'}),collaborating=requirement('协作需求',{collaboratorIds:['dev']}),owned=requirement('我负责的未指派需求',{ownerId:'dev'});
  requirement('别人需求');requirement('已完成需求',{assigneeId:'dev',status:'已完成'});requirement('已终止需求',{assigneeId:'dev',status:'已终止'});requirement('归档需求',{assigneeId:'dev',archived:true});
  let archivedProject=b.createProject(actor.admin,{name:'归档项目'});
  archivedProject=b.setMember(actor.admin,archivedProject.id,{userId:'dev',role:'developer',version:archivedProject.version}).project;
  task('归档项目中的任务',{projectId:archivedProject.id,ownerId:'dev'});
  b.archiveProject(actor.admin,archivedProject.id,{version:archivedProject.version});
  const mine=work.snapshot(actor.dev,TODAY);
  assert.deepEqual(ids(mine.personal.tasks),[own.id]);
  assert.deepEqual(ids(mine.personal.requirements),[assigned.id,collaborating.id,owned.id].sort());
  assert.deepEqual(ids(mine.personal.reviews),[review.id]);  // 所有成员都可以验收他人提测的任务
  assert.deepEqual(ids(work.snapshot(actor.tester,TODAY).personal.reviews),[review.id]);
  assert.deepEqual(work.snapshot(actor.product,TODAY).personal.reviews,[]);
  assert.deepEqual(work.snapshot(actor.viewer,TODAY).personal,{tasks:[],requirements:[],reviews:[],splits:[],isLead:false});
  assert.deepEqual(ids(work.snapshot(actor.lead,TODAY).personal.reviews),[review.id]);
});

test('提醒准确区分逾期、三天内到期、依赖阻塞与验收，并限制接收对象', t => {
  const {work,actor,task,patch}=fixture(t);
  const overdue=task('逾期一天',{dueDate:'2026-09-15'}),today=task('今天截止',{dueDate:TODAY}),soon=task('三天后截止',{dueDate:'2026-09-19'}),later=task('四天后截止',{dueDate:'2026-09-20'});
  const pending=task('未完成前置'),complete=task('完成前置',{status:'已完成'}),terminated=task('终止前置',{status:'terminated'}),archived=task('已归档前置',{status:'done',archived:true});
  const blocked=task('被阻塞任务');
  patch('tasks',blocked,{dependencyIds:[pending.id,complete.id,terminated.id,archived.id,'missing-dependency']});
  const otherOwner=task('产品负责的逾期任务',{ownerId:'product',dueDate:'2026-09-14'});
  const review=task('待验收任务',{ownerId:'product',status:'test'});
  task('完成任务不再催办',{status:'done',dueDate:'2026-09-10'});
  const mine=work.snapshot(actor.dev,TODAY),due=mine.reminders.filter(item=>['due','overdue'].includes(item.kind));
  assert.deepEqual(new Set(due.map(item=>item.entityId)),new Set([overdue.id,today.id,soon.id]));
  assert.equal(due.find(item=>item.entityId===overdue.id).kind,'overdue');
  assert.match(due.find(item=>item.entityId===overdue.id).message,/逾期 1 天/);
  assert.equal(mine.reminders[0].entityId,overdue.id);
  assert.equal(mine.reminders.find(item=>item.entityId===blocked.id).message,'有 4 个前置任务尚未完成');
  assert(!mine.reminders.some(item=>[later.id,otherOwner.id,review.id].includes(item.entityId)));
  assert(work.snapshot(actor.lead,TODAY).reminders.some(item=>item.entityId===otherOwner.id));
  assert(work.snapshot(actor.lead,TODAY).reminders.some(item=>item.entityId===overdue.id));
  assert(!work.snapshot(actor.product,TODAY).reminders.some(item=>item.entityId===overdue.id));
  assert(work.snapshot(actor.tester,TODAY).reminders.some(item=>item.entityId===review.id&&item.kind==='review'));
  assert.deepEqual(work.snapshot(actor.viewer,TODAY).reminders,[]);
  const after=work.snapshot(actor.dev,'2026-09-17');
  assert.notEqual(after.reminders.find(item=>item.entityId===today.id).id,mine.reminders.find(item=>item.entityId===today.id).id);
  assert.equal(after.reminders.find(item=>item.entityId===overdue.id).id,mine.reminders.find(item=>item.entityId===overdue.id).id);
});

test('已读状态只写当前用户，拒绝不可见编号且失败没有残留', t => {
  const {db,work,actor,task}=fixture(t);
  task('共享催办',{dueDate:'2026-09-15'});
  const notice=work.snapshot(actor.dev,TODAY).reminders[0];
  assert.equal(db.prepare('SELECT count(*) n FROM app_meta').get().n,0);
  assert.equal(work.snapshot(actor.lead,TODAY).reminders[0].id,notice.id);
  const result=work.markRead(actor.dev,{ids:[notice.id,notice.id],date:TODAY});
  assert.equal(result.readCount,1);
  assert.equal(work.snapshot(actor.dev,TODAY).unread,0);
  assert.equal(work.snapshot(actor.lead,TODAY).unread,1);
  assert.equal(work.snapshot(actor.lead,TODAY).reminders[0].read,false);
  for(const ids of [[notice.id],['0'.repeat(32)]])assert.throws(()=>work.markRead(actor.outsider,{ids,date:TODAY}),error=>error.status===404);
  assert.equal(db.prepare('SELECT count(*) n FROM app_meta').get().n,1);
  for(const ids of [null,['bad-id'],[1],Array(501).fill(notice.id)])assert.throws(()=>work.markRead(actor.dev,{ids,date:TODAY}),error=>error.code==='INVALID_NOTIFICATIONS');
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{invalid','read_notifications:dev');
  assert.equal(work.snapshot(actor.dev,TODAY).unread,1);
  db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}','read_notifications:dev');
  assert.equal(work.snapshot(actor.dev,TODAY).unread,1);
  db.prepare("DELETE FROM memberships WHERE user_id='dev'").run();
  assert.throws(()=>work.markRead(actor.dev,{ids:[notice.id],date:TODAY}),error=>error.status===404);
});

test('报表日期必须是有效日历日期，拒绝日期前缀加任意后缀', t => {
  const {work,actor}=fixture(t);
  for(const date of ['2026-02-30','2026-13-01','2026-9-16','0000-01-01','2026-09-16junk','2026-09-16T00:00:00Z','',null,20260916])assert.throws(()=>work.snapshot(actor.dev,date),error=>error.code==='INVALID_DATE');
  assert.equal(work.snapshot(actor.dev,'2024-02-29').date,'2024-02-29');
});

test('八周趋势按真实日期计数，未知完成时间单列且不借截止或修改日期补造', t => {
  const {work,actor,requirement,task,patch}=fixture(t);
  requirement('窗口前',{createdAt:'2026-07-26'});requirement('窗口第一天',{createdAt:'2026-07-27'});requirement('本周创建',{createdAt:'2026-09-14T10:00:00Z'});requirement('未来创建',{createdAt:'2026-09-17'});requirement('无效创建时间',{createdAt:'2026-09-14invalid'});
  task('第一周完成',{status:'done',createdAt:'2026-07-25',completedAt:'2026-07-27'});
  task('本周完成',{status:'已完成',createdAt:'2026-09-12T08:00:00Z',completedAt:'2026-09-15T15:00:00Z'});
  task('创建日期比完成晚',{status:'done',createdAt:'2026-09-16',completedAt:'2026-09-15'});
  task('未知创建日期',{status:'done',createdAt:'2026-09-14bogus',completedAt:'2026-09-16'});
  task('未来完成不计入',{status:'done',createdAt:'2026-09-01',completedAt:'2026-09-17'});
  task('窗口前完成不计入',{status:'done',createdAt:'2026-07-01',completedAt:'2026-07-26'});
  for(const completedAt of ['', '2026-02-30T12:00:00Z', '2026-09-14bogus', '2026-09-14T25:00:00Z']) {
    const unknown=task('未知完成时间',{status:'done',createdAt:'2026-09-01',completedAt,dueDate:'2026-09-14'});
    patch('tasks',unknown,{updatedAt:'2026-09-15T12:00:00Z'});
  }
  task('归档完成不计入',{status:'done',archived:true});
  const report=work.snapshot(actor.dev,TODAY);
  assert.equal(report.trend.length,8);
  assert.equal(report.trend[0].start,'2026-07-27');assert.equal(report.trend.at(-1).start,'2026-09-14');assert.equal(report.trend.at(-1).end,'2026-09-20');
  assert.equal(report.trend[0].createdRequirements,1);assert.equal(report.trend.at(-1).createdRequirements,1);assert.equal(report.trend.reduce((sum,week)=>sum+week.createdRequirements,0),2);
  assert.equal(report.trend[0].completedTasks,1);assert.equal(report.trend.at(-1).completedTasks,3);
  assert.equal(report.undatedCompleted,4);
  assert.deepEqual(report.cycle,{count:2,averageDays:2.5});
});

test('带时区的完成时间按统一时区归日，健康报表明确未排期与无分母', t => {
  const {work,actor,task,patch,project,other}=fixture(t);
  task('跨日完成',{status:'done',createdAt:'2026-09-12',completedAt:'2026-09-17T01:00:00+08:00'});
  task('已逾期',{dueDate:'2026-09-15'});task('今天到期',{dueDate:TODAY});task('没有排期');
  const invalid=task('无效排期');patch('tasks',invalid,{dueDate:'2026-09-10bogus'});
  task('终止的不计入',{status:'terminated',dueDate:'2026-09-01'});
  const report=work.snapshot(actor.admin,TODAY);
  assert.equal(report.trend.at(-1).completedTasks,1);
  assert.deepEqual(report.cycle,{count:1,averageDays:4});
  assert.deepEqual(report.health.find(item=>item.projectId===project.id),{projectId:project.id,name:project.name,pending:4,scheduled:2,overdue:1,unscheduled:2,overdueRate:50});
  assert.deepEqual(report.health.find(item=>item.projectId===other.id),{projectId:other.id,name:other.name,pending:0,scheduled:0,overdue:0,unscheduled:0,overdueRate:null});
});

test('主开发收到待拆分需求和开发自行补充任务的提醒，其他角色不收到', t => {
  const {b,work,actor,project,requirement,ids}=fixture(t);
  const confirmed=requirement('已确定待拆分',{status:'已确定'});requirement('仍在评审',{status:'待评审'});
  const lead=work.snapshot(actor.lead,TODAY);
  assert.deepEqual(ids(lead.personal.splits),[confirmed.id]);assert.equal(lead.personal.isLead,true);
  assert(lead.reminders.some(item=>item.kind==='split'&&item.entityId===confirmed.id));
  for(const role of ['product','dev','tester'])assert(!work.snapshot(actor[role],TODAY).reminders.some(item=>item.kind==='split'));
  let parent=b.updateRequirement(actor.lead,confirmed.id,{version:b.getRequirement(actor.lead,confirmed.id).version,assigneeId:'dev'});
  const byLead=b.createTask(actor.lead,{projectId:project.id,requirementId:parent.id,title:'主开发拆的任务',ownerId:'dev',estimateHours:8});
  const byDev=b.createTask(actor.dev,{projectId:project.id,requirementId:parent.id,title:'开发补充的任务',ownerId:'dev',estimateHours:4});
  const added=work.snapshot(actor.lead,TODAY).reminders.filter(item=>item.kind==='added');
  assert.deepEqual(added.map(item=>item.entityId),[byDev.id]);assert(!added.some(item=>item.entityId===byLead.id));
  assert(!work.snapshot(actor.product,TODAY).reminders.some(item=>item.kind==='added'));
});
