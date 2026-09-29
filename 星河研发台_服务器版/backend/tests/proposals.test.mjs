import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { createProposalService } from '../proposals.mjs';
import { createApplication } from '../server.mjs';

const status = expected => error => error.status === expected;
function fixture(t) {
  const db = openDatabase(':memory:');t.after(() => db.close());
  for (const id of ['admin', 'product', 'lead', 'developer', 'developer2', 'tester', 'viewer', 'executive', 'outsider']) db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password,executive) VALUES(?,?,?,?,'active',0,?)").run(id, id, `${id}姓名`, id === 'admin' ? 'admin' : 'member', id === 'executive' ? 1 : 0);
  const actors = Object.fromEntries(['admin', 'product', 'lead', 'developer', 'developer2', 'tester', 'viewer', 'executive', 'outsider'].map(id => [id, { id }]));
  for (const id of ['p', 'other-project']) db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(id, JSON.stringify({ id, name: id, ownerId: 'product' }));
  for (const id of ['product', 'lead', 'developer', 'developer2', 'tester', 'viewer']) db.prepare('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)').run('p', id, id === 'developer2' ? 'developer' : id);
  const business = createBusiness(db), proposals = createProposalService(db, business);
  const content = { projectId: 'p', title: '客户提出的导出能力', description: '减少手工汇总', acceptance: '导出结果包含所有筛选条目', source: '客户反馈', proposerName: '客户甲', priority: 'P1' };
  return { db, actors, business, proposals, content };
}

test('多角色提议，创建人可信、外部提出人可记录，查看隔离且只读角色不可写', t => {
  const { db, actors, proposals, content } = fixture(t);
  for (const role of ['admin', 'product', 'lead', 'developer', 'tester']) {
    const item = proposals.create(actors[role], content);
    assert.equal(item.createdBy, role);assert.equal(item.proposerName, '客户甲');assert.equal(item.status, '待评估');
    assert.equal(proposals.read(actors.viewer, item.id).id, item.id);
    assert.equal(proposals.read(actors.executive, item.id).id, item.id);
    assert.throws(() => proposals.read(actors.outsider, item.id), status(403));
  }
  for (const role of ['viewer', 'executive', 'outsider']) assert.throws(() => proposals.create(actors[role], content), status(403));
  assert.throws(() => proposals.create(actors.developer, { ...content, createdBy: 'product' }), status(400));
  assert.throws(() => proposals.create(actors.developer, { ...content, status: '已转需求' }), status(400));
  assert.throws(() => proposals.create(actors.developer, { ...content, projectId: 'other-project' }), status(403));
  assert.deepEqual(proposals.list(actors.outsider), []);
  db.prepare("UPDATE users SET must_change_password=1 WHERE id='developer'").run();
  assert.throws(() => proposals.create(actors.developer, content), error => error.code === 'PASSWORD_CHANGE_REQUIRED');
});

test('本人补充与产品评估权限独立，退回需说明且并发版本冲突不覆盖内容', t => {
  const { db, actors, proposals, content } = fixture(t);
  let item = proposals.create(actors.developer, content);
  assert.throws(() => proposals.update(actors.developer2, item.id, { version: item.version, title: '他人改动' }), status(403));
  assert.throws(() => proposals.update(actors.developer, item.id, { version: item.version, status: '评估中' }), status(403));
  item = proposals.update(actors.developer, item.id, { version: item.version, description: '补充背景' });
  assert.throws(() => proposals.update(actors.product, item.id, { version: 1, title: '覆盖旧版本' }), error => error.code === 'VERSION_CONFLICT');
  assert.throws(() => proposals.update(actors.product, item.id, { version: item.version, status: '待补充' }), /评估说明/);
  item = proposals.update(actors.product, item.id, { version: item.version, status: '待补充', decisionReason: '请说明导出字段' });
  item = proposals.update(actors.developer, item.id, { version: item.version, description: '导出姓名和创建日期' });
  assert.equal(item.status, '待评估');
  item = proposals.update(actors.product, item.id, { version: item.version, status: '评估中' });
  assert.throws(() => proposals.update(actors.developer, item.id, { version: item.version, description: '评估时改动' }), status(403));
  const entries = proposals.history(actors.viewer, item.id);
  assert.equal(entries.length, 5);assert.equal(entries[0].detail.after.status, '评估中');assert.equal(entries[0].actorName, 'product姓名');
  db.prepare("UPDATE users SET name='改名后' WHERE id='product'").run();assert.equal(proposals.history(actors.viewer, item.id)[0].actorName, 'product姓名');
  assert.throws(() => proposals.history(actors.outsider, item.id), status(403));
});

test('提议支持全文、章节和验收用例关联，省略字段保留旧值，显式空数组才移除', t => {
  const { db, actors, proposals, content } = fixture(t);
  let item = proposals.create(actors.developer, { ...content, docRefs: [{ document: '  产品说明.md  ', type: 'PRD', sections: [] }, { document: '研发设计.md', type: '技术方案', sections: ['§2', '§2', '§2.1'] }], acceptanceCases: ['EXPORT-AC-01', 'EXPORT-AC-01'] });
  assert.deepEqual(item.docRefs, [{ document: '产品说明.md', type: 'PRD', sections: [] }, { document: '研发设计.md', type: '技术方案', sections: ['§2', '§2.1'] }]);
  assert.deepEqual(item.acceptanceCases, ['EXPORT-AC-01']);
  assert.deepEqual(proposals.read(actors.viewer, item.id).docRefs, item.docRefs);
  assert.deepEqual(proposals.list(actors.tester)[0].acceptanceCases, item.acceptanceCases);
  for (const role of ['developer2', 'viewer', 'executive', 'outsider']) assert.throws(() => proposals.update(actors[role], item.id, { version: item.version, docRefs: [] }), status(403));
  const originalRefs = item.docRefs, originalCases = item.acceptanceCases;
  item = proposals.update(actors.developer, item.id, { version: item.version, description: '补充说明但没有改文档' });
  assert.deepEqual(item.docRefs, originalRefs); assert.deepEqual(item.acceptanceCases, originalCases);
  assert.throws(() => proposals.update(actors.product, item.id, { version: 1, docRefs: [] }), error => error.code === 'VERSION_CONFLICT');
  item = proposals.update(actors.product, item.id, { version: item.version, docRefs: [], acceptanceCases: [] });
  assert.deepEqual(item.docRefs, []); assert.deepEqual(item.acceptanceCases, []);
  const latest = proposals.history(actors.viewer, item.id)[0];
  assert.deepEqual(latest.detail.before.docRefs, originalRefs); assert.deepEqual(latest.detail.after.docRefs, []); assert.equal(latest.actorName, 'product姓名');
  assert.equal(db.prepare('SELECT count(*) n FROM documents').get().n, 0, '只引用文档，不自动创建文档');
});

test('提议与需求使用相同文档引用校验，失败不保存记录或审计且未上传文件名保持兼容', t => {
  const { db, actors, proposals, business, content } = fixture(t);
  const requirementInput = { projectId: 'p', title: content.title, description: content.description, acceptance: content.acceptance };
  const invalid = [
    { docRefs: 'invalid' }, { docRefs: null }, { docRefs: Array(51).fill({ document: 'a.md' }) },
    { docRefs: [null] }, { docRefs: [{ document: '' }] }, { docRefs: [{ document: 'a\u0000.md' }] },
    { docRefs: [{ document: 'a.md', type: '未知' }] }, { docRefs: [{ document: 'a.md', sections: '章节' }] },
    { docRefs: [{ document: 'a.md', sections: Array(201).fill('§2') }] }, { docRefs: [{ document: 'a.md', sections: ['<unsafe>'] }] },
    { acceptanceCases: null }, { acceptanceCases: ['有 空格'] }, { acceptanceCases: Array(501).fill('A1') },
  ];
  const before = db.prepare('SELECT count(*) n FROM audit').get().n;
  for (const fields of invalid) {
    let proposalError, requirementError;
    try { proposals.create(actors.developer, { ...content, ...fields }); } catch (error) { proposalError = error; }
    try { business.createRequirement(actors.product, { ...requirementInput, ...fields }); } catch (error) { requirementError = error; }
    assert(proposalError); assert(requirementError); assert.equal(proposalError.status, 400); assert.equal(proposalError.code, requirementError.code); assert.equal(proposalError.message, requirementError.message);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM proposals').get().n, 0); assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 0); assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n, before);
  const pending = proposals.create(actors.developer, { ...content, docRefs: [{ document: '稍后上传.md', sections: ['P-1'] }] });
  assert.equal(pending.docRefs[0].document, '稍后上传.md');
  assert.deepEqual(pending.acceptanceCases, []);
});

test('确认提议完整传递文档引用，不复制文档，审批重试不改变原关联', t => {
  const { db, actors, proposals, business, content } = fixture(t);
  business.uploadDocument(actors.product, 'p', { name: '产品说明.md', type: 'PRD', contentBuffer: Buffer.from('# 导出能力〔EXPORT-1〕\n包括筛选结果。') });
  const originalDocuments = db.prepare('SELECT * FROM documents ORDER BY id').all(), originalVersions = db.prepare('SELECT * FROM document_versions ORDER BY id').all();
  let item = proposals.create(actors.developer, { ...content, docRefs: [{ document: '产品说明.md', type: 'PRD', sections: [] }], acceptanceCases: ['EXPORT-AC-01'] });
  const beforeCount = db.prepare('SELECT count(*) n FROM audit').get().n;
  assert.throws(() => proposals.approve(actors.product, item.id, { version: item.version, docRefs: [{ document: '', sections: [] }] }), status(400));
  assert.equal(proposals.read(actors.product, item.id).version, item.version); assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 0); assert.equal(db.prepare('SELECT count(*) n FROM audit').get().n, beforeCount);
  const approved = proposals.approve(actors.product, item.id, { version: item.version, docRefs: [{ document: '产品说明.md', type: 'PRD', sections: ['EXPORT-1'] }], acceptanceCases: ['EXPORT-AC-01', 'EXPORT-AC-02'] });
  assert.deepEqual(approved.proposal.docRefs, approved.requirement.docRefs); assert.deepEqual(approved.proposal.acceptanceCases, approved.requirement.acceptanceCases);
  assert.deepEqual(approved.requirement.docRefs, [{ document: '产品说明.md', type: 'PRD', sections: ['EXPORT-1'] }]);
  const repeated = proposals.approve(actors.product, item.id, { version: item.version, docRefs: [], acceptanceCases: [] });
  assert.equal(repeated.replayed, true); assert.equal(repeated.requirement.id, approved.requirement.id); assert.deepEqual(repeated.requirement.docRefs, approved.requirement.docRefs); assert.deepEqual(repeated.proposal.acceptanceCases, approved.proposal.acceptanceCases);
  assert.deepEqual(db.prepare('SELECT * FROM documents ORDER BY id').all(), originalDocuments); assert.deepEqual(db.prepare('SELECT * FROM document_versions ORDER BY id').all(), originalVersions);
  const audit = proposals.history(actors.product, item.id)[0]; assert.deepEqual(audit.detail.after.docRefs, approved.requirement.docRefs);
});

test('旧提议覆盖记录缺文档字段时继承原需求引用，读取不写库，编辑和原位确认不丢关联', t => {
  const { db, actors, proposals, content } = fixture(t);
  const old = { id: 'legacy-links', projectId: 'p', title: '已有文档的原需求', description: content.description, acceptance: content.acceptance, ownerId: 'product', status: '未确定', docRefs: [{ document: '原文档.md', type: '技术方案', sections: ['§3'] }], acceptanceCases: ['OLD-AC-01'] };
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run(old.id, 'p', JSON.stringify(old));
  let item = proposals.read(actors.product, old.id);
  assert.deepEqual(item.docRefs, old.docRefs); assert.deepEqual(item.acceptanceCases, old.acceptanceCases);
  item = proposals.update(actors.product, item.id, { version: item.version, title: '已存在的旧版提议覆盖记录' });
  const saved = JSON.parse(db.prepare('SELECT data FROM proposals WHERE id=?').get(item.id).data); delete saved.docRefs; delete saved.acceptanceCases;
  db.prepare('UPDATE proposals SET data=? WHERE id=?').run(JSON.stringify(saved), item.id);
  const raw = db.prepare('SELECT data FROM proposals WHERE id=?').get(item.id).data;
  item = proposals.read(actors.viewer, item.id); proposals.list(actors.product);
  assert.equal(db.prepare('SELECT data FROM proposals WHERE id=?').get(item.id).data, raw);
  assert.deepEqual(item.docRefs, old.docRefs); assert.deepEqual(item.acceptanceCases, old.acceptanceCases);
  item = proposals.update(actors.product, item.id, { version: item.version, description: '补充正文保留旧关联' });
  assert.deepEqual(item.docRefs, old.docRefs); assert.deepEqual(item.acceptanceCases, old.acceptanceCases);
  const replacement = [{ document: '原文档.md', type: '技术方案', sections: ['§3', '§4'] }];
  const result = proposals.approve(actors.product, item.id, { version: item.version, docRefs: replacement });
  assert.equal(result.requirement.id, old.id); assert.deepEqual(result.requirement.docRefs, replacement); assert.deepEqual(result.requirement.acceptanceCases, old.acceptanceCases);
  assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 1);
});

test('旧提议明确移除文档引用时不再从原需求补回，确认只改引用不删除文档', t => {
  const { db, actors, proposals, content } = fixture(t);
  const old = { ...content, id: 'legacy-clear', ownerId: 'product', status: '未确定', docRefs: [{ document: '保留文件.md', sections: [] }], acceptanceCases: ['OLD-1'] };
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run(old.id, 'p', JSON.stringify(old));
  let item = proposals.read(actors.product, old.id); item = proposals.update(actors.product, item.id, { version: item.version, docRefs: [], acceptanceCases: [] });
  assert.deepEqual(proposals.read(actors.viewer, item.id).docRefs, []);
  assert.equal(db.prepare('SELECT data FROM requirements WHERE id=?').get(old.id).data, JSON.stringify(old));
  const result = proposals.approve(actors.product, item.id, { version: item.version });
  assert.deepEqual(result.requirement.docRefs, []); assert.deepEqual(result.requirement.acceptanceCases, []);
});

test('产品确认转需求为原子操作，校验完整性、来源关联和重复请求不重复创建', t => {
  const { db, actors, proposals, business, content } = fixture(t);
  const item = proposals.create(actors.developer, { ...content, acceptance: '' });
  assert.throws(() => proposals.approve(actors.lead, item.id, { version: item.version }), status(403));
  assert.throws(() => proposals.approve(actors.product, item.id, { version: item.version }), /验收标准/);
  assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 0);
  db.exec("CREATE TRIGGER fail_proposal_audit BEFORE INSERT ON audit WHEN NEW.entity_type='proposal' AND NEW.action='approve' BEGIN SELECT RAISE(ABORT,'isolated_rollback'); END");
  assert.throws(() => proposals.approve(actors.product, item.id, { version: item.version, acceptance: content.acceptance }), /isolated_rollback/);
  assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 0);assert.equal(proposals.read(actors.product, item.id).version, item.version);
  db.exec('DROP TRIGGER fail_proposal_audit');
  const result = proposals.approve(actors.product, item.id, { version: item.version, acceptance: content.acceptance });
  assert.equal(result.replayed, false);assert.equal(result.requirement.status, '已确定');assert.equal(result.requirement.projectId, 'p');
  assert.equal(result.requirement.originProposalId, item.id);assert.equal(result.requirement.originSubmittedBy, 'developer');assert.equal(result.proposal.requirementId, result.requirement.id);
  const repeated = proposals.approve(actors.product, item.id, { version: item.version });assert.equal(repeated.replayed, true);assert.equal(repeated.requirement.id, result.requirement.id);
  assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 1);
  assert.throws(() => proposals.update(actors.product, item.id, { version: result.proposal.version, title: '已转出后改' }), error => error.code === 'PROPOSAL_CONVERTED');
  assert.equal(proposals.history(actors.product, item.id)[0].action, 'approve');
  assert.equal(business.getRequirement(actors.product, result.requirement.id).title, content.title);
});

test('旧未确认需求作为提议评估，原位确认保留任务、附件、历史和原编号', t => {
  const { db, actors, proposals, content } = fixture(t);
  const old = { id: 'legacy-requirement', projectId: 'p', title: '原始需求', description: '原始背景', acceptance: '', priority: 'P2', ownerId: 'product', status: '待评审', dependencyIds: [], docRefs: [{ document: '设计.md', sections: ['1'] }], acceptanceCases: ['A1'] };
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run(old.id, 'p', JSON.stringify(old));
  db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data) VALUES(?,?,?,?)').run('legacy-task', 'p', old.id, JSON.stringify({ id: 'legacy-task', title: '原任务', requirementId: old.id, projectId: 'p', status: 'wait' }));
  db.prepare('INSERT INTO attachments(id,requirement_id,project_id,name,mime,content) VALUES(?,?,?,?,?,?)').run('legacy-file', old.id, 'p', '说明.txt', 'text/plain', Buffer.from('原始文件'));
  db.prepare('INSERT INTO audit(user_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)').run('developer', 'create', 'requirement', old.id, JSON.stringify({ projectId: 'p', after: old }));
  let item = proposals.list(actors.product).find(x => x.id === old.id);
  assert.equal(item.status, '评估中');assert.equal(item.createdBy, 'developer');assert.equal(item.legacyRequirementId, old.id);
  item = proposals.update(actors.product, item.id, { version: item.version, title: '评估后的名称', acceptance: content.acceptance, status: '待补充', decisionReason: '补充验收要求' });
  assert.equal(db.prepare('SELECT data FROM requirements WHERE id=?').get(old.id).data, JSON.stringify(old));
  assert.equal(proposals.list(actors.product).filter(x => x.id === old.id).length, 1);
  const result = proposals.approve(actors.product, item.id, { version: item.version });
  assert.equal(result.requirement.id, old.id);assert.equal(result.requirement.status, '已确定');assert.equal(result.requirement.title, '评估后的名称');
  assert.deepEqual(result.requirement.docRefs, old.docRefs);assert.deepEqual(result.requirement.acceptanceCases, old.acceptanceCases);
  assert.equal(db.prepare('SELECT requirement_id FROM tasks WHERE id=?').get('legacy-task').requirement_id, old.id);
  assert.equal(Buffer.from(db.prepare('SELECT content FROM attachments WHERE id=?').get('legacy-file').content).toString(), '原始文件');
  assert.equal(db.prepare('SELECT count(*) n FROM requirements').get().n, 1);
  assert(proposals.history(actors.product, item.id).some(entry => entry.entityType === 'requirement' && entry.action === 'create'));
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('项目归档后提议不可写，旧提议底层版本变化不会覆盖或误批准', t => {
  const { db, actors, proposals, content } = fixture(t);
  const item = proposals.create(actors.developer, content);
  db.prepare("UPDATE projects SET archived=1 WHERE id='p'").run();
  assert.deepEqual(proposals.list(actors.product), []);assert.equal(proposals.list(actors.product, { includeArchived: true }).length, 1);
  assert.throws(() => proposals.approve(actors.product, item.id, { version: item.version }), error => error.code === 'ARCHIVED');
  db.prepare("UPDATE projects SET archived=0 WHERE id='p'").run();
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run('old', 'p', JSON.stringify({ ...content, status: '未确定', ownerId: 'product' }));
  let old = proposals.read(actors.product, 'old');old = proposals.update(actors.product, old.id, { version: old.version, title: '暂存提议' });
  db.prepare("UPDATE requirements SET version=version+1,data=json_set(data,'$.title','来自其他入口的内容改动') WHERE id='old'").run();
  assert.throws(() => proposals.approve(actors.product, old.id, { version: old.version }), error => error.code === 'VERSION_CONFLICT');
});

test('旧需求归档与恢复同步提议只读和可见性，恢复后仍可保留原编号确认', t => {
  const { db, actors, proposals, business, content } = fixture(t);
  db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run('archived-old', 'p', JSON.stringify({ ...content, id: 'archived-old', status: '未确定', ownerId: 'product' }));
  let proposal = proposals.read(actors.product, 'archived-old');
  proposal = proposals.update(actors.product, proposal.id, { version: proposal.version, description: '在提议模块补充后的内容' });
  const archived = business.archiveRequirement(actors.admin, proposal.id, { version: 1 });
  assert.equal(proposals.read(actors.product, proposal.id).archived, true);
  assert.equal(proposals.list(actors.product).some(item => item.id === proposal.id), false);
  assert.equal(proposals.list(actors.product, { includeArchived: true }).some(item => item.id === proposal.id), true);
  assert.throws(() => proposals.approve(actors.product, proposal.id, { version: proposal.version }), error => error.code === 'ARCHIVED');
  business.archiveRequirement(actors.admin, proposal.id, { version: archived.version, archived: false });
  const result = proposals.approve(actors.product, proposal.id, { version: proposal.version });
  assert.equal(result.requirement.id, proposal.id);assert.equal(result.requirement.description, '在提议模块补充后的内容');
});

test('提议接口校验会话与跨站凭证，完整批准可在初始化数据读取且重复请求幂等', async t => {
  const db = openDatabase(':memory:');t.after(() => db.close());
  const app = createApplication({ db, publicOrigin: 'http://127.0.0.1:3000', secureCookies: false, logger: { info() {}, error() {} } });
  const password = 'Proposal-Isolated!2026';await app.auth.bootstrapAdmin({ username: 'proposal-admin', name: '提议管理员', password });
  async function call(url, { method = 'GET', body, cookie, csrf, origin } = {}) {
    const req = new PassThrough();req.url = url;req.method = method;req.socket = { remoteAddress: 'proposal-test' };req.headers = { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(origin ? { origin } : {}) };
    return new Promise((resolve, reject) => {
      const headers = new Headers(), res = { statusCode: 200, headersSent: false, setHeader(key, value) { headers.set(key, value); }, writeHead(status, values = {}) { this.statusCode = status;this.headersSent = true;for (const [key, value] of Object.entries(values)) headers.set(key, value); }, end(value) { resolve({ status: this.statusCode, headers, data: JSON.parse(String(value)) }); } };
      app.handler(req, res).catch(reject);req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'proposal-admin', password } });assert.equal(login.status, 200);
  const session = { cookie: login.headers.get('set-cookie').split(';')[0], csrf: login.data.csrfToken };
  const project = app.business.createProject(login.data.user, { name: '接口项目' });
  const content = { projectId: project.id, title: '接口提议', description: '需要改进', acceptance: '改进后可验收', docRefs: [{ document: '接口说明.md', type: 'PRD', sections: [] }], acceptanceCases: ['API-AC-1'] };
  assert.equal((await call('/api/proposals')).status, 401);
  assert.equal((await call('/api/proposals', { method: 'POST', body: content, cookie: session.cookie })).data.code, 'CSRF_REJECTED');
  assert.equal((await call('/api/proposals', { method: 'POST', body: content, ...session, origin: 'https://untrusted.invalid' })).data.code, 'ORIGIN_REJECTED');
  const created = await call('/api/proposals', { method: 'POST', body: content, ...session });assert.equal(created.status, 201);
  const proposal = created.data, body = { version: proposal.version };
  const approved = await call(`/api/proposals/${proposal.id}/approve`, { method: 'POST', body, ...session });assert.equal(approved.status, 200);assert.equal(approved.data.requirement.status, '已确定');
  assert.deepEqual(approved.data.requirement.docRefs, content.docRefs);assert.deepEqual(approved.data.requirement.acceptanceCases, content.acceptanceCases);
  const repeated = await call(`/api/proposals/${proposal.id}/approve`, { method: 'POST', body, ...session });assert.equal(repeated.data.replayed, true);
  const bootstrap = await call('/api/bootstrap', session);assert.equal(bootstrap.data.proposals.length, 1);assert.equal(bootstrap.data.proposals[0].requirementId, approved.data.requirement.id);
  assert.deepEqual(bootstrap.data.proposals[0].docRefs, content.docRefs);assert.deepEqual(bootstrap.data.proposals[0].acceptanceCases, content.acceptanceCases);
  assert.equal((await call(`/api/proposals?projectId=${project.id}`, session)).data.proposals.length, 1);
  assert.equal((await call(`/api/proposals/${proposal.id}/history`, session)).data.entries.length, 2);
  assert.equal((await call('/api/proposals/missing', session)).status, 404);
});
