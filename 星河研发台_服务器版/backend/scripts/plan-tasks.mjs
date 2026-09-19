#!/usr/bin/env node
// 按计划文件为需求批量创建研发任务并排期。默认只预检（输出排期与负载），--apply 才写入；
// 写入前自动备份，已有任务的需求整条跳过，不会重复创建，也不改动需求内容。
// --replace：用新计划替换「尚未开工」的旧任务（全部为待开始且从未修改），旧任务归档保留；
// 旧计划从未执行，因此需求基线同时重置为新计划。只要有一个任务动过，整条需求保持不变。
//   npm run plan:tasks -- [--plan 计划文件] [--db 数据库] [--apply] [--replace] [--actor 用户名]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { backupDatabase } from './backup.mjs';
import { taskStage } from '../../frontend/workflow.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PHASES = ['N0', 'S', 'N1', 'N2', 'N3', 'N4', 'N3cut'];
const DAY = 86_400_000;
const toDay = value => Date.parse(value + 'T00:00:00Z') / DAY;
const toText = day => new Date(day * DAY).toISOString().slice(0, 10);

/** 工作日日历：跳过周六日与节假日。 */
export function workCalendar(startDate, holidays = []) {
  const skip = new Set(holidays), days = [];
  for (let day = toDay(startDate); days.length < 400; day++) { const weekday = new Date(day * DAY).getUTCDay(); if (weekday !== 0 && weekday !== 6 && !skip.has(toText(day))) days.push(toText(day)); }
  return days;
}

/**
 * 顺序排期：按阶段（N0 → 10/9 冲刺 → N1 …）和文件顺序，把任务依次放进负责人的日历，
 * 每人每天最多 capacityHours 小时；after 中列出的任务完成后的下一个工作日才能开始。
 */
export function schedulePlan(plan) {
  const calendar = workCalendar(plan.startDate, plan.holidays);
  // capacityOverrides: [{ from, until, hours }] — e.g. a sprint with planned overtime.
  const capacityOf = day => (plan.capacityOverrides || []).find(item => calendar[day] >= item.from && calendar[day] <= item.until)?.hours ?? plan.capacityHours;
  const cursors = new Map(), placed = new Map(), result = [];
  const ordered = plan.tasks.map((task, index) => ({ ...task, index })).sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase) || a.index - b.index);
  for (const task of ordered) {
    if (!PHASES.includes(task.phase)) throw new Error(`未知阶段 ${task.phase}：${task.title}`);
    if (!(task.hours > 0)) throw new Error(`工时无效：${task.title}`);
    const owner = plan.owners[task.owner] || task.owner;
    let { day, used } = cursors.get(owner) || { day: 0, used: 0 };
    for (const title of task.after || []) {
      const dependency = placed.get(title); if (!dependency) throw new Error(`「${task.title}」的前置任务「${title}」必须排在它前面`);
      const next = calendar.indexOf(dependency.dueDate) + 1; if (day < next) { day = next; used = 0; }
    }
    if (used >= capacityOf(day)) { day++; used = 0; }
    const start = day; let remaining = task.hours;
    while (remaining > 1e-9) { const take = Math.min(capacityOf(day) - used, remaining); remaining -= take; used += take; if (remaining > 1e-9) { day++; used = 0; } }
    if (day >= calendar.length) throw new Error('排期超出日历范围');
    cursors.set(owner, { day, used });
    const item = { ...task, owner, startDate: calendar[start], dueDate: calendar[day] };
    placed.set(task.title, item); result.push(item);
  }
  const addWorkdays = (date, count) => calendar[Math.min(calendar.length - 1, calendar.indexOf(date) + count)];
  const requirements = new Map();
  for (const item of result) {
    const entry = requirements.get(item.req) || { id: item.req, tasks: [], hours: new Map() };
    entry.tasks.push(item); entry.hours.set(item.owner, (entry.hours.get(item.owner) || 0) + item.hours); requirements.set(item.req, entry);
  }
  for (const entry of requirements.values()) {
    entry.planStart = entry.tasks.map(item => item.startDate).sort()[0];
    entry.planEnd = addWorkdays(entry.tasks.map(item => item.dueDate).sort().at(-1), plan.acceptanceBufferDays || 0);
    const owners = [...entry.hours].sort((a, b) => b[1] - a[1]);
    entry.assignee = owners[0][0]; entry.collaborators = owners.slice(1).map(([owner]) => owner);
    entry.tasks.sort((a, b) => a.startDate.localeCompare(b.startDate) || a.index - b.index);
  }
  const load = new Map();
  for (const item of result) { const entry = load.get(item.owner) || { hours: 0, last: '' }; entry.hours += item.hours; if (item.dueDate > entry.last) entry.last = item.dueDate; load.set(item.owner, entry); }
  return { tasks: result, requirements: [...requirements.values()], load };
}

function argument(name, fallback) { const index = process.argv.indexOf(name); return index > 0 ? process.argv[index + 1] : fallback; }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const planFile = path.resolve(argument('--plan', path.join(HERE, '..', 'migrations', 'task-plan-2026-09-18.json')));
    const databasePath = path.resolve(argument('--db', process.env.DATABASE_PATH || path.join(HERE, '..', 'var', 'xinghe.sqlite')));
    const apply = process.argv.includes('--apply'), replace = process.argv.includes('--replace');
    const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    const schedule = schedulePlan(plan);
    const db = openDatabase(databasePath);
    try {
      const business = createBusiness(db);
      const actorName = argument('--actor', 'admin');
      const actor = db.prepare("SELECT id FROM users WHERE username=? AND status='active'").get(actorName);
      if (!actor) throw new Error(`执行账号 ${actorName} 不存在或未启用。`);
      const userIds = new Map(db.prepare('SELECT id,username FROM users').all().map(row => [row.username, row.id]));
      const names = new Map(db.prepare('SELECT id,name FROM users').all().map(row => [row.id, row.name]));
      const projects = new Map(db.prepare('SELECT id,data FROM projects').all().map(row => [row.id, JSON.parse(row.data)]));
      const lines = [], skipped = [], late = [];
      for (const entry of schedule.requirements) {
        const row = db.prepare('SELECT project_id,data,version FROM requirements WHERE id=? AND archived=0').get(entry.id);
        if (!row) throw new Error(`需求 ${entry.id} 不存在或已归档。`);
        for (const owner of [entry.assignee, ...entry.collaborators]) if (!userIds.has(owner)) throw new Error(`负责人 ${owner} 不存在。`);
        const liveTasks = db.prepare('SELECT id,data,version FROM tasks WHERE requirement_id=? AND archived=0').all(entry.id), existing = liveTasks.length;
        entry.oldTasks = liveTasks.map(task => ({ id: task.id, version: task.version, status: JSON.parse(task.data).status }));
        entry.replaceable = existing > 0 && entry.oldTasks.every(task => task.version === 1 && taskStage(task.status) === 'wait');
        const requirement = JSON.parse(row.data), project = projects.get(row.project_id);
        entry.projectId = row.project_id; entry.title = requirement.title;
        if (existing && !(replace && entry.replaceable)) skipped.push(`${entry.id} ${requirement.title}：已有 ${existing} 个任务${replace ? '且已有进展或修改' : ''}，跳过`);
        else if (existing) entry.replacing = true;
        if (project.targetDate && entry.planEnd > project.targetDate) late.push(`${entry.id} ${requirement.title}：计划 ${entry.planEnd}，晚于项目目标 ${project.targetDate}`);
        lines.push(`${entry.id.padEnd(9)} ${entry.planStart} — ${entry.planEnd}  ${String(entry.tasks.length).padStart(2)} 个任务 ${String(entry.tasks.reduce((sum, item) => sum + item.hours, 0)).padStart(3)} 小时  主责 ${entry.assignee}${entry.collaborators.length ? ' · 协作 ' + entry.collaborators.join('、') : ''}  ${requirement.title}`);
      }
      console.info(`计划：${path.basename(planFile)} · 每人每天 ${plan.capacityHours} 小时${(plan.capacityOverrides || []).map(item => `（${item.from} — ${item.until} 按 ${item.hours} 小时）`).join('')} · 从 ${plan.startDate} 起 · ${schedule.tasks.length} 个任务 / ${schedule.requirements.length} 条需求\n`);
      console.info(lines.sort().join('\n'));
      console.info('\n负载：' + [...schedule.load].map(([owner, item]) => `${owner} ${item.hours} 小时，排到 ${item.last}`).join('；'));
      if (late.length) console.info('\n晚于项目目标日期：\n' + late.join('\n'));
      if (skipped.length) console.info('\n跳过：\n' + skipped.join('\n'));
      const replacing = schedule.requirements.filter(entry => entry.replacing);
      if (replacing.length) console.info(`\n将替换 ${replacing.length} 条需求下尚未开工的 ${replacing.reduce((sum, entry) => sum + entry.oldTasks.length, 0)} 个旧任务（归档保留），基线重置为新计划。`);
      if (!apply) console.info('\n以上为预检，没有写入。确认后追加 --apply。');
      else {
      const backup = path.join(path.dirname(databasePath), 'backups', `before-task-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
      await backupDatabase(databasePath, backup);
      console.info(`\n已备份：${backup}`);
      let created = 0, scheduled = 0, archived = 0;
      for (const entry of schedule.requirements) {
        if (entry.replacing) {
          // Re-check right before writing: someone may have started a task since the dry run.
          const now = db.prepare('SELECT id,data,version FROM tasks WHERE requirement_id=? AND archived=0').all(entry.id);
          if (now.some(task => task.version !== 1 || taskStage(JSON.parse(task.data).status) !== 'wait')) { console.info(`${entry.id}：任务刚有变动，跳过`); continue; }
          for (const task of now) business.archiveTask(actor, task.id, { version: task.version, archived: true });
          archived += now.length;
        } else if (db.prepare("SELECT COUNT(*) AS total FROM tasks WHERE requirement_id=? AND archived=0").get(entry.id).total) continue;
        const version = () => db.prepare('SELECT version FROM requirements WHERE id=?').get(entry.id).version;
        business.createTaskBatch(actor, entry.id, { version: version(), requestId: `task-plan-${path.basename(planFile, '.json')}-${entry.id}`, tasks: entry.tasks.map(item => ({ title: item.title, ownerId: userIds.get(item.owner), startDate: item.startDate, dueDate: item.dueDate, estimateHours: item.hours, description: item.desc || '' })) });
        created += entry.tasks.length;
        const current = JSON.parse(db.prepare('SELECT data FROM requirements WHERE id=?').get(entry.id).data);
        const target = projects.get(entry.projectId).targetDate;
        business.updateRequirement(actor, entry.id, { version: version(), assigneeId: userIds.get(entry.assignee), collaboratorIds: entry.collaborators.map(owner => userIds.get(owner)), planStart: entry.planStart, planEnd: entry.planEnd, ...(current.status === '已确定' ? { status: '已排期' } : {}), ...(target && entry.planEnd > target ? { force: true } : {}) });
        if (entry.replacing) {
          const row = db.prepare('SELECT data FROM requirements WHERE id=?').get(entry.id), data = JSON.parse(row.data);
          data.baseline = { planStart: entry.planStart, planEnd: entry.planEnd, capturedAt: new Date().toISOString() }; data.rescheduleCount = 0;
          db.prepare('UPDATE requirements SET data=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(data), new Date().toISOString(), entry.id);
          db.prepare('INSERT INTO audit(user_id,action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?,?)').run(actor.id, 'rebaseline', 'requirement', entry.id, JSON.stringify({ projectId: entry.projectId, reason: `以 ${path.basename(planFile)} 替换尚未开工的任务计划`, baseline: data.baseline }), new Date().toISOString());
        }
        scheduled++;
      }
      console.info(`已创建 ${created} 个任务，排期 ${scheduled} 条需求${archived ? `，归档 ${archived} 个尚未开工的旧任务` : ''}（执行账号 ${names.get(actor.id)}）。`);
      }
    } finally { db.close(); }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
