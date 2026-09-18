import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../database.mjs';
import { createAuth, hashToken, issueAdminRecoveryFromCli, resetUserFromCli } from '../auth.mjs';

const OLD_PASSWORD = 'Original-Test-Password';
const SIX_CHARACTER_PASSWORD = 'abc123';
const AT = Date.parse('2026-09-15T12:00:00Z');
const errorCode = code => error => error.code === code;

async function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let instant = AT;
  const now = () => instant;
  const auth = createAuth(db, { now });
  const admin = await auth.bootstrapAdmin({ username: 'original.admin', name: '原管理员姓名', password: OLD_PASSWORD });
  return { db, auth, admin, now, advance: milliseconds => { instant += milliseconds; } };
}

function snapshotBusiness(db) {
  const tables = ['projects', 'requirements', 'tasks', 'memberships', 'attachments', 'app_meta'];
  return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

test('默认选择唯一启用管理员并签发三十分钟令牌，明文不进入数据库或审计', async t => {
  const f = await fixture(t);
  const recovery = issueAdminRecoveryFromCli(f.db, { now: f.now });
  assert.deepEqual(Object.keys(recovery).sort(), ['expiresAt', 'token', 'username']);
  assert.equal(recovery.username, f.admin.username);
  assert.equal(Date.parse(recovery.expiresAt) - AT, 30 * 60 * 1000);
  const stored = f.db.prepare('SELECT * FROM account_tokens').get();
  assert.equal(stored.kind, 'reset');
  assert.equal(stored.user_id, f.admin.id);
  assert.equal(stored.token_hash, hashToken(recovery.token));
  assert.equal(stored.created_by, null);
  assert.ok(!JSON.stringify(stored).includes(recovery.token));
  const audit = f.db.prepare("SELECT * FROM audit WHERE action='account.cli_issue_admin_recovery'").get();
  assert.equal(audit.entity_id, f.admin.id);
  assert.equal(audit.user_id, null);
  assert.ok(!JSON.stringify(audit).includes(recovery.token));
  assert.ok(!JSON.stringify(audit).includes(OLD_PASSWORD));
  assert.equal('issueAdminRecoveryFromCli' in f.auth, false);
});

test('多名管理员必须明确选择，选定账号以外的管理员凭据保持原样', async t => {
  const f = await fixture(t);
  const created = f.auth.createUser(f.admin, { username: 'second.admin', name: '第二位管理员', role: 'admin' });
  await f.auth.redeemToken({ token: created.activationToken, password: OLD_PASSWORD });
  const before = f.db.prepare('SELECT id,password_hash FROM users ORDER BY id').all();
  assert.throws(() => issueAdminRecoveryFromCli(f.db, { now: f.now }), errorCode('ADMIN_USERNAME_REQUIRED'));
  assert.deepEqual(f.db.prepare('SELECT id,password_hash FROM users ORDER BY id').all(), before);
  const recovery = issueAdminRecoveryFromCli(f.db, { username: 'SECOND.ADMIN', now: f.now });
  assert.equal(recovery.username, 'second.admin');
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(created.user.id).password_hash, null);
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(f.admin.id).password_hash, before.find(user => user.id === f.admin.id).password_hash);
});

test('无管理员、未知账号、普通成员及停用或待激活管理员全部拒绝', async t => {
  const empty = openDatabase(':memory:');
  t.after(() => empty.close());
  assert.throws(() => issueAdminRecoveryFromCli(empty), errorCode('ADMIN_NOT_FOUND'));
  const f = await fixture(t);
  const member = f.auth.createUser(f.admin, { username: 'ordinary.member', name: '普通成员', role: 'member' });
  await f.auth.redeemToken({ token: member.activationToken, password: OLD_PASSWORD });
  const pending = f.auth.createUser(f.admin, { username: 'pending.admin', name: '待激活管理员', role: 'admin' });
  const disabled = f.auth.createUser(f.admin, { username: 'disabled.admin', name: '已停用管理员', role: 'admin' });
  await f.auth.redeemToken({ token: disabled.activationToken, password: OLD_PASSWORD });
  f.auth.updateUser(f.admin, disabled.user.id, { status: 'disabled' });
  const before = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.throws(() => issueAdminRecoveryFromCli(f.db, { username: 'missing.admin' }), errorCode('NOT_FOUND'));
  for (const username of [member.user.username, pending.user.username, disabled.user.username]) assert.throws(() => issueAdminRecoveryFromCli(f.db, { username }), errorCode('ADMIN_RECOVERY_NOT_ALLOWED'));
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), before);
});

test('恢复立即撤销旧密码和会话，六位密码兑换后正常登录且令牌只能使用一次', async t => {
  const f = await fixture(t);
  const oldSession = await f.auth.login({ username: f.admin.username, password: OLD_PASSWORD });
  const recovery = issueAdminRecoveryFromCli(f.db, { username: f.admin.username, now: f.now });
  assert.equal(f.auth.authenticate(oldSession.token), null);
  await assert.rejects(f.auth.login({ username: f.admin.username, password: OLD_PASSWORD }), errorCode('INVALID_CREDENTIALS'));
  await assert.rejects(f.auth.redeemToken({ token: recovery.token, password: 'abc12' }), errorCode('WEAK_PASSWORD'));
  const restored = await f.auth.redeemToken({ token: recovery.token, password: SIX_CHARACTER_PASSWORD });
  assert.equal(restored.user.id, f.admin.id);
  assert.equal(restored.user.name, f.admin.name);
  assert.equal(restored.user.role, 'admin');
  assert.equal(restored.user.status, 'active');
  assert.equal(restored.user.mustChangePassword, false);
  assert.equal((await f.auth.login({ username: f.admin.username, password: SIX_CHARACTER_PASSWORD })).user.id, f.admin.id);
  await assert.rejects(f.auth.redeemToken({ token: recovery.token, password: 'other6' }), errorCode('INVALID_TOKEN'));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM users').get().count, 1);
});

test('恢复链接到期无效，重新签发废弃旧链接并支持仍需改密的管理员', async t => {
  const f = await fixture(t);
  await resetUserFromCli(f.db, { username: f.admin.username, password: OLD_PASSWORD }, { now: f.now });
  assert.equal(f.db.prepare('SELECT must_change_password FROM users WHERE id=?').get(f.admin.id).must_change_password, 1);
  const first = issueAdminRecoveryFromCli(f.db, { now: f.now, tokenTtlMs: 1000 });
  f.advance(1000);
  await assert.rejects(f.auth.redeemToken({ token: first.token, password: SIX_CHARACTER_PASSWORD }), errorCode('INVALID_TOKEN'));
  const second = issueAdminRecoveryFromCli(f.db, { now: f.now, tokenTtlMs: 1000 });
  const third = issueAdminRecoveryFromCli(f.db, { now: f.now, tokenTtlMs: 1000 });
  await assert.rejects(f.auth.redeemToken({ token: second.token, password: SIX_CHARACTER_PASSWORD }), errorCode('INVALID_TOKEN'));
  const user = (await f.auth.redeemToken({ token: third.token, password: SIX_CHARACTER_PASSWORD })).user;
  assert.equal(user.mustChangePassword, false);
  assert.equal(user.role, 'admin');
});

test('恢复不改管理员身份、项目角色、需求、任务、附件及原有业务数据', async t => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('p-existing', JSON.stringify({ name: '原项目', ownerId: f.admin.id }));
  f.db.prepare('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)').run('p-existing', f.admin.id, 'product');
  f.db.prepare('INSERT INTO requirements(id,project_id,data) VALUES(?,?,?)').run('r-existing', 'p-existing', JSON.stringify({ title: '原需求', assigneeId: f.admin.id }));
  f.db.prepare('INSERT INTO tasks(id,project_id,requirement_id,data) VALUES(?,?,?,?)').run('t-existing', 'p-existing', 'r-existing', JSON.stringify({ title: '原任务', ownerId: f.admin.id }));
  f.db.prepare('INSERT INTO attachments(id,requirement_id,project_id,name,mime,content,created_by) VALUES(?,?,?,?,?,?,?)').run('f-existing', 'r-existing', 'p-existing', '原文档.md', 'text/markdown', Buffer.from('原始正文'), f.admin.id);
  f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run('legacy_import_sha256', 'original-business-digest');
  const before = snapshotBusiness(f.db);
  const identityBefore = f.db.prepare('SELECT id,username,name,role,status,created_at FROM users ORDER BY id').all();
  const recovery = issueAdminRecoveryFromCli(f.db, { now: f.now });
  assert.deepEqual(snapshotBusiness(f.db), before);
  await f.auth.redeemToken({ token: recovery.token, password: SIX_CHARACTER_PASSWORD });
  assert.deepEqual(snapshotBusiness(f.db), before);
  assert.deepEqual(f.db.prepare('SELECT id,username,name,role,status,created_at FROM users ORDER BY id').all(), identityBefore);
});

test('无效的账号选择与恢复期限配置在修改密码前被拒绝', async t => {
  const f = await fixture(t);
  const before = f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(f.admin.id).password_hash;
  for (const options of [{ username: '' }, { username: null }, { tokenTtlMs: 0 }, { tokenTtlMs: 1800001 }, { tokenTtlMs: 1.5 }, { tokenTtlMs: '1000' }, { now: 123 }, { now: () => NaN }, { now: () => Infinity }, { extra: true }]) assert.throws(() => issueAdminRecoveryFromCli(f.db, options));
  assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(f.admin.id).password_hash, before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS count FROM account_tokens').get().count, 0);
});
