import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';
import { createWorkService } from '../work-service.mjs';
import { parseSections, changedSections, referencedSections, affectedSections } from '../../frontend/doc-sections.js';

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const put = db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES(?,?,?,?, 'active',0)");
  for (const [id, role] of [['admin','admin'],['product','member'],['lead','member'],['dev','member'],['viewer','member'],['boss','member'],['other','member']]) put.run(id,id,id,role);
  db.prepare("UPDATE users SET executive=1 WHERE id='boss'").run();
  const b = createBusiness(db); const actor = Object.fromEntries(['admin','product','lead','dev','viewer','boss','other'].map(id => [id, { id }]));
  let p = b.createProject(actor.admin, { name: '文档项目', ownerId: 'product' });
  for (const [userId, role] of [['lead','lead'],['dev','developer'],['viewer','viewer']]) p = b.setMember(actor.admin, p.id, { userId, role, version: p.version }).project;
  return { db, b, actor, p };
}
const file = text => Buffer.from(text, 'utf8');
const PRD = '# M1 网关\n\n## 1. 目标\n说明\n\n## 2. 对外接口 〔GW-2〕\n接口表\n\n### 2.1 流式 〔GW-2.1〕\n旧规则\n\n## 3. 错误 〔GW-3〕\n错误码\n';

test('章节识别：PRD 只取〔编号〕，技术方案取 § 章节号，验收用例取用例编号；子章节变化会带上父章节', () => {
  assert.deepEqual(parseSections('M1.md', PRD).map(item => item.code), ['GW-2', 'GW-2.1', 'GW-3']);
  assert.deepEqual(parseSections('spec.md', '# 规格\n## 9. 快照\n### 9.1 边界\n```\n## 不是标题\n```\n## 10. 路由\n').map(item => item.code), ['§9', '§9.1', '§10']);
  const feature = parseSections('M1.feature', 'Feature: 网关\n\n  @GW-AC-01 @req:GW-2 @N1\n  Scenario: 流式\n    Given 一个请求\n\n  @GW-AC-02 @req:GW-3\n  Scenario: 错误\n    Then 返回错误\n');
  assert.deepEqual(feature.map(item => [item.code, item.title, item.reqs]), [['GW-AC-01', '流式', ['GW-2']], ['GW-AC-02', '错误', ['GW-3']]]);
  const next = parseSections('M1.md', PRD.replace('旧规则', '新规则'));
  assert.deepEqual(changedSections(parseSections('M1.md', PRD), next), ['GW-2', 'GW-2.1']);
  const updated = { name: 'M1.md', type: 'PRD', changedSections: ['GW-2', 'GW-2.1'] };
  assert.deepEqual(affectedSections({ docRefs: [{ document: 'M1.md', sections: ['GW-2.1'] }] }, updated), ['GW-2.1']);
  assert.deepEqual(affectedSections({ docRefs: [{ document: 'M1.md', sections: ['GW-2'] }] }, updated), ['GW-2'], '子章节变化提醒引用父章节的需求');
  assert.deepEqual(affectedSections({ docRefs: [{ document: 'M1.md', sections: ['GW-3'] }] }, updated), []);
  const requirement = { docRefs: [{ document: 'M1.md', sections: ['GW-2'] }, { document: 'M1.feature', sections: ['GW-2'] }], acceptanceCases: ['GW-AC-01', 'X-AC-09'] };
  assert.deepEqual(referencedSections(requirement, { name: 'M1.md', type: 'PRD' }), ['GW-2']);
  assert.deepEqual(referencedSections(requirement, { name: 'M1.feature', type: '验收用例', sections: feature }), ['GW-AC-01']);
});

test('项目文档：产品经理上传与更新版本，内容不变不生成新版本，并记录变更章节', t => {
  const { b, actor, p } = fixture(t);
  const first = b.uploadDocument(actor.product, p.id, { name: 'M1.md', title: 'M1 网关', type: 'PRD', contentBuffer: file(PRD) });
  assert.equal(first.unchanged, false); assert.equal(first.document.version, 1); assert.equal(first.document.sections.length, 3);
  assert.equal(b.uploadDocument(actor.product, p.id, { name: 'M1.md', contentBuffer: file(PRD) }).unchanged, true);
  const second = b.uploadDocument(actor.product, p.id, { name: 'M1.md', contentBuffer: file(PRD.replace('错误码', '错误码与重试')), expectedVersion: 1, note: '补充重试' });
  assert.equal(second.document.version, 2); assert.deepEqual(second.document.changedSections, ['GW-3']);
  assert.throws(() => b.uploadDocument(actor.product, p.id, { name: 'M1.md', contentBuffer: file(PRD), expectedVersion: 1 }), error => error.code === 'VERSION_CONFLICT');
  assert.deepEqual(b.listDocumentVersions(actor.dev, first.document.id).map(item => item.version), [2, 1]);
  assert.match(b.getDocumentContent(actor.viewer, first.document.id, 1).contentBuffer.toString(), /错误码\n$/);
  assert.equal(b.bootstrap(actor.dev).documents.length, 1);
  assert.equal(b.bootstrap(actor.boss).documents.length, 1, '管理层只读可见全部项目文档');
  assert.equal(b.bootstrap(actor.other).documents.length, 0, '非成员看不到项目文档');
  assert.throws(() => b.listDocuments(actor.other, p.id), error => error.status === 403);
});

test('项目文档权限：主开发只维护技术方案，开发与观察者只读；主文档每个项目只有一份', t => {
  const { b, actor, p } = fixture(t);
  assert.throws(() => b.uploadDocument(actor.lead, p.id, { name: '总PRD.md', type: 'PRD', contentBuffer: file('# 总 PRD') }), error => error.status === 403);
  assert.equal(b.uploadDocument(actor.lead, p.id, { name: '架构.md', type: '技术方案', contentBuffer: file('# 架构') }).document.type, '技术方案');
  for (const role of ['dev', 'viewer', 'boss']) assert.throws(() => b.uploadDocument(actor[role], p.id, { name: 'x.md', type: '其他', contentBuffer: file('x') }), error => error.status === 403);
  assert.throws(() => b.uploadDocument(actor.product, p.id, { name: '../x.md', contentBuffer: file('x') }), error => error.status === 400);
  assert.throws(() => b.uploadDocument(actor.product, p.id, { name: 'x.exe', contentBuffer: file('x') }), error => error.status === 400);
  const main = b.uploadDocument(actor.product, p.id, { name: '总PRD.md', type: 'PRD', primary: true, contentBuffer: file('# 总 PRD') }).document;
  const other = b.uploadDocument(actor.product, p.id, { name: '总PRD-v2.md', type: 'PRD', primary: true, contentBuffer: file('# 新总 PRD') }).document;
  const docs = b.listDocuments(actor.dev, p.id);
  assert.deepEqual(docs.filter(item => item.primary).map(item => item.id), [other.id]);
  assert.equal(b.updateDocument(actor.product, main.id, { primary: true }).primary, true);
  assert.equal(b.listDocuments(actor.dev, p.id).filter(item => item.primary).length, 1);
  assert.throws(() => b.updateDocument(actor.lead, main.id, { title: '改标题' }), error => error.status === 403);
});

test('文档新版本修改了需求关联的章节时，提醒主责开发、主开发和测试，不提醒其他人', t => {
  const { db, b, actor, p } = fixture(t);
  db.prepare("INSERT INTO users(id,username,name,role,status,must_change_password) VALUES('tester','tester','tester','member','active',0)").run();
  actor.tester = { id: 'tester' };
  b.setMember(actor.admin, p.id, { userId: 'tester', role: 'tester', version: b.getProject(actor.admin, p.id).version });
  b.uploadDocument(actor.product, p.id, { name: 'M1.md', type: 'PRD', contentBuffer: file(PRD) });
  const linked = b.createRequirement(actor.product, { projectId: p.id, title: '流式', ownerId: 'product' });
  const other = b.createRequirement(actor.product, { projectId: p.id, title: '错误码', ownerId: 'product' });
  db.prepare('UPDATE requirements SET data=json_set(data,\'$.docRefs\',json(?)) WHERE id=?').run(JSON.stringify([{ document: 'M1.md', type: 'PRD', sections: ['GW-2'] }]), linked.id);
  db.prepare('UPDATE requirements SET data=json_set(data,\'$.docRefs\',json(?)) WHERE id=?').run(JSON.stringify([{ document: 'M1.md', type: 'PRD', sections: ['GW-3'] }]), other.id);
  b.uploadDocument(actor.product, p.id, { name: 'M1.md', contentBuffer: file(PRD.replace('旧规则', '新规则')) });
  const work = createWorkService(db, b), today = new Date().toISOString().slice(0, 10);
  const notices = id => work.snapshot(actor[id], today).reminders.filter(item => item.kind === 'document');
  assert.deepEqual(notices('lead').map(item => item.entityId), [linked.id]);
  assert.match(notices('lead')[0].message, /GW-2/);
  assert.deepEqual(notices('tester').map(item => item.entityId), [linked.id]);
  for (const id of ['dev', 'product', 'viewer']) assert.deepEqual(notices(id), []);
});

test('需求接口可写入关联文档章节与验收用例，去重并拒绝格式错误', async () => {
  const { openDatabase } = await import('../database.mjs');
  const { createBusiness } = await import('../business.mjs');
  const { createAuth } = await import('../auth.mjs');
  const db = openDatabase(':memory:');
  try {
    const auth = createAuth(db, { secureCookies: false });
    const admin = (await auth.bootstrapAdmin({ username: 'doc-admin', name: '管理员', password: 'Doc-Links-2026' })).user ?? db.prepare("SELECT id FROM users WHERE username='doc-admin'").get();
    const b = createBusiness(db);
    const project = b.createProject({ id: admin.id }, { name: '文档关联', targetDate: '2026-12-31' });
    const req = b.createRequirement({ id: admin.id }, { projectId: project.id, title: '网关', docRefs: [{ document: 'M1-网关.md', type: 'PRD', sections: ['GW-2', 'GW-2', 'GW-3.1'] }, { document: 'M1.feature', type: '验收用例', sections: ['GW-2'] }], acceptanceCases: ['GW-AC-01', 'GW-AC-01'] });
    assert.deepEqual(req.docRefs[0], { document: 'M1-网关.md', type: 'PRD', sections: ['GW-2', 'GW-3.1'] });
    assert.deepEqual(req.acceptanceCases, ['GW-AC-01']);
    const tech = b.updateRequirement({ id: admin.id }, req.id, { version: req.version, docRefs: [{ document: '算法升级版.md', type: '技术方案', sections: ['§9', '§16.1'] }] });
    assert.deepEqual(tech.docRefs[0].sections, ['§9', '§16.1']); assert.deepEqual(tech.acceptanceCases, ['GW-AC-01']);
    for (const bad of [{ docRefs: [{ document: '', sections: [] }] }, { docRefs: [{ document: 'a.md', type: '未知', sections: [] }] }, { docRefs: [{ document: 'a.md', sections: ['<b>'] }] }, { acceptanceCases: ['有 空格'] }, { docRefs: 'x' }])
      assert.throws(() => b.updateRequirement({ id: admin.id }, req.id, { version: tech.version, ...bad }), error => error.status === 400);
  } finally { db.close(); }
});
