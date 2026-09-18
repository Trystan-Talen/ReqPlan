import { api, rows, setCsrf, ApiError } from './api.js';
import { createTimelineState, renderTimeline, resolveTimelineRange } from './timeline.js';
import { availableRequirementActions, availableTaskStatuses, roleCan, ROLE_LABELS, OWNER_ROLES, LEAD_REQUIREMENT_FIELDS } from './workflow.js';
import { renderAuditEntry, renderBaseline, renderErrorDetails, renderTextComparison } from './review-ui.js';
import { blankTask, readBatchForm, renderBatchRows, renderBatchSummary } from './task-batch.js';
import { renderPersonalWork, renderReminders, renderReports } from './work-ui.js';
import { renderDocumentPreview } from './document-preview.js';
import { esc, icon, BRAND_MARK, hue, initial, avatarMark, personChip, badge, priority, accountStatus, options, empty, heading, sectionHeading, metric, field, input, select, area } from './ui-kit.js';

const $ = (selector, root = document) => root.querySelector(selector);
const encode = value => encodeURIComponent(value);
function avatar(id, size = '') { return avatarMark(id, id ? nameOf(id) : '', size); }
function person(id, size = 'xs') { return personChip(id, nameOf(id), size); }
function projectColor(id) { const index = data.projects.findIndex(project => project.id === id); return COLORS[Math.max(0, index) % COLORS.length]; }
function toggleTheme() {
  const root = document.documentElement; if (!root) return;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('xinghe:theme', root.dataset.theme); } catch (_) {}
}
const TASK_STATUS = { wait: '待开始', develop: '开发中', test: '测试中', done: '已完成', terminated: '已终止' };
const taskStage = value => ({'待开始':'wait','开发中':'develop','测试中':'test','已完成':'done','已终止':'terminated'}[value] || value);
const REQUEST_STATUS = ['未确定', '待评审', '已确定', '待排期', '已排期', '开发中', '测试中', '已完成', '已终止'];
const MEMBER_ROLE = ROLE_LABELS;
const REQUIREMENT_CONTROLS = ['title','description','acceptance','priority','status','assigneeId','collaboratorIds','dependencyIds','estimatePoints','planStart','planEnd','source'];
const TASK_CONTROLS = ['title','requirementId','ownerId','status','startDate','dueDate','estimateHours','dependencyIds'];
const VIEW_LABEL = { personal:'我的工作',notifications:'站内提醒',reports:'交付报表',operations:'数据备份',team: '团队工作台', projects: '项目目录', overview: '项目概览', requirements: '需求池', tasks: '研发任务', timeline: '交付排期', members: '项目成员', users: '账号管理', audit: '操作记录' };
// Project identity colors come from design tokens --project-1…6 (design/tokens.css).
const COLORS = ['var(--project-1)', 'var(--project-2)', 'var(--project-3)', 'var(--project-4)', 'var(--project-5)', 'var(--project-6)'];
let user = null, data = { projects: [], requirements: [], tasks: [], users: [], memberships: [] };
let selectedProject = '', route = { view: 'team', projectId: '' };
let ui = { search: '', status: 'all', priority: 'all', archived: false, page: 1, taskLayout: 'board' };
const timelineStates = new Map();
let toastTimer, modalReturnFocus, transientToken = '', attachmentObjectUrl = '', selfResetPending = false;
const dialog = $('#dialog');
const attachmentMeta = new Map();
const entryParameters = new URLSearchParams(location.hash.slice(1));
let setupToken = location.hash.startsWith('#setup=') ? entryParameters.get('setup') || '' : '';
let activationToken = setupToken ? '' : (location.hash.startsWith('#activate=') ? entryParameters.get('activate') : '') || new URLSearchParams(location.search).get('token') || '';
const adminRecovery = Boolean(activationToken && entryParameters.get('purpose') === 'admin-reset');
const recoveryUsername = adminRecovery ? (entryParameters.get('username') || '').slice(0, 64) : '';
let loginUsername = '';
entryParameters.delete('setup');entryParameters.delete('activate');
let setupAllowed = false;
if (setupToken || activationToken) history.replaceState(null, '', location.pathname);

function nameOf(id) { return data.users.find(person => person.id === id)?.name || (id ? '未知成员' : '未分配'); }
function projectOf(id = route.projectId) { return data.projects.find(project => project.id === id); }
function isAdmin() { return user?.role === 'admin'; }
function memberRole(id = route.projectId) { const project = projectOf(id); return project?.userRole || data.memberships.find(item => item.projectId === id && item.userId === user?.id)?.role || ''; }
function isExecutive() { return Boolean(user?.executive); }
// 'admin' acts with every project permission; managers ('executive') read every project.
function projectRole(id = route.projectId) { return isAdmin() ? 'admin' : memberRole(id) || (isExecutive() ? 'executive' : ''); }
function roleLabel(id = route.projectId) { return isAdmin() ? '系统管理员' : MEMBER_ROLE[memberRole(id)] || (isExecutive() ? '管理层 · 只读' : '项目成员'); }
function can(permission, id = route.projectId) { return roleCan(projectRole(id), permission); }
function canEdit(id = route.projectId) { return can('editRequirement', id); }
function canCreateTask(id = route.projectId) { return can('assignTasks', id) || can('createOwnTask', id); }
function participates(item) { return item.assigneeId === user.id || (item.collaboratorIds || []).includes(user.id) || data.tasks.some(task => task.requirementId === item.id && !task.archived && task.ownerId === user.id); }
function canSplit(item) { return !item.archived && (can('assignTasks', item.projectId) || (can('createOwnTask', item.projectId) && participates(item))); }
function canEditEntity(kind, item) {
  if (!item) return kind === 'tasks' ? canCreateTask() : canEdit();
  const role = projectRole(item.projectId);
  if (role === 'admin') return true;
  if (kind === 'tasks') return role === 'lead' || (role === 'developer' && item.ownerId === user.id) || (role === 'tester' && ['test','done'].includes(taskStage(item.status)));
  return ['product','lead'].includes(role) || (role === 'developer' && participates(item)) || (role === 'tester' && ['测试中','已完成'].includes(item.status));
}
// Form fields each role may change; null means every field. The server enforces the same scope.
function editableFields(kind, item, projectId) {
  const role = projectRole(projectId);
  if (role === 'admin') return null;
  if (kind === 'requirements') return role === 'product' ? REQUIREMENT_CONTROLS.filter(key => key !== 'assigneeId') : role === 'lead' ? LEAD_REQUIREMENT_FIELDS : ['status'];
  if (kind === 'tasks') return role === 'lead' ? null : role === 'developer' ? TASK_CONTROLS.filter(key => key !== 'ownerId' && (!item || key !== 'requirementId')) : ['status'];
  return null;
}
function lockFields(kind, item, projectId) {
  const allowed = editableFields(kind, item, projectId); if (!allowed) return;
  for (const control of dialog.querySelectorAll('input,textarea,select')) if ([...REQUIREMENT_CONTROLS, ...TASK_CONTROLS].includes(control.name) && !allowed.includes(control.name)) control.disabled = true;
}
function taskOptions(current, projectId, task = null) {
  const role = projectRole(projectId);
  return availableTaskStatuses(role, current, {dependencies:(task?.dependencyIds||[]).map(id=>data.tasks.find(item=>item.id===id)||{id,status:'wait'})}).map(value => `<option value="${value}"${taskStage(current)===value?' selected':''}>${TASK_STATUS[value] || value}</option>`).join('');
}
function requirementActions(item) {
  return availableRequirementActions(projectRole(item.projectId),item,{tasks:data.tasks.filter(task=>task.requirementId===item.id&&!task.archived),dependencies:(item.dependencyIds||[]).map(id=>data.requirements.find(req=>req.id===id)||{id,status:'未确定'})});
}
function requirementOptions(item) {
  const actions=requirementActions(item);
  return `<option value="${esc(item.status)}" selected>${esc(item.status)}（当前）</option>`+actions.map(action=>`<option value="${esc(action.status)}"${action.allowed?'':' disabled'}>${esc(action.label)}${action.allowed?'':'（条件未满足）'}</option>`).join('');
}
function workflowHints(item) {
  const blocked=requirementActions(item).filter(action=>!action.allowed);
  return blocked.length?`<div class="workflow-hints"><strong>流转条件</strong>${blocked.map(action=>`<p>${esc(action.label)}：${esc(action.message)}</p>`).join('')}</div>`:'';
}
function canManage(id = route.projectId) { return isAdmin() || (Boolean(user) && projectOf(id)?.ownerId === user.id); }
function projectUsers(id = route.projectId) { const ids = new Set(data.memberships.filter(item => item.projectId === id).map(item => item.userId)); return data.users.filter(person => (ids.has(person.id) || person.role === 'admin') && person.status !== 'disabled'); }
function projectPath(id, view = 'overview') { return `#/p/${encode(id)}/${view}`; }
function date(value) { return value ? String(value).slice(0, 10) : '未设置'; }
function time(value) { if (!value) return '时间未知'; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString('zh-CN', { hour12: false }) : String(value); }
function today() { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; }
function isDone(item) { return taskStage(item.status)==='done'; }
function overdue(item) { const due = item.dueDate || item.planEnd; return !item.archived && !isDone(item) && taskStage(item.status)!=='terminated' && due && due < today(); }
function personOptions(current, projectId = route.projectId, roles = null) { const people = projectUsers(projectId).filter(person => !roles || data.memberships.some(item => item.projectId === projectId && item.userId === person.id && roles.includes(item.role))); const currentPerson = data.users.find(item => item.id === current); if (currentPerson && !people.some(item => item.id === current)) people.push(currentPerson); return `<option value="">未分配</option>${people.map(person => `<option value="${esc(person.id)}"${person.id === current ? ' selected' : ''}>${esc(person.name)}</option>`).join('')}`; }
function toast(message, error = false) { clearTimeout(toastTimer); $('#toast-region').innerHTML = `<div class="toast${error ? ' error' : ''}">${icon(error ? 'alert' : 'check')}<span>${esc(message)}</span></div>`; toastTimer = setTimeout(() => $('#toast-region').innerHTML = '', 5500); }
function busy(button, state) { if (!button) return; button.disabled = state; button.setAttribute('aria-busy', String(state)); }
function presentError(error, container) {
  if (error.status === 401 && user) { user = null; setCsrf(''); closeDialog(); renderAuth('login', '会话已结束，请重新登录。'); return; }
  const text = error.code === 'VERSION_CONFLICT' ? `内容已被其他成员更新。${error.message} 重新载入会放弃本次尚未保存的修改。` : error.message || '操作未完成，请重试。';
  if (container) { container.hidden = false; container.innerHTML = `<span>${esc(text)}</span>${renderErrorDetails(error.details)}${error.code === 'VERSION_CONFLICT' ? '<button type="button" class="text-button" data-action="refresh">重新载入最新内容</button>' : ''}`; container.focus(); }
  else if (error.code === 'VERSION_CONFLICT') { $('#page-alert').innerHTML = `<div class="notice notice-danger server-error"><span>${esc(text)}</span><button class="btn btn-secondary btn-small" data-action="refresh">重新载入</button></div>`; }
  else { const alert=$('#page-alert'); if(alert) alert.innerHTML=`<div class="notice notice-danger server-error" role="alert"><span>${esc(text)}</span>${renderErrorDetails(error.details)}<button class="text-button" data-action="dismiss-alert">关闭提示</button></div>`; else toast(text,true); }
}
async function reload() {
  const [result, accounts] = await Promise.all([api('/bootstrap?includeArchived=1'), isAdmin() ? api('/users') : Promise.resolve(null)]);
  data = { projects: rows(result.projects, 'projects'), requirements: rows(result.requirements || result.requests, 'requirements'), tasks: rows(result.tasks, 'tasks'), users: rows(accounts || result.users, 'users'), memberships: rows(result.memberships, 'memberships') };
  if (!data.users.some(person => person.id === user.id)) data.users.push(user);
  if (!data.projects.some(project => project.id === selectedProject && !project.archived)) selectedProject = data.projects.find(project => !project.archived)?.id || '';
}
function resetFilters() { ui.search = ''; ui.status = 'all'; ui.priority = 'all'; ui.archived = false; ui.page = 1; }
function readRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'p') {
    let id; try { id = decodeURIComponent(parts[1] || ''); } catch (_) { id = ''; }
    route = { projectId: id, view: ['overview','requirements','tasks','timeline','members'].includes(parts[2]) ? parts[2] : 'overview' };
    if (projectOf(id)) selectedProject = id;
  } else route = { projectId: '', view: ['team','projects','users','audit','personal','notifications','reports','operations'].includes(parts[0]) ? parts[0] : 'team' };
}
function validateNewPassword(value) {
  if(typeof value!=='string'||Array.from(value).length<6)throw new Error('密码至少 6 个字符。');
  if(!value.trim())throw new Error('密码不能全部为空白字符。');
}
function authAside() {
  return `<aside class="auth-aside"><a class="brand" href="/"><span class="brand-mark">${BRAND_MARK}</span><span><strong>星河研发台</strong><small>让每个好想法，走向交付</small></span></a><div class="auth-hero"><span class="auth-eyebrow"><i></i>项目协作 · 需求管理 · 交付跟踪</span><h1>从一个需求，<br>到一次<em>可靠交付</em>。</h1><p class="auth-lede">把项目、团队与进展放在一起。<br>目标清楚，责任明确，协作持续向前。</p><div class="auth-flow" aria-hidden="true"><div class="auth-flow-step"><span>01</span><i></i><strong>沉淀需求</strong><small>背景、验收、优先级</small></div><div class="auth-flow-step"><span>02</span><i class="tone-blue"></i><strong>拆解任务</strong><small>负责人、工时、依赖</small></div><div class="auth-flow-step"><span>03</span><i class="tone-green"></i><strong>按期交付</strong><small>排期、验收、复盘</small></div></div></div><p class="auth-note">XINGHE · R&amp;D DELIVERY</p></aside>`;
}
function renderAuth(kind = 'login', message = '', { notice = '' } = {}) {
  const forced = kind === 'password';
  const activation = kind === 'activate';
  const recovery = activation && adminRecovery;
  const title = forced ? '设置你的新密码' : recovery ? '重置管理员密码' : activation ? '激活账号 / 重置密码' : '欢迎回到星河';
  const description = forced ? '账号要求修改密码后继续使用。修改成功后请重新登录。' : recovery ? '设置一个至少 6 位的新密码，保存后返回登录。恢复链接只能使用一次。' : activation ? '设置密码后即可使用账号。链接只可使用一次，并受有效期限制。' : '使用团队账号登录，让每一次协作都有据可循。';
  const account = recovery && recoveryUsername ? `<div class="recovery-account"><span>管理员账号</span><strong>${esc(recoveryUsername)}</strong></div>` : '';
  const fields = !forced && !activation
    ? `<div class="form-field"><label for="auth-username">账号</label><input id="auth-username" name="username" value="${esc(loginUsername)}" autocomplete="username" maxlength="64" required autofocus placeholder="输入团队账号"></div><div class="form-field"><label for="auth-password">密码</label><input id="auth-password" name="password" type="password" autocomplete="current-password" required placeholder="输入密码"></div>`
    : `${forced ? '<div class="form-field"><label for="auth-current">当前密码</label><input id="auth-current" name="currentPassword" type="password" autocomplete="current-password" required autofocus></div>' : ''}<div class="form-field"><label for="auth-new">新密码</label><input id="auth-new" name="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required${!forced ? ' autofocus' : ''}></div><div class="form-field"><label for="auth-confirm">确认新密码</label><input id="auth-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required></div><p class="password-rules">密码至少 6 个字符。</p>`;
  const footnote = forced
    ? '<button class="text-button" data-action="logout">退出当前账号</button>'
    : activation
      ? '<a class="text-button" href="/">返回登录</a>'
      : '<button type="button" class="text-button" data-action="recover-admin">忘记管理员密码？</button><p>没有账号或忘记成员密码？请联系团队管理员获取激活或重置链接。</p>';
  $('#app').innerHTML = `<div class="auth-layout">${authAside()}<main id="main" class="auth-content"><div class="auth-card"><h2>${title}</h2><p>${description}</p>${account}${notice ? `<div class="notice notice-info auth-notice" role="status">${esc(notice)}</div>` : ''}<div id="auth-error" class="notice notice-danger auth-error" tabindex="-1" role="alert"${message ? '' : ' hidden'}>${esc(message)}</div><form id="auth-form" data-kind="${kind}">${fields}<button class="btn btn-primary" type="submit">${forced ? '修改密码并重新登录' : recovery ? '保存新密码并返回登录' : activation ? '设置密码' : '登录工作空间'} ${icon('arrow')}</button></form><div class="auth-footnote">${footnote}</div></div></main></div>`;
}
function adminRecoveryHelp() {
  openDialog('找回管理员账号', '<div class="dialog-body"><h3>在这台电脑上使用</h3><p>打开项目文件夹，双击“重置管理员密码.command（管理员密码恢复启动文件）”。浏览器会打开设置新密码页面，设置至少 6 位密码后即可登录。</p><h3>部署在服务器上使用</h3><p>请联系拥有服务器访问权限的管理人员，生成一次性恢复链接，再通过链接设置新密码。</p></div>', '<button class="btn btn-primary" data-action="close-dialog">知道了</button>','center');
}

function renderSetup(status, message = '') {
  const allowed = Boolean(status.required && status.enabled && setupToken);
  setupAllowed = allowed;
  const title = allowed ? '创建首个管理员账号' : '先完成工作空间初始化';
  const description = allowed ? '在网页中设置管理员姓名、登录账号和密码，创建成功后直接进入工作台。' : '当前工作空间尚未设置管理员。请从应用启动入口打开初始化页面，然后在网页中完成设置。';
  const form = allowed ? '<form id="auth-form" data-kind="setup"><div class="form-field"><label for="auth-name">管理员姓名</label><input id="auth-name" name="name" value="'+esc(status.suggestedName || '管理员')+'" autocomplete="name" maxlength="80" required autofocus></div><div class="form-field"><label for="auth-username">登录账号</label><input id="auth-username" name="username" value="'+esc(status.suggestedUsername || 'admin')+'" autocomplete="username" maxlength="64" required></div><div class="form-field"><label for="auth-new">登录密码</label><input id="auth-new" name="newPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required></div><div class="form-field"><label for="auth-confirm">确认密码</label><input id="auth-confirm" name="confirmPassword" type="password" autocomplete="new-password" minlength="6" maxlength="128" required></div><p class="password-rules">密码至少 6 个字符。</p><button class="btn btn-primary" type="submit">创建管理员并进入工作台 '+icon('arrow')+'</button></form>' : '<form><button type="button" class="btn btn-secondary" data-action="check-setup">重新检查初始化状态</button></form>';
  $('#app').innerHTML = '<div class="auth-layout">'+authAside()+'<main id="main" class="auth-content"><div class="auth-card"><h2>'+title+'</h2><p>'+description+'</p><div id="auth-error" class="notice notice-danger auth-error" tabindex="-1" role="alert"'+(message?'':' hidden')+'>'+esc(message)+'</div>'+form+'<div class="auth-footnote">'+(allowed?'管理员负责团队账号与项目管理。初始化完成后，这个入口将自动关闭。':'初始化完成后，刷新此页面即可正常登录。')+'</div></div></main></div>';
}
function navLink(view, label, glyph, href, count) { return `<a href="${href}" class="${route.view === view ? 'active' : ''}"${route.view === view ? ' aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span>${count !== undefined ? `<span class="nav-count">${count}</span>` : ''}</a>`; }
function renderShell() {
  const current=projectOf(),activeProjects=data.projects.filter(project=>!project.archived);
  const selectedRecord=projectOf(selectedProject);if(selectedRecord?.archived)activeProjects.push(selectedRecord);
  const liveCount=collection=>data[collection].filter(item=>item.projectId===selectedProject&&!item.archived).length;
  const projectNav=selectedProject?['overview','requirements','tasks','timeline','members'].map((view,index)=>navLink(view,VIEW_LABEL[view],['dashboard','inbox','board','calendar','users'][index],projectPath(selectedProject,view),view==='requirements'?liveCount('requirements'):view==='tasks'?liveCount('tasks'):undefined)).join(''):'<p class="nav-empty">加入项目后可查看需求与任务</p>';
  const scope=current?'项目空间':['users','audit','operations'].includes(route.view)?'系统管理':'团队空间';
  const searchLabel={team:'搜索项目',projects:'搜索项目',requirements:'搜索需求',tasks:'搜索任务',timeline:'搜索任务',users:'搜索账号'}[route.view];
  const contextRole=current?roleLabel():selectedRecord?'点击切换 · 进入项目':'选择后进入项目，查看需求与交付';
  const switcher=`<div class="project-context"><span class="project-glyph" style="--project:${selectedRecord?projectColor(selectedRecord.id):'var(--project-none)'}" aria-hidden="true">${selectedRecord?initial(selectedRecord.name):'+'}</span><span class="project-context-copy"><strong>${esc(selectedRecord?.name||'暂无可访问的项目')}</strong><span class="project-context-meta">${esc(contextRole)}</span></span>${icon('chevrons')}<label class="sr-only" for="project-switch">${current?'当前项目':'选择项目'}</label><select id="project-switch" title="${esc(selectedRecord?.name||'选择项目')}"${activeProjects.length?'':' disabled'}>${activeProjects.length?activeProjects.map(project=>`<option value="${esc(project.id)}"${project.id===selectedProject?' selected':''}>${esc(project.name)}${project.archived?'（已归档）':''}</option>`).join(''):'<option>暂无可访问的项目</option>'}</select></div>`;
  $('#app').innerHTML=`<div class="app-shell"><aside id="sidebar" class="sidebar" aria-label="主导航">
    <div class="sidebar-top"><a class="brand" href="#/team"><span class="brand-mark">${BRAND_MARK}</span><span><strong>星河研发台</strong><small>项目 · 需求 · 交付</small></span></a></div>
    <div class="sidebar-scroll"><p class="nav-caption">团队空间</p><nav class="main-nav" aria-label="团队功能">${navLink('team','团队工作台','dashboard','#/team')}${navLink('projects','项目目录','folder','#/projects')}${navLink('personal','我的工作','check','#/personal')}${navLink('notifications','站内提醒','bell','#/notifications')}${navLink('reports','交付报表','chart','#/reports')}</nav>
    <section class="project-navigation" aria-label="项目空间"><p class="nav-caption">${current?'当前项目':'项目空间'}</p>${switcher}<nav class="project-nav-links" aria-label="当前项目功能">${projectNav}</nav></section>
    ${isAdmin()?`<div class="admin-nav"><p class="nav-caption">系统管理</p><nav class="project-nav-links" aria-label="管理功能">${navLink('users','账号管理','users','#/users')}${navLink('audit','操作记录','history','#/audit')}${navLink('operations','数据备份','shield','#/operations')}</nav></div>`:''}</div>
    <div class="sidebar-bottom"><div class="workspace-profile">${avatar(user.id)}<div class="profile-copy"><strong>${esc(user.name)}</strong><small>${isAdmin()?'系统管理员':isExecutive()?'管理层':'团队成员'}</small></div><button class="icon-button" data-action="password" aria-label="修改我的密码" title="修改我的密码">${icon('lock')}</button><button class="icon-button" data-action="logout" aria-label="退出登录" title="退出登录">${icon('logout')}</button></div></div>
    </aside><button id="sidebar-shade" class="sidebar-shade" data-action="close-menu" aria-label="关闭导航" hidden></button><div class="workspace"><header class="topbar"><div class="breadcrumb-group"><button class="icon-button menu-toggle" data-action="menu" aria-label="打开导航" aria-expanded="false">${icon('menu')}</button><nav class="breadcrumb" aria-label="当前位置"><a href="#/team">团队</a><span>/</span>${current?`<a title="${esc(current.name)}" href="${projectPath(current.id)}">${esc(current.name)}</a><span>/</span>`:''}<strong aria-current="page">${VIEW_LABEL[route.view]}</strong></nav></div><div class="topbar-actions">${searchLabel?`<label class="search-field">${icon('search')}<input id="search" type="search" aria-label="${searchLabel}" placeholder="${searchLabel}" value="${esc(ui.search)}" maxlength="100"><kbd aria-hidden="true">/</kbd></label>`:''}<button class="icon-button theme-toggle" data-action="theme" aria-label="切换浅色或深色主题" title="切换主题">${icon('moon','icon-moon')}${icon('sun','icon-sun')}</button><button class="avatar avatar-small" style="--hue:${hue(user.id)}" data-action="profile" aria-label="我的账号">${initial(user.name)}</button></div></header>
    <main id="main" tabindex="-1"><div id="page-alert" role="alert"></div><div id="view"></div><footer class="workspace-footer"><span class="connection-note">已连接 · 星河研发台</span><span>${esc(scope)}</span></footer></main></div></div>`;
  renderView();
}
function scoped(collection) { return data[collection].filter(item => !route.projectId || item.projectId === route.projectId); }
function matches(item) { return !ui.search || [item.title,item.name,item.id,item.username,item.description,nameOf(item.ownerId),nameOf(item.assigneeId)].some(value => String(value || '').toLowerCase().includes(ui.search.toLowerCase())); }
function projectCard(project) {
  const reqs=data.requirements.filter(item=>item.projectId===project.id&&!item.archived);
  const tasks=data.tasks.filter(item=>item.projectId===project.id&&!item.archived);
  const eligible=tasks.filter(item=>taskStage(item.status)!=='terminated'),completed=eligible.filter(isDone).length;
  const percent=eligible.length?Math.round(completed/eligible.length*100):0;
  const role=roleLabel(project.id);
  return `<article class="project-card" style="--project:${projectColor(project.id)}"><div class="project-card-top"><span class="project-dot" aria-hidden="true">${initial(project.name)}</span><h3 title="${esc(project.name)}">${esc(project.name)}</h3>${project.status?badge(project.status):''}</div><p class="project-description">${esc(project.description||'尚未填写项目说明')}</p><dl class="project-card-meta"><div><dt>负责人</dt><dd>${person(project.ownerId)}</dd></div><div><dt>我的角色</dt><dd>${esc(role)}</dd></div><div><dt>目标交付</dt><dd>${date(project.targetDate)}</dd></div></dl><div class="project-progress"><div class="project-progress-label"><span>任务完成率</span><strong>${eligible.length?`${percent}% · ${completed} / ${eligible.length}`:tasks.length?'任务均已终止':'暂无任务'}</strong></div><div class="progress-track"${eligible.length?` role="progressbar" aria-label="${esc(project.name)}任务完成率（不含已终止任务）" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"`:''}><div class="progress-fill" style="width:${percent}%"></div></div></div><div class="project-card-foot"><span class="project-stats">${reqs.length} 项需求 · ${tasks.length} 个任务</span><a class="project-open" href="${projectPath(project.id)}">进入项目 →</a></div></article>`;
}
function todoItem(task, meta) {
  const late=overdue(task);
  return `<button class="todo-item" data-task="${esc(task.id)}"><span class="todo-icon${late?' is-late':''}">${icon(late?'alert':'board')}</span><span class="todo-copy"><strong>${esc(task.title)}</strong><span class="todo-meta${late?' overdue-text':''}">${meta}</span></span>${badge(task.status)}</button>`;
}
function teamView(directory = false) {
  const activeIds=new Set(data.projects.filter(project=>!project.archived).map(project=>project.id));
  const projects=data.projects.filter(project=>(directory?Boolean(project.archived)===ui.archived:!project.archived)&&matches(project));
  const requests=data.requirements.filter(item=>!item.archived&&activeIds.has(item.projectId)),tasks=data.tasks.filter(item=>!item.archived&&activeIds.has(item.projectId));
  const mine=tasks.filter(item=>item.ownerId===user.id&&!['done','terminated'].includes(taskStage(item.status))).sort((a,b)=>(a.dueDate||'9999').localeCompare(b.dueDate||'9999'));
  const newProject=isAdmin()?'<button class="btn btn-primary" data-action="new-project">'+icon('plus')+' 新建项目</button>':'';
  const grid=`<div class="project-grid">${projects.map(projectCard).join('') || empty('还没有可访问的项目',isAdmin() ? '创建第一个项目，再邀请成员加入。' : '请联系管理员或项目负责人，将你加入项目。',isAdmin() ? 'new-project' : '', '新建项目')}</div>`;
  if(directory) return heading('项目目录','浏览你可以访问的项目。进入项目后，需求、任务与排期都限定在该项目。',newProject,'团队空间')+`<section class="section-block"><div class="section-heading project-directory-heading"><div class="section-heading-copy"><h2>${ui.archived?'已归档项目':'全部可访问项目'}</h2><span class="count-label">${projects.length} 个项目</span></div><label class="archive-toggle"><input id="archive-filter" type="checkbox"${ui.archived?' checked':''}><span>查看归档项目</span></label></div>${grid}</section>`;
  const now=new Date(),hour=now.getHours();
  const greeting=hour<5?'夜深了':hour<11?'早上好':hour<13?'中午好':hour<18?'下午好':'晚上好';
  const lateMine=mine.filter(overdue).length,lateAll=tasks.filter(overdue).length;
  const summary=mine.length?`你有 <strong>${mine.length}</strong> 项待办${lateMine?`，其中 <strong>${lateMine}</strong> 项已逾期`:''}。`:'你目前没有待办任务。';
  return `<section class="hero"><div><span class="scope-pill">团队工作台 · ${now.getMonth()+1}月${now.getDate()}日 星期${'日一二三四五六'[now.getDay()]}</span><h1>${greeting}，${esc(user.name)}</h1><p>${summary}这里汇总你可访问项目的进展与待办。</p></div>${newProject?`<div class="page-actions">${newProject}</div>`:''}</section>`
    + `<div class="metrics-grid">${metric('可访问项目',activeIds.size,'按项目组织协作','folder','purple')}${metric('当前需求',requests.length,'当前可访问的未归档项目','inbox','blue')}${metric('我的待办',mine.length,'未完成且未终止的任务','check','green')}${metric('逾期任务',lateAll,'需要重新确认交付','clock','amber',lateAll>0)}</div>`
    + `<div class="split team-layout"><section class="section-block">${sectionHeading('可访问项目',{count:`${projects.length} 个项目`,actionsHtml:`<a class="section-link" href="#/projects">项目目录 ${icon('arrow')}</a>`})}${grid}</section>`
    + `<section class="section-block activity-panel">${sectionHeading('我的待办',{count:mine.length,actionsHtml:`<a class="section-link" href="#/personal">我的工作 ${icon('arrow')}</a>`})}<div class="panel">${mine.length?`<div class="todo-list">${mine.slice(0,8).map(task=>todoItem(task,`${esc(projectOf(task.projectId)?.name)} · ${date(task.dueDate)}`)).join('')}</div>`:empty('没有待办任务','分配给你的未完成任务会出现在这里。')}</div></section></div>`;
}
function overviewView() {
  const project = projectOf(), reqs = scoped('requirements').filter(item => !item.archived), tasks = scoped('tasks').filter(item => !item.archived);
  const eligible=tasks.filter(item=>taskStage(item.status)!=='terminated');
  const completed=eligible.filter(isDone).length,percent=eligible.length?Math.round(completed/eligible.length*100):0;
  const todo = tasks.filter(item => !['done','terminated'].includes(taskStage(item.status))).sort((a,b)=>(a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0,6);
  const stageCount=value=>tasks.filter(item=>taskStage(item.status)===value).length;
  const stages=Object.entries(TASK_STATUS).filter(([value])=>value!=='terminated'||stageCount('terminated'));
  const tone={wait:'plan',develop:'progress',test:'test',done:'done',terminated:'terminated'};
  const late=tasks.filter(overdue).length,now=today();
  const milestones=(project.milestones||[]).slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')));
  return heading(project.name,project.description || '为项目设置目标与交付计划，让团队对齐工作方向。',canManage() ? '<button class="btn btn-secondary" data-action="edit-project">'+icon('edit')+' 编辑项目</button>' : '', '当前项目 · '+roleLabel())
    + `<div class="metrics-grid">${metric('需求总数',reqs.length,`${reqs.filter(item=>['未确定','待评审'].includes(item.status)).length} 项待确认`,'inbox','purple')}${metric('进行中任务',tasks.filter(item=>['develop','test'].includes(taskStage(item.status))).length,'开发中 + 测试中','board','blue')}${metric('任务完成',completed,`共 ${tasks.length} 个任务`,'check','green')}${metric('逾期任务',late,'截止日期早于今天','clock','amber',late>0)}</div>`
    + `<div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>研发进度</h2><p class="muted small">按任务数量统计</p></div><a class="section-link" href="${projectPath(project.id,'tasks')}">查看任务 ${icon('arrow')}</a></div><div class="progress-summary"><div class="progress-ring" style="--p:${eligible.length?percent:0};--ring:${projectColor(project.id)}"><div><span class="progress-number">${eligible.length?percent:'—'}${eligible.length?'<small>%</small>':''}</span><p class="muted small">任务完成率</p></div></div><div class="progress-summary-detail"><strong>${completed} / ${eligible.length}</strong><span>已完成 / 非终止任务</span></div><div class="progress-summary-detail"><strong>${tasks.reduce((sum,item)=>sum+Number(item.estimateHours||0),0)}</strong><span>预估总工时（小时）</span></div></div>${tasks.length?`<div class="stack-bar" role="img" aria-label="任务状态分布">${stages.filter(([value])=>stageCount(value)).map(([value,label])=>`<i class="status-${tone[value]}" style="flex:${stageCount(value)}" title="${label} ${stageCount(value)}"></i>`).join('')}</div>`:''}<div class="status-bars">${stages.map(([value])=>`<div class="status-row">${badge(value)}<span>${stageCount(value)}<small> 项</small></span></div>`).join('')}</div><div class="panel-note">${icon('document')}完成率按非终止任务数量计算；需求点数与任务工时分别记录。</div></section>`
    + `<section class="panel"><div class="panel-heading"><h2>近期交付</h2><span class="muted small">项目内待办 · 按截止日期</span></div><div class="todo-list">${todo.map(task=>todoItem(task,`${esc(nameOf(task.ownerId))} · ${date(task.dueDate)}${overdue(task)?' · 已逾期':''}`)).join('') || empty('当前没有待交付任务','新建任务并安排日期后显示在这里。')}</div></section></div>`
    + `<section class="panel"><div class="panel-heading"><h2>项目里程碑</h2><span class="muted small">负责人：${esc(nameOf(project.ownerId))} · 目标交付 ${date(project.targetDate)}</span></div>${milestones.length?`<div class="milestone-list">${milestones.map(item=>`<div class="milestone${item.date&&item.date<now?' is-past':''}"><span>${esc(item.name || item.label)}</span><time>${date(item.date)}</time></div>`).join('')}</div>`:'<div class="panel-pad"><p class="muted small">暂无里程碑，可在编辑项目中设置。</p></div>'}</section>`;
}
function filterBar(type, count) {
  const statusValues = type === 'tasks' ? Object.keys(TASK_STATUS) : REQUEST_STATUS;
  return `<div class="table-toolbar"><div class="table-filters"><select id="status-filter" aria-label="按状态筛选"><option value="all">全部状态</option>${options(statusValues,ui.status,TASK_STATUS)}</select>${type==='requirements'?`<select id="priority-filter" aria-label="按优先级筛选"><option value="all">全部优先级</option>${options(['P0','P1','P2'],ui.priority)}</select>`:''}<label class="archive-toggle"><input id="archive-filter" type="checkbox"${ui.archived?' checked':''}><span>查看归档</span></label></div><div class="table-toolbar-meta"><span class="toolbar-count">${count} 项${ui.search ? '搜索结果' : ''}</span>${type==='tasks'?`<div class="segmented" role="group" aria-label="任务显示方式"><button data-layout="board" aria-pressed="${ui.taskLayout==='board'}" class="${ui.taskLayout==='board'?'active':''}">${icon('board')}看板</button><button data-layout="list" aria-pressed="${ui.taskLayout==='list'}" class="${ui.taskLayout==='list'?'active':''}">${icon('list')}列表</button></div>`:''}</div></div>`;
}
function filtered(type) { return scoped(type).filter(item => Boolean(item.archived) === ui.archived && matches(item) && (ui.status==='all'||(type==='tasks'?taskStage(item.status):item.status)===ui.status) && (type==='tasks'||ui.priority==='all'||item.priority===ui.priority)); }
function footer(count) { const pages=Math.max(1,Math.ceil(count/25)); ui.page=Math.min(ui.page,pages); return `<div class="table-footer"><span>共 ${count} 项</span><div class="pagination"><button class="btn btn-small btn-secondary" data-page="${ui.page-1}"${ui.page===1?' disabled':''}>上一页</button><span>${ui.page} / ${pages}</span><button class="btn btn-small btn-secondary" data-page="${ui.page+1}"${ui.page===pages?' disabled':''}>下一页</button></div></div>`; }
function requirementsView() {
  const list = filtered('requirements'), pages=Math.max(1,Math.ceil(list.length/25)); ui.page=Math.min(ui.page,pages);
  return heading('需求池','记录问题、明确验收标准，再将需求拆解为可交付的任务。',canEdit()?'<button class="btn btn-primary" data-action="new-requirement">'+icon('plus')+' 新建需求</button>':'',projectOf().name) + readonly() + `<section class="panel">${filterBar('requirements',list.length)}${list.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>需求</th><th>优先级</th><th>负责人</th><th>状态</th><th>计划截止</th><th>点数</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${list.slice((ui.page-1)*25,ui.page*25).map(item=>`<tr><td class="title-cell"><button class="item-title" data-requirement="${esc(item.id)}">${esc(item.title)}</button><div class="item-meta"><code>${esc(item.id)}</code><span>${esc(item.source || '未填写来源')}</span></div></td><td>${priority(item.priority)}</td><td>${person(item.assigneeId || item.ownerId)}</td><td>${badge(item.status)}</td><td class="${overdue(item)?'overdue-text':''}">${date(item.planEnd)}</td><td class="num-cell">${Number(item.estimatePoints||0)}</td><td class="action-cell"><button class="text-button" data-requirement="${esc(item.id)}">详情</button>${canEditEntity('requirements',item)?` <button class="text-button" data-edit-requirement="${esc(item.id)}">编辑</button>`:''}</td></tr>`).join('')}</tbody></table></div>${footer(list.length)}`:empty(ui.archived?'暂无归档需求':'没有符合条件的需求','尝试清除搜索或调整状态筛选。')}</section>`;
}
function readonly(view = 'requirements') {
  const role = projectRole();
  if (role === 'admin' || (role === 'product' && view === 'requirements') || (role === 'lead' && view === 'tasks')) return '';
  const text = {
    product: '研发任务由主开发拆分和分派；你可以查看任务进展，并在需求池维护需求与排期。',
    lead: '需求内容由产品经理维护。你负责指定主责开发、拆分和分派任务、安排排期。',
    developer: '你可推进本人任务，并在参与的需求下为自己补充任务；派给他人的任务由主开发拆分。',
    tester: '你负责验收测试中的任务和需求；退回开发时请写明原因。',
  }[role] || '你当前是只读权限；需要编辑时请联系项目负责人。';
  return `<p class="project-readonly">${text}</p>`;
}

function reviewButtons(kind,item) {
  const role=projectRole(item.projectId);
  if (!['tasks','requirements'].includes(kind)||item.archived||!(kind==='tasks'?can('reviewTask',item.projectId):['tester','admin'].includes(role))||taskStage(item.status)!=='test') return '';
  return `<button type="button" class="btn btn-small btn-secondary" data-review-kind="${kind}" data-review-id="${esc(item.id)}" data-review-status="${kind==='tasks'?'develop':'开发中'}">退回开发</button><button type="button" class="btn btn-small btn-primary" data-review-kind="${kind}" data-review-id="${esc(item.id)}" data-review-status="${kind==='tasks'?'done':'已完成'}">通过验收</button>`;
}
function taskCard(task) { const request=data.requirements.find(item=>item.id===task.requirementId), late=overdue(task); return `<article class="task-card${late?' is-overdue':''}"><div class="task-card-top"><span>${esc(task.id)}</span><span class="points">${Number(task.estimateHours||0)} 小时</span></div><button class="task-card-title" data-task="${esc(task.id)}">${esc(task.title)}</button>${request?`<div class="task-request">${icon('link')}<span>${esc(request.title)}</span></div>`:''}<div class="task-card-footer"><span class="owner">${person(task.ownerId)}</span><span class="due ${late?'overdue-text':'muted'}">${task.dueDate?date(task.dueDate):'未排期'}${late?' · 逾期':''}</span></div>${canEditEntity('tasks',task)&&!task.archived?`<select class="task-status-select" data-task-status="${esc(task.id)}" aria-label="${esc(task.title)}的状态">${taskOptions(task.status,task.projectId,task)}</select>`:''}${reviewButtons('tasks',task)?`<div class="task-review-actions">${reviewButtons('tasks',task)}</div>`:''}</article>`; }
function tasksView() {
  const list = filtered('tasks');
  const table = `<div class="table-wrap"><table class="data-table"><thead><tr><th>任务</th><th>负责人</th><th>状态</th><th>预估工时</th><th>开始 / 截止</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${list.map(task=>`<tr><td class="title-cell"><button class="item-title" data-task="${esc(task.id)}">${esc(task.title)}</button><div class="item-meta task-requirement-summary"><code>${esc(task.id)}</code><span>${esc(data.requirements.find(item=>item.id===task.requirementId)?.title || '未关联需求')}</span></div></td><td>${person(task.ownerId)}</td><td>${badge(task.status)}</td><td class="num-cell">${Number(task.estimateHours||0)} 小时</td><td class="${overdue(task)?'overdue-text':''}">${date(task.startDate)} — ${date(task.dueDate)}</td><td class="action-cell"><button class="text-button" data-task="${esc(task.id)}">${canEditEntity('tasks',task)?'编辑':'查看'}</button></td></tr>`).join('')}</tbody></table></div>`;
  const stages=Object.entries(TASK_STATUS).filter(([value])=>value!=='terminated'||list.some(item=>taskStage(item.status)==='terminated'));
  const board=`<div class="board">${stages.map(([value])=>{const items=list.filter(task=>taskStage(task.status)===value);return `<section class="board-column" data-stage="${value}"><div class="board-heading">${badge(value)}<span class="board-count">${items.length}</span></div>${items.map(taskCard).join('')||'<div class="board-empty">暂无任务</div>'}${canCreateTask()&&!ui.archived&&value==='wait'?`<button class="board-add text-button" data-new-task-status="${value}">${icon('plus')} 添加任务</button>`:''}</section>`;}).join('')}</div>`;
  return heading('研发任务','由主开发把需求拆成可交付的工作，明确负责人、状态与时间。',canCreateTask()?'<button class="btn btn-primary" data-action="new-task">'+icon('plus')+' 新建任务</button>':'',projectOf().name)+readonly('tasks')+(ui.taskLayout==='board'?`<section class="panel">${filterBar('tasks',list.length)}</section>${list.length?board:`<section class="panel">${empty('暂无符合条件的任务','调整筛选条件，或创建项目任务。')}</section>`}`:`<section class="panel">${filterBar('tasks',list.length)}${list.length?table:empty('暂无符合条件的任务','调整筛选条件，或创建项目任务。')}</section>`);
}
function timelineKey() { return `${user?.id||''}:${route.projectId}`; }
function timelineState() {
  if (!timelineStates.has(timelineKey())) timelineStates.set(timelineKey(), createTimelineState(today()));
  return timelineStates.get(timelineKey());
}
function timelineContext() { return {project:projectOf(),tasks:scoped('tasks').filter(item=>!item.archived),today:today()}; }
function updateTimeline(patch) { timelineStates.set(timelineKey(),{...timelineState(),...patch});renderView(); }
const dayText = day => new Date(Math.floor(day) * 86400000).toISOString().slice(0, 10);
const dayOf = value => { const stamp = Date.parse(value + 'T00:00:00Z'); return Number.isFinite(stamp) ? stamp / 86400000 : null; };
function timelineWidth() {
  const scroller = $('.schedule-scroll'), name = scroller && $('.schedule-chart .schedule-name', scroller);
  if (scroller?.clientWidth > 0 && name?.offsetWidth > 0) return scroller.clientWidth - name.offsetWidth;
  const view = $('#view')?.clientWidth, narrow = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches;
  return view > 0 ? view - 2 - (narrow ? 160 : 240) : 900;
}
function timelineGeometry(scroller) {
  const chart = scroller && $('.schedule-chart', scroller);
  if (!chart?.dataset) return null;
  const name = $('.schedule-name', chart);
  const geometry = { scroller, nameWidth: name?.offsetWidth || 0, start: Number(chart.dataset.extentStart), days: Number(chart.dataset.extentDays), px: Number(chart.dataset.px), fitPx: Number(chart.dataset.fitPx), maxPx: Number(chart.dataset.maxPx), fit: chart.dataset.fit === '1', today: chart.dataset.today === '' ? null : Number(chart.dataset.today) };
  geometry.width = (scroller.clientWidth || 0) - geometry.nameWidth;
  return geometry.width > 0 && [geometry.start, geometry.days, geometry.px].every(Number.isFinite) ? geometry : null;
}
const timelineDayAt = (geometry, offset) => geometry.start + (geometry.scroller.scrollLeft + offset) / geometry.px;
function syncTimelineChrome(geometry) {
  const { scroller } = geometry, label = $('[data-timeline-visible]');
  const first = Math.max(geometry.start, Math.floor(timelineDayAt(geometry, 0))), last = Math.min(geometry.start + geometry.days - 1, Math.ceil(timelineDayAt(geometry, geometry.width)) - 1);
  if (label) label.innerHTML = `${dayText(first)} <span>—</span> ${dayText(Math.max(first, last))}`;
  const prev = $('[data-action="timeline-prev"]'), next = $('[data-action="timeline-next"]');
  if (prev) prev.disabled = scroller.scrollLeft <= 1;
  if (next) next.disabled = scroller.scrollLeft >= scroller.scrollWidth - scroller.clientWidth - 1;
}
function positionTimeline() {
  const geometry = timelineGeometry($('.schedule-scroll')); if (!geometry) return;
  const state = timelineState();
  const fallback = Number.isFinite(geometry.today) ? geometry.today + .5 : null;
  const day = Number.isFinite(state.focusDay) ? state.focusDay : fallback;
  const offset = Number.isFinite(state.focusOffset) ? state.focusOffset : geometry.width / 2;
  geometry.scroller.scrollLeft = day === null ? 0 : (day - geometry.start) * geometry.px - offset;
  syncTimelineChrome(geometry);
}
function rememberTimeline(geometry) { timelineStates.set(timelineKey(), { ...timelineState(), focusDay: timelineDayAt(geometry, geometry.width / 2), focusOffset: geometry.width / 2 }); }
// Zoom keeps the day under the pointer (or the centre) fixed on screen.
function zoomTimeline(factor, offset) {
  const geometry = timelineGeometry($('.schedule-scroll')); if (!geometry) return;
  const at = Number.isFinite(offset) ? offset : geometry.width / 2;
  const next = Math.max(geometry.fitPx, Math.min(geometry.maxPx, geometry.px * factor));
  if (Math.abs(next - geometry.px) < geometry.px * .001) return;
  const fit = next <= geometry.fitPx * 1.001;
  updateTimeline({ zoom: fit ? null : next, fit, focusDay: timelineDayAt(geometry, at), focusOffset: at, ...(fit ? { returnZoom: timelineState().zoom ?? null, returnMode: timelineState().mode, returnDay: timelineDayAt(geometry, geometry.width / 2) } : {}) });
}
let timelineDrag = null, timelineDragged = false, timelineWheel = null;
function timelineView() {
  return heading('交付排期','从本周安排到完整项目周期，查看任务与里程碑。',(can('planRequirement')?'<button class="btn btn-secondary" data-action="schedule-batch">批量调整需求排期</button>':'')+(canCreateTask()?'<button class="btn btn-primary" data-action="new-task">'+icon('plus')+' 新建任务</button>':''),projectOf().name)
    + renderTimeline({state:timelineState(),...timelineContext(),users:data.users,query:ui.search,viewportWidth:timelineWidth()});
}
function membersView() {
  const members=data.memberships.filter(item=>item.projectId===route.projectId), editable=canManage(), ownerId=projectOf().ownerId;
  const roles=[['产品经理','上传文档、维护需求、组织评审、确认排期'],['主开发','指定主责开发，拆分和分派任务，安排排期'],['开发','推进本人任务，可在参与的需求下补充自己的任务'],['测试','验收测试中的任务和需求'],['观察者','只读查看项目内容'],['项目负责人','须为产品经理或主开发，负责管理项目信息与成员']];
  return heading('项目成员','成员权限只作用于当前项目；团队账号由系统管理员统一管理。','',projectOf().name)+`<div class="split"><section class="panel"><div class="panel-heading"><h2>成员列表 <span class="count-label">${members.length}</span></h2></div>${members.length?`<div class="table-wrap"><table class="data-table"><thead><tr><th>成员</th><th>项目角色</th><th>账号状态</th>${editable?'<th><span class="sr-only">操作</span></th>':''}</tr></thead><tbody>${members.map(member=>{const person=data.users.find(item=>item.id===member.userId);return `<tr><td><span class="person">${avatar(member.userId)}<span><strong class="member-title">${esc(person?.name || member.userId)}</strong>${member.userId===ownerId?' <span class="badge plain">项目负责人</span>':''}${person?.username?`<span class="item-meta">${esc(person.username)}</span>`:''}</span></span></td><td>${editable?`<select class="project-member-role" data-member-role="${esc(member.userId)}" aria-label="${esc(person?.name)}的项目角色">${options(Object.keys(MEMBER_ROLE),member.role,MEMBER_ROLE)}</select>`:`<span class="badge plain">${esc(MEMBER_ROLE[member.role]||member.role)}</span>`}</td><td>${accountStatus(person?.status)}</td>${editable?`<td class="action-cell"><button class="text-button danger" data-remove-member="${esc(member.userId)}">移出项目</button></td>`:''}</tr>`;}).join('')}</tbody></table></div>`:empty('项目尚无成员','项目负责人可添加已经创建的团队账号。')}</section>${editable?`<section class="panel member-add"><div class="panel-heading"><h2>添加项目成员</h2></div><div class="panel-pad"><form id="member-form"><div id="member-error" class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-field"><label for="member-user">团队账号</label><select id="member-user" name="userId" required><option value="">选择成员</option>${data.users.filter(person=>person.status!=='disabled'&&!members.some(item=>item.userId===person.id)).map(person=>`<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('')}</select></div><div class="form-field"><label for="member-role">项目角色</label><select id="member-role" name="role">${options(Object.keys(MEMBER_ROLE),'developer',MEMBER_ROLE)}</select></div><button class="btn btn-primary" type="submit">${icon('plus')} 添加成员</button></form><div class="role-description">${roles.map(([name,text])=>`<div><strong>${name}</strong><span>${text}</span></div>`).join('')}</div></div></section>`:''}</div>`;
}
function usersView() { const people=data.users.filter(matches); return heading('账号管理','创建团队账号，管理角色与访问状态。激活和重置链接由管理员手动交付。','<button class="btn btn-primary" data-action="new-user">'+icon('plus')+' 创建账号</button>','系统管理')+`<section class="panel"><div class="panel-heading"><h2>团队账号 <span class="count-label">${people.length}</span></h2></div><div class="table-wrap"><table class="data-table"><thead><tr><th>姓名 / 账号</th><th>系统角色</th><th>状态</th><th>密码要求</th><th><span class="sr-only">操作</span></th></tr></thead><tbody>${people.map(person=>`<tr><td><span class="person">${avatar(person.id)}<span><strong class="member-title">${esc(person.name)}</strong><span class="item-meta"><code>${esc(person.username || '—')}</code></span></span></span></td><td>${person.role==='admin'?'<span class="badge status-review">系统管理员</span>':''}${person.executive?' <span class="badge status-plan">管理层</span>':''}${person.role!=='admin'&&!person.executive?'<span class="badge plain">团队成员</span>':''}</td><td>${accountStatus(person.status)}</td><td class="${person.mustChangePassword?'':'muted'}">${person.mustChangePassword?'下次登录需改密':'—'}</td><td class="row-actions"><button class="text-button" data-edit-user="${esc(person.id)}">编辑</button> <button class="text-button" data-reset-user="${esc(person.id)}">重置密码</button></td></tr>`).join('')}</tbody></table></div></section>`; }
async function auditView() { $('#view').innerHTML=heading('操作记录','查看团队管理与项目业务变更记录。','','系统管理')+`<section class="panel">${empty('正在读取记录','请稍候…')}</section>`; try {const result=await api('/audit');if(route.view!=='audit')return;const entries=rows(result,'entries');$('#view').innerHTML=heading('操作记录','服务器记录的账号、项目和业务变更。','','系统管理')+`<section class="panel"><div class="panel-heading"><h2>最近操作</h2><span class="muted small">${entries.length} 条</span></div><div class="panel-pad history-list">${entries.map(historyRow).join('')||'<p class="muted small">暂无可显示的操作记录。</p>'}</div></section>`;}catch(error){presentError(error);}}
function historyRow(entry) {
  const labels={create:'创建',update:'修改',transition:'状态流转',archive:'归档',restore:'恢复',upload:'上传附件',set_member:'设置成员角色',remove_member:'移出成员',legacy_import:'导入原项目','auth.login':'登录','auth.logout':'退出登录','auth.login_failed':'登录失败','account.create':'创建账号','account.update':'修改账号','account.bootstrap_admin':'初始化管理员','account.issue_activation':'生成激活链接','account.issue_reset':'生成重置链接','account.activate':'激活账号','account.password_change':'修改密码','account.password_reset':'重置密码','account.cli_password_reset':'通过服务器终端重置密码','membership.set':'设置项目成员','membership.remove':'移出项目成员','schema.role_migration':'角色迁移'};
  const types={project:'项目',requirement:'需求',task:'任务',attachment:'附件',user:'账号',workspace:'团队',authentication:'身份验证'};
  const action=labels[entry.action] || '业务更新';
  const target=data.projects.find(item=>item.id===entry.entityId)?.name || [...data.requirements,...data.tasks].find(item=>item.id===entry.entityId)?.title || data.users.find(item=>item.id===entry.entityId)?.name || entry.entityId || '';
  const actor=entry.actorName || ((entry.actorId||entry.userId)?nameOf(entry.actorId||entry.userId):'系统');
  return renderAuditEntry(entry,{actor,stamp:time(entry.at||entry.createdAt||entry.timestamp),summary:entry.summary||entry.message||entry.description||(typeof entry.detail==='string'?entry.detail:`${action} · ${types[entry.entityType]||'记录'} ${target}`),nameOf});
}
function renderView() {
  workViewGeneration++;
  if (!user) return;
  if (route.projectId&&!projectOf()) { $('#view').innerHTML=empty('无法访问这个项目','项目可能已归档，或你的成员权限已变化。请从项目目录重新选择。')+'<a class="btn btn-secondary" href="#/projects">返回项目目录</a>'; return; }
  if (['users','audit','operations'].includes(route.view)&&!isAdmin()) { $('#view').innerHTML=empty('需要管理员权限','请联系系统管理员处理账号管理事项。');return; }
  if(route.view==='audit'){auditView();return;}
  if(['personal','notifications','reports','operations'].includes(route.view)){workView();return;}
  $('#view').innerHTML=({team:()=>teamView(false),projects:()=>teamView(true),overview:overviewView,requirements:requirementsView,tasks:tasksView,timeline:timelineView,members:membersView,users:usersView}[route.view]||(()=>teamView(false)))();
  if(route.view==='timeline')positionTimeline();
}

let workViewGeneration = 0, workSnapshot = null;
async function workView() {
  const view=route.view, generation=++workViewGeneration, actorId=user?.id;
  const current=()=>generation===workViewGeneration&&route.view===view&&user?.id===actorId;
  const descriptions={personal:'汇总你负责、协作和需要验收的事项。',notifications:'按当前项目权限提示交付风险；已读状态单独保存。',reports:'查看跨项目风险与真实完成记录，不补造历史日期。',operations:'查看自动备份的运行结果，或立即生成一次一致性备份。'};
  const actions='<button class="btn btn-secondary" data-action="refresh-work">刷新</button>'+(view==='operations'?'<button class="btn btn-primary" data-action="run-backup">立即备份</button>':'');
  const header=heading(VIEW_LABEL[view],descriptions[view],actions,view==='operations'?'系统管理':'团队空间');
  $('#view').innerHTML=header+'<div class="work-loading" role="status">正在读取最新内容…</div>';
  try {
    if(view==='operations') {
      const status=await api('/admin/backup-status');if(!current())return;
      const secondary={unconfigured:'未配置',pending:'待执行',ok:'已保存',failed:'保存失败'};
      $('#view').innerHTML=header+`<section class="panel"><div class="panel-heading"><h2>备份状态</h2><span class="badge">${status.running?'正在执行':status.enabled?'自动备份已启用':'自动备份未启用'}</span></div><div class="panel-pad"><dl class="detail-kv"><div><dt>最近尝试</dt><dd>${status.lastAttemptAt?esc(time(status.lastAttemptAt)):'尚未执行'}</dd></div><div><dt>最近成功</dt><dd>${status.lastSuccessAt?esc(time(status.lastSuccessAt)):'尚无成功记录'}</dd></div><div><dt>下次运行</dt><dd>${status.nextRunAt?esc(time(status.nextRunAt)):'尚未安排'}</dd></div><div><dt>第二备份目录</dt><dd>${esc(secondary[status.secondaryStatus]||(status.secondaryConfigured?'已配置':'未配置'))}</dd></div><div><dt>第二目录最近成功</dt><dd>${status.lastSecondarySuccessAt?esc(time(status.lastSecondarySuccessAt)):'尚无成功记录'}</dd></div><div><dt>连续失败次数</dt><dd>${Number(status.failureCount)||0}</dd></div></dl>${status.lastError?`<div class="notice notice-danger">最近备份异常，请联系服务器维护人员检查备份目录、可用空间和服务日志。错误编号：${esc(status.lastError)}</div>`:''}<p class="field-help">第二目录是否位于异地，需要由服务器维护人员核实。恢复前应先进行隔离恢复演练；此页面不会覆盖当前数据库。</p></div></section>`;
      return;
    }
    const result=await api(`/work?date=${today()}`);if(!current())return;
    workSnapshot=result;
    const context={projectName:id=>projectOf(id)?.name||'未知项目',nameOf};
    $('#view').innerHTML=header+(view==='personal'?renderPersonalWork(result,context):view==='notifications'?renderReminders(result,context):renderReports(result));
  } catch(error) {if(current()){ $('#view').innerHTML=header+empty('内容未能载入','请刷新重试；如果权限发生变化，请重新登录。');presentError(error);}}
}

function closeDialog() {
  if (batchDraft && $('#task-batch-form')) collectBatchDraft();
  if(dialog.open)dialog.close();
  document.body.classList.remove('dialog-open');
  transientToken='';
  if(selfResetPending){selfResetPending=false;user=null;setCsrf('');renderAuth('login','密码重置已启动，请通过刚才保存的链接设置密码后重新登录。');}
  if(attachmentObjectUrl){URL.revokeObjectURL(attachmentObjectUrl);attachmentObjectUrl='';}
  modalReturnFocus?.focus?.();
}
function openDialog(title, body, footer='', variant='drawer') {
  if(!dialog.open)modalReturnFocus=document.activeElement;
  dialog.className=variant==='drawer'?'':`is-${variant}`;
  dialog.innerHTML=`<div id="dialog-content"><div class="dialog-header"><h2 id="dialog-title">${esc(title)}</h2><button class="dialog-close" data-action="close-dialog" aria-label="关闭对话框">${icon('close')}</button></div>${body}${footer?`<div class="dialog-footer">${footer}</div>`:''}</div>`;
  if(!dialog.open)dialog.showModal();
  document.body.classList.add('dialog-open');
  requestAnimationFrame(()=>($('[autofocus]',dialog)||$('input,select,button',dialog))?.focus());
}
function formDialog(title,kind,id,fields,extra='',item=null,editable=true) {
  const archive=item&&editable&&(kind==='projects'?canManage(item.id):kind==='tasks'?can('assignTasks',item.projectId):canEdit(item.projectId))?`<button type="button" class="text-button danger" data-archive-kind="${kind}" data-archive-id="${esc(id)}">${icon('archive')} ${item.archived?'恢复':'归档'}</button>`:'';
  openDialog(title,`<form id="entity-form" data-kind="${kind}" data-id="${esc(id||'')}"><div class="dialog-body"><div id="form-error" class="form-error server-error" role="alert" tabindex="-1" hidden></div>${item?.archived?'<div class="notice notice-info">这条记录已归档。恢复后可重新纳入工作范围。</div>':''}<div class="form-grid">${fields}</div>${extra}</div><div class="dialog-footer">${archive}<div class="footer-buttons"><button type="button" class="btn btn-secondary" data-action="close-dialog">${editable?'取消':'关闭'}</button>${editable?'<button type="submit" class="btn btn-primary">保存</button>':''}${item?reviewButtons(kind,item):''}</div></div></form>`);
  if(!editable)for(const control of dialog.querySelectorAll('input,textarea,select'))control.disabled=true;
}
function editProject(id='') {
  const item=id?data.projects.find(project=>project.id===id):null;
  const milestoneText=(item?.milestones||[]).map(m=>`${m.name||m.label} | ${m.date||''}`).join('\n');
  const fields=[field('项目名称 <span class="required">*</span>','name',input('name',item?.name||'','required maxlength="120" autofocus'),true),field('项目说明','description',area('description',item?.description||'','rows="3" maxlength="4000"'),true),field('项目负责人','ownerId',select('ownerId',(item?data.users.filter(person=>person.id===item.ownerId||data.memberships.some(member=>member.projectId===item.id&&member.userId===person.id&&OWNER_ROLES.includes(member.role))):data.users.filter(person=>person.status!=='disabled')).map(person=>`<option value="${esc(person.id)}"${(item?.ownerId||user.id)===person.id?' selected':''}>${esc(person.name)}</option>`).join('')),false,item?'只能从本项目的产品经理或主开发中选择。':''),...(item?[]:[field('负责人项目角色','ownerRole',select('ownerRole',options(OWNER_ROLES,'product',MEMBER_ROLE)),false,'负责人会以该角色加入项目。')]),field('项目状态','status',select('status',options([...new Set(['规划中','进行中','已完成','已终止',item?.status].filter(Boolean))],item?.status||'规划中'))),field('开始日期','startDate',input('startDate',item?.startDate||'','type="date"')),field('目标日期','targetDate',input('targetDate',item?.targetDate||'','type="date"')),field('里程碑','milestones',area('milestones',milestoneText,'rows="4" placeholder="需求确认 | 2026-10-01\n上线交付 | 2026-10-20"'),true,'每行一项：名称 | 年-月-日；清空将移除全部里程碑。')].join('');
  formDialog(item?'编辑项目':'新建项目','projects',id,fields,'',item,item?canManage(id):isAdmin());
}
function editRequirement(id='') {
  const item=id?data.requirements.find(req=>req.id===id):null;
  const projectId=item?.projectId||route.projectId;
  const editable=item?canEditEntity('requirements',item):canEdit(projectId), people=projectUsers(projectId);
  for(const collaboratorId of item?.collaboratorIds||[]){const person=data.users.find(p=>p.id===collaboratorId);if(person&&!people.some(p=>p.id===person.id))people.push(person);}
  const fields=[field('需求标题 <span class="required">*</span>','title',input('title',item?.title||'','required maxlength="200" autofocus'),true),field('优先级','priority',select('priority',options(['P0','P1','P2'],item?.priority||'P1'))),field('状态','status',select('status',item?requirementOptions(item):options(['未确定'],'未确定'))),field('主责开发','assigneeId',select('assigneeId',personOptions(item?.assigneeId||'',projectId,['lead','developer']))),field('需求点数','estimatePoints',input('estimatePoints',item?.estimatePoints??0,'type="number" min="0" max="1000" step="0.5"')),field('计划开始','planStart',input('planStart',item?.planStart||'','type="date"')),field('计划截止','planEnd',input('planEnd',item?.planEnd||'','type="date"')),field('需求来源','source',input('source',item?.source||'','maxlength="160" placeholder="例如：客户反馈、产品规划"'),true),field('背景与目标','description',area('description',item?.description||'','rows="3" maxlength="10000"'),true),field('验收标准','acceptance',area('acceptance',item?.acceptance||'','rows="3" maxlength="10000"'),true),`<fieldset class="form-field full-width collaborator-field"><legend>前置需求</legend><p class="field-help">前置需求全部完成后，当前需求才可进入开发中。</p><div class="checklist dependency-list">${data.requirements.filter(req=>req.projectId===projectId&&req.id!==item?.id&&(!req.archived||(item?.dependencyIds||[]).includes(req.id))).map(req=>`<label><input type="checkbox" name="dependencyIds" value="${esc(req.id)}"${item?.dependencyIds?.includes(req.id)?' checked':''}><span>${esc(req.title)} · ${esc(req.status)}${req.archived?'（已归档）':''}</span></label>`).join('')||'<span class="muted small">暂无其他需求</span>'}</div></fieldset>`,`<fieldset class="form-field full-width collaborator-field"><legend>协作成员</legend><div class="checklist">${people.map(person=>`<label><input type="checkbox" name="collaboratorIds" value="${esc(person.id)}"${item?.collaboratorIds?.includes(person.id)?' checked':''}><span>${esc(person.name)}</span></label>`).join('')||'<span class="muted small">项目暂无可选成员</span>'}</div></fieldset>`].join('');
  formDialog(item?'编辑需求':'新建需求','requirements',id,fields + (item ? field('流转说明','reason',area('reason','','rows="2" maxlength="1000"'),true,'终止或退回开发时必填；其他状态可补充说明。') : '') + (item && can('planRequirement',projectId) ? '<label class="checkbox-label full-width schedule-override"><input type="checkbox" name="force" value="1"><span>我已确认本次排期可以超过项目目标日期</span></label>' : ''),item?`${workflowHints(item)}${renderBaseline(item)}<div class="field-help form-meta">创建人：${esc(nameOf(item.ownerId))} · 创建日期：${date(item.createdAt)} · 调整排期 ${Number(item.rescheduleCount||0)} 次</div>`:'',item,editable);
  $('#entity-form').dataset.projectId=projectId;
  if(editable) lockFields('requirements',item,projectId);
}
function editTask(id='',preset={}) {
  const item=id?data.tasks.find(task=>task.id===id):null;
  const projectId=item?.projectId||preset.projectId||route.projectId;
  const editable=item?canEditEntity('tasks',item):canCreateTask(projectId), reqs=data.requirements.filter(req=>req.projectId===projectId&&(item?(!req.archived||req.id===item.requirementId):canSplit(req)));
  const fields=[field('任务标题 <span class="required">*</span>','title',input('title',item?.title||'','required maxlength="200" autofocus'),true),field('关联需求 <span class="required">*</span>','requirementId',select('requirementId',(item&&!item.requirementId?'<option value="">未关联需求</option>':'<option value="">选择需求</option>')+reqs.map(req=>`<option value="${esc(req.id)}"${(item?.requirementId||preset.requirementId)===req.id?' selected':''}>${esc(req.title)}</option>`).join('')),true),field('负责人','ownerId',select('ownerId',personOptions(item?.ownerId||(can('assignTasks',projectId)?'':user.id),projectId))),field('任务状态','status',select('status',item?taskOptions(item.status,projectId,item):options(['wait'],'wait',TASK_STATUS))),field('开始日期','startDate',input('startDate',item?.startDate||'','type="date"')),field('截止日期','dueDate',input('dueDate',item?.dueDate||'','type="date"')),field('预估工时','estimateHours',input('estimateHours',item?.estimateHours??0,'type="number" min="0" max="100000" step="0.5"'),true,'按小时填写；与需求点数分别统计。已完成状态由测试或主开发确认。'),`<fieldset class="form-field full-width collaborator-field"><legend>前置任务</legend><p class="field-help">前置任务全部完成后才可开始开发；不能依赖自己或形成循环。</p><div class="checklist dependency-list">${data.tasks.filter(task=>task.projectId===projectId&&task.id!==item?.id&&(!task.archived||(item?.dependencyIds||[]).includes(task.id))).map(task=>`<label><input type="checkbox" name="dependencyIds" value="${esc(task.id)}"${item?.dependencyIds?.includes(task.id)?' checked':''}><span>${esc(task.title)} · ${esc(TASK_STATUS[taskStage(task.status)]||task.status)}${task.archived?'（已归档）':''}</span></label>`).join('')||'<span class="muted small">暂无其他任务</span>'}</div></fieldset>`].join('');
  formDialog(item?(editable?'编辑任务':'任务详情'):'新建任务','tasks',id,fields+(item?field('流转说明','reason',area('reason','','rows="2" maxlength="1000"'),true,'终止时需由主开发填写原因。'):''),'',item,editable);
  $('#entity-form').dataset.projectId=projectId;
  if(editable) lockFields('tasks',item,projectId);
  if(!item) $('select[name="requirementId"]',dialog)?.setAttribute('required','');
}
async function requirementDetails(id) {
  const item=data.requirements.find(req=>req.id===id);if(!item)return;
  const linked=data.tasks.filter(task=>task.requirementId===id&&!task.archived);
  openDialog('需求详情',`<div class="dialog-body" data-detail-id="${esc(id)}"><div class="detail-hero"><span class="detail-hero-id">${esc(item.id)} · ${esc(projectOf(item.projectId)?.name||'')}</span><h3>${esc(item.title)}</h3><div class="detail-summary">${priority(item.priority,true)}${badge(item.status)}${item.archived?'<span class="badge plain">已归档</span>':''}</div></div><dl class="detail-kv"><div><dt>主责开发</dt><dd>${item.assigneeId?person(item.assigneeId):'<span class="muted">待主开发指定</span>'}</dd></div><div><dt>需求点数</dt><dd>${Number(item.estimatePoints||0)}</dd></div><div><dt>来源</dt><dd>${esc(item.source||'未填写')}</dd></div><div><dt>计划开始</dt><dd>${date(item.planStart)}</dd></div><div><dt>计划截止</dt><dd class="${overdue(item)?'overdue-text':''}">${date(item.planEnd)}</dd></div><div><dt>创建人 / 日期</dt><dd>${esc(nameOf(item.ownerId))} · ${date(item.createdAt)}</dd></div></dl>${renderBaseline(item)}${workflowHints(item)}<section class="detail-section"><h3>背景与目标</h3><p class="detail-copy">${esc(item.description||'尚未填写')}</p></section><section class="detail-section"><h3>验收标准</h3><p class="detail-copy">${esc(item.acceptance||'尚未填写')}</p></section><section class="detail-section"><h3>关联任务 <span class="count-label">${linked.length}</span></h3><div class="linked-tasks">${linked.map(task=>`<div class="linked-task"><span class="person">${avatar(task.ownerId,'xs')}<button class="item-title" data-task="${esc(task.id)}">${esc(task.title)}</button></span>${badge(task.status)}</div>`).join('')||'<p class="muted small">暂无关联任务</p>'}</div><div class="detail-actions">${canSplit(item)?`<button class="btn btn-secondary btn-small" data-linked-task="${esc(id)}">${icon('plus')} 新建关联任务</button>`:''}${canSplit(item)?`<button class="btn btn-secondary btn-small" data-batch-requirement="${esc(id)}">${icon('list')} 批量拆分任务</button>`:''}</div></section><section class="detail-section"><h3>文档与原型</h3><div id="attachment-list" class="attachment-list"><p class="muted small">正在读取附件…</p></div>${can('uploadDocument',item.projectId)&&!item.archived?`<form id="attachment-form" data-id="${esc(id)}"><div class="upload-row"><label class="sr-only" for="attachment-file">选择上传文件</label><input id="attachment-file" type="file" name="file" accept=".txt,.md,.markdown,.html,.htm,.json" required><button class="btn btn-secondary btn-small" type="submit">上传附件</button></div><p class="field-help">同名同类型附件将保存为新版本，历史内容保留。单个文件最多 2 兆字节；网页原型在受限预览中打开。</p><div id="attachment-error" class="form-error" role="alert" hidden></div></form>`:''}</section><section class="detail-section"><h3>变更记录</h3><div id="requirement-history" class="history-list"><p class="muted small">正在读取记录…</p></div></section></div>`,`<button class="btn btn-secondary" data-action="close-dialog">关闭</button>${reviewButtons('requirements',item)}${canEditEntity('requirements',item)?`<button class="btn btn-primary" data-edit-requirement="${esc(id)}">${icon('edit')} 编辑需求</button>`:''}`);
  const results=await Promise.allSettled([api(`/requirements/${encode(id)}/attachments`),api(`/requirements/${encode(id)}/history`)]);
  if($('.dialog-body',dialog)?.dataset.detailId!==id)return;
  const [attachments,history]=results;
  for(const [key,file] of attachmentMeta)if(file.requirementId===id)attachmentMeta.delete(key);
  if(attachments.status==='fulfilled') {const files=rows(attachments.value,'attachments');files.forEach(file=>attachmentMeta.set(file.id,file));$('#attachment-list').innerHTML=files.map(file=>`<div class="attachment-item">${icon('document')}<span>${esc(file.name)} <small class="badge">版本 ${file.version}</small>${file.size?`<small class="item-meta">${Math.ceil(file.size/1024)} 千字节</small>`:''}</span><div class="attachment-actions"><button class="text-button" data-attachment-history="${esc(file.id)}">历史版本</button><button class="text-button" data-preview-attachment="${esc(file.id)}">查看</button><button class="text-button" data-download-attachment="${esc(file.id)}">下载</button></div></div>`).join('')||'<p class="muted small">暂无附件。</p>';}else $('#attachment-list').innerHTML=`<p class="overdue-text small">${esc(attachments.reason.message)}</p>`;
  if(history.status==='fulfilled')$('#requirement-history').innerHTML=rows(history.value,'entries').map(historyRow).join('')||'<p class="muted small">暂无变更记录。</p>';else $('#requirement-history').innerHTML=`<p class="overdue-text small">${esc(history.reason.message)}</p>`;
}
async function attachment(id,download=false) {
  try {
    const response=await fetch(`/api/attachments/${encode(id)}`,{credentials:'same-origin'});
    if(!response.ok){let result={};try{result=await response.json();}catch(_){}throw new ApiError(result.error||'附件无法读取。',response.status,result.code);}
    const file={...(attachmentMeta.get(id)||{})};
    const disposition=response.headers.get('Content-Disposition')||'';
    const encodedName=disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const plainName=disposition.match(/filename="?([^";]+)"?/i);
    if(!file.name){try{file.name=encodedName?decodeURIComponent(encodedName[1]):plainName?.[1]||'附件';}catch(_){file.name='附件';}}
    const bytes=new Uint8Array(await response.arrayBuffer());
    const mime=response.headers.get('Content-Type')||file.mime||'application/octet-stream';
    if(download){const url=URL.createObjectURL(new Blob([bytes],{type:mime}));const link=document.createElement('a');link.href=url;link.download=file.name||'附件';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    if(/html/i.test(mime)||/\.html?$/i.test(file.name||'')) {
      // Sandboxed document intentionally has no same-origin privilege or script
      // permission: uploaded prototypes cannot read cookies or application data.
      openDialog(file.name||'原型预览',`<div class="dialog-body"><p class="notice notice-info">静态原型预览；脚本与外部访问已限制。可下载原文件用于进一步检查。</p><iframe id="prototype-frame" class="attachment-frame" sandbox="" referrerpolicy="no-referrer" title="附件原型预览"></iframe></div>`,`<button class="btn btn-secondary" data-action="close-dialog">关闭</button><button class="btn btn-primary" data-download-attachment="${esc(id)}">下载原文件</button>`,'wide');
      const content=new TextDecoder().decode(bytes);
      $('#prototype-frame').srcdoc=`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'; connect-src 'none'">${content}`;
    } else if(/markdown/i.test(mime)||/\.(md|markdown)$/i.test(file.name||'')) {
      openDialog(file.name||'文档预览',`<div class="dialog-body">${renderDocumentPreview(new TextDecoder().decode(bytes))}</div>`,`<button class="btn btn-secondary" data-action="close-dialog">关闭</button><button class="btn btn-primary" data-download-attachment="${esc(id)}">下载原文件</button>`,'wide');
    } else if(mime.startsWith('text/')||/\.(txt|csv|json|log)$/i.test(file.name||'')) {
      openDialog(file.name||'文档预览',`<div class="dialog-body"><pre class="attachment-text">${esc(new TextDecoder().decode(bytes))}</pre></div>`,`<button class="btn btn-secondary" data-action="close-dialog">关闭</button><button class="btn btn-primary" data-download-attachment="${esc(id)}">下载文件</button>`,'wide');
    } else openDialog(file.name||'附件',`<div class="dialog-body">${empty('此文件不支持在线预览','下载后使用对应应用打开。')}</div>`,`<button class="btn btn-secondary" data-action="close-dialog">关闭</button><button class="btn btn-primary" data-download-attachment="${esc(id)}">下载文件</button>`,'center');
  } catch(error){presentError(error);}
}
function editUser(id='') {
  const item=id?data.users.find(person=>person.id===id):null;
  const fields=[field('姓名 <span class="required">*</span>','name',input('name',item?.name||'','required maxlength="80" autofocus')),field('登录账号 <span class="required">*</span>','username',input('username',item?.username||'',`required maxlength="64" autocomplete="off"${item?' readonly':''}`)),field('系统角色','role',select('role',options(['member','admin'],item?.role||'member',{member:'团队成员',admin:'系统管理员'}))),field('管理层','executive',select('executive',options(['0','1'],item?.executive?'1':'0',{'0':'否','1':'是 · 只读查看全部项目'})),false,'管理层无需加入项目即可查看全部项目的进度与排期，不能修改任何内容。'),...(item?[field('账号状态','status',select('status',options([...new Set(['active','disabled',item.status].filter(Boolean))],item.status,{active:'已启用',disabled:'已禁用',pending:'待激活',invited:'待激活'})))]:[])].join('');
  formDialog(item?'编辑账号':'创建团队账号','users',id,fields,item?'':`<div class="notice notice-info form-meta">创建后会生成一次性激活链接。请复制并通过你们约定的渠道交给本人；系统不会自动发送消息。</div>`,null,true);
}
let batchDraft = null;
let scheduleDraft = null;
const batchDraftKey = id => `xinghe:batch:${user.id}:${id}`;
function persistBatchDraft() {
  if (!batchDraft) return;
  try { sessionStorage.setItem(batchDraftKey(batchDraft.requirementId), JSON.stringify(batchDraft)); } catch (_) {}
}
function collectBatchDraft(changed = false) {
  const form = $('#task-batch-form');
  if (!batchDraft || !form) return;
  batchDraft.tasks = readBatchForm(form);
  if (changed) batchDraft.requestId = crypto.randomUUID();
  persistBatchDraft();
}
function openTaskBatch(requirementId) {
  const requirement = data.requirements.find(item => item.id === requirementId);
  if (!requirement || !canSplit(requirement)) throw new Error('任务由主开发拆分；开发只能在参与的需求下补充自己的任务。');
  const ownerId = can('assignTasks', requirement.projectId) ? requirement.assigneeId || '' : user.id;
  let stored;
  try { stored = JSON.parse(sessionStorage.getItem(batchDraftKey(requirementId))); } catch (_) {}
  const valid = stored && stored.requirementId === requirementId && Number.isSafeInteger(stored.version) && Array.isArray(stored.tasks) && stored.tasks.length > 0 && stored.tasks.length <= 100 && stored.tasks.every(task=>task && typeof task==='object' && !Array.isArray(task));
  batchDraft = {
    requirementId, projectId: requirement.projectId, ownerId,
    version: valid ? stored.version : requirement.version,
    requestId: valid && /^[a-zA-Z0-9_-]{8,100}$/.test(stored.requestId) ? stored.requestId : crypto.randomUUID(),
    tasks: valid ? stored.tasks.map(task => ({title: String(task.title || '').slice(0,200), ownerId: String(task.ownerId || ''), estimateHours: Number(task.estimateHours), startDate: String(task.startDate || '').slice(0,10), dueDate: String(task.dueDate || '').slice(0,10)})) : [blankTask(ownerId)]
  };
  renderTaskBatch();
}
function renderTaskBatch() {
  const requirement = data.requirements.find(item => item.id === batchDraft.requirementId);
  const fixedOwner = can('assignTasks', batchDraft.projectId) ? '' : user.id;
  openDialog('批量拆分任务', `<form id="task-batch-form"><div class="dialog-body"><p class="form-intro">${esc(requirement.title)}。全部任务一起校验、一起保存；失败时草稿保留。估算粒度提示不会阻止提交。</p><div id="form-error" class="form-error" role="alert" tabindex="-1" hidden></div><div id="batch-rows">${renderBatchRows(batchDraft.tasks,projectUsers(batchDraft.projectId),{fixedOwner})}</div><button type="button" class="btn btn-secondary btn-small" data-action="add-batch-task"${batchDraft.tasks.length >= 100 ? ' disabled' : ''}>添加一行</button><p id="batch-summary" class="batch-summary">${renderBatchSummary(batchDraft.tasks)}</p></div><div class="dialog-footer"><button type="button" class="btn btn-secondary" data-action="close-dialog">保存草稿并关闭</button><button type="submit" class="btn btn-primary">提交全部任务</button></div></form>`);
  persistBatchDraft();
}
async function submitTaskBatch(form) {
  collectBatchDraft();
  try {
    const result = await api(`/requirements/${encode(batchDraft.requirementId)}/task-batch`, {method:'POST',body:{version:batchDraft.version,requestId:batchDraft.requestId,tasks:batchDraft.tasks}});
    const id = batchDraft.requirementId;
    try { sessionStorage.removeItem(batchDraftKey(id)); } catch (_) {}
    batchDraft = null;
    closeDialog(); await reload(); renderShell(); await requirementDetails(id);
    toast(`已${result.replayed ? '确认' : '创建'} ${result.tasks.length} 个任务。`);
    if (result.warnings?.length) $('#page-alert').innerHTML = `<div class="notice notice-info">任务已保存，以下是估算建议：${renderErrorDetails(result.warnings)}</div>`;
  } catch (error) {
    presentError(error, $('#form-error',form));
    if (error.code === 'VERSION_CONFLICT') $('#form-error',form).innerHTML = `<p>需求已被修改。当前草稿已保留，请先核对最新需求，再决定是否提交。</p><button type="button" class="text-button" data-action="reload-batch-version">载入最新版本并保留草稿</button>`;
  }
}
async function attachmentHistory(id) {
  const result = await api(`/attachments/${encode(id)}/versions`);
  const versions = rows(result,'versions');
  versions.forEach(file => attachmentMeta.set(file.id,file));
  const current = attachmentMeta.get(id);
  const options = versions.map(file=>`<option value="${esc(file.id)}">版本 ${file.version}${file.historical?' · 原系统历史':''}</option>`).join('');
  openDialog(current?.name || '附件历史版本', `<div class="dialog-body"><p class="form-intro">每个版本独立保留。编号按保存顺序排列；补录历史的日期可能早于现用版本，且不会替换当前文件。</p>${versions.map(file=>`<article class="attachment-version"><div><strong>版本 ${file.version}${file.historical?' · 原系统历史':''}</strong><p>${time(file.createdAt)} · ${esc(file.actor?.name || nameOf(file.createdBy))} · ${Math.ceil(file.size/1024)} 千字节</p></div><div class="attachment-actions"><button class="text-button" data-preview-attachment="${esc(file.id)}">查看此版</button><button class="text-button" data-download-attachment="${esc(file.id)}">下载</button></div></article>`).join('')}${versions.length > 1 ? `<div class="version-compare-controls"><label for="compare-before">对照版本<select id="compare-before">${options}</select></label><label for="compare-after">目标版本<select id="compare-after">${options}</select></label><button class="btn btn-secondary" data-action="compare-attachment-versions">对照文本内容</button></div>` : ''}<div id="form-error" class="form-error" role="alert" hidden></div></div>`, '<button class="btn btn-secondary" data-action="close-dialog">关闭</button>');
  if (versions.length > 1) { const target=versions.find(file=>file.id===id)||versions[0]; const other=versions.filter(file=>file.id!==target.id).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0]; $('#compare-before').value=other.id; $('#compare-after').value=target.id; }
}
async function compareAttachments() {
  const before = $('#compare-before').value, after = $('#compare-after').value;
  if (before === after) throw new Error('请选择两个不同版本。');
  const read = async id => { const response=await fetch(`/api/attachments/${encode(id)}`,{credentials:'same-origin'}); if(!response.ok)throw new Error('附件读取失败，请重新登录或检查权限。');return new TextDecoder().decode(await response.arrayBuffer()); };
  const [left,right] = await Promise.all([read(before),read(after)]);
  openDialog('附件版本对照',`<div class="dialog-body">${renderTextComparison(left,right)}</div>`,'<button class="btn btn-secondary" data-action="close-dialog">关闭</button>','wide');
}
function openScheduleBatch() {
  const requirements = scoped('requirements').filter(item => !item.archived && !['已完成','已终止'].includes(item.status));
  if (!can('planRequirement') || !requirements.length) throw new Error('当前项目没有可调整的需求。');
  scheduleDraft = {projectId:route.projectId,requirements,preview:null};
  openDialog('批量调整需求排期',`<form id="schedule-batch-form"><div class="dialog-body"><p class="form-intro">填写需要调整的日期。先预览全部变更，再一次提交；任务日期保持独立，需要在任务中安排。</p><div id="form-error" class="form-error" role="alert" hidden></div>${requirements.map((item,index)=>`<fieldset class="batch-task" data-schedule-row="${esc(item.id)}"><legend>${esc(item.title)}</legend><div class="form-grid"><div class="form-field"><label for="schedule-start-${index}">计划开始</label><input id="schedule-start-${index}" type="date" data-schedule-field="planStart" value="${esc(item.planStart||'')}"></div><div class="form-field"><label for="schedule-end-${index}">计划截止</label><input id="schedule-end-${index}" type="date" data-schedule-field="planEnd" value="${esc(item.planEnd||'')}"></div></div></fieldset>`).join('')}<div class="form-field"><label for="schedule-reason">调整原因 <span class="required">*</span></label><textarea id="schedule-reason" name="reason" maxlength="1000" required rows="2"></textarea></div></div><div class="dialog-footer"><button type="button" class="btn btn-secondary" data-action="close-dialog">取消</button><button class="btn btn-primary" type="submit">预览变更</button></div></form>`);
}
async function previewScheduleBatch(form) {
  const changes = [...form.querySelectorAll('[data-schedule-row]')].map(row=>({requirementId:row.dataset.scheduleRow,version:scheduleDraft.requirements.find(item=>item.id===row.dataset.scheduleRow).version,...Object.fromEntries([...row.querySelectorAll('[data-schedule-field]')].map(input=>[input.dataset.scheduleField,input.value]))})).filter(change=>{const old=scheduleDraft.requirements.find(item=>item.id===change.requirementId);return change.planStart!==(old.planStart||'')||change.planEnd!==(old.planEnd||'');});
  if (!changes.length) throw new Error('尚未调整任何日期。');
  if(changes.length>100)throw new Error('每次最多调整 100 条需求，请分批处理。');
  const reason=$('#schedule-reason',form).value.trim();
  if (!reason) throw new Error('请填写调整原因。');
  const result=await api(`/projects/${encode(scheduleDraft.projectId)}/schedule/preview`,{method:'POST',body:{changes}});
  scheduleDraft={...scheduleDraft,changes,reason,preview:result};
  openDialog('确认排期变更',`<div class="dialog-body"><p class="form-intro">将调整 ${result.changes.filter(item=>item.changed).length} 条需求。提交时会再次检查全部版本；任何冲突都会停止整批变更。</p><div class="table-wrap"><table class="change-table"><thead><tr><th>需求</th><th>原排期</th><th>新排期</th></tr></thead><tbody>${result.changes.map(item=>`<tr><th scope="row">${esc(item.title)}</th><td>${esc(item.before.planStart||'未设置')} — ${esc(item.before.planEnd||'未设置')}</td><td>${esc(item.after.planStart||'未设置')} — ${esc(item.after.planEnd||'未设置')}</td></tr>`).join('')}</tbody></table></div><p class="field-help">调整原因：${esc(reason)}</p>${result.warnings.length?`<div class="notice notice-info">${renderErrorDetails(result.warnings)}</div>`:''}${result.requiresConfirmation?`<label class="checkbox-label schedule-override"><input id="schedule-force" type="checkbox"><span>确认这些排期可以超过项目目标日期</span></label>`:''}<div id="form-error" class="form-error" role="alert" hidden></div></div>`,'<button class="btn btn-secondary" data-action="close-dialog">取消</button><button class="btn btn-primary" data-action="apply-schedule-batch">提交全部变更</button>');
}
async function applyScheduleBatch(button) {
  if(!scheduleDraft?.preview)throw new Error('请先预览变更。');
  if(scheduleDraft.preview.requiresConfirmation&&!$('#schedule-force')?.checked)throw new Error('请确认超出项目目标的排期。');
  busy(button,true);
  const result=await api(`/projects/${encode(scheduleDraft.projectId)}/schedule/apply`,{method:'POST',body:{changes:scheduleDraft.changes,previewToken:scheduleDraft.preview.previewToken,reason:scheduleDraft.reason,force:Boolean($('#schedule-force')?.checked)}});
  scheduleDraft=null;closeDialog();await reload();renderShell();toast(`已调整 ${result.changedCount} 条需求的排期。`);
}

function showToken(result,title='一次性账号链接') {
  const token=result.activationToken||result.token;
  if(!token){toast('操作成功，但服务器没有返回可用链接。',true);return;}
  transientToken=String(token);
  const link=`${location.origin}${location.pathname}#activate=${encode(transientToken)}`;
  openDialog(title,`<div class="dialog-body"><p>账号：<strong>${esc(result.user?.name||result.user?.username||'团队成员')}</strong></p><div class="notice notice-info">此链接只在当前窗口显示一次。请现在复制并手动交给本人，关闭后将无法再次查看。</div><div class="token-box"><label class="sr-only" for="one-time-link">一次性激活或重置链接</label><input id="one-time-link" readonly value="${esc(link)}"><p>有效期至：${time(result.expiresAt)}。完成使用后链接立即失效。</p></div></div>`,`<button class="btn btn-secondary" data-action="close-dialog">已保存，关闭</button><button class="btn btn-primary" data-action="copy-token">复制链接</button>`,'center');
}
function passwordDialog() {
  openDialog('修改我的密码',`<form id="password-form"><div class="dialog-body"><p class="form-intro">修改后所有登录会话都会失效，请使用新密码重新登录。</p><div id="form-error" class="form-error" role="alert" tabindex="-1" hidden></div><div class="form-grid">${field('当前密码','currentPassword',input('currentPassword','','type="password" autocomplete="current-password" required autofocus'),true)}${field('新密码','newPassword',input('newPassword','','type="password" autocomplete="new-password" required minlength="6" maxlength="128"'),true)}${field('确认新密码','confirmPassword',input('confirmPassword','','type="password" autocomplete="new-password" required minlength="6" maxlength="128"'),true)}</div><p class="password-rules is-spaced">密码至少 6 个字符。</p></div><div class="dialog-footer"><button type="button" class="btn btn-secondary" data-action="close-dialog">取消</button><button type="submit" class="btn btn-primary">确认修改</button></div></form>`,'','center');
}
function confirmAction(title,message,action,attributes='') { openDialog(title,`<div class="dialog-body"><p>${esc(message)}</p><div id="form-error" class="form-error" role="alert" tabindex="-1" hidden></div></div>`,`<button class="btn btn-secondary" data-action="close-dialog">取消</button><button class="btn btn-primary" data-action="${action}" ${attributes}>确认</button>`,'center'); }
async function saveEntity(form) {
  const kind=form.dataset.kind,id=form.dataset.id,values=Object.fromEntries(new FormData(form)),item=id?data[kind].find(record=>record.id===id):null;
  let payload;
  if(kind==='requirements')payload={title:values.title,description:values.description,acceptance:values.acceptance,priority:values.priority,status:values.status,assigneeId:values.assigneeId||null,collaboratorIds:new FormData(form).getAll('collaboratorIds'),dependencyIds:new FormData(form).getAll('dependencyIds'),estimatePoints:Number(values.estimatePoints),planStart:values.planStart||'',planEnd:values.planEnd||'',source:values.source,...(!item?{projectId:form.dataset.projectId,ownerId:user.id}:{})};
  if(kind==='tasks')payload={title:values.title,requirementId:values.requirementId||null,ownerId:values.ownerId||null,status:item&&(!values.status||taskStage(item.status)===values.status)?item.status:values.status,startDate:values.startDate||'',dueDate:values.dueDate||'',estimateHours:Number(values.estimateHours),dependencyIds:new FormData(form).getAll('dependencyIds'),...(!item?{projectId:form.dataset.projectId}:{})};
  if(kind==='projects') {
    const milestones=values.milestones.split('\n').map(line=>line.trim()).filter(Boolean).map((line,index)=>{const split=line.lastIndexOf('|');if(split<1)throw new Error(`第 ${index+1} 个里程碑需使用「名称 | 年-月-日」。`);const name=line.slice(0,split).trim(),day=line.slice(split+1).trim();if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error(`第 ${index+1} 个里程碑的日期格式不正确。`);const old=(item?.milestones||[]).find(m=>(m.label||m.name)===name);return {label:name,date:day,kind:old?.kind||'checkpoint'};});
    payload={name:values.name,description:values.description,ownerId:values.ownerId||null,status:values.status,startDate:values.startDate||'',targetDate:values.targetDate||'',milestones,...(!item&&values.ownerRole?{ownerRole:values.ownerRole}:{})};
  }
  if(kind==='users')payload={name:values.name,role:values.role,executive:values.executive==='1',...(item?{status:item.status==='disabled'&&item.needsActivation&&values.status==='active'?'pending':values.status}:{username:values.username})};
  const allowed=['requirements','tasks'].includes(kind)?editableFields(kind,item,item?.projectId||form.dataset.projectId):null;
  if(allowed)for(const key of kind==='requirements'?REQUIREMENT_CONTROLS:TASK_CONTROLS)if(!allowed.includes(key))delete payload[key];
  if(item && ['requirements','tasks'].includes(kind) && values.reason) payload.reason=values.reason;
  if(kind==='requirements' && item && can('planRequirement',item.projectId) && values.force==='1') payload.force=true;
  if(item)payload.version=item.version;
  const result=await api(`/${kind}${id?'/'+encode(id):''}`,{method:id?'PATCH':'POST',body:payload});
  closeDialog();
  if(kind==='users'&&item?.status==='disabled'&&item.needsActivation&&values.status==='active'){const tokenResult=await api(`/users/${encode(id)}/reset-password`,{method:'POST',body:{}});const index=data.users.findIndex(person=>person.id===id);if(index>=0)data.users[index]=tokenResult.user||result;renderShell();showToken(tokenResult,'重新启用账号的激活链接');return;}
  if(kind==='users'&&id===user.id)user=result.user||result;
  if(kind==='users'&&!id){if(result.user)data.users.push(result.user);renderShell();showToken(result,'新账号激活链接');return;}
  await reload();renderShell();toast(item?'修改已保存。':'创建成功。');
  if(kind==='projects'&&!id){const project=result.project||result;if(project.id)location.hash=projectPath(project.id);}
}

// Drag the schedule chart to pan (bounded by the project's scheduled dates); a drag never opens the task under the pointer.
document.addEventListener('pointerdown',event=>{const scroller=event.target.closest?.('.schedule-scroll');if(!scroller||scroller.classList.contains('is-fit')||event.button!==0||event.pointerType==='touch'||event.target.closest('.schedule-name,select,input'))return;timelineDrag={scroller,x:event.clientX,left:scroller.scrollLeft,id:event.pointerId,moved:false};});
document.addEventListener('pointermove',event=>{const drag=timelineDrag;if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x;if(!drag.moved){if(Math.abs(dx)<5)return;drag.moved=true;drag.scroller.classList.add('is-dragging');try{drag.scroller.setPointerCapture(event.pointerId);}catch(_){}}drag.scroller.scrollLeft=drag.left-dx;});
function endTimelineDrag(event){const drag=timelineDrag;if(!drag||event.pointerId!==drag.id)return;timelineDrag=null;drag.scroller.classList.remove('is-dragging');if(drag.moved){timelineDragged=true;setTimeout(()=>{timelineDragged=false;},80);}}
document.addEventListener('pointerup',endTimelineDrag);
document.addEventListener('pointercancel',endTimelineDrag);
document.addEventListener('scroll',event=>{const scroller=event.target;if(!scroller?.classList?.contains('schedule-scroll'))return;const geometry=timelineGeometry(scroller);if(geometry){syncTimelineChrome(geometry);rememberTimeline(geometry);}},true);
document.addEventListener('wheel',event=>{const scroller=event.target.closest?.('.schedule-scroll');if(!scroller||!(event.ctrlKey||event.metaKey))return;event.preventDefault();const geometry=timelineGeometry(scroller);if(!geometry)return;const offset=Math.max(0,Math.min(geometry.width,event.clientX-scroller.getBoundingClientRect().left-geometry.nameWidth));if(!timelineWheel){timelineWheel={factor:1,offset};setTimeout(()=>{const pending=timelineWheel;timelineWheel=null;zoomTimeline(pending.factor,pending.offset);},70);}timelineWheel.factor*=Math.exp(-event.deltaY*.01);timelineWheel.offset=offset;},{passive:false});
let timelineResizeTimer=0;
window.addEventListener('resize',()=>{if(route.view!=='timeline')return;clearTimeout(timelineResizeTimer);timelineResizeTimer=setTimeout(()=>{if(route.view==='timeline')renderView();},150);});
document.addEventListener('submit',async event=>{
  const form=event.target;if(!(form instanceof HTMLFormElement))return;
  const known=['auth-form','entity-form','password-form','member-form','attachment-form','task-batch-form','schedule-batch-form'];if(!known.includes(form.id))return;
  event.preventDefault();const button=$('button[type="submit"]',form);busy(button,true);
  try {
    const values=Object.fromEntries(new FormData(form));
    if(form.id==='auth-form') {
      const kind=form.dataset.kind;
      if(kind==='setup') {
        if(!setupAllowed || !setupToken)throw new Error('初始化入口不可用，请从应用启动入口重新打开。');
        if(values.newPassword!==values.confirmPassword)throw new Error('两次输入的密码不一致。');
        validateNewPassword(values.newPassword);
        const session=await api('/setup/admin',{method:'POST',body:{username:values.username,name:values.name,password:values.newPassword,setupToken}});
        setupAllowed=false;setupToken='';user=session.user;setCsrf(session.csrfToken);
        try { await reload(); }
        catch (_) {user=null;setCsrf('');renderAuth('login','管理员账号已创建，但工作台载入失败。请使用刚设置的账号和密码登录。');return;}
        resetFilters();route={view:'team',projectId:''};history.replaceState(null,'',location.pathname+'#/team');renderShell();toast('管理员账号已创建，欢迎进入工作空间。');
      } else if(kind==='login') {const session=await api('/auth/login',{method:'POST',body:{username:values.username,password:values.password}});user=session.user;if(user.mustChangePassword){renderAuth('password');return;}await reload();readRoute();renderShell();}
      else {
        if(values.newPassword!==values.confirmPassword)throw new Error('两次输入的新密码不一致。');
        validateNewPassword(values.newPassword);
        const result=await api(kind==='activate'?'/auth/activate':'/auth/change-password',{method:'POST',body:kind==='activate'?{token:activationToken,password:values.newPassword}:{currentPassword:values.currentPassword,newPassword:values.newPassword}});
        // The server resolves the token owner; URL account hints never select which account changes.
        loginUsername=result.user?.username || (kind==='activate'?recoveryUsername:user?.username) || '';
        if(kind==='activate')activationToken='';
        user=null;setCsrf('');
        const message=kind==='activate'&&adminRecovery?'管理员密码已重置，请使用下方账号和新密码登录。':'密码已设置，请使用账号和新密码登录。';
        renderAuth('login','',{notice:message});toast(message);
      }
    } else if(form.id==='task-batch-form')await submitTaskBatch(form);
    else if(form.id==='schedule-batch-form')await previewScheduleBatch(form);
    else if(form.id==='entity-form')await saveEntity(form);
    else if(form.id==='password-form') {
      if(values.newPassword!==values.confirmPassword)throw new Error('两次输入的新密码不一致。');
        validateNewPassword(values.newPassword);
      await api('/auth/change-password',{method:'POST',body:{currentPassword:values.currentPassword,newPassword:values.newPassword}});
      closeDialog();user=null;setCsrf('');renderAuth('login');toast('密码已修改，请重新登录。');
    } else if(form.id==='member-form') {
      await api(`/projects/${encode(route.projectId)}/members`,{method:'PUT',body:{userId:values.userId,role:values.role,version:projectOf().version}});
      await reload();renderShell();toast('成员已加入项目。');
    } else if(form.id==='attachment-form') {
      const file=$('input[type="file"]',form).files[0];if(!file)throw new Error('请选择需要上传的附件。');
      if(file.size>2*1024*1024)throw new Error('文件超过 2 兆字节，请缩减后重试。');
      if(!/\.(txt|md|markdown|html?|json)$/i.test(file.name))throw new Error('仅支持文本、文档标记、网页与结构化文本附件。');
      try{new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch(_){throw new Error('附件需要采用通用文本编码，请转换为 UTF-8（统一字符编码）后上传。');}
      const content=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败。'));reader.readAsDataURL(file);});
      const mime=({txt:'text/plain',md:'text/markdown',markdown:'text/markdown',html:'text/html',htm:'text/html',json:'application/json'})[file.name.split('.').pop().toLowerCase()];
      const existing=[...attachmentMeta.values()].filter(item=>item.requirementId===form.dataset.id&&item.name===file.name&&item.mime===mime&&!item.historical).sort((a,b)=>b.version-a.version)[0];
      await api(`/requirements/${encode(form.dataset.id)}/attachments`,{method:'POST',body:{name:file.name,mime,content,expectedVersion:existing?.version||0,...(existing?{logicalId:existing.logicalId||existing.id}:{})}});
      await reload();await requirementDetails(form.dataset.id);toast('附件已上传。');
    }
  } catch(error){
    if(form.id==='auth-form'&&form.dataset.kind==='setup'&&['SETUP_COMPLETE','SETUP_DISABLED','INVALID_SETUP_TOKEN'].includes(error.code)) {
      setupAllowed=false;setupToken='';
      if(error.code==='SETUP_COMPLETE')renderAuth('login',error.message);
      else renderSetup({required:true,enabled:false},error.message);
    } else presentError(error,$(form.id==='auth-form'?'#auth-error':form.id==='member-form'?'#member-error':form.id==='attachment-form'?'#attachment-error':'#form-error'));
  }
  finally{busy(button,false);}
});
document.addEventListener('click',async event=>{
  if(timelineDragged&&event.target.closest?.('.schedule-scroll')){timelineDragged=false;return;}
  const button=event.target.closest('button,[data-action]');if(!button||button.disabled)return;
  if(button.dataset.action==='menu'){document.body.classList.add('menu-open');$('#sidebar-shade').hidden=false;button.setAttribute('aria-expanded','true');return;}
  if(button.dataset.action==='close-menu'){document.body.classList.remove('menu-open');if($('#sidebar-shade'))$('#sidebar-shade').hidden=true;$('.menu-toggle')?.setAttribute('aria-expanded','false');return;}
  const action=button.dataset.action;
  try {
    if(button.dataset.documentAnchor&&/^doc-heading-\d+$/.test(button.dataset.documentAnchor)){const target=$('#'+button.dataset.documentAnchor,dialog);target?.setAttribute('tabindex','-1');target?.scrollIntoView({block:'start'});target?.focus({preventScroll:true});return;}
    if(button.dataset.timelineFit!==undefined){
      const state=timelineState(),geometry=timelineGeometry($('.schedule-scroll'));
      if(geometry?.fit||state.fit)updateTimeline({fit:false,zoom:state.returnZoom??null,mode:state.returnMode||'month',focusDay:state.returnDay,focusOffset:null});
      else updateTimeline({fit:true,returnZoom:state.zoom??null,returnMode:state.mode,returnDay:geometry?timelineDayAt(geometry,geometry.width/2):state.focusDay,focusDay:null,focusOffset:null});
      return;
    }
    if(button.dataset.timelineZoom){zoomTimeline(button.dataset.timelineZoom==='in'?1.6:1/1.6);return;}
    if(button.dataset.timelineMode){
      const mode=button.dataset.timelineMode;if(!['week','month','quarter','custom'].includes(mode))return;
      const geometry=timelineGeometry($('.schedule-scroll'));let patch={mode,zoom:null,fit:false};
      if(mode==='custom'){
        const current=timelineState();
        if(!current.start||!current.end){const first=geometry?Math.floor(timelineDayAt(geometry,0)):null,last=geometry?Math.ceil(timelineDayAt(geometry,geometry.width))-1:null;const resolved=resolveTimelineRange({...current,mode:'month'},timelineContext());patch={...patch,start:first===null?resolved.start:dayText(first),end:last===null?resolved.end:dayText(last)};}
        const start=dayOf(patch.start||current.start);patch={...patch,focusDay:start,focusOffset:0};
      } else if(geometry) patch={...patch,focusDay:timelineDayAt(geometry,geometry.width/2),focusOffset:null};
      updateTimeline(patch);return;
    }
    if(['timeline-prev','timeline-next','timeline-today'].includes(action)){
      const geometry=timelineGeometry($('.schedule-scroll'));if(!geometry)return;
      if(action==='timeline-today'){if(Number.isFinite(geometry.today))geometry.scroller.scrollTo({left:(geometry.today+.5-geometry.start)*geometry.px-geometry.width/2,behavior:'smooth'});return;}
      geometry.scroller.scrollBy({left:(action==='timeline-prev'?-1:1)*geometry.width*.8,behavior:'smooth'});return;
    }
    if(action==='timeline-reset'){ui.search='';if($('#search'))$('#search').value='';updateTimeline({owner:'all',status:'all'});return;}
    if(action==='close-dialog'){closeDialog();return;}
    if(action==='theme'){toggleTheme();return;}
    if(action==='recover-admin'){adminRecoveryHelp();return;}
    if(action==='check-setup'){busy(button,true);await boot();return;}
    if(action==='logout'){busy(button,true);await api('/auth/logout',{method:'POST'});user=null;setCsrf('');closeDialog();renderAuth();return;}
    if(action==='refresh-work'){await workView();return;}
    if(action==='run-backup'){busy(button,true);await api('/admin/backup-run',{method:'POST',body:{}});await workView();toast('备份任务已提交，可刷新查看结果。');return;}
    if(action==='read-all-notifications'||button.dataset.readNotification){busy(button,true);const ids=button.dataset.readNotification?[button.dataset.readNotification]:(workSnapshot?.reminders||[]).filter(item=>!item.read).map(item=>item.id);for(let i=0;i<ids.length;i+=500)await api('/work/read',{method:'POST',body:{ids:ids.slice(i,i+500),date:workSnapshot?.date||today()}});await workView();return;}
    if(action==='refresh'){busy(button,true);closeDialog();await reload();readRoute();renderShell();toast('已载入服务器最新内容。');return;}
    if(action==='password'){passwordDialog();return;}
    if(action==='profile'){openDialog('我的账号',`<div class="dialog-body"><div class="profile-card">${avatar(user.id,'lg')}<div><strong>${esc(user.name)}</strong><span>${isAdmin()?'系统管理员':isExecutive()?'管理层':'团队成员'}</span></div></div><dl class="detail-kv"><div><dt>姓名</dt><dd>${esc(user.name)}</dd></div><div><dt>登录账号</dt><dd>${esc(user.username)}</dd></div><div><dt>系统角色</dt><dd>${[isAdmin()?'系统管理员':'',isExecutive()?'管理层（只读查看全部项目）':''].filter(Boolean).join('、')||'团队成员'}</dd></div></dl></div>`,`<button class="btn btn-secondary" data-action="close-dialog">关闭</button><button class="btn btn-primary" data-action="password">修改密码</button>`,'center');return;}
    if(action==='new-project'){editProject();return;}if(action==='edit-project'){editProject(route.projectId);return;}
    if(action==='new-requirement'){editRequirement();return;}if(action==='new-task'){editTask();return;}if(action==='new-user'){editUser();return;}
    if(button.dataset.requirement){await requirementDetails(button.dataset.requirement);return;}
    if(button.dataset.editRequirement){editRequirement(button.dataset.editRequirement);return;}
    if(button.dataset.task){editTask(button.dataset.task);return;}
    if(button.dataset.newTaskStatus){editTask('',{status:button.dataset.newTaskStatus});return;}
    if(button.dataset.linkedTask){const req=data.requirements.find(item=>item.id===button.dataset.linkedTask);editTask('',{projectId:req.projectId,requirementId:req.id});return;}
    if(button.dataset.editUser){editUser(button.dataset.editUser);return;}
    if(button.dataset.resetUser){const person=data.users.find(item=>item.id===button.dataset.resetUser);confirmAction('重置账号密码',`将为「${person.name}」生成一次性重置链接。现有登录会话将失效；请手动向本人交付链接。`,'confirm-reset',`data-user-id="${esc(person.id)}"`);return;}
    if(action==='confirm-reset'){busy(button,true);const resetSelf=button.dataset.userId===user.id;const result=await api(`/users/${encode(button.dataset.userId)}/reset-password`,{method:'POST',body:{}});if(result.user){const index=data.users.findIndex(person=>person.id===result.user.id);if(index>=0)data.users[index]=result.user;}renderShell();showToken(result,'密码重置链接');selfResetPending=resetSelf;return;}
    if(action==='dismiss-alert'){if($('#page-alert'))$('#page-alert').innerHTML='';return;}
    if(button.dataset.batchRequirement){openTaskBatch(button.dataset.batchRequirement);return;}
    if(action==='add-batch-task'){collectBatchDraft();if(batchDraft.tasks.length>=100)return;batchDraft.tasks.push(blankTask(batchDraft.ownerId));batchDraft.requestId=crypto.randomUUID();renderTaskBatch();return;}
    if(button.dataset.removeBatch!==undefined){collectBatchDraft();batchDraft.tasks.splice(Number(button.dataset.removeBatch),1);batchDraft.requestId=crypto.randomUUID();renderTaskBatch();return;}
    if(action==='reload-batch-version'){collectBatchDraft();const current=await api(`/requirements/${encode(batchDraft.requirementId)}`);const index=data.requirements.findIndex(item=>item.id===current.id);if(index>=0)data.requirements[index]=current;if(!canSplit(current))throw new Error('当前权限已变化，草稿已保留，请联系项目负责人。');batchDraft.version=current.version;batchDraft.requestId=crypto.randomUUID();renderTaskBatch();$('#form-error').hidden=false;$('#form-error').innerHTML=`<strong>请核对最新需求</strong><p>${esc(current.title)}</p><p>${esc(current.description||'未填写背景')}</p><p>验收标准：${esc(current.acceptance||'未填写')}</p>`;return;}
    if(button.dataset.attachmentHistory){await attachmentHistory(button.dataset.attachmentHistory);return;}
    if(action==='compare-attachment-versions'){await compareAttachments();return;}
    if(action==='schedule-batch'){openScheduleBatch();return;}
    if(action==='apply-schedule-batch'){await applyScheduleBatch(button);return;}
    if(action==='copy-token'){const input=$('#one-time-link');try{await navigator.clipboard.writeText(input.value);toast('链接已复制，请手动交付本人。');}catch(_){input.focus();input.select();toast('请使用系统复制快捷键复制已选中的链接。');}return;}
    if(button.dataset.removeMember){confirmAction('移出项目成员',`将「${nameOf(button.dataset.removeMember)}」移出当前项目。此操作不会删除团队账号。`,'confirm-remove-member',`data-user-id="${esc(button.dataset.removeMember)}"`);return;}
    if(action==='confirm-remove-member'){busy(button,true);await api(`/projects/${encode(route.projectId)}/members/${encode(button.dataset.userId)}`,{method:'DELETE',body:{version:projectOf().version}});closeDialog();await reload();renderShell();toast('成员已移出项目。');return;}
    if(button.dataset.archiveKind){const kind=button.dataset.archiveKind,id=button.dataset.archiveId,item=data[kind].find(record=>record.id===id);confirmAction(item.archived?'恢复记录':'归档记录',`${item.archived?'恢复':'归档'}「${item.name||item.title}」。${item.archived?'恢复后重新显示在当前工作范围。':'归档内容可通过「查看归档」筛选恢复。'}`,'confirm-archive',`data-kind="${kind}" data-id="${esc(id)}"`);return;}
    if(action==='confirm-archive'){busy(button,true);const item=data[button.dataset.kind].find(record=>record.id===button.dataset.id);await api(`/${button.dataset.kind}/${encode(item.id)}`,{method:'PATCH',body:{version:item.version,archived:!item.archived}});closeDialog();await reload();if(button.dataset.kind==='projects'){location.hash='#/projects';readRoute();}renderShell();toast(item.archived?'记录已恢复。':'记录已归档。');return;}
    if(button.dataset.reviewKind==='requirements'&&button.dataset.reviewStatus==='开发中'){editRequirement(button.dataset.reviewId);$('#field-status').value='开发中';$('#field-reason')?.focus();toast('请填写退回开发的原因后保存。');return;}
    if(button.dataset.reviewKind){busy(button,true);const item=data[button.dataset.reviewKind].find(record=>record.id===button.dataset.reviewId);await api(`/${button.dataset.reviewKind}/${encode(item.id)}`,{method:'PATCH',body:{version:item.version,status:button.dataset.reviewStatus}});closeDialog();await reload();renderShell();toast(button.dataset.reviewStatus==='done'||button.dataset.reviewStatus==='已完成'?'已通过验收。':'已退回开发。');return;}
    if(button.dataset.previewAttachment){await attachment(button.dataset.previewAttachment);return;}if(button.dataset.downloadAttachment){await attachment(button.dataset.downloadAttachment,true);return;}
    if(button.dataset.layout){ui.taskLayout=button.dataset.layout;renderView();return;}
    if(button.dataset.page){ui.page=Number(button.dataset.page);renderView();return;}
  } catch(error){presentError(error,dialog.open?$('#form-error',dialog):null);}
  finally{busy(button,false);}
});
document.addEventListener('change',async event=>{
  const control=event.target;
  if(control.dataset.timelineFilter&&['owner','status'].includes(control.dataset.timelineFilter)){updateTimeline({[control.dataset.timelineFilter]:control.value});return;}
  if(control.dataset.timelineDate&&['start','end','anchor'].includes(control.dataset.timelineDate)){const field=control.dataset.timelineDate,day=dayOf(control.value);if(field==='anchor'){const geometry=timelineGeometry($('.schedule-scroll'));if(geometry&&day!==null){const clamped=Math.max(geometry.start,Math.min(geometry.start+geometry.days-1,day));geometry.scroller.scrollTo({left:(clamped+.5-geometry.start)*geometry.px-geometry.width/2,behavior:'smooth'});}timelineStates.set(timelineKey(),{...timelineState(),anchor:control.value});return;}const state=timelineState();updateTimeline({[field]:control.value,mode:'custom',zoom:null,fit:false,focusDay:dayOf(field==='start'?control.value:state.start),focusOffset:0});return;}
  if(control.id==='project-switch'){const view=route.projectId?route.view:'overview';selectedProject=control.value;resetFilters();location.hash=projectPath(control.value,view);return;}
  if(control.id==='status-filter'){ui.status=control.value;ui.page=1;renderView();return;}
  if(control.id==='priority-filter'){ui.priority=control.value;ui.page=1;renderView();return;}
  if(control.id==='archive-filter'){ui.archived=control.checked;ui.page=1;renderView();return;}
  if(control.dataset.taskStatus){const task=data.tasks.find(item=>item.id===control.dataset.taskStatus),old=task.status;if(control.value==='terminated'){editTask(task.id);$('#field-status').value='terminated';return;}control.disabled=true;try{await api(`/tasks/${encode(task.id)}`,{method:'PATCH',body:{status:control.value,version:task.version}});await reload();renderShell();toast('任务状态已更新。');}catch(error){control.value=taskStage(old);presentError(error);}finally{control.disabled=false;}return;}
  if(control.dataset.memberRole){control.disabled=true;try{await api(`/projects/${encode(route.projectId)}/members`,{method:'PUT',body:{userId:control.dataset.memberRole,role:control.value,version:projectOf().version}});await reload();renderShell();toast('项目角色已更新。');}catch(error){control.value=data.memberships.find(item=>item.projectId===route.projectId&&item.userId===control.dataset.memberRole)?.role||'';presentError(error);}finally{control.disabled=false;}}
});
document.addEventListener('input',event=>{if(event.target.dataset.batchField){collectBatchDraft(true);if($('#batch-summary'))$('#batch-summary').textContent=renderBatchSummary(batchDraft.tasks);}if(event.target.id==='search'){ui.search=event.target.value;ui.page=1;renderView();}if(event.target.type==='password'&&['newPassword','confirmPassword'].includes(event.target.name)){const value=event.target.value;event.target.setCustomValidity(value&&Array.from(value).length<6?'密码至少 6 个字符。':'');}});
window.addEventListener('hashchange',()=>{if(!user||user.mustChangePassword)return;resetFilters();readRoute();document.body.classList.remove('menu-open');renderShell();window.scrollTo?.(0,0);});
dialog.addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeDialog();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){document.body.classList.remove('menu-open');if($('#sidebar-shade'))$('#sidebar-shade').hidden=true;}if(event.key==='/'&&!dialog.open&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){event.preventDefault();$('#search')?.focus();}});
async function boot() {
  let existedMessage='';
  try {
    const status=await api('/setup/status',{headers:setupToken?{'X-Setup-Token':setupToken}:{}});
    if(status.required) {
      renderSetup(status,status.enabled?'':'初始化入口暂未启用，请通过应用启动入口打开工作空间。');
      return;
    }
    setupAllowed=false;
    if(setupToken){setupToken='';existedMessage='管理员账号已经存在，请使用原账号登录。初始化入口不会修改已有账号。';}
    if(activationToken){renderAuth('activate');return;}
    const session=await api('/auth/me');user=session.user;if(user.mustChangePassword){renderAuth('password');return;}await reload();readRoute();renderShell();
  } catch(error){user=null;setCsrf('');renderAuth('login',error.status===401?existedMessage:error.message);}
}
boot();
