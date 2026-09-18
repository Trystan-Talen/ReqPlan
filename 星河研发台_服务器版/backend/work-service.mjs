import { createHash } from 'node:crypto';
import { transaction } from './database.mjs';
import { taskStage } from '../frontend/workflow.js';

const DAY = 86400000;
function day(value) {
  if (typeof value !== 'string') return null;
  const text=value.slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)||text<'0001-01-01') return null;
  const stamp=Date.parse(text+'T00:00:00Z');
  if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==text)return null;
  if(value.length===10)return stamp;
  // Imported timestamps must be real ISO timestamps; a valid date prefix does
  // not make an arbitrary suffix a known creation or completion time.
  if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value))return null;
  const parsed=Date.parse(value);
  if(!Number.isFinite(parsed))return null;
  return Date.parse(new Date(parsed).toISOString().slice(0,10)+'T00:00:00Z');
}
const iso = stamp => new Date(stamp).toISOString().slice(0,10);
const noticeId = text => createHash('sha256').update(text).digest('hex').slice(0,32);
const active = item => !item.archived;
const finished = item => ['done','terminated'].includes(taskStage(item.status));

export function summarizeWork(data,user,date) {
  const today=day(date);
  if(typeof date!=='string'||date.length!==10||today===null)throw Object.assign(new Error('统计日期无效'),{status:400,code:'INVALID_DATE'});
  const projects=data.projects.filter(active), projectIds=new Set(projects.map(item=>item.id));
  const tasks=data.tasks.filter(item=>active(item)&&projectIds.has(item.projectId));
  const requirements=data.requirements.filter(item=>active(item)&&projectIds.has(item.projectId));
  const roles=new Map(data.memberships.filter(item=>item.userId===user.id).map(item=>[item.projectId,item.role]));
  const manager=id=>user.role==='admin'||roles.get(id)==='lead';
  const reviewer=id=>user.role==='admin'||['lead','tester'].includes(roles.get(id));
  const lead=id=>roles.get(id)==='lead';
  const assignedTasks=tasks.filter(item=>item.ownerId===user.id&&!finished(item));
  const assignedRequirements=requirements.filter(item=>!finished(item)&&(item.ownerId===user.id||item.assigneeId===user.id||(item.collaboratorIds||[]).includes(user.id)));
  const reviews=tasks.filter(item=>taskStage(item.status)==='test'&&reviewer(item.projectId));
  const taskById=new Map(tasks.map(item=>[item.id,item]));
  const reminders=[];
  for(const task of tasks) {
    if(finished(task)||!(task.ownerId===user.id||manager(task.projectId)))continue;
    const due=day(task.dueDate);
    if(due!==null&&due<=today+3*DAY) {
      const late=due<today;
      reminders.push({id:noticeId(`task-due:${task.id}:${task.dueDate}:${late}`),kind:late?'overdue':'due',entityType:'task',entityId:task.id,projectId:task.projectId,title:task.title,message:late?`截止日期 ${task.dueDate}，已逾期 ${Math.round((today-due)/DAY)} 天`:`将在 ${task.dueDate} 截止`,date:task.dueDate});
    }
    const blocked=(task.dependencyIds||[]).filter(id=>taskStage(taskById.get(id)?.status)!=='done');
    if(blocked.length)reminders.push({id:noticeId(`blocked:${task.id}:${blocked.join(',')}`),kind:'blocked',entityType:'task',entityId:task.id,projectId:task.projectId,title:task.title,message:`有 ${blocked.length} 个前置任务尚未完成`,date:task.dueDate||''});
  }
  // Lead developers split confirmed requirements and review tasks developers added themselves.
  const splits=requirements.filter(item=>item.status==='已确定'&&lead(item.projectId));
  for(const item of splits)reminders.push({id:noticeId(`split:${item.id}`),kind:'split',entityType:'requirement',entityId:item.id,projectId:item.projectId,title:item.title,message:'需求已确定，等待拆分任务并指定主责开发',date:item.planStart||''});
  const developerIds=new Set(data.memberships.filter(item=>item.role==='developer').map(item=>`${item.projectId}:${item.userId}`));
  for(const task of tasks)if(lead(task.projectId)&&developerIds.has(`${task.projectId}:${task.createdBy}`)&&taskStage(task.status)==='wait')reminders.push({id:noticeId(`added:${task.id}`),kind:'added',entityType:'task',entityId:task.id,projectId:task.projectId,title:task.title,message:'开发补充了这个任务，请确认拆分和排期',date:task.dueDate||''});
  for(const task of reviews)reminders.push({id:noticeId(`review:${task.id}:${task.version}`),kind:'review',entityType:'task',entityId:task.id,projectId:task.projectId,title:task.title,message:'任务已进入测试，等待验收',date:task.dueDate||''});
  const monday=today-((new Date(today).getUTCDay()+6)%7)*DAY;
  const trend=Array.from({length:8},(_,index)=>({start:iso(monday-(7-index)*7*DAY),end:iso(monday-(7-index)*7*DAY+6*DAY),createdRequirements:0,completedTasks:0}));
  let undatedCompleted=0;
  for(const item of requirements) { const stamp=day(item.createdAt);if(stamp===null)continue;const bucket=trend.find(week=>stamp>=day(week.start)&&stamp<=Math.min(day(week.end),today));if(bucket)bucket.createdRequirements++; }
  const cycleDays=[];
  for(const item of tasks.filter(item=>taskStage(item.status)==='done')) {
    const stamp=day(item.completedAt),created=day(item.createdAt);
    if(stamp===null){undatedCompleted++;continue;}
    const bucket=trend.find(week=>stamp>=day(week.start)&&stamp<=Math.min(day(week.end),today));
    if(bucket) {bucket.completedTasks++;if(created!==null&&created<=stamp)cycleDays.push((stamp-created)/DAY);}
  }
  const health=projects.map(project=>{
    const pending=tasks.filter(item=>item.projectId===project.id&&!finished(item));
    const scheduled=pending.filter(item=>day(item.dueDate)!==null);
    const overdue=scheduled.filter(item=>day(item.dueDate)<today).length;
    return {projectId:project.id,name:project.name,pending:pending.length,scheduled:scheduled.length,overdue,unscheduled:pending.length-scheduled.length,overdueRate:scheduled.length?Math.round(overdue/scheduled.length*100):null};
  });
  return {date,personal:{tasks:assignedTasks,requirements:assignedRequirements,reviews,splits,isLead:roles.size>0&&[...roles.values()].includes('lead')},reminders:reminders.sort((a,b)=>(a.kind==='overdue'?-1:0)-(b.kind==='overdue'?-1:0)||(a.date||'9999').localeCompare(b.date||'9999')),health,trend,undatedCompleted,cycle:{count:cycleDays.length,averageDays:cycleDays.length?Math.round(cycleDays.reduce((a,b)=>a+b,0)/cycleDays.length*10)/10:null}};
}

export function createWorkService(db,business) {
  function snapshot(actor,date=new Date().toISOString().slice(0,10)) {
    const data=business.bootstrap(actor);
    const result=summarizeWork(data,data.currentUser,date);
    const key=`read_notifications:${data.currentUser.id}`;
    const stored=db.prepare('SELECT value FROM app_meta WHERE key=?').get(key);
    let read=[];try {read=JSON.parse(stored?.value||'[]');}catch{}
    const readIds=new Set(Array.isArray(read)?read:[]);
    return {...result,reminders:result.reminders.map(item=>({...item,read:readIds.has(item.id)})),unread:result.reminders.filter(item=>!readIds.has(item.id)).length};
  }
  function markRead(actor,{ids,date}={}) {
    if(!Array.isArray(ids)||ids.length>500||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)))throw Object.assign(new Error('提醒编号格式无效'),{status:400,code:'INVALID_NOTIFICATIONS'});
    return transaction(db,()=>{
      const current=snapshot(actor,date),visible=new Set(current.reminders.map(item=>item.id));
      if(ids.some(id=>!visible.has(id)))throw Object.assign(new Error('提醒不存在或无权访问'),{status:404,code:'NOT_FOUND'});
      const read=[...new Set([...current.reminders.filter(item=>item.read).map(item=>item.id),...ids])].slice(-500);
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`read_notifications:${actor.id}`,JSON.stringify(read));
      return {ok:true,readCount:read.length};
    });
  }
  return {snapshot,markRead};
}
