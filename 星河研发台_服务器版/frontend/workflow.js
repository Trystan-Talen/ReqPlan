// Shared, side-effect-free workflow rules used by the browser and the server.
export const REQUIREMENT_STATUSES = Object.freeze(['未确定', '待评审', '已确定', '待排期', '已排期', '开发中', '测试中', '已完成', '已终止']);
export const TASK_STATUSES = Object.freeze(['wait', 'develop', 'test', 'done', 'terminated', '待开始', '开发中', '测试中', '已完成', '已终止']);
export const taskStage = status => ({ '待开始': 'wait', '开发中': 'develop', '测试中': 'test', '已完成': 'done', '已终止': 'terminated' }[status] || status);

// Project roles. The system administrator acts as the pseudo role 'admin' in every
// project and passes every role check; managers ('executive') only ever read.
export const PROJECT_ROLES = Object.freeze(['product', 'lead', 'developer', 'tester', 'viewer']);
export const ROLE_LABELS = Object.freeze({ product: '产品经理', lead: '主开发', developer: '开发', tester: '测试', viewer: '观察者' });
export const OWNER_ROLES = Object.freeze(['product', 'lead']);
// Everyone who works on a project may test: accept or send back tasks and requirements under test.
export const REVIEW_ROLES = Object.freeze(['product', 'lead', 'developer', 'tester']);
export const REQUIREMENT_REVIEW_ROLES = Object.freeze(['product', 'lead', 'tester']);
export const DELIVERY_REQUIREMENT_STATUSES = Object.freeze(REQUIREMENT_STATUSES.filter(status => !['未确定', '待评审'].includes(status)));
const PERMISSIONS = Object.freeze({
  editRequirement: ['product'],        // create, edit content, archive, upload documents
  planRequirement: ['product', 'lead'], // plan dates, batch reschedule
  assignTasks: ['lead'],                // choose the lead developer, split, assign and terminate tasks
  deleteTask: [],                      // only the system administrator may delete/restore tasks
  createOwnTask: ['lead', 'developer'], // add a task owned by oneself under a requirement one takes part in
  reviewTask: REVIEW_ROLES,             // confirm or reopen finished tasks
  reviewRequirement: REQUIREMENT_REVIEW_ROLES, // final requirement acceptance is separate from task testing
  uploadDocument: ['product', 'lead'],
});
export function roleCan(role, permission) { return role === 'admin' || (PERMISSIONS[permission] || []).includes(role); }
// Fields a lead developer may change on a requirement; the content itself belongs to the product manager.
export const LEAD_REQUIREMENT_FIELDS = Object.freeze(['status', 'reason', 'force', 'assigneeId', 'collaboratorIds', 'planStart', 'planEnd', 'estimatePoints', 'dependencyIds']);

const REQUIREMENT_RULES = Object.freeze({
  '未确定>待评审': ['product'], '待评审>未确定': ['product'], '待评审>已确定': ['product'], '已确定>待评审': ['product'],
  '已确定>待排期': ['lead'], '已确定>已排期': ['product', 'lead'], '待排期>已排期': ['product', 'lead'], '待排期>已确定': ['product', 'lead'], '待排期>待评审': ['product'],
  '已排期>已确定': ['product', 'lead'], '已排期>开发中': ['lead', 'developer'], '开发中>已排期': ['lead'], '开发中>测试中': ['lead', 'developer'],
  '测试中>开发中': REVIEW_ROLES, '测试中>已完成': REVIEW_ROLES, '已完成>开发中': REVIEW_ROLES, '已终止>未确定': ['product'],
});
const REQUIREMENT_REASON = new Set(['测试中>开发中', '已完成>开发中']);
const TASK_RULES = Object.freeze({
  'wait>develop': ['lead', 'developer'], 'develop>wait': ['lead', 'developer'], 'develop>test': ['lead', 'developer'],
  'test>develop': REVIEW_ROLES, 'test>done': REVIEW_ROLES, 'done>develop': REVIEW_ROLES,
  'wait>terminated': ['lead'], 'develop>terminated': ['lead'], 'test>terminated': ['lead'], 'terminated>wait': ['lead'],
});
const WRITERS = ['admin', 'product', 'lead', 'developer', 'tester'];
const allows = (roles, role) => role === 'admin' || roles.includes(role);
const accepted = () => ({ ok: true });
const rejected = (status, message, code = 'VALIDATION_ERROR') => ({ ok: false, status, message, code });
const hasText = value => typeof value === 'string' && value.trim().length > 0;
const ROLE_NAMES = roles => roles.map(role => ROLE_LABELS[role]).join('或');

export function checkRequirementTransition(role, previous, next, { tasks = [], reason = '', dependencies = [] } = {}) {
  if (!WRITERS.includes(role)) return rejected(403, '当前项目角色无权执行此操作', 'FORBIDDEN');
  if (previous.status === next.status) return accepted();
  const key = `${previous.status}>${next.status}`;
  if (DELIVERY_REQUIREMENT_STATUSES.includes(previous.status)) {
    const finalReview = ['测试中>已完成', '测试中>开发中', '已完成>开发中'].includes(key);
    if (next.status === '已终止') {
      if (!allows(['product'], role)) return rejected(403, '终止需求需要产品经理', 'FORBIDDEN');
      return hasText(reason) ? accepted() : rejected(400, '终止需求必须说明原因');
    }
    if (key === '已终止>已确定') {
      if (!allows(['product', 'lead'], role)) return rejected(403, '重启需求需要产品经理或主开发', 'FORBIDDEN');
      return hasText(reason) ? accepted() : rejected(400, '重新打开需求必须说明原因');
    }
    if (!finalReview) return rejected(409, '研发阶段由计划和任务自动同步，请维护研发计划或推进任务', 'AUTOMATIC_WORKFLOW');
    if (!allows(REQUIREMENT_REVIEW_ROLES, role)) return rejected(403, '需求验收或退回需要产品经理、主开发或测试', 'FORBIDDEN');
    if (next.status === '开发中') return hasText(reason) ? accepted() : rejected(400, '退回或重新打开需求必须说明原因');
    const delivery = requirementDeliveryState(next, tasks, dependencies);
    if (!delivery.readyForAcceptance) return rejected(409, delivery.acceptanceGates.join('；'), 'TRANSITION_GATE');
    return accepted();
  }
  if (next.status === '已终止') { if (!allows(['product'], role)) return rejected(403, '终止需求需要产品经理', 'FORBIDDEN'); }
  else if (!REQUIREMENT_RULES[key]) return rejected(409, '不能跳过需求流程，请按当前阶段流转', 'STATE_TRANSITION');
  else if (!allows(REQUIREMENT_RULES[key], role)) return rejected(403, `此流转需要${ROLE_NAMES(REQUIREMENT_RULES[key])}`, 'FORBIDDEN');
  if ((next.status === '已终止' || REQUIREMENT_REASON.has(key)) && !hasText(reason)) return rejected(400, next.status === '已终止' ? '终止需求必须说明原因' : '退回开发必须说明原因');
  if (next.status === '待评审' && !hasText(next.description)) return rejected(400, '提交评审前请填写背景与目标', 'TRANSITION_GATE');
  if (['已确定', '已排期', '测试中', '已完成'].includes(next.status) && !hasText(next.acceptance)) return rejected(400, '进入此阶段前请填写验收标准', 'TRANSITION_GATE');
  const activeTasks = tasks.filter(task => !task.archived), liveTasks = activeTasks.filter(task => taskStage(task.status) !== 'terminated');
  if (['待排期', '已排期'].includes(next.status) && (!next.assigneeId || !liveTasks.length || liveTasks.some(task => !task.ownerId || !(Number(task.estimateHours) > 0)))) return rejected(400, '拆分完成前必须指定主责开发，并为每个任务填写负责人和预估工时', 'TRANSITION_GATE');
  if (next.status === '已排期' && (!next.planStart || !next.planEnd)) return rejected(400, '排期前必须填写计划起止日期', 'TRANSITION_GATE');
  if (next.status === '开发中' && (!next.assigneeId || !next.planStart || !next.planEnd || !activeTasks.length)) return rejected(400, '开工前必须指派主责开发、填写计划起止日期并拆分任务', 'TRANSITION_GATE');
  if (next.status === '开发中') {
    const byId = new Map(dependencies.filter(Boolean).map(requirement => [requirement.id, requirement]));
    if ((next.dependencyIds || []).some(id => { const dependency = byId.get(id); return !dependency || dependency.archived || dependency.status !== '已完成'; })) return rejected(409, '前置需求尚未完成，不能开始开发', 'DEPENDENCY_GATE');
  }
  if (key === '开发中>测试中' && (!liveTasks.length || liveTasks.some(task => !['test', 'done'].includes(taskStage(task.status))))) return rejected(409, '所有未终止任务提测后，需求才能进入测试', 'TRANSITION_GATE');
  if (next.status === '已完成' && (!activeTasks.length || activeTasks.some(task => !['done', 'terminated'].includes(taskStage(task.status))))) return rejected(409, '关联任务尚未全部完成，不能完成需求', 'TRANSITION_GATE');
  return accepted();
}

export function availableRequirementActions(role, requirement, { tasks = [], dependencies = [] } = {}) {
  if (!WRITERS.includes(role) || requirement.archived) return [];
  const targets = DELIVERY_REQUIREMENT_STATUSES.includes(requirement.status)
    ? [...(requirement.status === '测试中' ? ['开发中', '已完成'] : requirement.status === '已完成' ? ['开发中'] : requirement.status === '已终止' ? ['已确定'] : []), ...(requirement.status === '已终止' ? [] : ['已终止'])]
    : [...Object.keys(REQUIREMENT_RULES).filter(key => key.startsWith(requirement.status + '>')).map(key => key.split('>')[1]), ...(requirement.status === '已终止' ? [] : ['已终止'])];
  return targets.map(status => {
    const check = checkRequirementTransition(role, requirement, { ...requirement, status }, { tasks, dependencies, reason: '待填写' });
    return { status, label: status, allowed: check.ok, message: check.message || '', code: check.code || '', requiresReason: status === '已终止' || REQUIREMENT_REASON.has(`${requirement.status}>${status}`) || requirement.status === '已终止' };
  }).filter(item => item.code !== 'FORBIDDEN');
}

// Confirmed requirements follow their tasks. The commitment dates remain owned by
// the requirement; development dates below are a separate projection of its tasks.
export function requirementDeliveryState(requirement, tasks = [], dependencies = []) {
  const liveTasks = tasks.filter(task => !task.archived && (!task.requirementId || task.requirementId === requirement.id) && taskStage(task.status) !== 'terminated');
  const counts = { wait: 0, develop: 0, test: 0, done: 0, total: liveTasks.length };
  for (const task of liveTasks) if (Object.hasOwn(counts, taskStage(task.status))) counts[taskStage(task.status)] += 1;
  const planGates = [];
  if (!requirement.assigneeId) planGates.push('请指定主责开发');
  if (!liveTasks.length) planGates.push('没有有效交付任务，请补充任务或终止需求');
  if (liveTasks.some(task => !task.ownerId || !(Number(task.estimateHours) > 0))) planGates.push('每个有效任务都需要负责人和大于零的预估工时');
  if (!hasText(requirement.acceptance)) planGates.push('请填写需求验收标准');
  const scheduledCount = liveTasks.filter(task => validDate(task.startDate) && validDate(task.dueDate) && task.startDate <= task.dueDate).length;
  const unscheduledCount = liveTasks.length - scheduledCount;
  const datedTasks = liveTasks.map(task => { const start = validDate(task.startDate), end = validDate(task.dueDate); return start && end && start > end ? { start: '', end: '' } : { start, end }; });
  const starts = datedTasks.map(task => task.start).filter(Boolean).sort();
  const ends = datedTasks.map(task => task.end).filter(Boolean).sort();
  const developmentStart = starts[0] || '', developmentEnd = ends.at(-1) || '';
  const commitmentEnd = validDate(requirement.planEnd);
  const delayDays = developmentEnd && commitmentEnd ? Math.max(0, Math.round((Date.parse(`${developmentEnd}T00:00:00Z`) - Date.parse(`${commitmentEnd}T00:00:00Z`)) / 86400000)) : null;
  const planReady = !planGates.length, scheduleReady = Boolean(liveTasks.length && !unscheduledCount);
  const hasStarted = Boolean(requirement.deliveryStartedAt || ['开发中', '测试中', '已完成'].includes(requirement.status) || counts.develop || counts.test || counts.done);
  const byId = new Map(dependencies.filter(Boolean).map(item => [item.id, item]));
  const pendingDependencies = (requirement.dependencyIds || []).filter(id => { const item = byId.get(id); return !item || item.archived || item.status !== '已完成'; });
  const startGates = hasStarted ? [] : [...planGates];
  if (!hasStarted && !scheduleReady) startGates.push('请为所有有效任务填写完整的计划起止日期');
  if (pendingDependencies.length) startGates.push('前置需求尚未完成');
  const acceptanceGates = [];
  if (!liveTasks.length) acceptanceGates.push('没有有效交付任务，不能完成需求');
  else if (counts.done !== counts.total) acceptanceGates.push('所有有效任务完成后才能验收需求');
  if (!hasText(requirement.acceptance)) acceptanceGates.push('请填写需求验收标准');
  if (requirement.workflowHold) acceptanceGates.push('需求已重新打开，请安排返工任务');
  const readyForAcceptance = !acceptanceGates.length;
  const gates = [...planGates];
  if (!scheduleReady) gates.push('请为所有有效任务填写完整的计划起止日期');
  if (pendingDependencies.length) gates.push('前置需求尚未完成');
  if (requirement.workflowHold) gates.push('需求已重新打开，请安排返工任务');
  let status = requirement.status;
  const enabled = DELIVERY_REQUIREMENT_STATUSES.includes(status);
  // Historical rows keep their displayed state until the first relevant write
  // adopts automatic delivery. Reads never silently rewrite their history.
  if (enabled && requirement.deliveryWorkflow === true && !requirement.archived && !['已完成', '已终止'].includes(status)) {
    if (hasStarted) status = liveTasks.length && counts.test + counts.done === counts.total && hasText(requirement.acceptance) && !requirement.workflowHold ? '测试中' : '开发中';
    else status = !planReady ? '已确定' : scheduleReady ? '已排期' : '待排期';
  }
  return { status, enabled, planSubmitted: Boolean(requirement.planSubmitted), planReady, scheduleReady, hasStarted, developmentStart, developmentEnd, scheduledCount, unscheduledCount, delayDays, startAllowed: !startGates.length, readyForAcceptance, gates, planGates, startGates, acceptanceGates, pendingDependencies, liveTasks, counts };
}

// ownTask: the actor owns the task. Only the lead developer may confirm their own work (pure technical tasks).
export function checkTaskTransition(role, previousStatus, nextStatus, { reason = '', dependencies = [], ownTask = false } = {}) {
  if (!WRITERS.includes(role)) return rejected(403, '当前项目角色无权执行此操作', 'FORBIDDEN');
  const previous = taskStage(previousStatus), next = taskStage(nextStatus);
  if (previous === next) return accepted();
  const roles = TASK_RULES[`${previous}>${next}`];
  if (!roles) return rejected(409, '不能跳过任务流程', 'STATE_TRANSITION');
  if (next === 'done' && !allows(roles, role)) return rejected(403, '验收任务需要项目成员（观察者只读）', 'FORBIDDEN');
  if (next === 'done' && ownTask && !['lead', 'admin'].includes(role)) return rejected(403, '不能验收自己负责的任务，请其他成员验收', 'FORBIDDEN');
  if (next === 'terminated' && (!allows(roles, role) || !hasText(reason))) return rejected(403, '终止任务需要主开发并填写原因', 'FORBIDDEN');
  if (!allows(roles, role)) return rejected(403, `此流转需要${ROLE_NAMES(roles)}`, 'FORBIDDEN');
  if (next === 'develop' && dependencies.some(task => !task || task.archived || taskStage(task.status) !== 'done')) return rejected(409, '前置任务尚未完成，不能开始开发', 'DEPENDENCY_GATE');
  return accepted();
}

export function availableTaskStatuses(role, currentStatus, { dependencies = [], ownTask = false } = {}) {
  const current = taskStage(currentStatus || 'wait');
  const targets = Object.keys(TASK_RULES).filter(key => key.startsWith(current + '>')).map(key => key.split('>')[1]);
  return [current, ...targets.filter(status => checkTaskTransition(role, current, status, { reason: '待填写', dependencies, ownTask }).ok)];
}

export function taskGranularity(hours) {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 100000) return { valid: false, warnings: ['任务估算工时必须为大于 0 且不超过 100000 的数字'] };
  return { valid: true, warnings: hours < 4 ? ['任务少于 4 小时，建议检查是否可以合并；仍可提交。'] : hours > 24 ? ['任务超过 24 小时，建议继续拆分；仍可提交。'] : [] };
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') return '';
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === value ? value : '';
}

export function normalizeBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) return null;
  const planStart = validDate(baseline.planStart) || validDate(baseline.startDate);
  const planEnd = validDate(baseline.planEnd) || validDate(baseline.dueDate);
  if (!planStart && !planEnd) return null;
  return { planStart, planEnd, capturedAt: typeof baseline.capturedAt === 'string' ? baseline.capturedAt : '' };
}

export function getScheduleComparison(requirement) {
  const baseline = normalizeBaseline(requirement.baseline);
  const current = { planStart: validDate(requirement.planStart), planEnd: validDate(requirement.planEnd) };
  const delta = (value, original) => value && original ? Math.round((Date.parse(`${value}T00:00:00Z`) - Date.parse(`${original}T00:00:00Z`)) / 86400000) : null;
  return { baseline, current, changed: Boolean(baseline && (baseline.planStart !== current.planStart || baseline.planEnd !== current.planEnd)), startDeltaDays: baseline ? delta(current.planStart, baseline.planStart) : null, endDeltaDays: baseline ? delta(current.planEnd, baseline.planEnd) : null, rescheduleCount: Number.isSafeInteger(requirement.rescheduleCount) && requirement.rescheduleCount >= 0 ? requirement.rescheduleCount : 0 };
}
