// 离线自测夹具：把 public/app.js 当成普通 ES 模块加载，用最小 DOM 替身跑通「服务端数据 → 渲染 → 点按钮」全链路。
// 本机没有内置 Browser 预览（端口 3210 被守护进程占着），所以用这个脚本代替手点。
// 跑法：node --import ./scripts/hooks.mjs scripts/selftest.mjs [角色]
const API = process.env.API || 'http://localhost:3210';

// ── 最小 DOM 替身：按选择器缓存节点，好让 render() 铺完、bind() 挂上 onclick 之后，还能拿回来点一下 ──
const nodes = new Map();
const mk = (sel = '') => {
  const listeners = {};
  const n = {
    sel, value: '', textContent: '', innerHTML: '', hidden: false, disabled: false,
    dataset: {}, style: {}, files: [], type: 'text', title: '', className: '', checked: false,
    onclick: null, oninput: null, onchange: null, onblur: null, onsubmit: null,
    classList: { add() {}, remove() {}, toggle() { return false; }, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    insertAdjacentHTML() {}, scrollIntoView() {}, focus() {}, remove() {}, blur() {},
    closest() { return null; }, appendChild() {}, replaceWith() {},
    // 真记监听器：bindWorkbench 全走 addEventListener('click')，夹具得能把它们触发出来
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    dispatch(type, ev = {}) { (listeners[type] || []).forEach(fn => fn({ currentTarget: n, target: n, preventDefault() {}, stopPropagation() {}, ...ev })) },
    querySelector() { return mk(); }, querySelectorAll() { return []; },
  };
  return n;
};
const node = sel => { if (!nodes.has(sel)) nodes.set(sel, mk(sel)); return nodes.get(sel); };
// 点击要照顾两条路径：onclick 直挂的，和被 addEventListener 收走的
const click = sel => { const n = node(sel); if (n.onclick) n.onclick({ currentTarget: n }); n.dispatch('click'); return n };

// 详情页会被绑定的控件（taskRowHtml / draftRowHtml 里的 data-*），这里只给一个代表样本。
// 关键点：模块加载时就抓一次快照，所以这些样本必须此刻就存在，不能靠运行时再补。
const SAMPLES = {
  '[data-task-owner]': { dataset: { taskOwner: 'T1' }, value: 'u-dev' },
  '[data-task-status]': { dataset: { taskStatus: 'T1' }, value: '开发中' },
  '[data-task-start]': { dataset: { taskStart: 'T1' }, value: '2026-09-14' },
  '[data-task-due]': { dataset: { taskDue: 'T1' }, value: '2026-09-16' },
  '[data-del-task]': { dataset: { delTask: 'T1' } },
  '[data-draft-field]': { dataset: { draftField: 'title', i: '0' }, value: '联调与回归' },
  '[data-del-draft]': { dataset: { delDraft: '0' } },
  '[data-transition]': { dataset: { transition: '待评审' } },
  '[data-terminate]': { dataset: { terminate: '1' } },
  '[data-collab]': { dataset: {}, value: 'u-dev', checked: true },
};

// render() 相当于把 #app 的 innerHTML 整体换掉，真实浏览器里旧节点连同监听器一起被丢弃。
// 夹具里节点是缓存的，必须在这里手动模拟这次「换血」，否则每渲染一次监听器就叠一层，
// 会把「一次点击触发 N 次」这种夹具才有的假象报成产品缺陷。
const appEl = node('#app');   // 先拿引用，下面的 setter 会清缓存，但 #app 自身要一直在
Object.defineProperty(appEl, 'innerHTML', {
  get: () => appEl._html || '',
  set(v) { appEl._html = v; nodes.clear(); nodes.set('#app', appEl); Object.entries(SAMPLES).forEach(([sel, s]) => nodes.set(sel, Object.assign(mk(sel), s))); },
});

globalThis.document = {
  querySelector: sel => node(sel),
  querySelectorAll: sel => {
    if (sel === '#app') return [appEl];
    if (!(sel in SAMPLES)) return [];
    return [node(sel)];   // 走缓存，好让 bind() 挂上的监听器在 render() 之后还找得回来
  },
  addEventListener() {}, createElement: () => mk(),
};
globalThis.window = { location: { reload() {} }, print() {} };
globalThis.location = globalThis.window.location;
globalThis.confirm = () => true;
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.FormData = class { constructor() {} entries() { return [] } };
globalThis.alert = () => {};

// ── 带会话的 fetch：登录后把 cookie 挂在后续每个请求上，跟浏览器同源行为一致 ──
const nativeFetch = globalThis.fetch;   // 先留一手，下面就把全局 fetch 换掉了，别自己调自己
let COOKIE = '';
globalThis.fetch = (path, options = {}) => globalThis.__raw(path, options, COOKIE);
globalThis.__raw = async (path, options = {}, cookie = '') => {
  const r = await nativeFetch(API + path, { ...options, headers: { ...(options.headers || {}), cookie } });
  const set = r.headers.getSetCookie?.()[0];
  if (set) COOKIE = set.split(';')[0];
  const text = await r.text();
  return { ok: r.ok, status: r.status, text, json: async () => JSON.parse(text) };
};

const ok = [], bad = [];
const check = (name, cond, extra = '') => (cond ? ok : bad).push(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
const settle = () => new Promise(r => setTimeout(r, 250));
const account = process.argv[2] || 'manager';   // 登录账号
let role = account;                             // 中文角色名，登录后按真实身份回填

// 先登录拿到会话，再 import app.js，好让它启动时那次 me+bootstrap 就有身份
const login = await globalThis.__raw('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: role, password: 'demo123' }) });
check(`登录 ${account}`, login.ok, login.ok ? '' : login.text);

const { TERMINATED } = await import('../lifecycle.js');
const mod = await import(`../public/app.js?role=${account}&t=${Date.now()}`);
const T = mod.__test();
const { state, view, reqActions, reqCtx, render, doTransition, saveSchedule, saveSplit, patchTask } = T;
await settle();  // 等启动 IIFE 落定

check('bootstrap 拿到用户与数据', !!state.db && !!state.me, `${state.me?.name} / ${state.me?.role}`);
role = state.me?.role || role;   // 之后所有权限判断都按服务端认定的角色走，而不是按登录名
if (!state.db) { console.log(bad.join('\n')); process.exit(1); }

const reqs = state.db.requirements;
check('需求池非空', reqs.length > 0, `${reqs.length} 条需求 / ${state.db.tasks.length} 条任务`);

// 种子里没有「测试中」的样本（有任务的需求只会停在 已排期/开发中/已完成），
// 这里造一条内存里的假需求，专门用来验证「测试中」这一步的渲染与流转，不落库、不影响真实数据。
const phantom = {
  id: reqs.find(r => false) || 'r-selftest',
  title: '自测：待验证的需求', projectId: state.db.projects[0]?.id || 'p-exec',
  status: '测试中', priority: 'P1', ownerId: state.me.id, assigneeId: T.reqCtx(reqs[0]).role ? (state.db.users.find(u => u.role === '开发')?.id || '') : '',
  estimatePoints: 3, acceptance: '自测用验收标准', description: '自测用描述', planStart: '2026-09-08', planEnd: '2026-09-12',
  progress: '2/3', rescheduleCount: 0, collaboratorIds: [], createdAt: '2026-09-08',
};
const viewPool = state.db.requirements = [...reqs, phantom];   // 挂进内存库，详情页才按 id 找得到它
const byStatus = s => viewPool.find(r => r.status === s);

// 七个列表视图逐个渲染，捕获任何模板里的运行时错误
for (const v of ['dashboard', 'requirements', 'projects', 'tasks', 'timeline', 'users', 'settings']) {
  try { state.view = v; view(); check(`渲染 ${v}`, true); }
  catch (e) { check(`渲染 ${v}`, false, e.message); }
}

// ── 需求详情工作台 ──
const detail = r => { state.view = 'requirement'; state.selectedRequirementId = r.id; return render() || ''; };

for (const s of ['未确定', '待评审', '已确定', '已排期', '开发中', '测试中', '已完成']) {
  const r = byStatus(s);
  if (!r) { check(`详情样本 ${s}`, false, '数据集里没有这个状态'); continue; }
  try { const html = detail(r); check(`渲染详情 ${s}`, true, r.title); }
  catch (e) { check(`渲染详情 ${s}`, false, e.message); }
  const a = reqActions(r);
  const acts = a.actions.map(x => `${x.to}${x.allowed ? '' : '(锁)'}`).join('、') || '无';
  check(`派生动作 ${s}`, a.status === s, `角色 ${role} → ${acts}`);
}

// 已完成的需求必须被状态机挡住，不能再拆分/流转
const done = byStatus('已完成');
check('已完成需求无可执行流转', done && reqActions(done).actions.length === 0);

// ── 真点按钮：直接调 doTransition，看服务端有没有把「角色不对 / 前置没满足」挡住 ──
// 挑一条当前角色真的能推的需求；夹具里的 [data-transition] 是固定样本，没法表示每个目标，所以这里调处理函数本体。
const pushable = viewPool.filter(r => r.id !== phantom.id).find(r => reqActions(r).actions.some(x => x.allowed));
if (pushable) {
  const target = reqActions(pushable).actions.find(x => x.allowed).to;
  detail(pushable);
  const before = pushable.status;
  node('#transition-reason').value = '自测：' + role;
  await doTransition(target);
  await settle();
  const now = state.db.requirements.find(r => r.id === pushable.id);
  check(`流转「${before} → ${target}」`, now.status === target, `实际 ${now.status}`);
  const hist = state.history.filter(h => h.requirementId === pushable.id);
  check('流转写入操作历史', hist.length > 0, hist.slice(-1)[0] ? `${hist.slice(-1)[0].action}（${hist.slice(-1)[0].actorName}）` : '无记录');
} else {
  check('当前角色有可推需求', true, '（没有可执行流转，跳过点击用例）');
}

// 反向：拿一个当前角色推不动的目标，确认服务端 403/400 而不是默默通过
const lockedReq = viewPool.filter(r => r.id !== phantom.id).find(r => {
  const a = reqActions(r);
  return a.actions.some(x => !x.allowed) ;
});
if (lockedReq) {
  const bad = reqActions(lockedReq).actions.find(x => !x.allowed);
  const before = state.db.requirements.find(r => r.id === lockedReq.id).status;
  detail(lockedReq);
  node('#transition-reason').value = '自测：越权尝试';
  await doTransition(bad.to);
  await settle();
  const now = state.db.requirements.find(r => r.id === lockedReq.id);
  check(`越权流转被拒「${before} → ${bad.to}」`, now.status === before, `实际仍是 ${now.status}`);
}

// 不可执行的动作必须在界面上是禁用态，而不是点得动但被接口拒
const blocked = reqs.find(r => { const a = reqActions(r); return a.actions.some(x => !x.allowed); });
if (blocked) {
  const html = detail(blocked);
  const a = reqActions(blocked);
  const locked = a.actions.filter(x => !x.allowed);
  check('不可执行流转渲染为 disabled', locked.length === 0 || html.includes('disabled'), `${locked.map(x => x.to).join('、')} 锁定`);
}

// 拆分：权限是「产品/项目管理，或该需求的主责开发」。先找一条当前角色拆得动的，
// 找不到就说明这个角色根本没资格拆，那就反过来验证它确实被挡住了。
const openReqs = viewPool.filter(r => r.id !== phantom.id && ['未确定', '待评审', '已确定', '已排期', '开发中'].includes(r.status));
const splittable = openReqs.find(r => ['产品', '项目管理'].includes(role) || r.assigneeId === state.me.id);
if (splittable) {
  detail(splittable);
  click('[data-action="add-draft-row"]');
  await settle();
  check('添加拆分草稿行', state.splitDraft.length > 0, `草稿 ${state.splitDraft.length} 行`);
  state.splitDraft[0].title = '自测任务：接口联调';
  state.splitDraft[0].estimateHours = 8;
  const n0 = state.db.tasks.length;
  await saveSplit();
  await settle();
  check('提交拆分落库', state.db.tasks.length > n0, `任务 ${n0} → ${state.db.tasks.length}`);
  check('拆分后草稿清空', state.splitDraft.length === 0);
  check('拆分写入操作历史', state.history.some(h => h.action === '拆分'), state.history.filter(h => h.action === '拆分').slice(-1)[0]?.detail || '无记录');

  // 结构错误必须是硬失败：空标题 / 非正工时，且逐条给出 details
  const tgt = state.db.requirements.find(r => r.id === splittable.id);
  detail(tgt);
  state.splitDraft = [{ title: '', estimateHours: -3, assigneeId: '', startDate: '', dueDate: '' }];
  await saveSplit();
  await settle();
  check('空标题/负工时的拆分被整包拒绝', !state.db.tasks.some(t => t.requirementId === splittable.id && t.estimateHours < 0));
  check('拆分失败后草稿保留，不丢用户输入', state.splitDraft.length === 1);

  // 颗粒度越界只能是警告，不能拦下提交
  detail(tgt);
  state.splitDraft = [{ title: '自测：超大任务', estimateHours: 60, assigneeId: tgt.assigneeId || '', startDate: '', dueDate: '' }];
  const w0 = state.db.tasks.length;
  await saveSplit();
  await settle();
  check('工时越界只警告不拦截', state.db.tasks.length > w0, `任务 ${w0} → ${state.db.tasks.length}`);
  check('越界任务确实落库', state.db.tasks.some(t => t.title === '自测：超大任务'));

  // 权限门：找一条不是自己主责的需求，确认被服务端挡下（开发/测试角色才有这一层）
  if (['开发', '测试'].includes(role)) {
    const others = openReqs.filter(r => r.assigneeId !== state.me.id);
    if (others.length) {
      const before = state.db.tasks.length;
      detail(others[0]);
      state.splitDraft = [{ title: '自测：越权拆分', estimateHours: 8, assigneeId: '', startDate: '', dueDate: '' }];
      await saveSplit();
      await settle();
      check('非主责开发不能拆分', state.db.tasks.length === before, `任务数 ${before} → ${state.db.tasks.length}`);
    }
  }
} else {
  // 越权拆分：确认服务端拒绝，而不是默默写进去
  const target = openReqs[0];
  const before = state.db.tasks.length;
  if (target) {
    detail(target);
    state.splitDraft = [{ title: '自测：越权拆分', estimateHours: 8, assigneeId: '', startDate: '', dueDate: '' }];
    await saveSplit();
    await settle();
    check(`非主责开发不能拆分（${role}）`, state.db.tasks.length === before, `任务数 ${before} → ${state.db.tasks.length}`);
  }
}

// 排期：改成晚于项目目标，验证 409 → 确认 → 强制保存这条路
const sched = viewPool.find(r => r.id !== phantom.id && (r.status === '已排期' || r.status === '开发中'));
if (sched && ['产品', '项目管理'].includes(role)) {
  detail(sched);
  node('#plan-start').value = '2026-09-20';
  node('#plan-end').value = '2026-12-31';   // 必然晚于任何项目目标
  const before = state.db.requirements.find(r => r.id === sched.id).rescheduleCount || 0;
  await saveSchedule(false);
  await settle(); await settle();   // 409 之后 saveSchedule 会再走一次 force
  const now = state.db.requirements.find(r => r.id === sched.id);
  check('超期改期需确认后强制保存', now.planEnd === '2026-12-31', `planEnd=${now.planEnd}，改期次数 ${before} → ${now.rescheduleCount}`);
  // 基线是拿来对比偏移的锚点：它必须记的是「改动之前那份计划」，而不是一条空记录。
  check('基线记录的是改动前的计划', !!now.baseline?.planStart && !!now.baseline?.planEnd, now.baseline ? `基线 ${now.baseline.planStart} ~ ${now.baseline.planEnd}` : '无基线');
  check('真改期累计计数器递增', (now.rescheduleCount || 0) > before, `${before} → ${now.rescheduleCount}`);
  // 首次排期不属于改期：不该提前留一条空基线，也不该把次数先加一次。
  const fresh = viewPool.find(r => r.id !== phantom.id && !r.planStart && !r.planEnd && ['未确定', '待评审', '已确定'].includes(r.status));
  if (fresh) {
    detail(fresh);
    node('#plan-start').value = '2026-10-05';
    node('#plan-end').value = '2026-10-30';
    await saveSchedule(false);
    await settle(); await settle();
    const f = state.db.requirements.find(r => r.id === fresh.id);
    check('首次排期不算改期次数', (f.rescheduleCount || 0) === 0, `改期次数 ${f.rescheduleCount}`);
    check('首次排期不留空基线', !f.baseline || (!!f.baseline.planStart && !!f.baseline.planEnd), f.baseline ? JSON.stringify(f.baseline) : '无基线');
  }
}

console.log(`\n【${role}】\n` + ok.join('\n'));
if (bad.length) { console.log('失败项：\n' + bad.join('\n')); process.exit(1); }
console.log(`—— ${ok.length} 项通过`);
