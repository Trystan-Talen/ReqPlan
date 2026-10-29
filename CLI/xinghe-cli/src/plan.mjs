// 排期计算：纯函数，不访问网络。与服务端 backend/scripts/plan-tasks.mjs 的顺排规则一致：
// 按阶段与文件顺序把任务放进负责人的工作日历，每人每天最多 capacityHours 小时。
import {fail} from './client.mjs';

const DAY=86_400_000;
const toDay=value=>Date.parse(value+'T00:00:00Z')/DAY;
const toText=day=>new Date(day*DAY).toISOString().slice(0,10);
const isDate=value=>typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && value>='0001-01-01' && Number.isFinite(toDay(value)) && toText(toDay(value))===value;
const isObject=value=>value!==null && typeof value==='object' && !Array.isArray(value);
const isHours=(value,max)=>Number.isFinite(value) && value>0 && value<=max;
const isDateList=value=>Array.isArray(value) && value.every(isDate);

/** 工作日日历：跳过周六日与 holidays，extraWorkdays 为调休上班日。 */
export function workCalendar(startDate,options={},length=500) {
  if(!isDate(startDate) || !isObject(options) || !Number.isSafeInteger(length) || length<0) fail('INVALID_PLAN','工作日历需要有效开始日期和非负整数天数。');
  const {holidays=[],extraWorkdays=[]}=options;
  if(!isDateList(holidays) || !isDateList(extraWorkdays)) fail('INVALID_PLAN','节假日和调休上班日必须是有效日期列表。');
  const skip=new Set(holidays),extra=new Set(extraWorkdays),days=[];
  const lastDay=toDay('9999-12-31');
  for(let day=toDay(startDate);days.length<length;day++) {
    if(day>lastDay) fail('INVALID_PLAN','工作日历超出支持的日期范围。');
    const text=toText(day),weekday=new Date(day*DAY).getUTCDay();if((extra.has(text) || (weekday!==0 && weekday!==6)) && !skip.has(text))days.push(text);
  }
  return days;
}

/** 校验计划文件，返回规范化后的计划；错误集中列出。 */
export function validatePlan(plan) {
  const errors=[];
  if(!isObject(plan)) fail('INVALID_PLAN','计划文件必须是对象。');
  if(!isDate(plan.startDate)) errors.push('startDate 必须是 YYYY-MM-DD。');
  if(!isHours(plan.capacityHours,12)) errors.push('capacityHours 必须是大于 0 且不超过 12 的小时数。');
  for(const key of ['holidays','extraWorkdays']) if(plan[key]!==undefined && !isDateList(plan[key])) errors.push(`${key} 必须是日期列表。`);
  if(plan.capacityOverrides!==undefined && !Array.isArray(plan.capacityOverrides)) errors.push('capacityOverrides 必须是产能调整列表。');
  else {
    const overrides=plan.capacityOverrides || [];
    for(const item of overrides) if(!isObject(item) || !isDate(item.from) || !isDate(item.until) || item.from>item.until || !isHours(item.hours,12)) errors.push('capacityOverrides 每项需要有效且先后有序的 from、until 与大于 0 且不超过 12 的 hours。');
    const validOverrides=overrides.filter(item=>isObject(item) && isDate(item.from) && isDate(item.until) && item.from<=item.until && isHours(item.hours,12));
    const sortedOverrides=validOverrides.slice().sort((left,right)=>left.from.localeCompare(right.from)||left.until.localeCompare(right.until));
    if(sortedOverrides.some((item,index)=>index>0 && item.from<=sortedOverrides[index-1].until)) errors.push('capacityOverrides 的日期区间不能重叠，以免产能覆盖规则产生歧义。');
  }
  const tasks=Array.isArray(plan.tasks)?plan.tasks:[];
  const phases=plan.phases===undefined?[...new Set(tasks.filter(isObject).map(task=>task.phase ?? ''))]:plan.phases;
  const validPhases=Array.isArray(phases) && phases.every(phase=>typeof phase==='string') && new Set(phases).size===phases.length;
  if(!validPhases) errors.push('phases 必须是不重复的阶段名称列表。');
  if(!Array.isArray(plan.tasks) || !plan.tasks.length || plan.tasks.length>300) errors.push('tasks 需要 1 至 300 个任务。');
  if(plan.acceptanceBufferDays!==undefined && (!Number.isSafeInteger(plan.acceptanceBufferDays) || plan.acceptanceBufferDays<0)) errors.push('acceptanceBufferDays 必须是非负整数工作日数。');
  if(plan.respectExistingLoad!==undefined && typeof plan.respectExistingLoad!=='boolean') errors.push('respectExistingLoad 必须是布尔值。');
  if(plan.owners!==undefined && (!isObject(plan.owners) || Object.values(plan.owners).some(owner=>typeof owner!=='string' || !owner.trim()))) errors.push('owners 必须是别名到负责人用户名或编号的映射。');
  if(plan.phaseDeadlines!==undefined && (!isObject(plan.phaseDeadlines) || Object.entries(plan.phaseDeadlines).some(([phase,date])=>!validPhases || !phases.includes(phase) || !isDate(date)))) errors.push('phaseDeadlines 必须把已有阶段映射到有效日期。');
  const titles=new Set();
  tasks.forEach((task,index)=>{
    const where=`第 ${index+1} 个任务`;
    if(!isObject(task)) {errors.push(`${where} 格式不正确。`);return;}
    if(typeof task.requirement!=='string' || !task.requirement.trim()) errors.push(`${where} 缺少 requirement（需求编号）。`);
    if(typeof task.owner!=='string' || !task.owner.trim()) errors.push(`${where} 缺少 owner（负责人）。`);
    if(typeof task.title!=='string' || !task.title.trim() || task.title.length>200) errors.push(`${where} 标题为空或超过 200 字。`);
    else if(titles.has(task.title)) errors.push(`${where} 标题重复：${task.title}（after 按标题引用，标题必须唯一）。`); else titles.add(task.title);
    if(!isHours(task.hours,80)) errors.push(`${where} hours 必须是大于 0 且不超过 80 的小时数。`);
    if(validPhases && !phases.includes(task.phase ?? '')) errors.push(`${where} 阶段 ${task.phase} 不在 phases 中。`);
    if(task.desc!==undefined && typeof task.desc!=='string') errors.push(`${where} desc 必须是文字说明。`);
    if(task.after!==undefined && (!Array.isArray(task.after) || task.after.some(title=>typeof title!=='string' || !title.trim()))) errors.push(`${where} after 必须是前置任务标题列表。`);
    else for(const title of task.after || []) if(!tasks.some(other=>isObject(other) && other.title===title)) errors.push(`${where} 的前置任务「${title}」不存在。`);
  });
  if(errors.length) fail('INVALID_PLAN',`计划文件有 ${errors.length} 处问题：${errors.slice(0,20).join(' ')}`,{details:errors});
  return {...plan,phases,holidays:plan.holidays || [],extraWorkdays:plan.extraWorkdays || [],acceptanceBufferDays:plan.acceptanceBufferDays ?? 1};
}

/**
 * 顺排：阶段顺序 → 文件顺序；busyUntil[owner] 为该负责人已有未完成任务的最晚截止日，
 * 新任务从其下一个工作日开始（respectExistingLoad=false 时忽略）。
 */
export function schedulePlan(input,{busyUntil={},startsAfter={},ownerOf=owner=>owner}={}) {
  const plan=validatePlan(input),calendar=workCalendar(plan.startDate,plan);
  const checkDay=day=>{if(day<0 || day>=calendar.length) fail('INVALID_PLAN','排期超出 500 个工作日的日历范围，请检查已有负载、工时、产能或验收缓冲。');};
  const capacityOf=day=>{checkDay(day);return (plan.capacityOverrides || []).find(item=>calendar[day]>=item.from && calendar[day]<=item.until)?.hours ?? plan.capacityHours;};
  const cursors=new Map(),placed=new Map(),tasks=[];
  const ordered=plan.tasks.map((task,index)=>({...task,index})).sort((a,b)=>plan.phases.indexOf(a.phase ?? '')-plan.phases.indexOf(b.phase ?? '') || a.index-b.index);
  for(const task of ordered) {
    const owner=ownerOf(task.owner);
    if(typeof owner!=='string' || !owner.trim()) fail('INVALID_PLAN',`无法解析负责人「${task.owner}」。`);
    if(!cursors.has(owner)) {
      const busy=plan.respectExistingLoad===false?null:(Object.hasOwn(busyUntil,owner)?busyUntil[owner]:null);
      if(busy && !isDate(busy)) fail('INVALID_PLAN',`负责人「${task.owner}」的已有任务截止日期无效。`);
      const first=busy?calendar.findIndex(day=>day>busy):0;
      checkDay(first);cursors.set(owner,{day:first,used:0});
    }
    let {day,used}=cursors.get(owner);
    if(Object.hasOwn(startsAfter,task.title)) {
      if(!isDate(startsAfter[task.title])) fail('INVALID_PLAN',`「${task.title}」的已有前置任务日期无效。`);
      const next=calendar.findIndex(date=>date>startsAfter[task.title]);checkDay(next);
      if(day<next){day=next;used=0;}
    }
    for(const title of task.after || []) {
      const dependency=placed.get(title);if(!dependency) fail('INVALID_PLAN',`「${task.title}」的前置任务「${title}」必须排在它前面（调整阶段或顺序）。`);
      const next=calendar.indexOf(dependency.dueDate)+1;if(day<next){day=next;used=0;}
    }
    if(used>=capacityOf(day)){day++;used=0;}
    const start=day;let remaining=task.hours;
    while(remaining>1e-9){const take=Math.min(capacityOf(day)-used,remaining);remaining-=take;used+=take;if(remaining>1e-9){day++;used=0;}}
    checkDay(day);
    cursors.set(owner,{day,used});
    const item={...task,owner,startDate:calendar[start],dueDate:calendar[day]};
    placed.set(task.title,item);tasks.push(item);
  }
  const addWorkdays=(date,count)=>{const day=calendar.indexOf(date)+count;checkDay(day);return calendar[day];};
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
  const ownerLoad=new Map();
  for(const item of tasks){const entry=ownerLoad.get(item.owner) || {hours:0,tasks:0,from:item.startDate,until:item.dueDate};entry.hours+=item.hours;entry.tasks++;if(item.startDate<entry.from)entry.from=item.startDate;if(item.dueDate>entry.until)entry.until=item.dueDate;ownerLoad.set(item.owner,entry);}
  const load=Object.fromEntries(ownerLoad);
  const phaseEnds=Object.fromEntries(plan.phases.map(phase=>[phase,tasks.filter(item=>(item.phase ?? '')===phase).map(item=>item.dueDate).sort().at(-1) || null]));
  return {tasks,requirements,load,phaseEnds,granularity:{averageHours:Math.round(tasks.reduce((sum,item)=>sum+item.hours,0)/tasks.length*10)/10,under8:tasks.filter(item=>item.hours<8).length,over24:tasks.filter(item=>item.hours>24).map(item=>item.title)}};
}
