// 需求生命周期定义 —— 唯一权威，服务端与浏览器共用同一份文件。
//
// 设计约定：
//   1. 这里只放「纯函数 + 常量」，不 import 任何 Node 内置模块，浏览器可直接加载。
//   2. 状态机的每一次流转都带角色白名单和前置门禁（gate），UI 只负责展示，判定一律以这里为准。
//   3. 新增状态或流转时，只改这个文件 + styles.css 的 .st-* 配色，其它地方不需要同步。

export const FLOW = ['未确定', '待评审', '已确定', '已排期', '开发中', '测试中', '已完成'];
export const TERMINATED = '已终止';
export const STATUSES = [...FLOW, TERMINATED];
export const ACTIVE_STATUSES = ['开发中', '测试中'];

// 历史数据里出现过的旧状态，统一归一化，避免状态机被脏数据卡住
const ALIAS = { '进行中': '开发中', '规划中': '未确定', '已取消': '已终止' };
export const normalizeStatus = (s) => {
  const v = ALIAS[s] || s;
  return STATUSES.includes(v) ? v : '未确定';
};

export const isActive = (s) => ACTIVE_STATUSES.includes(normalizeStatus(s));

// ── 拆分颗粒度规则（数值口径集中在这里，前端提示与服务端校验不会打架） ──
export const SPLIT = {
  MIN_HOURS: 4,          // < 4h：颗粒度过细，考虑与相邻任务合并
  MAX_HOURS: 24,         // > 24h：颗粒度过粗，必须继续拆
  MIN_PER_DEV_DAY: 8,    // 1 人日 = 8 小时
  MIN_TASK_POINTS: 0.5,
};

// 需求的工作量换算成小时；与拆分出的任务工时对照，用于提示拆分是否配平
export const expectedHours = (estimatePoints) => {
  const p = Number(estimatePoints);
  return Number.isFinite(p) && p > 0 ? p * SPLIT.MIN_PER_DEV_DAY : 0;
};

// 单个任务的工时诊断：只返回提示，不阻断保存（真实研发里存在无法均分的边角任务）
export function taskGranularity(hours) {
  const h = Number(hours) || 0;
  if (h <= 0) return { level: 'error', message: '任务工时必须大于 0 小时' };
  if (h > SPLIT.MAX_HOURS) return { level: 'warn', message: `超过 ${SPLIT.MAX_HOURS}h（${SPLIT.MAX_HOURS / SPLIT.MIN_PER_DEV_DAY} 人日），建议继续拆分` };
  if (h < SPLIT.MIN_HOURS) return { level: 'warn', message: `不足 ${SPLIT.MIN_HOURS}h，颗粒度过细，建议与相邻任务合并` };
  return { level: 'ok', message: `粒度合适（约 ${+(h / SPLIT.MIN_PER_DEV_DAY).toFixed(1)} 人日）` };
}

// 整条需求的拆分配平诊断：任务工时合计 vs 需求故事点折算工时
export function splitBalance(estimatePoints, tasks = []) {
  const sum = tasks.reduce((n, t) => n + (Number(t.estimateHours) || 0), 0);
  const expect = expectedHours(estimatePoints);
  const count = tasks.length;
  if (!expect) return { sum, expect: 0, count, level: 'ok', message: '未填工作量，无法配平校验' };
  const ratio = sum / expect;
  if (!count) return { sum, expect, count, level: 'error', message: '还没有拆分任务，需求无法进入已排期' };
  if (ratio > 1.5) return { sum, expect, count, level: 'warn', message: `拆分合计 ${sum}h，比需求规模 ${expect}h 高 ${Math.round((ratio - 1) * 100)}%，确认是否高估` };
  if (ratio < 0.5) return { sum, expect, count, level: 'warn', message: `拆分合计仅 ${sum}h，比需求规模 ${expect}h 少 ${Math.round((1 - ratio) * 100)}%，可能漏拆` };
  return { sum, expect, count, level: 'ok', message: `拆分合计 ${sum}h，与需求规模 ${expect}h 匹配` };
}

// ── 流转角色白名单 ──
// 参数顺序是 (角色, 角色显示名, 为什么要这个角色)，三处取值全部落到 TRANSITIONS 上：
// allowed 决定谁能点，label 决定按钮上写谁，reason 是给用户看的解释。
const D = (allowed, label, reason) => ({ allowed, label, reason });
const PROPOSER = [D('产品', '产品', '拟定并提交评审'), D('项目管理', '项目管理', '代产品录入或调整')];
const ASSIGNER = [D('项目管理', '项目管理', '决定投入与交付承诺'), D('产品', '产品', '代表需求方排期')];
const EXECUTOR = [D('开发', '开发', '任务干完了自然要流转'), D('测试', '测试', '验证通过放行'), D('项目管理', '项目管理', '代为收尾')];

const gates = {
  description: { ok: (r) => String(r.description || '').trim() !== '', message: '请先补充需求描述与背景，评审才有依据' },
  acceptance: { ok: (r) => String(r.acceptance || '').trim() !== '', message: '请先写清验收标准，否则无法判断做完没有' },
  assignee: { ok: (r) => !!r.assigneeId, message: '请先指派主责开发' },
  scheduled: { ok: (r) => !!r.planStart && !!r.planEnd, message: '请先填写计划开始与计划结束日期' },
  split: { ok: (_r, ctx) => ctx.taskCount > 0, message: '请先把需求拆成研发任务（建议单个任务 4–24 小时）' },
  inWindow: {
    ok: (r, ctx) => {
      if (!ctx.projectTarget) return true;
      return !r.planEnd || r.planEnd <= ctx.projectTarget;
    },
    message: '计划结束晚于项目目标交付日，请调整排期或与项目管理确认',
  },
};

// 每条流转规则：from → to，谁能点、需要过哪些门禁
export const TRANSITIONS = [
  ...PROPOSER.map((d) => ({ from: '未确定', to: '待评审', role: d.allowed, label: d.label, reason: d.reason, gates: [gates.description] })),
  ...PROPOSER.map((d) => ({ from: '待评审', to: '已确定', role: d.allowed, label: d.label, reason: d.reason, gates: [gates.acceptance] })),
  ...ASSIGNER.map((d) => ({ from: '已确定', to: '已排期', role: d.allowed, label: d.label, reason: d.reason, gates: [gates.assignee, gates.scheduled, gates.split] })),
  ...EXECUTOR.map((d) => ({ from: '已排期', to: '开发中', role: d.allowed, label: d.label, reason: d.reason, gates: [gates.assignee, gates.split] })),
  ...EXECUTOR.map((d) => ({ from: '开发中', to: '测试中', role: d.allowed, label: d.label, reason: d.reason, gates: [] })),
  ...EXECUTOR.map((d) => ({ from: '测试中', to: '已完成', role: d.allowed, label: d.label, reason: d.reason, gates: [gates.acceptance] })),
  ...[...ASSIGNER, ...EXECUTOR].map((d) => ({ from: '*', to: TERMINATED, role: d.allowed, label: d.label, reason: '需求阶段性不再交付', gates: [] })),
  { from: '开发中', to: '已排期', role: '项目管理', label: '项目管理', reason: '打回重新排期', gates: [] },
  { from: '测试中', to: '开发中', role: '测试', label: '测试', reason: '验证不通过，打回开发', gates: [] },
  { from: '待评审', to: '未确定', role: '产品', label: '产品', reason: '评审不通过，退回收集箱', gates: [] },
  { from: TERMINATED, to: '未确定', role: '项目管理', label: '项目管理', reason: '重启已终止的需求', gates: [] },
];

// 把当前状态能走的动作折叠成「动作 → 可用角色」，便于一次性渲染出全部按钮
export function actionsFrom(status, role) {
  const cur = normalizeStatus(status);
  const out = new Map();
  for (const t of TRANSITIONS) {
    if (t.to === TERMINATED) continue; // 终止单独处理，避免抢占主流程按钮
    if (t.from !== '*' && t.from !== cur) continue;
    if (!out.has(t.to)) out.set(t.to, { to: t.to, roles: [] });
    const entry = out.get(t.to);
    if (!entry.roles.some((x) => x.role === t.role)) entry.roles.push({ role: t.role, label: t.label, reason: t.reason });
  }
  return [...out.values()].map((a) => ({ ...a, allowed: !role || a.roles.some((x) => x.role === role) }));
}

export const isTerminable = (status) => {
  const cur = normalizeStatus(status);
  return cur !== TERMINATED && cur !== '已完成';
};

// ── 服务端校验入口：返回 { ok, error?, to?, gates? } ──
// ctx: { role, taskCount, projectTarget }
export function checkTransition(req = {}, to, ctx = {}) {
  const cur = normalizeStatus(req.status);
  const want = normalizeStatus(to);
  if (cur === want) return { ok: false, error: `需求已经处于「${want}」` };
  const rules = TRANSITIONS.filter((t) => t.to === want && (t.from === '*' || t.from === cur));
  if (!rules.length) return { ok: false, error: `不允许从「${cur}」直接流转到「${want}」` };
  const forRole = rules.filter((t) => t.role === ctx.role);
  if (!forRole.length) {
    const who = [...new Set(rules.map((t) => t.label))].join(' / ');
    return { ok: false, error: `「${ctx.role || '当前角色'}」不能执行该流转，需要：${who}` };
  }
  const failed = [];
  for (const gate of forRole[0].gates) if (!gate.ok(req, ctx)) failed.push(gate.message);
  if (failed.length) return { ok: false, error: failed[0], gates: failed };
  return { ok: true, from: cur, to: want };
}

// 派生「当前可执行的动作」给前端渲染按钮用（与 checkTransition 同一套规则，不会出现按钮能点但接口拒绝）
export function availableActions(req = {}, ctx = {}) {
  const cur = normalizeStatus(req.status);
  const list = actionsFrom(cur, ctx.role).filter((a) => checkTransition(req, a.to, ctx).ok);
  return { status: cur, canTerminate: isTerminable(cur) && TRANSITIONS.some((t) => t.to === TERMINATED && t.role === ctx.role && (t.from === '*' || t.from === cur)), actions: list };
}

// 需求进度口径：由拆分出的任务派生，与生命周期阶段（status）分开表达
export const PROGRESS_LABEL = { 未开始: '未开始', 进行中: '进行中', 已完成: '已完成' };
export function deriveProgress(tasks = []) {
  if (!tasks.length) return '未开始';
  if (tasks.every((t) => t.status === '已完成')) return '已完成';
  if (tasks.some((t) => ACTIVE_STATUSES.includes(t.status))) return '进行中';
  return '未开始';
}

// 状态机可视化用的展示元数据
export const STATUS_META = {
  未确定: { short: '收集箱', hint: '刚收集进来，还没想清楚要不要做' },
  待评审: { short: '待评审', hint: '已拟好描述，等待产品与研发一起过' },
  已确定: { short: '已确定', hint: '验收标准已签字，进入待排期' },
  已排期: { short: '已排期', hint: '已指派主责开发并给出计划起止' },
  开发中: { short: '开发中', hint: '研发正在实现' },
  测试中: { short: '测试中', hint: '提测，验收标准逐条过' },
  已完成: { short: '已完成', hint: '验收通过，交付完成' },
  已终止: { short: '已终止', hint: '阶段性不再交付，保留记录' },
};
