import {
  DELIVERY_REQUIREMENT_STATUSES, REQUIREMENT_STATUSES, taskStage, requirementDeliveryState,
  roleCan, checkTaskTransition, checkRequirementTransition,
} from './workflow.js';

const DAY = 86400000;
const unfinished = item => !['done', 'terminated'].includes(taskStage(item.status));
const list = value => Array.isArray(value) ? value : [];
const dateValue = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return '';
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? value : '';
};
const stampOf = value => Date.parse(`${value}T00:00:00Z`);
const daysBetween = (start, end) => Math.round((stampOf(end) - stampOf(start)) / DAY);
const groupBy = (items, field) => {
  const result = new Map();
  for (const item of items) {
    if (!result.has(item[field])) result.set(item[field], []);
    result.get(item[field]).push(item);
  }
  return result;
};

// This projection never updates workflow, dates or business records. The server's
// authorized bootstrap remains the only source of entities; /work supplies inbox
// candidates, whose identity and permissions are checked again against that data.
export function buildWorkbench({ data, user, date, work = null }) {
  if (!dateValue(date)) throw new Error('工作台统计日期无效');
  const windowEnd = new Date(Math.min(stampOf(date) + 6 * DAY, stampOf('9999-12-31'))).toISOString().slice(0, 10);
  const sourceProjects = list(data.projects).filter(project => !project.archived);
  const projectIds = new Set(sourceProjects.map(project => project.id));
  const tasks = list(data.tasks).filter(task => projectIds.has(task.projectId) && !task.archived && taskStage(task.status) !== 'terminated');
  const requirements = list(data.requirements).filter(item => projectIds.has(item.projectId) && !item.archived && DELIVERY_REQUIREMENT_STATUSES.includes(item.status));
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const requirementById = new Map(requirements.map(item => [item.id, item]));
  const allRequirements = new Map(list(data.requirements).map(item => [item.id, item]));
  const tasksByProject = groupBy(tasks, 'projectId');
  const tasksByRequirement = groupBy(tasks, 'requirementId');
  const requirementsByProject = groupBy(requirements, 'projectId');
  const linkedTasks = item => (tasksByRequirement.get(item.id) || []).filter(task => task.projectId === item.projectId);
  const dependencies = item => list(item.dependencyIds).map(id => allRequirements.get(id)).filter(other => other?.projectId === item.projectId);
  const deliveryStates = new Map();
  const deliveryOf = item => {
    if (!deliveryStates.has(item.id)) deliveryStates.set(item.id, requirementDeliveryState(item, linkedTasks(item), dependencies(item)));
    return deliveryStates.get(item.id);
  };
  const overdue = item => unfinished(item) && Boolean(dateValue(item.dueDate)) && item.dueDate < date;
  const dueSoon = item => unfinished(item) && Boolean(dateValue(item.dueDate)) && item.dueDate >= date && item.dueDate <= windowEnd;

  const projects = sourceProjects.map(project => {
    const projectRequirements = requirementsByProject.get(project.id) || [];
    const projectTasks = tasksByProject.get(project.id) || [];
    const openRequirements = projectRequirements.filter(unfinished);
    const pendingTasks = projectTasks.filter(unfinished);
    const counts = { wait: 0, develop: 0, test: 0, done: 0 };
    for (const task of projectTasks) if (Object.hasOwn(counts, taskStage(task.status))) counts[taskStage(task.status)]++;
    const stageCounts = Object.fromEntries(REQUIREMENT_STATUSES.map(status => [status, 0]));
    for (const item of projectRequirements) stageCounts[deliveryOf(item).status]++;
    const targetPastDays = dateValue(project.targetDate) && project.targetDate < date && (openRequirements.length || pendingTasks.length)
      ? daysBetween(project.targetDate, date) : 0;
    const preparation = openRequirements.flatMap(requirement => {
      const state = deliveryOf(requirement);
      return state.planReady && state.scheduleReady ? [] : [{ requirement, state }];
    });
    const commitmentOverdue = openRequirements.filter(item => dateValue(item.planEnd) && item.planEnd < date);
    const planConflicts = openRequirements.filter(item => {
      const state = deliveryOf(item), target = dateValue(project.targetDate);
      return state.delayDays > 0 || Boolean(target && ((dateValue(item.planEnd) && item.planEnd > target)
        || (state.developmentEnd && state.developmentEnd > target)));
    });
    const nextMilestone = list(project.milestones).filter(item => dateValue(item.date) && item.date >= date)
      .slice().sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    return {
      project, requirements: projectRequirements, tasks: projectTasks,
      completedTasks: counts.done, totalTasks: projectTasks.length, waitingTasks: counts.wait, developTasks: counts.develop, testTasks: counts.test,
      stageCounts, targetPastDays, overdueTasks: pendingTasks.filter(overdue), dueSoonTasks: pendingTasks.filter(dueSoon),
      unassignedTasks: pendingTasks.filter(task => !task.ownerId), preparation, commitmentOverdue, planConflicts, nextMilestone,
    };
  });
  const hasIssues = item => Boolean(item.overdueTasks.length || item.unassignedTasks.length || item.preparation.length || item.commitmentOverdue.length || item.planConflicts.length);
  const projectRank = item => item.targetPastDays ? 0 : item.nextMilestone?.date === date ? 1 : hasIssues(item) ? 2
    : (item.dueSoonTasks.length || (item.nextMilestone && item.nextMilestone.date <= windowEnd)) ? 3 : 4;
  // A stable priority sort preserves the original directory order within a tier.
  projects.sort((a, b) => projectRank(a) - projectRank(b));

  const memberships = list(data.memberships).filter(item => item.userId === user.id && projectIds.has(item.projectId));
  const roles = new Map(memberships.map(item => [item.projectId, item.role]));
  const roleForOwnTask = projectId => user.role === 'admin' ? 'admin' : roles.get(projectId) || '';
  const taskParentOpen = task => {
    if (!task.requirementId) return true;
    const parent = allRequirements.get(task.requirementId);
    return Boolean(parent && parent.projectId === task.projectId && !parent.archived && unfinished(parent));
  };
  let todos = null;
  if (work?.date === date && work.personal && ['tasks', 'splits', 'reviews'].every(key => Array.isArray(work.personal[key]))) {
    const items = new Map();
    const kindOrder = { planning: 0, review: 1, task: 2 };
    const add = (entity, entityType, kind, reasons, itemDate, openTasks = false) => {
      const key = `${entityType}:${entity.id}`;
      const item = items.get(key) || { entityType, entityId: entity.id, projectId: entity.projectId, title: entity.title,
        date: dateValue(itemDate), reasons: [], kind, openTasks };
      item.reasons = [...new Set([...item.reasons, ...reasons])];
      if (kindOrder[kind] < kindOrder[item.kind]) item.kind = kind;
      item.openTasks ||= openTasks;
      items.set(key, item);
    };
    const taskReasons = task => {
      const reasons = [];
      if (overdue(task)) reasons.push(`任务已逾期 ${daysBetween(task.dueDate, date)} 天`);
      else if (dueSoon(task)) reasons.push(task.dueDate === date ? '任务今天截止' : `任务将在 ${task.dueDate} 截止`);
      const blocked = list(task.dependencyIds).filter(id => {
        const dependency = taskById.get(id);
        return !dependency || dependency.projectId !== task.projectId || taskStage(dependency.status) !== 'done';
      });
      if (blocked.length) reasons.push(`${blocked.length} 个前置任务尚未完成`);
      const parent = allRequirements.get(task.requirementId);
      if (parent?.projectId === task.projectId && deliveryOf(parent).pendingDependencies.length) reasons.push('前置需求尚未完成');
      return reasons;
    };
    for (const candidate of work.personal.tasks) {
      const task = taskById.get(candidate.id);
      if (!task || task.ownerId !== user.id || !unfinished(task) || !taskParentOpen(task)) continue;
      const role = roleForOwnTask(task.projectId), stage = taskStage(task.status);
      if (stage === 'test') {
        if (!roleCan(role, 'reviewTask') || !checkTaskTransition(role, task.status, 'done', { ownTask: true }).ok) continue;
        add(task, 'task', 'review', [...taskReasons(task), '任务待我验收'], task.dueDate);
      } else if (['wait', 'develop'].includes(stage) && roleCan(role, 'createOwnTask')) {
        add(task, 'task', 'task', [...taskReasons(task), stage === 'wait' ? '我的待开始任务' : '我的开发中任务'], task.dueDate);
      }
    }
    for (const candidate of work.personal.splits) {
      const item = requirementById.get(candidate.id), role = item && roles.get(item.projectId);
      if (!item || !unfinished(item) || role !== 'lead' || !roleCan(role, 'assignTasks')) continue;
      const state = deliveryOf(item);
      if (state.planReady && state.scheduleReady) continue;
      const reasons = state.planReady ? [`${state.unscheduledCount} 个任务的计划起止日期待完善`] : [...state.planGates];
      if (state.pendingDependencies.length) reasons.push('前置需求尚未完成');
      add(item, 'requirement', 'planning', reasons, item.planEnd, true);
    }
    for (const candidate of work.personal.reviews) {
      const task = taskById.get(candidate.id), role = task && roles.get(task.projectId);
      if (!task || taskStage(task.status) !== 'test' || !taskParentOpen(task) || !roleCan(role, 'reviewTask')) continue;
      if (!checkTaskTransition(role, task.status, 'done', { ownTask: task.ownerId === user.id }).ok) continue;
      add(task, 'task', 'review', [...taskReasons(task), '任务待我验收'], task.dueDate);
    }
    for (const candidate of list(work.reminders)) {
      if (candidate.entityType !== 'requirement' || candidate.kind !== 'review') continue;
      const item = requirementById.get(candidate.entityId), role = item && roles.get(item.projectId);
      if (!item || item.status !== '测试中' || !roleCan(role, 'reviewRequirement')) continue;
      if (!checkRequirementTransition(role, item, { ...item, status: '已完成' }, { tasks: linkedTasks(item), dependencies: dependencies(item) }).ok) continue;
      add(item, 'requirement', 'review', ['全部有效任务已完成，待我确认需求验收'], item.planEnd);
    }
    todos = [...items.values()].sort((a, b) => {
      const lateA = a.date && a.date < date ? 1 : 0, lateB = b.date && b.date < date ? 1 : 0;
      return lateB - lateA || kindOrder[a.kind] - kindOrder[b.kind] || (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31');
    });
  }

  let activation = null;
  if (user.role === 'admin') {
    const pendingIds = new Set(list(data.users).filter(item => item.status === 'pending').map(item => item.id));
    const assigned = tasks.filter(task => unfinished(task) && pendingIds.has(task.ownerId));
    activation = { accountCount: new Set(assigned.map(task => task.ownerId)).size, taskCount: assigned.length };
  }
  return {
    date, windowEnd,
    metrics: { projectCount: projects.length, requirementCount: requirements.length, targetPast: projects.filter(item => item.targetPastDays > 0).length,
      overdue: tasks.filter(overdue).length, dueSoon: tasks.filter(dueSoon).length, actionable: todos === null ? null : todos.length },
    projects, todos, activation,
  };
}
