import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { openDatabase, writeAudit } from '../database.mjs';
import { hashToken } from '../auth.mjs';
import { createApplication } from '../server.mjs';
import { reconcileDeliveryWorkflow } from '../delivery-migration.mjs';
import { requirementDeliveryState } from '../../frontend/workflow.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES('admin','admin','测试管理员','admin','active',0)").run();
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('p', JSON.stringify({ id: 'p', name: '升级校准测试', ownerId: 'admin' }));
  const requirement = (id, extra = {}, { archived = 0, projectId = 'p' } = {}) => {
    const data = { id, projectId, title: '旧需求', status: '开发中', description: '原始背景', acceptance: '原始验收标准', ownerId: 'admin', assigneeId: 'admin', dependencyIds: [], planStart: '2026-09-25', planEnd: '2026-10-01', baseline: { planStart: '2026-09-25', planEnd: '2026-10-01', capturedAt: '2026-09-20T16:44:42.197Z' }, rescheduleCount: 2, docRefs: [{ document: '算法.md', type: '技术方案', sections: ['§10'] }], acceptanceCases: ['§15-9'], ...extra };
    db.prepare('INSERT INTO requirements(id,project_id,data,version,archived,created_at,updated_at) VALUES(?,?,?,6,?,?,?)').run(id, projectId, JSON.stringify(data), archived, '2026-09-20T16:44:42.197Z', '2026-09-22T15:07:00.631Z');
    return data;
  };
  const task = (id, requirementId, extra = {}, { archived = 0, projectId = 'p' } = {}) => {
    const data = { id, projectId, requirementId, title: id, status: 'done', ownerId: 'admin', estimateHours: 6, startDate: '2026-09-25', dueDate: '2026-09-30', completedAt: '2026-09-24T08:01:29.638Z', ...extra };
    db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data,version,archived) VALUES(?,?,?,?,4,?)').run(id, projectId, requirementId, JSON.stringify(data), archived);
    return data;
  };
  const row = id => db.prepare('SELECT * FROM requirements WHERE id=?').get(id);
  const stored = id => JSON.parse(row(id).data);
  const start = () => createApplication({ db, publicOrigin: 'http://127.0.0.1:3000', secureCookies: false, logger: { info() {}, error() {} } });
  return { db, requirement, task, row, stored, start };
}

async function get(app, endpoint, cookie) {
  const request = new PassThrough();
  request.url = endpoint; request.method = 'GET'; request.headers = { cookie }; request.socket = { remoteAddress: '127.0.0.1' };
  return new Promise((resolve, reject) => {
    const response = { statusCode: 200, headersSent: false, setHeader() {}, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(body) { resolve({ status: this.statusCode, data: JSON.parse(body) }); } };
    app.handler(request, response).catch(reject); request.end();
  });
}

test('升级首次启动即修复五项任务全完成的旧需求，首次读取无需保存且保留全部关联数据', async t => {
  const f = fixture(t), original = f.requirement('r-old');
  const tasks = Array.from({ length: 5 }, (_, index) => f.task(`t-${index}`, original.id));
  f.db.prepare('INSERT INTO attachments(id,requirement_id,project_id,name,mime,content) VALUES(?,?,?,?,?,?)').run('a', original.id, 'p', '算法.md', 'text/markdown', Buffer.from('原始附件'));
  f.db.prepare('INSERT INTO documents(id,project_id,name,title,type) VALUES(?,?,?,?,?)').run('d', 'p', '算法.md', '算法', '技术方案');
  f.db.prepare('INSERT INTO document_versions(id,document_id,version,mime,content,content_hash,sections) VALUES(?,?,?,?,?,?,?)').run('dv', 'd', 1, 'text/markdown', Buffer.from('原始文档'), 'existing-hash', '[{"code":"§10"}]');
  f.db.prepare('INSERT INTO proposals(id,project_id,requirement_id,data) VALUES(?,?,?,?)').run('q', 'p', original.id, '{"status":"已转需求"}');
  writeAudit(f.db, 'admin', 'transition', 'requirement', original.id, { projectId: 'p', reason: '原有流转记录' });
  const tables = ['projects', 'users', 'tasks', 'attachments', 'documents', 'document_versions', 'proposals', 'memberships', 'app_meta'];
  const untouched = new Map(tables.map(table => [table, f.db.prepare(`SELECT * FROM ${table}`).all()]));
  const oldAudit = f.db.prepare('SELECT * FROM audit').all(), oldRow = f.row(original.id);
  const token = 'a'.repeat(43);
  f.db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,auth_version) VALUES(?,?,?,0)').run(hashToken(token), 'admin', new Date(Date.now() + 60000).toISOString());

  const app = f.start(), boot = await get(app, '/api/bootstrap', `xinghe_session=${token}`);
  assert.equal(boot.status, 200);
  const current = boot.data.requirements.find(item => item.id === original.id);
  assert.equal(current.status, '测试中'); assert.equal(current.deliveryWorkflow, true); assert.equal(current.version, 7);
  assert.deepEqual(f.stored(original.id), { ...original, status: '测试中', deliveryWorkflow: true });
  assert.equal(f.row(original.id).created_at, oldRow.created_at);
  assert.equal(requirementDeliveryState(current, tasks).readyForAcceptance, true);
  for (const [table, rows] of untouched) assert.deepEqual(f.db.prepare(`SELECT * FROM ${table}`).all(), rows, table);
  assert.deepEqual(f.db.prepare('SELECT * FROM audit ORDER BY id LIMIT 1').all(), oldAudit);
  const history = app.business.listHistory({ id: 'admin' }, { entityType: 'requirement', entityId: original.id });
  const migration = history.find(item => item.detail.migration === 'delivery_workflow_v1');
  assert.equal(migration.userId, null); assert.equal(migration.detail.actorName, '系统升级');
  assert.equal(migration.detail.before.status, '开发中'); assert.equal(migration.detail.after.status, '测试中');
  const afterStartup = f.row(original.id), audits = f.db.prepare('SELECT count(*) n FROM audit').get().n;
  assert.equal((await get(app, `/api/requirements/${original.id}`, `xinghe_session=${token}`)).data.status, '测试中');
  assert.deepEqual(f.row(original.id), afterStartup); assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n, audits);
});

test('旧需求按真实任务校准，兼容中文状态并保留验收缺项和返工暂停，不自动验收完成', t => {
  const f = fixture(t);
  const cases = [
    ['done', {}, [{ status: 'done' }], '测试中'],
    ['chinese', { deliveryWorkflow: false }, [{ status: '已完成' }], '测试中'],
    ['testing', { deliveryWorkflow: 'true' }, [{ status: 'test' }, { status: 'done' }], '测试中'],
    ['unfinished', {}, [{ status: 'done' }, { status: 'wait' }], '开发中'],
    ['scheduled', { status: '已确定' }, [{ status: 'wait' }], '已排期'],
    ['undated', { status: '已确定' }, [{ status: 'wait', startDate: '', dueDate: '' }], '待排期'],
    ['unassigned', { status: '已确定', assigneeId: '' }, [{ status: 'wait' }], '已确定'],
    ['acceptance', { acceptance: ' ' }, [{ status: 'done' }], '开发中'],
    ['held', { workflowHold: true }, [{ status: 'done' }], '开发中'],
    ['empty', {}, [], '开发中'],
    ['terminated-task', {}, [{ status: 'terminated' }], '开发中'],
    ['stale-modern', { deliveryWorkflow: true }, [{ status: 'done' }], '测试中']
  ];
  for (const [id, extra, tasks] of cases) { f.requirement(id, extra); tasks.forEach((task, index) => f.task(`${id}-${index}`, id, task)); }
  f.requirement('archived-task'); f.task('archived-child', 'archived-task', {}, { archived: 1 });
  f.start();
  for (const [id, , , status] of cases) {
    assert.equal(f.stored(id).status, status, id); assert.equal(f.stored(id).deliveryWorkflow, true, id);
    assert.equal(f.stored(id).deliveryStartedAt, undefined, '校准不编造历史开工时间');
  }
  assert.equal(f.stored('held').workflowHold, true);
  assert.equal(f.stored('archived-task').status, '开发中');
  assert.equal(f.db.prepare("SELECT count(*) n FROM requirements WHERE json_extract(data,'$.status')='已完成'").get().n, 0);
});

test('升级不改未确认、已完成、已终止及归档记录，已同步记录也不增加版本与审计', t => {
  const f = fixture(t), ids = [];
  for (const status of ['未确定', '待评审', '已完成', '已终止', '未知历史阶段']) { const id = `skip-${ids.length}`; f.requirement(id, { status }); f.task(`${id}-task`, id); ids.push(id); }
  f.requirement('archived', {}, { archived: 1 }); f.task('archived-task', 'archived'); ids.push('archived');
  f.db.prepare('INSERT INTO projects(id,data,archived) VALUES(?,?,1)').run('p-archived', '{"name":"归档项目"}');
  f.requirement('archived-project', {}, { projectId: 'p-archived' }); f.task('archived-project-task', 'archived-project', {}, { projectId: 'p-archived' }); ids.push('archived-project');
  f.requirement('already-aligned', { status: '测试中', deliveryWorkflow: true }); f.task('already-aligned-task', 'already-aligned'); ids.push('already-aligned');
  const before = ids.map(f.row), audits = f.db.prepare('SELECT count(*) n FROM audit').get().n;
  f.start();
  assert.deepEqual(ids.map(f.row), before); assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n, audits);
});

test('重复启动不重复校准，后续恢复或导入的旧需求仍在下一次启动处理', t => {
  const f = fixture(t); f.requirement('first'); f.task('first-task', 'first'); f.start();
  const first = f.row('first'), auditCount = f.db.prepare('SELECT count(*) n FROM audit').get().n;
  assert.deepEqual(reconcileDeliveryWorkflow(f.db), { updated: 0, transitions: 0 }); f.start();
  assert.deepEqual(f.row('first'), first); assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n, auditCount);
  f.requirement('later-import'); f.task('later-task', 'later-import'); f.start();
  assert.equal(f.stored('later-import').status, '测试中'); assert.deepEqual(f.row('first'), first);
  assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n, auditCount + 1);
});

test('校准任何一条失败时整批回滚需求与审计，失败修复后可再次启动', t => {
  const f = fixture(t); for (const id of ['a', 'b']) { f.requirement(id); f.task(`${id}-task`, id); }
  const before = ['a', 'b'].map(f.row), audits = f.db.prepare('SELECT * FROM audit').all();
  f.db.exec("CREATE TRIGGER fail_migration BEFORE INSERT ON audit WHEN NEW.entity_id='b' BEGIN SELECT RAISE(ABORT,'migration-failure'); END");
  assert.throws(() => f.start(), /migration-failure/);
  assert.deepEqual(['a', 'b'].map(f.row), before); assert.deepEqual(f.db.prepare('SELECT * FROM audit').all(), audits);
  assert.equal(f.db.isTransaction, false);
  f.db.exec('DROP TRIGGER fail_migration'); f.start();
  assert.deepEqual(['a', 'b'].map(id => f.stored(id).status), ['测试中', '测试中']);
  assert.equal(f.db.prepare('SELECT count(*) n FROM audit').get().n, 2);
});

test('升级校准增加版本号，旧页面的过期保存被拒绝，最终完成仍需人工验收', t => {
  const f = fixture(t), old = f.requirement('r'); f.task('t', old.id); const app = f.start();
  assert.throws(() => app.business.updateRequirement({ id: 'admin' }, old.id, { version: 6, title: '过期覆盖' }), error => error.code === 'VERSION_CONFLICT');
  assert.equal(f.stored(old.id).status, '测试中'); assert.equal(f.stored(old.id).title, old.title);
  const current = app.business.getRequirement({ id: 'admin' }, old.id);
  assert.equal(app.business.updateRequirement({ id: 'admin' }, current.id, { version: current.version, status: '已完成' }).status, '已完成');
});
