// Isolated role-aware browser acceptance fixture; never opens a disk database.
// Node 24: node backend/tests/support/workbench-member-server.mjs [--check] [--long-titles] [--project-pages] [--requirement-pages] [--document-pages]
// Optional WORKBENCH_TEST_DATE=YYYY-MM-DD; default is today's Singapore date.
// Only use the printed localhost origin, keeping its cookies separate from the
// real application on 127.0.0.1. All fixture accounts and content are synthetic.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../database.mjs';
import { createApplication } from '../../server.mjs';
import { buildWorkbench } from '../../../frontend/workbench-model.js';
import { checkRequirementTransition, taskStage } from '../../../frontend/workflow.js';
import { taskInterval } from '../../../frontend/timeline.js';
import { documentAssociationSummary } from '../../../frontend/doc-sections.js';

const frontend = fileURLToPath(new URL('../../../frontend/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const date = process.env.WORKBENCH_TEST_DATE || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10), date);
const shift = days => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const password = 'Workbench-Fixture!2026';
const longTitles = process.argv.includes('--long-titles');
const projectPages = process.argv.includes('--project-pages');
const documentPages = process.argv.includes('--document-pages');
const requirementPages = process.argv.includes('--requirement-pages') || documentPages;
const pageTitles = projectPages || requirementPages;
const db = openDatabase(':memory:');
let app;
const server = http.createServer((req, res) => {
  if (!app) { res.writeHead(503); res.end(); return; }
  if (req.url.startsWith('/api/')) { void app.handler(req, res); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  const file = path.resolve(frontend, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(frontend) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});
let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => { db.close(); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, origin = `http://localhost:${port}`;
  app = createApplication({ db, publicOrigin: origin, secureCookies: false, logger: { info() {}, error() {} } });
  const admin = await app.auth.bootstrapAdmin({ username: 'quality-fixture-admin', name: '隔离夹具管理员', password });
  const actors = {};
  for (const [role, name] of [['developer', '示例开发成员'], ['tester', '示例测试成员'], ['lead', '示例主开发'], ['viewer', '示例观察者'], ...(requirementPages ? [['product', '示例产品经理']] : [])]) {
    const result = app.auth.createUser(admin, { username: `quality-${role}`, name, role: 'member' });
    await app.auth.redeemToken({ token: result.activationToken, password });
    actors[role] = { id: result.user.id };
  }
  const business = app.business;
  const projects = [];
  const longProjectName = '示例·资源同步与异常恢复联调工作区ResourceSynchronizationCompatibility';
  const longRequirementTitle = '示例需求：ResourceSynchronizationCompatibility接口字段映射与资源同步异常重试，整理跨项目联调记录及验收依据';
  const longMilestoneLabel = '示例节点：跨项目ResourceSynchronizationCompatibility接口完成异常重试联调与交付检查';
  const projectDescription = '这是完全合成的手机页面验收项目，用于验证跨项目资源同步、接口字段兼容与异常恢复的协作过程。团队需要明确接口契约、资源标识映射、超时重试边界和交付检查条件，并在项目目录、概览及研发任务中保持一致的上下文。研发阶段应记录联调结论与待处理问题，测试阶段按照验收标准确认资源一致性和失败后的恢复行为。较长的项目说明用于检查手机窄屏下的自然换行与完整阅读，不包含任何真实业务内容，也不改变原有项目、需求、任务数量或成员职责。';
  if (pageTitles) {
    assert([...longProjectName].length >= 40 && [...longProjectName].length <= 60);
    assert([...longRequirementTitle].length >= 60 && [...longRequirementTitle].length <= 90);
  }
  const names = [pageTitles ? longProjectName : '示例·接口服务', '示例·资源工作区', '示例·协作组件', '示例·发布控制'];
  for (const [index, name] of names.entries()) {
    let project = business.createProject(admin, { name, description: pageTitles && index === 0 ? projectDescription : '仅用于隔离浏览器验收的示例项目，不是真实业务数据。', ownerId: actors.lead.id, ownerRole: 'lead', status: '进行中',
      startDate: shift(-20), targetDate: shift(index === 0 ? -3 : 14 + index),
      milestones: [{ label: pageTitles && index === 0 ? longMilestoneLabel : index === 1 ? '今日示例联调节点' : '示例交付检查', date: shift(index === 1 ? 0 : index + 1), kind: 'checkpoint' }] });
    for (const [role, actor] of Object.entries(actors)) {
      if (role === 'lead') continue;
      project = business.setMember(admin, project.id, { userId: actor.id, role, version: project.version }).project;
    }
    projects.push(project);
  }
  const hiddenProject = business.createProject(admin, { name: '隐藏示例项目', description: '无成员权限时不得出现在快照、工作台、待办或详情。', ownerId: admin.id, status: '进行中', startDate: shift(-20), targetDate: shift(-1) });
  const createRequirement = (project, title, extra = {}) => business.createRequirement(admin, { projectId: project.id, title,
    description: '隔离验收示例背景：验证进展、风险、待办、权限和长标题展示。', acceptance: '示例工作流按角色流转成功，界面无溢出，且不能访问隐藏项目。',
    ownerId: admin.id, assigneeId: actors.developer.id, planStart: shift(-10), planEnd: shift(10), ...extra });
  const createTask = (project, requirement, title, extra = {}) => business.createTask(admin, { projectId: project.id, requirementId: requirement.id, title,
    description: '这是隔离浏览器验收任务，所有字段都由真实业务规则校验。', ownerId: actors.developer.id, startDate: shift(-7), dueDate: shift(6), estimateHours: 8, ...extra });
  const moveTask = (actor, task, status, reason = '') => business.updateTask(actor, task.id, { version: business.getTask(actor, task.id).version, status, ...(reason ? { reason } : {}) });
  const longRequirementDescription = '这是合成的手机需求详情验收背景。'.repeat(12) + 'ResourceSynchronizationProtocolCompatibility'.padEnd(80, 'X');
  const longRequirementAcceptance = '验收标准：资源同步、接口字段兼容、异常重试和联调记录完整，日期与操作入口清楚。'.repeat(8);
  const longDocumentName = `${'ResourceSynchronizationProtocolCompatibility'.padEnd(100, 'X')}.md`;
  const documentTitle = '示例项目文档：跨项目资源同步、异常恢复和字段兼容完整协作规范' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X');
  const sectionTitle = '跨项目资源同步、异常恢复、字段兼容与验收证据核对的完整章节' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X');
  const documentBody = `# 示例手机阅读器验收文档\n\n这是完全合成的项目文档，只存在内存数据库中。\n\n## ${sectionTitle} 〔SYNC-1〕\n\n${'ResourceSynchronizationProtocolCompatibility'.padEnd(140, 'X')}\n\n较长的中文正文用于验证窄屏完整阅读、章节定位和关联内容返回。\n\n### 验收与异常恢复检查 〔SYNC-1.1〕\n\n逐项检查资源标识、协议版本、失败恢复和跨项目联调记录。\n\n## 历史规则保留与版本差异 〔SYNC-2〕\n\n保留旧版说明，不覆盖原始记录。\n`;
  let linkedDocument = requirementPages ? business.uploadDocument(actors.product, projects[0].id, {
    name: longDocumentName, title: documentPages ? documentTitle : `示例关联文档：${longDocumentName}`, type: 'PRD',
    ...(documentPages ? { primary: true, note: '初始合成版本，用于验证历史阅读入口。' } : {}),
    contentBuffer: Buffer.from(documentPages ? documentBody : '# 示例接口协议\n\n这是仅保存在内存数据库中的合成文档，用于检查需求详情的关联文档入口。\n'),
  }).document : null;
  const baseRequirements = projects.map((project, index) => createRequirement(project, pageTitles && index === 0 ? longRequirementTitle : `示例研发主线 ${index + 1}`, requirementPages && index === 0 ? {
    ownerId: actors.product.id, description: longRequirementDescription, acceptance: longRequirementAcceptance,
    source: '示例来源：ResourceSynchronizationProtocolCompatibility'.padEnd(100, 'X'),
    planStart: shift(-45), planEnd: shift(22), docRefs: [{ document: longDocumentName, type: 'PRD', sections: [] }],
  } : {}));
  if (requirementPages) {
    baseRequirements[0] = business.updateRequirement(actors.product, baseRequirements[0].id, {
      version: baseRequirements[0].version, planStart: shift(-44), planEnd: shift(23), force: true,
    });
  }
  const expectedOwnIds = [], extraExcludedIds = [];
  const offsets = [-2, 0, 6, 7, 2, 12];
  for (const [projectIndex, project] of projects.entries()) {
    for (let index = 0; index < 6; index++) {
      const stressed = longTitles && index === 0;
      const title = stressed ? (expectedOwnIds.length === 0 ? `示例接口：${'GetResourceSynchronizationProtocolCompatibility'.padEnd(80, 'X')}`
        : `示例任务 ${projectIndex + 1}-${index + 1}：完成跨项目接口协议与资源同步的异常分支校验，并整理联调记录、超时重试条件、字段兼容规则和交付检查清单，确认窄屏下长标题能够完整阅读`)
        : `示例任务 ${projectIndex + 1}-${index + 1}：接口字段映射与资源同步异常分支校验`;
      assert([...title].length >= (stressed ? 60 : 18) && [...title].length <= (stressed ? 90 : 48));
      // The optional requirements-page mode changes only synthetic display data:
      // one active task has no dates, and one task spans a month boundary. Their
      // existing overdue/due-soon/todo membership is deliberately unchanged.
      const pageDates = requirementPages && projectIndex === 0 && index === 5 ? { startDate: '', dueDate: '' }
        : requirementPages && projectIndex === 0 && index === 0 ? { startDate: shift(-45) } : {};
      let task = createTask(project, baseRequirements[projectIndex], title, { dueDate: shift(offsets[index]), ...pageDates });
      if (index % 2) task = moveTask(actors.developer, task, 'develop');
      expectedOwnIds.push(task.id);
    }
  }
  // Real transitions create test/done/terminated states. Archived work remains
  // in the in-memory database but is excluded by normal bootstrap filtering.
  let ownTest = createTask(projects[0], baseRequirements[0], '示例：本人已提测，须其他成员验收');
  ownTest = moveTask(actors.developer, ownTest, 'develop');
  ownTest = moveTask(actors.developer, ownTest, 'test');
  extraExcludedIds.push(ownTest.id);
  let completed = createTask(projects[0], baseRequirements[0], '示例：已完成任务不再算待办');
  completed = moveTask(actors.developer, completed, 'develop');
  completed = moveTask(actors.developer, completed, 'test');
  completed = moveTask(actors.tester, completed, 'done');
  extraExcludedIds.push(completed.id);
  let terminated = createTask(projects[0], baseRequirements[0], '示例：已终止任务不进入有效分母');
  terminated = moveTask(actors.lead, terminated, 'terminated', '仅用于验收终止任务统计口径');
  extraExcludedIds.push(terminated.id);
  const archived = createTask(projects[0], baseRequirements[0], '示例：已归档任务不进入当前待办');
  business.archiveTask(admin, archived.id, { version: archived.version });
  extraExcludedIds.push(archived.id);
  const someoneElse = createTask(projects[1], baseRequirements[1], '示例：他人待开始任务不进入开发者待办', { ownerId: actors.lead.id });
  extraExcludedIds.push(someoneElse.id);
  const otherTestTitle = longTitles
    ? '示例验收：其他成员已经完成跨项目协议与资源同步联调，请检查异常分支、超时重试策略、字段兼容规则和验收材料，并确认窄屏下任务长标题与操作入口均能完整阅读'
    : '示例：其他成员已提测，开发者也可按权限验收';
  let otherTest = createTask(projects[1], baseRequirements[1], otherTestTitle, { ownerId: actors.lead.id });
  otherTest = moveTask(actors.lead, otherTest, 'develop');
  otherTest = moveTask(actors.lead, otherTest, 'test');

  const finalReviewIds = [];
  for (let index = 0; index < 6; index++) {
    const project = projects[index % projects.length], requirement = createRequirement(project, requirementPages && index === 0
      ? `示例最终需求验收：${'ResourceSynchronizationProtocolCompatibility'.padEnd(80, 'X')}全部有效任务已完成，等待确认交付结果`
      : `示例最终需求验收 ${index + 1}：全部有效任务已完成，等待确认交付结果`);
    let task = createTask(project, requirement, `示例验收前置任务 ${index + 1}`);
    task = moveTask(actors.developer, task, 'develop');
    task = moveTask(actors.developer, task, 'test');
    moveTask(actors.tester, task, 'done');
    finalReviewIds.push(requirement.id);
  }
  const planningIds = [];
  for (let index = 0; index < 3; index++) {
    const requirement = createRequirement(projects[index], requirementPages && index === 0
      ? '示例待安排需求：跨项目资源同步与兼容规则梳理，补充主责开发、负责人、交付检查条件和未排期事项，确认长标题在手机上可完整阅读'
      : `示例待安排需求 ${index + 1}：由主开发补充分工和排期`, { assigneeId: '', ...(requirementPages && index === 0 ? { planStart: '', planEnd: '' } : {}) });
    planningIds.push(requirement.id);
  }
  const hiddenRequirement = createRequirement(hiddenProject, '隐藏示例需求', { assigneeId: admin.id });
  const hiddenTask = createTask(hiddenProject, hiddenRequirement, '隐藏示例任务', { ownerId: admin.id, dueDate: shift(-1) });

  let documentPageExpected = null, documentFixtures = null;
  if (documentPages) {
    const note = '补充跨项目资源同步的异常恢复规则、字段映射说明与完整验收依据，确认手机端可以自然换行读取。'.repeat(4) + 'ResourceSynchronizationCompatibility'.padEnd(100, 'X');
    linkedDocument = business.uploadDocument(actors.product, projects[0].id, { name: longDocumentName, documentId: linkedDocument.id,
      expectedVersion: 1, note, contentBuffer: Buffer.from(documentBody.replace('保留旧版说明', '第二版补充：保留旧版说明并记录兼容边界')) }).document;
    const technical = business.uploadDocument(actors.lead, projects[0].id, { name: 'TechnicalArchitectureResourceSynchronization'.padEnd(100, 'X') + '.md',
      title: '示例技术方案：分布式资源同步、接口兼容与异常恢复实现说明' + 'TechnicalArchitectureCompatibility'.padEnd(80, 'X'), type: '技术方案',
      note: '尚待产品评估的关联技术方案。', contentBuffer: Buffer.from('# 示例技术方案\n\n## 1. ' + sectionTitle + '\n\n' + 'ResourceSynchronizationArchitecture'.padEnd(120, 'X') + '\n\n## 2. 风险与恢复\n保留接口状态和重试约束。\n') }).document;
    const unlinked = business.uploadDocument(actors.product, projects[0].id, { name: '示例尚未关联资料.md', title: '示例尚未关联资料：用于核验未关联分类与原有文档操作入口', type: '其他',
      contentBuffer: Buffer.from('# 示例未关联资料\n\n## 1. 调研记录\n这份文档尚未关联需求或提议。\n') }).document;
    const proposalContent = { projectId: projects[0].id, description: longRequirementDescription, acceptance: longRequirementAcceptance,
      source: '示例手机验收来源：' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X'), proposerName: '示例外部提出人：跨项目资源同步与异常恢复联调成员', priority: 'P1' };
    const pending = app.proposals.create(actors.developer, { ...proposalContent, title: '示例待评估提议：手机端完整阅读资源同步与异常恢复的长标题' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X'),
      docRefs: [{ document: longDocumentName, type: 'PRD', sections: ['SYNC-1'] }] });
    let supplement = app.proposals.create(actors.developer, { ...proposalContent, title: '示例待补充提议：请补充字段兼容、联调范围与验收依据后重新评估' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X'),
      docRefs: [{ document: technical.name, type: '技术方案', sections: ['§1'] }] });
    supplement = app.proposals.update(actors.product, supplement.id, { version: supplement.version, status: '待补充',
      decisionReason: '请补充资源同步失败后的恢复步骤、跨项目字段映射规则和可以复核的验收材料。'.repeat(6) });
    const converting = app.proposals.create(actors.developer, { ...proposalContent, title: '示例已转需求提议：保留原提议并关联确认后的需求，验证阅读器往返' + 'ResourceSynchronizationCompatibility'.padEnd(80, 'X'),
      docRefs: [{ document: longDocumentName, type: 'PRD', sections: ['SYNC-2'] }] });
    const converted = app.proposals.approve(actors.product, converting.id, { version: converting.version, ownerId: actors.product.id });
    const hiddenDocument = business.uploadDocument(admin, hiddenProject.id, { name: '隐藏文档.md', type: 'PRD', contentBuffer: Buffer.from('# 隐藏文档\n只允许隐藏项目成员读取。') }).document;
    const hiddenProposal = app.proposals.create(admin, { ...proposalContent, projectId: hiddenProject.id, title: '隐藏提议：非项目成员不可读取', docRefs: [] });
    documentFixtures = { pending, supplement, converted, technical, unlinked, hiddenDocument, hiddenProposal };
    documentPageExpected = { projectId: projects[0].id, documents: [linkedDocument, technical, unlinked].map(item => ({ id: item.id, title: item.title, name: item.name, type: item.type, version: item.version,
      sections: item.sections.map(section => ({ code: section.code, title: section.title })) })),
      proposals: [pending, supplement, converted.proposal].map(item => ({ id: item.id, title: item.title, status: item.status, createdBy: item.createdBy, requirementId: item.requirementId })),
      linkedRequirementId: converted.requirement.id, originalLinkedRequirementId: baseRequirements[0].id, versionNote: note, permissionChecks: {} };
  }

  // Exercise the real HTTP authentication and permission handler, then build
  // each projection exclusively from that actor's authorized HTTP responses.
  const request = (pathname, { method = 'GET', body, cookie = '', csrf = '' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { Host: `localhost:${port}`, Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
        ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, data: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
  const expected = {};
  let requirementPageExpected = null;
  for (const [role, actor] of Object.entries(actors)) {
    const login = await request('/api/auth/login', { method: 'POST', body: { username: `quality-${role}`, password } });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'member');
    const cookie = login.headers['set-cookie'][0].split(';')[0], csrf = login.data.csrfToken;
    const bootstrap = await request('/api/bootstrap', { cookie });
    const work = await request(`/api/work?date=${date}`, { cookie });
    assert.equal(bootstrap.status, 200); assert.equal(work.status, 200);
    assert.equal(bootstrap.data.currentUser.id, actor.id);
    assert.equal(bootstrap.data.projects.length, 4);
    if (pageTitles) {
      const project = bootstrap.data.projects.find(item => item.id === projects[0].id);
      const requirement = bootstrap.data.requirements.find(item => item.id === baseRequirements[0].id);
      assert.equal(project.name, longProjectName);
      assert.equal(project.description, projectDescription);
      assert.equal(project.milestones[0].label, longMilestoneLabel);
      assert.equal(requirement.title, longRequirementTitle);
    }
    if (requirementPages) {
      const visibleRequirements = bootstrap.data.requirements.filter(item => item.projectId === projects[0].id);
      const visibleTasks = bootstrap.data.tasks.filter(item => item.projectId === projects[0].id);
      const missingDates = visibleTasks.filter(item => !taskInterval(item));
      const firstRequirement = visibleRequirements.find(item => item.id === baseRequirements[0].id);
      assert.equal(firstRequirement.description, longRequirementDescription);
      assert.equal(firstRequirement.acceptance, longRequirementAcceptance);
      assert.equal(firstRequirement.ownerId, actors.product.id);
      assert.deepEqual(firstRequirement.docRefs, [{ document: longDocumentName, type: 'PRD', sections: [] }]);
      assert.equal(firstRequirement.baseline.planStart, shift(-45));
      assert.equal(firstRequirement.baseline.planEnd, shift(22));
      assert.equal(firstRequirement.rescheduleCount, 1);
      assert(bootstrap.data.documents.some(item => item.id === linkedDocument.id && item.name === longDocumentName));
      assert.equal(visibleRequirements.length, documentPages ? 5 : 4);
      assert.equal(visibleTasks.length, 11);
      assert.equal(missingDates.length, 1);
      assert.equal(missingDates[0].status, 'develop');
      assert(visibleTasks.some(item => item.startDate && item.dueDate && item.startDate.slice(0, 7) !== item.dueDate.slice(0, 7)), '排期包含跨月日期');
      assert(visibleRequirements.some(item => !item.planStart && !item.planEnd), '需求池包含尚未安排承诺日期的需求');
      const requirementPatch = await request(`/api/requirements/${firstRequirement.id}`, { method: 'PATCH', cookie, csrf,
        body: { version: firstRequirement.version, title: firstRequirement.title + (role === 'product' ? '' : '（权限自检）') } });
      assert.equal(requirementPatch.status, ['product'].includes(role) ? 200 : 403,
        '产品经理可维护内容；主开发、开发、测试和观察者不可通过真实接口编辑需求内容');
      requirementPageExpected = { projectId: projects[0].id, requirements: visibleRequirements.length, tasks: visibleTasks.length,
        requirementStatuses: visibleRequirements.reduce((counts, item) => ({ ...counts, [item.status]: (counts[item.status] || 0) + 1 }), {}),
        scheduledTasks: visibleTasks.filter(taskInterval).length, missingDates: missingDates.map(item => item.id),
        firstRequirementId: firstRequirement.id, finalReviewRequirementId: finalReviewIds[0], unscheduledRequirementId: planningIds[0],
        linkedDocumentId: linkedDocument.id, baseline: firstRequirement.baseline,
        currentCommitment: { planStart: firstRequirement.planStart, planEnd: firstRequirement.planEnd } };
    }
    if (documentPages) {
      const { pending, supplement, converted, technical, unlinked, hiddenDocument, hiddenProposal } = documentFixtures;
      const documents = (await request(`/api/projects/${projects[0].id}/documents`, { cookie })).data.documents;
      assert.equal(documents.length, 3);
      const summaries = documents.map(document => { const summary = documentAssociationSummary(document, bootstrap.data.requirements, bootstrap.data.proposals);
        return { id: document.id, classification: summary.classification, confirmed: summary.confirmed.length, unconfirmed: summary.unconfirmed.length, covered: summary.covered, total: summary.total }; });
      assert.deepEqual(summaries.find(item => item.id === linkedDocument.id), { id: linkedDocument.id, classification: ['confirmed', 'unconfirmed'], confirmed: 2, unconfirmed: 1, covered: 3, total: 3 });
      assert.deepEqual(summaries.find(item => item.id === technical.id), { id: technical.id, classification: ['unconfirmed'], confirmed: 0, unconfirmed: 1, covered: 1, total: 2 });
      assert.deepEqual(summaries.find(item => item.id === unlinked.id).classification, ['unlinked']);
      assert.equal(bootstrap.data.requirements.length, 14);
      assert.equal(bootstrap.data.proposals.length, 3);
      assert.equal((await request(`/api/documents/${linkedDocument.id}/versions`, { cookie })).data.versions.length, 2);
      assert.equal(business.getDocumentContent(actor, linkedDocument.id, 1).version, 1);
      assert.equal(business.getDocumentContent(actor, linkedDocument.id, 2).version, 2);
      for (const item of [pending, supplement, converted.proposal]) {
        assert.equal((await request(`/api/proposals/${item.id}`, { cookie })).status, 200);
        assert.equal((await request(`/api/proposals/${item.id}/history`, { cookie })).status, 200);
      }
      assert.equal((await request(`/api/documents/${hiddenDocument.id}/versions`, { cookie })).status, 403);
      assert.equal((await request(`/api/proposals/${hiddenProposal.id}`, { cookie })).status, 403);
      const documentPatch = await request(`/api/documents/${linkedDocument.id}`, { method: 'PATCH', cookie, csrf, body: { title: linkedDocument.title } });
      assert.equal(documentPatch.status, role === 'product' ? 200 : 403);
      const technicalPatch = await request(`/api/documents/${technical.id}`, { method: 'PATCH', cookie, csrf, body: { title: technical.title } });
      assert.equal(technicalPatch.status, ['product', 'lead'].includes(role) ? 200 : 403);
      const currentPending = bootstrap.data.proposals.find(item => item.id === pending.id);
      const proposalPatch = await request(`/api/proposals/${pending.id}`, { method: 'PATCH', cookie, csrf, body: { version: currentPending.version, title: pending.title } });
      assert.equal(proposalPatch.status, ['product', 'developer'].includes(role) ? 200 : 403);
      const approve = await request(`/api/proposals/${converted.proposal.id}/approve`, { method: 'POST', cookie, csrf, body: { version: converted.proposal.version } });
      assert.equal(approve.status, role === 'product' ? 200 : 403);
      if (role === 'product') { assert.equal(approve.data.replayed, true); assert.equal(approve.data.requirement.id, converted.requirement.id); }
      documentPageExpected.classifications = summaries;
      documentPageExpected.permissionChecks[role] = { readDocuments: 200, readProposals: 200, readHidden: 403, editPrd: documentPatch.status, editTechnical: technicalPatch.status,
        editDeveloperOwnPending: proposalPatch.status, approveProposal: approve.status };
    }
    const snapshot = buildWorkbench({ data: bootstrap.data, user: bootstrap.data.currentUser, date, work: work.data });
    assert(!JSON.stringify(snapshot).includes(hiddenProject.id));
    assert(!JSON.stringify(snapshot).includes(hiddenRequirement.id));
    assert(!JSON.stringify(snapshot).includes(hiddenTask.id));
    assert.equal(snapshot.activation, null);
    assert.equal((await request(`/api/projects/${hiddenProject.id}`, { cookie })).status, 403);
    assert.equal((await request(`/api/requirements/${hiddenRequirement.id}`, { cookie })).status, 403);
    assert.equal((await request(`/api/tasks/${hiddenTask.id}`, { cookie })).status, 403);
    if (role === 'developer') {
      assert.equal(snapshot.metrics.actionable, 25);
      assert.deepEqual(new Set(snapshot.todos.map(item => item.entityId)), new Set([...expectedOwnIds, otherTest.id]));
      assert(snapshot.todos.every(item => !extraExcludedIds.includes(item.entityId)));
      if (longTitles) {
        const firstFive = snapshot.todos.slice(0, 5);
        assert(firstFive.every(item => [...item.title].length >= 60 && [...item.title].length <= 90), '首页前五项全部覆盖长标题压力');
        assert(firstFive.some(item => /[A-Za-z]{80}/.test(item.title)), '首页前五项包含连续八十字符英文接口名');
      }
      const ownTestNow = bootstrap.data.tasks.find(item => item.id === ownTest.id);
      const forbidden = await request(`/api/tasks/${ownTest.id}`, { method: 'PATCH', cookie, csrf, body: { version: ownTestNow.version, status: 'done' } });
      assert.equal(forbidden.status, 403, '开发者不可验收自己的测试中任务');
    }
    if (role === 'tester') {
      assert.equal(snapshot.metrics.actionable, 8);
      assert.deepEqual(new Set(snapshot.todos.filter(item => item.entityType === 'requirement').map(item => item.entityId)), new Set(finalReviewIds));
      for (const id of finalReviewIds) {
        const requirement = bootstrap.data.requirements.find(item => item.id === id);
        assert.equal(requirement.status, '测试中');
        const tasks = bootstrap.data.tasks.filter(item => item.requirementId === id);
        assert(tasks.every(item => taskStage(item.status) === 'done'));
        assert(checkRequirementTransition(role, requirement, { ...requirement, status: '已完成' }, { tasks }).ok);
      }
    }
    if (role === 'lead') {
      assert.equal(snapshot.metrics.actionable, documentPages ? 14 : requirementPages ? 13 : 12);
      assert.deepEqual(new Set(snapshot.todos.filter(item => item.kind === 'planning').map(item => item.entityId)), new Set([...planningIds, ...(requirementPages ? [baseRequirements[0].id] : []), ...(documentPages ? [documentFixtures.converted.requirement.id] : [])]));
    }
    if (role === 'viewer') {
      assert.equal(snapshot.metrics.actionable, 0); assert.deepEqual(snapshot.todos, []);
      const ownTaskNow = bootstrap.data.tasks.find(item => item.id === expectedOwnIds[0]);
      const forbidden = await request(`/api/tasks/${ownTaskNow.id}`, { method: 'PATCH', cookie, csrf, body: { version: ownTaskNow.version, status: 'develop' } });
      assert.equal(forbidden.status, 403, '观察者不能通过真实接口更新任务');
    }
    expected[role] = { username: `quality-${role}`, metrics: snapshot.metrics, todoIds: snapshot.todos.map(item => item.entityId),
      kinds: snapshot.todos.reduce((counts, item) => ({ ...counts, [item.kind]: (counts[item.kind] || 0) + 1 }), {}) };
    await request('/api/auth/logout', { method: 'POST', cookie, csrf, body: {} });
  }
  console.log(JSON.stringify({ origin, date, database: ':memory:', longTitles, projectPages, requirementPages, documentPages, requirementPageExpected, documentPageExpected,
    visibleProjectIds: projects.map(project => project.id), firstRequirementId: baseRequirements[0].id, password, expected }));
  if (process.argv.includes('--check')) stop();
} catch (error) {
  stop();
  throw error;
}
