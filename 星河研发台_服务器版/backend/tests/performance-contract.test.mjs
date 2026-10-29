import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { createWorkService, summarizeWork } from '../work-service.mjs';

function fixture(t) {
  const db=openDatabase(':memory:');t.after(()=>db.close());
  for(const id of ['admin','executive','member','single','outsider']) {
    db.prepare("INSERT INTO users(id,username,name,role,executive,status,must_change_password) VALUES(?,?,?,?,?,'active',0)")
      .run(id,id,id,id==='admin'?'admin':'member',id==='executive'?1:0);
  }
  for(const id of ['p-b','p-a','p-hidden','p-old']) {
    db.prepare('INSERT INTO projects(id,data,archived) VALUES(?,?,?)').run(id,JSON.stringify({id,name:id,ownerId:'admin'}),id==='p-old'?1:0);
  }
  for(const project of ['p-a','p-b','p-old'])db.prepare("INSERT INTO memberships(project_id,user_id,role) VALUES(?,'member','viewer')").run(project);
  db.exec("INSERT INTO memberships(project_id,user_id,role) VALUES('p-a','single','developer')");
  // Deliberately interleave projects and timestamps to check global ordering, including ties.
  const rows=[
    ['b','p-b',0,'2026-09-02'],['z','p-a',0,'2026-09-01'],['a','p-a',0,'2026-09-02'],
    ['archived','p-a',1,'2026-09-02'],['hidden','p-hidden',0,'2026-09-01'],['old','p-old',0,'2026-09-01'],
  ];
  for(const [id,projectId,archived,createdAt] of rows) {
    const requirement={id:'r-'+id,projectId,title:id,status:'已确定',createdAt,ownerId:'admin'};
    db.prepare('INSERT INTO requirements(id,project_id,data,archived,version,created_at,updated_at) VALUES(?,?,?,?,3,?,?)')
      .run(requirement.id,projectId,JSON.stringify(requirement),archived,createdAt,'2026-09-03');
    const task={id:'t-'+id,projectId,requirementId:requirement.id,title:id,status:'wait',ownerId:'member'};
    db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data,archived,version,created_at,updated_at) VALUES(?,?,?,?,?,4,?,?)')
      .run(task.id,projectId,requirement.id,JSON.stringify(task),archived,createdAt,'2026-09-04');
  }
  const reads=[];
  const measured={prepare(sql) {
    const statement=db.prepare(sql);
    return new Proxy(statement,{get(target,key) {
      if(key==='all')return (...args)=>{const result=target.all(...args);reads.push({sql,rows:result});return result;};
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
  }};
  return {db,b:createBusiness(measured),reads};
}

test('实体列表与初始化保留各角色的项目范围、归档范围、全局顺序和版本',t=>{
  const {b}=fixture(t);
  const scenarios=[
    ['member',{},['z','a','b']],
    ['member',{includeArchived:true},['old','z','a','archived','b']],
    ['admin',{},['hidden','z','a','b']],
    ['executive',{},['hidden','z','a','b']],
    ['executive',{includeArchived:true},['hidden','old','z','a','archived','b']],
    ['outsider',{},[]],
    ['outsider',{includeArchived:true},[]],
    ['member',{projectId:'p-b'},['b']],
    ['member',{projectId:'p-old'},[]],
    ['member',{projectId:'p-old',includeArchived:true},['old']],
  ];
  for(const [id,options,expected] of scenarios) {
    const actor={id},snapshot=b.bootstrap(actor,options);
    for(const [method,key,prefix,version] of [['listRequirements','requirements','r-',3],['listTasks','tasks','t-',4]]) {
      const result=b[method](actor,options);
      assert.deepEqual(result.map(item=>item.id),expected.map(id=>prefix+id),`${id} ${key} ${JSON.stringify(options)}`);
      assert.deepEqual(snapshot[key],result);
      for(const item of result) {
        assert.equal(item.version,version);
        assert.equal(item.archived,item.id===prefix+'archived');
        assert.equal(item.updatedAt,key==='requirements'?'2026-09-03':'2026-09-04');
      }
    }
  }
  for(const method of ['bootstrap','listRequirements','listTasks']) {
    assert.throws(()=>b[method]({id:'member'},{projectId:'p-hidden'}),error=>error.status===403);
    assert.throws(()=>b[method]({id:'member'},{projectId:'missing'}),error=>error.status===404);
    assert.throws(()=>b[method]({id:'member'},{projectId:"p-a' OR 1=1 --"}),error=>error.status===400);
  }
});

test('数据库不返回不可见或不需要的归档实体，初始化只读取一次项目集合',t=>{
  const {db,b,reads}=fixture(t);
  for(let index=0;index<120;index++) {
    db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run('unrelated-'+index,'p-hidden',JSON.stringify({title:'无关需求'}));
  }
  const entityReads=()=>reads.filter(entry=>/\bFROM (requirements|tasks)\b/.test(entry.sql));
  const snapshot=b.bootstrap({id:'single'});
  assert.deepEqual(snapshot.requirements.map(item=>item.id),['r-z','r-a']);
  assert.deepEqual(snapshot.tasks.map(item=>item.id),['t-z','t-a']);
  assert.equal(reads.filter(entry=>/\bFROM projects\b/.test(entry.sql)).length,1);
  assert.equal(entityReads().flatMap(entry=>entry.rows).length,4);
  assert(entityReads().every(entry=>entry.rows.every(row=>row.project_id==='p-a'&&row.archived===0)));
  reads.length=0;
  b.bootstrap({id:'outsider'});
  assert.equal(entityReads().length,0);
  // No authorization scope is retained across reads: membership removal takes effect immediately.
  db.exec("DELETE FROM memberships WHERE user_id='single'");
  assert.deepEqual(b.bootstrap({id:'single'}).tasks,[]);
});

test('优化读取兼容持久化历史记录，重开数据库后全部原始行与表结构不变',t=>{
  const directory=mkdtempSync(path.join(tmpdir(),'xinghe-read-compatibility-'));
  const file=path.join(directory,'existing.sqlite');
  let db;
  t.after(()=>{if(db)db.close();rmSync(directory,{recursive:true,force:true});});
  db=openDatabase(file);
  db.exec("INSERT INTO users(id,username,name,role,status,password_hash,must_change_password) VALUES('admin','admin','历史管理员','admin','active','synthetic-existing-hash',0)");
  db.prepare('INSERT INTO projects(id,data,version) VALUES(?,?,5)').run('p','{"name":"历史项目","ownerId":"admin"}');
  db.exec("INSERT INTO memberships(project_id,user_id,role) VALUES('p','admin','lead')");
  // Optional fields intentionally remain absent; unknown extensions are not normalized away.
  const original={title:'历史需求',projectId:'p',status:'已确定',ownerId:'admin',acceptance:'旧验收标准',docRefs:[{document:'旧文档.md',sections:['OLD-1']}],legacyExtension:{sourceId:'old-01',values:[null,0,'原值']}};
  db.prepare('INSERT INTO requirements(id,project_id,data,version,created_at,updated_at) VALUES(?,?,?,7,?,?)')
    .run('r-legacy','p',JSON.stringify(original),'2020-01-01','2020-02-01');
  db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data,version) VALUES(?,?,?,?,4)')
    .run('t-legacy','p','r-legacy',JSON.stringify({title:'历史任务',projectId:'p',requirementId:'r-legacy',ownerId:'admin',status:'已完成',legacyNote:'保留中文状态'}));
  db.prepare('INSERT INTO attachments(id,logical_id,requirement_id,project_id,name,mime,content,version) VALUES(?,?,?,?,?,?,?,3)')
    .run('a','a','r-legacy','p','原附件.bin','application/octet-stream',Buffer.from([0,1,127,128,255]));
  db.prepare('INSERT INTO documents(id,project_id,name,title,type) VALUES(?,?,?,?,?)').run('d','p','旧文档.md','旧文档','技术方案');
  db.prepare('INSERT INTO document_versions(id,document_id,version,mime,content,content_hash,sections) VALUES(?,?,1,?,?,?,?)')
    .run('dv','d','text/markdown',Buffer.from('# 旧章节\n原始内容\r\n'),'synthetic-original-hash','[{"code":"OLD-1","title":"旧章节"}]');
  db.prepare('INSERT INTO proposals(id,project_id,requirement_id,data) VALUES(?,?,?,?)').run('q','p','r-legacy','{"status":"已转需求","originalId":"q-old"}');
  db.exec("INSERT INTO audit(user_id,action,entity_type,entity_id,detail) VALUES('admin','import','requirement','r-legacy','{\"source\":\"legacy\"}')");
  db.exec("INSERT INTO app_meta(key,value) VALUES('read_notifications:admin','[]')");
  const raw=()=>({
    version:db.prepare('PRAGMA user_version').get(),
    schema:db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all(),
    tables:Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({name})=>[name,db.prepare(`SELECT * FROM "${name.replaceAll('"','""')}" ORDER BY rowid`).all()])),
  });
  const before=raw();
  const read=()=>{
    const business=createBusiness(db),actor={id:'admin'};
    const snapshot=business.bootstrap(actor,{includeArchived:true});
    assert.deepEqual(snapshot.requirements[0],{...original,id:'r-legacy',version:7,archived:false,updatedAt:'2020-02-01'});
    assert.equal(snapshot.tasks[0].version,4);assert.equal(snapshot.tasks[0].requirementId,'r-legacy');
    assert.equal(snapshot.tasks[0].status,'已完成');assert.equal(snapshot.documents[0].id,'d');
    const work=createWorkService(db,business).snapshot(actor,'2026-10-10');
    assert.equal(work.undatedCompleted,1,'旧任务缺少完成时间时继续明确标为未知');
    return {snapshot,work};
  };
  const result=read();assert.deepEqual(raw(),before);
  db.close();db=null;db=openDatabase(file);
  assert.deepEqual(read(),result);assert.deepEqual(raw(),before);
});

function workFixture() {
  const date='2026-09-16';
  const requirement=(id,projectId,changes={})=>({id,projectId,title:id,status:'开发中',assigneeId:'lead',acceptance:'通过验收',dependencyIds:[],createdAt:date,...changes});
  const task=(id,projectId,requirementId,changes={})=>({id,projectId,requirementId,title:id,status:'wait',ownerId:'dev',estimateHours:8,startDate:'2026-09-01',dueDate:date,dependencyIds:[],version:1,createdAt:'2026-09-01',...changes});
  return {date,user:{id:'lead',role:'member'},data:{
    projects:[{id:'p-b',name:'乙'},{id:'p-a',name:'甲'},{id:'p-old',name:'归档',archived:true}],
    requirements:[requirement('r-ready','p-b',{status:'测试中',planEnd:date,docRefs:[{document:'说明.md',sections:['S-1']}]}),requirement('r-plan','p-a',{status:'已确定'}),requirement('r-other','p-a'),requirement('r-old','p-old')],
    tasks:[task('t-done','p-b','r-ready',{status:'done',completedAt:date}),task('t-plan','p-a','r-plan',{startDate:'',createdBy:'dev',dependencyIds:['missing']}),task('t-review','p-a','r-other',{status:'test'}),task('t-overdue','p-a','r-other',{dueDate:'2026-09-15'}),task('t-old','p-old','r-old')],
    memberships:[{projectId:'p-b',userId:'lead',role:'lead'},{projectId:'p-a',userId:'lead',role:'lead'},{projectId:'p-a',userId:'dev',role:'developer'}],
    documents:[{id:'d-b',projectId:'p-b',name:'说明.md',title:'说明',type:'PRD',version:2,versionCreatedAt:date,changedSections:['S-1'],sections:[{code:'S-1'}]}],
  }};
}

test('工作台分组后保留同日提醒的稳定顺序、身份、日期和项目报表顺序',()=>{
  const {data,user,date}=workFixture(),before=structuredClone(data);
  const result=summarizeWork(data,user,date);
  assert.deepEqual(result.reminders.map(item=>[item.kind,item.entityId,item.date]),[
    ['overdue','t-overdue','2026-09-15'],['due','t-plan',date],['blocked','t-plan',date],['due','t-review',date],
    ['added','t-plan',date],['review','t-review',date],['review','r-ready',date],['document','r-ready',date],['schedule','r-plan',''],
  ]);
  // Existing notification identities keep the user's read state across the optimization.
  assert.deepEqual(result.reminders.map(item=>item.id),[
    '7380c33e3ad823824491b60d62fd8ea5','ac0454076ccd18409b6c7e3fc7143527','a726104f2b39b7e131ea219f62b06e54',
    '66ac8c0381b1b2217d8cc021cde4fbe6','a98abc9895a4588f873076434f44c126','5dbf9c047dd3cf19fc2d93109c109794',
    '50aa0b200cd20e384a56fbd1ea892c7a','3fa5f24011e8d9b63db0afbc63c038dd','13fdf7487b2655b0284343533a03ce6d',
  ]);
  assert.deepEqual(result.health,[
    {projectId:'p-b',name:'乙',pending:0,scheduled:0,overdue:0,unscheduled:0,overdueRate:null},
    {projectId:'p-a',name:'甲',pending:3,scheduled:3,overdue:1,unscheduled:0,overdueRate:33},
  ]);
  assert.deepEqual(data,before,'摘要读取不改变输入');
  assert.deepEqual(summarizeWork(data,user,date),result,'重复读取的内容与顺序稳定');
  data.tasks.find(item=>item.id==='t-plan').startDate='2026-09-16';
  assert(!summarizeWork(data,user,date).reminders.some(item=>item.kind==='schedule'),'后续快照重新计算交付状态');
});
