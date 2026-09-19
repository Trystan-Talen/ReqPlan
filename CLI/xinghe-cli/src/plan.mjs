// 排期计算：纯函数，不访问网络。与服务端 backend/scripts/plan-tasks.mjs 的顺排规则一致：
// 按阶段与文件顺序把任务放进负责人的工作日历，每人每天最多 capacityHours 小时。
import {fail} from './client.mjs';

const DAY=86_400_000;
const toDay=value=>Date.parse(value+'T00:00:00Z')/DAY;
const toText=day=>new Date(day*DAY).toISOString().slice(0,10);
const isDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toText(toDay(value))===value;

/** 工作日日历：跳过周六日与 holidays，extraWorkdays 为调休上班日。 */
export function workCalendar(startDate,{holidays=[],extraWorkdays=[]}={},length=500) {
  const skip=new Set(holidays),extra=new Set(extraWorkdays),days=[];
  for(let day=toDay(startDate);days.length<length;day++) {const text=toText(day),weekday=new Date(day*DAY).getUTCDay();if((extra.has(text) || (weekday!==0 && weekday!==6)) && !skip.has(text))days.push(text);}
  return days;
}

/** 校验计划文件，返回规范化后的计划；错误集中列出。 */
export function validatePlan(plan) {
  const errors=[];
  if(!plan || typeof plan!=='object' || Array.isArray(plan)) fail('INVALID_PLAN','计划文件必须是对象。');
  if(!isDate(plan.startDate)) errors.push('startDate 必须是 YYYY-MM-DD。');
  if(!(plan.capacityHours>0 && plan.capacityHours<=12)) errors.push('capacityHours 必须在 0 到 12 小时之间。');
  for(const key of ['holidays','extraWorkdays']) if(plan[key]!==undefined && (!Array.isArray(plan[key]) || plan[key].some(value=>!isDate(value)))) errors.push(`${key} 必须是日期列表。`);
  for(const item of plan.capacityOverrides || []) if(!isDate(item.from) || !isDate(item.until) || !(item.hours>0 && item.hours<=12)) errors.push('capacityOverrides 每项需要 from、until 与 0～12 的 hours。');
  const phases=plan.phases ?? [...new Set((plan.tasks || []).map(task=>task.phase ?? ''))];
  if(!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length>300) errors.push('tasks 需要 1 至 300 个任务。');
  const titles=new Set();
  (plan.tasks || []).forEach((task,index)=>{
    const where=`第 ${index+1} 个任务`;
    if(!task || typeof task!=='object') {errors.push(`${where} 格式不正确。`);return;}
    if(typeof task.requirement!=='string' || !task.requirement) errors.push(`${where} 缺少 requirement（需求编号）。`);
    if(typeof task.owner!=='string' || !task.owner) errors.push(`${where} 缺少 owner（负责人）。`);
    if(typeof task.title!=='string' || !task.title.trim() || task.title.length>200) errors.push(`${where} 标题为空或超过 200 字。`);
    else if(titles.has(task.title)) errors.push(`${where} 标题重复：${task.title}（after 按标题引用，标题必须唯一）。`); else titles.add(task.title);
    if(!(task.hours>0 && task.hours<=80)) errors.push(`${where} hours 必须在 0 到 80 之间。`);
    if(!phases.includes(task.phase ?? '')) errors.push(`${where} 阶段 ${task.phase} 不在 phases 中。`);
    for(const title of task.after || []) if(!(plan.tasks || []).some(other=>other.title===title)) errors.push(`${where} 的前置任务「${title}」不存在。`);
  });
  if(errors.length) fail('INVALID_PLAN',`计划文件有 ${errors.length} 处问题：${errors.slice(0,20).join(' ')}`,{details:errors});
  return {...plan,phases,holidays:plan.holidays || [],extraWorkdays:plan.extraWorkdays || [],acceptanceBufferDays:plan.acceptanceBufferDays ?? 1};
}

/**
 * 顺排：阶段顺序 → 文件顺序；busyUntil[owner] 为该负责人已有未完成任务的最晚截止日，
 * 新任务从其下一个工作日开始（respectExistingLoad=false 时忽略）。
 */
export function schedulePlan(input,{busyUntil={},ownerOf=owner=>owner}={}) {
  const plan=validatePlan(input),calendar=workCalendar(plan.startDate,plan);
  const capacityOf=day=>(plan.capacityOverrides || []).find(item=>calendar[day]>=item.from && calendar[day]<=item.until)?.hours ?? plan.capacityHours;
  const cursors=new Map(),placed=new Map(),tasks=[];
  const ordered=plan.tasks.map((task,index)=>({...task,index})).sort((a,b)=>plan.phases.indexOf(a.phase ?? '')-plan.phases.indexOf(b.phase ?? '') || a.index-b.index);
  for(const task of ordered) {
    const owner=ownerOf(task.owner);
    if(!cursors.has(owner)) {
      const busy=plan.respectExistingLoad===false?null:busyUntil[owner];
      const first=busy?calendar.findIndex(day=>day>busy):0;
      cursors.set(owner,{day:Math.max(0,first),used:0});
    }
    let {day,used}=cursors.get(owner);
    for(const title of task.after || []) {
      const dependency=placed.get(title);if(!dependency) fail('INVALID_PLAN',`「${task.title}」的前置任务「${title}」必须排在它前面（调整阶段或顺序）。`);
      const next=calendar.indexOf(dependency.dueDate)+1;if(day<next){day=next;used=0;}
    }
    if(used>=capacityOf(day)){day++;used=0;}
    const start=day;let remaining=task.hours;
    while(remaining>1e-9){const take=Math.min(capacityOf(day)-used,remaining);remaining-=take;used+=take;if(remaining>1e-9){day++;used=0;}}
    if(day>=calendar.length) fail('INVALID_PLAN','排期超出两年日历范围，请检查工时或产能。');
    cursors.set(owner,{day,used});
    const item={...task,owner,startDate:calendar[start],dueDate:calendar[day]};
    placed.set(task.title,item);tasks.push(item);
  }
  const addWorkdays=(date,count)=>calendar[Math.min(calendar.length-1,calendar.indexOf(date)+count)];
  const byRequirement=new Map();
  for(const item of tasks) {
    const entry=byRequirement.get(item.requirement) || {requirementId:item.requirement,tasks:[],hours:new Map()};
    entry.tasks.push(item);entry.hours.set(item.owner,(entry.hours.get(item.owner) || 0)+item.hours);byRequirement.set(item.requirement,entry);
  }
  const requirements=[...byRequirement.values()].map(entry=>{
    const owners=[...entry.hours].sort((a,b)=>b[1]-a[1]);
    return {requirementId:entry.requirementId,planStart:entry.tasks.map(item=>item.startDate).sort()[0],planEnd:addWorkdays(entry.tasks.map(item=>item.dueDate).sort().at(-1),plan.acceptanceBufferDays),
      assignee:owners[0][0],collaborators:owners.slice(1).map(([owner])=>owner),hours:entry.tasks.reduce((sum,item)=>sum+item.hours,0),
      tasks:entry.tasks.sort((a,b)=>a.startDate.localeCompare(b.startDate) || a.index-b.index)};
  });
  const load={};
  for(const item of tasks){const entry=load[item.owner] ||= {hours:0,tasks:0,from:item.startDate,until:item.dueDate};entry.hours+=item.hours;entry.tasks++;if(item.startDate<entry.from)entry.from=item.startDate;if(item.dueDate>entry.until)entry.until=item.dueDate;}
  const phaseEnds=Object.fromEntries(plan.phases.map(phase=>[phase,tasks.filter(item=>(item.phase ?? '')===phase).map(item=>item.dueDate).sort().at(-1) || null]));
  return {tasks,requirements,load,phaseEnds,granularity:{averageHours:Math.round(tasks.reduce((sum,item)=>sum+item.hours,0)/tasks.length*10)/10,under8:tasks.filter(item=>item.hours<8).length,over24:tasks.filter(item=>item.hours>24).map(item=>item.title)}};
}
