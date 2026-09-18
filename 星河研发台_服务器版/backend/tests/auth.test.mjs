import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase, transaction } from '../database.mjs';
import { createAuth, hashPassword, verifyPassword, hashToken, validatePassword, resetUserFromCli } from '../auth.mjs';

const PASSWORD = 'Test-Only-Passphrase-123';
const NEW_PASSWORD = 'Changed-Test-Passphrase-456';
const CURRENT = Date.parse('2026-09-15T12:00:00Z');

async function setup(t, options = {}) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = createAuth(db, { now: () => CURRENT, ...options });
  const admin = await auth.bootstrapAdmin({ username: 'root.admin', name: '测试管理员', password: PASSWORD });
  return { db, auth, admin };
}
async function member(auth, admin, username = 'member.one', role = 'member') {
  const created = auth.createUser(admin, { username, name: '测试成员', role });
  return (await auth.activate({ token: created.activationToken, password: PASSWORD })).user;
}
function errorCode(code) { return error => error.code === code; }

test('数据库为真实SQLite并启用外键与文件权限，事务失败回滚', t => {
  const folder = mkdtempSync(join(tmpdir(), 'xinghe-auth-db-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'workspace.sqlite');
  const db = openDatabase(path);
  try {
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => transaction(db, () => { db.prepare('INSERT INTO app_meta VALUES(?,?)').run('rollback', 'yes'); throw new Error('stop'); }), /stop/);
    assert.equal(db.prepare('SELECT 1 FROM app_meta WHERE key=?').get('rollback'), undefined);
    assert.throws(() => db.prepare('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?)').run('missing', 'missing', 'viewer'), /FOREIGN KEY/);
  } finally { db.close(); }
});

test('密码以带随机盐的规定scrypt参数保存，验证正确且拒绝弱密码', async () => {
  for (const password of ['short', ' '.repeat(12), '密'.repeat(400), null]) assert.throws(() => validatePassword(password), errorCode('WEAK_PASSWORD'));
  const first = await hashPassword(PASSWORD);
  const second = await hashPassword(PASSWORD);
  assert.match(first, /^scrypt\$32768\$8\$3\$/);
  assert.notEqual(first, second);
  assert.ok(!first.includes(PASSWORD));
  assert.equal(await verifyPassword(PASSWORD, first), true);
  assert.equal(await verifyPassword(NEW_PASSWORD, first), false);
  assert.equal(await verifyPassword(PASSWORD, 'malformed'), false);
});

test('最低密码接受六个字符、拒绝五个字符，并继续兼容原十二位以上密码', async () => {
  const previousPassword = 'LegacyPass12';
  assert.equal(Array.from(previousPassword).length, 12);
  for (const password of ['abc123', '密码保护一二', '😀'.repeat(6), previousPassword, PASSWORD]) assert.equal(validatePassword(password), password);
  for (const password of ['abc12', '密码保护一', '😀'.repeat(5)]) assert.throws(() => validatePassword(password), error => error.code === 'WEAK_PASSWORD' && error.message.includes('至少 6 个字符'));
  const sixCharacterHash = await hashPassword('abc123');
  assert.equal(await verifyPassword('abc123', sixCharacterHash), true);
  const previousLengthHash = await hashPassword(previousPassword);
  assert.equal(await verifyPassword(previousPassword, previousLengthHash), true);
  assert.match(previousLengthHash, /^scrypt\$32768\$8\$3\$/);
});

test('六位密码可建立管理员并登录，五位密码无法初始化账号', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = createAuth(db);
  await assert.rejects(auth.bootstrapAdmin({ username: 'short.admin', name: '测试管理员', password: 'abc12' }), errorCode('WEAK_PASSWORD'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  const admin = await auth.bootstrapAdmin({ username: 'short.admin', name: '测试管理员', password: 'abc123' });
  const session = await auth.login({ username: 'short.admin', password: 'abc123' });
  assert.equal(session.user.id, admin.id);
});

test('没有默认管理员或密码，首次管理员只能建立一次', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const auth = createAuth(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  await assert.rejects(auth.bootstrapAdmin({ username: 'root.admin', name: '管理员', password: 'short' }), errorCode('WEAK_PASSWORD'));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 0);
  const admin = await auth.bootstrapAdmin({ username: 'root.admin', name: '管理员', password: PASSWORD });
  assert.equal(admin.role, 'admin');
  assert.equal(admin.mustChangePassword, false);
  await assert.rejects(auth.bootstrapAdmin({ username: 'other.admin', name: '管理员二', password: PASSWORD }), errorCode('ADMIN_EXISTS'));
});

test('首次管理员复用原导入账号及项目关联，采用明确填写的姓名', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare("INSERT INTO users(id,username,name,role,status,password_hash) VALUES(?,?,?,'member','pending',NULL)").run('u-original', 'original.user', '原始姓名');
  db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run('p-original', '{}');
  db.prepare("INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,'product')").run('p-original', 'u-original');
  const admin = await createAuth(db).bootstrapAdmin({ username: 'original.user', name: '初始化填写姓名', password: PASSWORD });
  assert.equal(admin.id, 'u-original');
  assert.equal(admin.name, '初始化填写姓名');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.status, 'active');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 1);
  assert.equal(db.prepare('SELECT user_id FROM memberships').get().user_id, admin.id);
});

test('会话令牌仅存哈希，cookie属性、跨站令牌与安全用户字段正确', async t => {
  const { db, auth } = await setup(t);
  const result = await auth.login({ username: 'ROOT.ADMIN', password: PASSWORD });
  const stored = db.prepare('SELECT * FROM sessions').get();
  assert.equal(stored.token_hash, hashToken(result.token));
  assert.ok(!JSON.stringify(stored).includes(result.token));
  assert.match(result.cookie, /HttpOnly/);
  assert.match(result.cookie, /Secure/);
  assert.match(result.cookie, /SameSite=Strict/);
  assert.match(result.cookie, /Path=\//);
  assert.equal(auth.tokenFromCookie('other=a; ' + result.cookie.split(';')[0]), result.token);
  assert.equal(auth.tokenFromCookie(result.cookie.split(';')[0] + '; ' + result.cookie.split(';')[0]), '');
  assert.equal(auth.verifyCsrf(result.token, result.csrfToken), true);
  assert.equal(auth.verifyCsrf(result.token, 'a'.repeat(64)), false);
  const authenticated = auth.authenticate(result.token);
  assert.equal(authenticated.user.username, 'root.admin');
  for (const key of ['password_hash', 'auth_version', 'token_hash']) assert.equal(key in authenticated.user, false);
});

test('会话跨数据库重启持久化，到期立即失效且删除', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'xinghe-auth-restart-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const path = join(folder, 'workspace.sqlite');
  let clock = CURRENT;
  let db = openDatabase(path);
  let auth = createAuth(db, { now: () => clock, sessionTtlMs: 1000 });
  await auth.bootstrapAdmin({ username: 'root.admin', name: '管理员', password: PASSWORD });
  const result = await auth.login({ username: 'root.admin', password: PASSWORD });
  db.close();
  db = openDatabase(path);
  try {
    auth = createAuth(db, { now: () => clock, sessionTtlMs: 1000 });
    assert.equal(auth.authenticate(result.token).user.username, 'root.admin');
    clock += 1000;
    assert.equal(auth.authenticate(result.token), null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions').get().n, 0);
  } finally { db.close(); }
});

test('登出使持久化会话失效，清除cookie可安全重复调用', async t => {
  const { auth } = await setup(t);
  const result = await auth.login({ username: 'root.admin', password: PASSWORD });
  assert.match(auth.logout(result.token).cookie, /Max-Age=0/);
  assert.equal(auth.authenticate(result.token), null);
  assert.match(auth.logout(result.token).cookie, /HttpOnly/);
});

test('未知账号、待激活、停用与错误密码使用相同失败响应', async t => {
  const { auth, admin } = await setup(t, { maxLoginAttempts: 100 });
  const pending = auth.createUser(admin, { username: 'pending.user', name: '待激活用户' });
  const active = await member(auth, admin);
  auth.updateUser(admin, active.id, { status: 'disabled' });
  for (const username of ['not.exists', pending.user.username, active.username, 'root.admin']) {
    await assert.rejects(auth.login({ username, password: username === 'root.admin' ? NEW_PASSWORD : PASSWORD }), error => error.status === 401 && error.code === 'INVALID_CREDENTIALS' && error.message === '用户名或密码错误');
  }
});

test('失败登录触发持久化限流，窗口到期后可重试', async t => {
  let clock = CURRENT;
  const { db, auth } = await setup(t, { now: () => clock, maxLoginAttempts: 2, loginWindowMs: 1000 });
  await assert.rejects(auth.login({ username: 'root.admin', password: NEW_PASSWORD, ip: 'test-ip' }), errorCode('INVALID_CREDENTIALS'));
  await assert.rejects(auth.login({ username: 'root.admin', password: NEW_PASSWORD, ip: 'test-ip' }), errorCode('INVALID_CREDENTIALS'));
  const secondInstance = createAuth(db, { now: () => clock, maxLoginAttempts: 2, loginWindowMs: 1000 });
  await assert.rejects(secondInstance.login({ username: 'root.admin', password: PASSWORD, ip: 'test-ip' }), errorCode('TOO_MANY_ATTEMPTS'));
  clock += 1001;
  assert.ok((await auth.login({ username: 'root.admin', password: PASSWORD, ip: 'test-ip' })).token);
});

test('同一账号失败八次会被锁定，但不阻断共享网关下其他账号正确登录', async t => {
  const { db, auth, admin } = await setup(t);
  const other = await member(auth, admin, 'other.member');
  const ip = 'shared-gateway';
  for (let attempt = 0; attempt < 8; attempt += 1) await assert.rejects(auth.login({ username: admin.username, password: NEW_PASSWORD, ip }), errorCode('INVALID_CREDENTIALS'));
  await assert.rejects(auth.login({ username: admin.username, password: PASSWORD, ip }), errorCode('TOO_MANY_ATTEMPTS'));
  const session = await auth.login({ username: other.username, password: PASSWORD, ip });
  assert.equal(session.user.id, other.id);
  const accountCounter = db.prepare('SELECT failures,locked_until FROM login_attempts WHERE key=?').get('user:' + hashToken(admin.username));
  const ipCounter = db.prepare('SELECT failures,locked_until FROM login_attempts WHERE key=?').get('ip:' + hashToken(ip));
  assert.equal(accountCounter.failures, 8);
  assert.ok(accountCounter.locked_until > CURRENT);
  assert.equal(ipCounter.failures, 8);
  assert.equal(ipCounter.locked_until, 0);
});

test('同一地址跨用户名累计失败达到地址阈值后被锁定，其他地址仍可登录', async t => {
  let clock = CURRENT;
  const { db, auth, admin } = await setup(t, { now: () => clock, maxIpLoginAttempts: 3, loginWindowMs: 1000 });
  for (let attempt = 0; attempt < 3; attempt += 1) await assert.rejects(auth.login({ username: 'random.user' + attempt, password: PASSWORD, ip: 'abusive-ip' }), errorCode('INVALID_CREDENTIALS'));
  const ipCounter = db.prepare('SELECT failures,locked_until FROM login_attempts WHERE key=?').get('ip:' + hashToken('abusive-ip'));
  assert.equal(ipCounter.failures, 3);
  assert.ok(ipCounter.locked_until > clock);
  const recreatedAuth = createAuth(db, { now: () => clock, maxIpLoginAttempts: 3, loginWindowMs: 1000 });
  await assert.rejects(recreatedAuth.login({ username: admin.username, password: PASSWORD, ip: 'abusive-ip' }), errorCode('TOO_MANY_ATTEMPTS'));
  assert.equal((await auth.login({ username: admin.username, password: PASSWORD, ip: 'different-ip' })).user.id, admin.id);
  clock += 1001;
  assert.equal((await auth.login({ username: admin.username, password: PASSWORD, ip: 'abusive-ip' })).user.id, admin.id);
});

test('地址默认阈值为八十次且禁止无效配置', async t => {
  const { db, auth, admin } = await setup(t);
  const key = 'ip:' + hashToken('default-threshold-ip');
  db.prepare('INSERT INTO login_attempts(key,failures,window_start,locked_until) VALUES(?,79,?,0)').run(key, CURRENT);
  await assert.rejects(auth.login({ username: 'random.missing', password: PASSWORD, ip: 'default-threshold-ip' }), errorCode('INVALID_CREDENTIALS'));
  assert.equal(db.prepare('SELECT failures FROM login_attempts WHERE key=?').get(key).failures, 80);
  await assert.rejects(auth.login({ username: admin.username, password: PASSWORD, ip: 'default-threshold-ip' }), errorCode('TOO_MANY_ATTEMPTS'));
  for (const maxIpLoginAttempts of [0, -1, 1.5, Infinity, '80']) assert.throws(() => createAuth(db, { maxIpLoginAttempts }), /地址登录尝试次数配置无效/);
});

test('激活令牌仅存哈希、只能消费一次，密码由用户设置', async t => {
  const { db, auth, admin } = await setup(t);
  const created = auth.createUser(admin, { username: 'member.one', name: '成员' });
  assert.equal(created.user.status, 'pending');
  assert.equal(created.user.needsActivation, true);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id=?').get(created.user.id).password_hash, null);
  const stored = db.prepare('SELECT * FROM account_tokens').get();
  assert.equal(stored.token_hash, hashToken(created.activationToken));
  assert.ok(!JSON.stringify(stored).includes(created.activationToken));
  const activated = await auth.activate({ token: created.activationToken, password: PASSWORD });
  assert.equal(activated.user.status, 'active');
  assert.equal(activated.user.needsActivation, false);
  assert.equal(activated.user.mustChangePassword, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(created.user.id).n, 0);
  await assert.rejects(auth.activate({ token: created.activationToken, password: PASSWORD }), errorCode('INVALID_TOKEN'));
  assert.ok((await auth.login({ username: 'member.one', password: PASSWORD })).token);
});

test('一次性令牌过期或重发后失效，停用账号无法凭旧链接激活', async t => {
  let clock = CURRENT;
  const { auth, admin } = await setup(t, { now: () => clock, tokenTtlMs: 1000 });
  const created = auth.createUser(admin, { username: 'member.one', name: '成员' });
  clock += 1000;
  await assert.rejects(auth.activate({ token: created.activationToken, password: PASSWORD }), errorCode('INVALID_TOKEN'));
  const replacement = auth.resetPassword(admin, created.user.id);
  await assert.rejects(auth.activate({ token: created.activationToken, password: PASSWORD }), errorCode('INVALID_TOKEN'));
  const disabled = auth.updateUser(admin, created.user.id, { status: 'disabled' });
  assert.equal(disabled.needsActivation, true);
  assert.throws(() => auth.updateUser(admin, created.user.id, { status: 'active' }), errorCode('ACTIVATION_REQUIRED'));
  await assert.rejects(auth.activate({ token: replacement.activationToken, password: PASSWORD }), errorCode('INVALID_TOKEN'));
  const pending = auth.updateUser(admin, created.user.id, { status: 'pending' });
  assert.equal(pending.status, 'pending');
  assert.ok(auth.resetPassword(admin, created.user.id).activationToken);
});

test('同一一次性令牌的并发消费只有一次成功', async t => {
  const { auth, admin } = await setup(t);
  const created = auth.createUser(admin, { username: 'member.one', name: '成员' });
  const results = await Promise.allSettled([
    auth.activate({ token: created.activationToken, password: PASSWORD }),
    auth.activate({ token: created.activationToken, password: NEW_PASSWORD })
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.code === 'INVALID_TOKEN').length, 1);
});

test('停用、改密、重置和角色变更撤销全部现有会话', async t => {
  const { auth, admin } = await setup(t);
  const user = await member(auth, admin);
  const first = await auth.login({ username: user.username, password: PASSWORD });
  const second = await auth.login({ username: user.username, password: PASSWORD });
  await auth.changePassword(user, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, first.token);
  assert.equal(auth.authenticate(first.token), null);
  assert.equal(auth.authenticate(second.token), null);
  const changed = await auth.login({ username: user.username, password: NEW_PASSWORD });
  const reset = auth.resetPassword(admin, user.id);
  assert.equal(auth.authenticate(changed.token), null);
  await assert.rejects(auth.login({ username: user.username, password: NEW_PASSWORD }), errorCode('INVALID_CREDENTIALS'));
  await auth.activate({ token: reset.activationToken, password: PASSWORD });
  const resetLogin = await auth.login({ username: user.username, password: PASSWORD });
  auth.updateUser(admin, user.id, { status: 'disabled' });
  assert.equal(auth.authenticate(resetLogin.token), null);
  auth.updateUser(admin, user.id, { status: 'active' });
  const enabled = await auth.login({ username: user.username, password: PASSWORD });
  auth.updateUser(admin, user.id, { role: 'admin' });
  assert.equal(auth.authenticate(enabled.token), null);
});

test('修改密码必须知道当前密码，会话必须属于当前账号', async t => {
  const { auth, admin } = await setup(t);
  const user = await member(auth, admin);
  const adminSession = await auth.login({ username: admin.username, password: PASSWORD });
  await assert.rejects(auth.changePassword(user, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, adminSession.token), errorCode('UNAUTHENTICATED'));
  await assert.rejects(auth.changePassword(user, { currentPassword: NEW_PASSWORD, newPassword: NEW_PASSWORD }), errorCode('INVALID_PASSWORD'));
  assert.ok(auth.authenticate(adminSession.token));
});

test('运维密码救援保留角色、强制下次改密并撤销全部会话与重置令牌', async t => {
  const { db, auth, admin } = await setup(t);
  const session = await auth.login({ username: admin.username, password: PASSWORD });
  const pendingReset = auth.resetPassword(admin, admin.id);
  const rescued = await resetUserFromCli(db, { username: admin.username, password: NEW_PASSWORD }, { now: () => CURRENT });
  assert.equal(rescued.id, admin.id);
  assert.equal(rescued.role, 'admin');
  assert.equal(rescued.mustChangePassword, true);
  assert.equal(auth.authenticate(session.token), null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM account_tokens').get().n, 0);
  await assert.rejects(auth.activate({ token: pendingReset.activationToken, password: PASSWORD }), errorCode('INVALID_TOKEN'));
  await assert.rejects(auth.login({ username: admin.username, password: PASSWORD }), errorCode('INVALID_CREDENTIALS'));
  const recoveredSession = await auth.login({ username: admin.username, password: NEW_PASSWORD });
  assert.equal(recoveredSession.user.mustChangePassword, true);
  assert.throws(() => auth.listUsers(recoveredSession.user), errorCode('PASSWORD_CHANGE_REQUIRED'));
  await auth.changePassword(recoveredSession.user, { currentPassword: NEW_PASSWORD, newPassword: PASSWORD }, recoveredSession.token);
  assert.equal(auth.authenticate(recoveredSession.token), null);
  assert.equal(auth.listUsers(admin)[0].mustChangePassword, false);
  assert.ok(db.prepare("SELECT 1 FROM audit WHERE action='account.cli_password_reset'").get());
  assert.equal('resetUserFromCli' in auth, false);
});

test('最后一个启用管理员在业务层及数据库层均不能被降权或停用', async t => {
  const { db, auth, admin } = await setup(t);
  assert.throws(() => auth.updateUser(admin, admin.id, { role: 'member' }), errorCode('LAST_ADMIN'));
  assert.throws(() => auth.updateUser(admin, admin.id, { status: 'disabled' }), errorCode('LAST_ADMIN'));
  assert.throws(() => db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(admin.id), /last_active_admin/);
  assert.throws(() => db.prepare('DELETE FROM users WHERE id=?').run(admin.id), /last_active_admin/);
  const second = await member(auth, admin, 'second.admin', 'admin');
  assert.equal(auth.updateUser(second, admin.id, { status: 'disabled' }).status, 'disabled');
  assert.throws(() => auth.updateUser(second, second.id, { role: 'member' }), errorCode('LAST_ADMIN'));
});

test('管理员权限重新从数据库读取，成员无法伪造角色管理账号', async t => {
  const { auth, admin } = await setup(t);
  const user = await member(auth, admin);
  const forged = { ...user, role: 'admin' };
  assert.throws(() => auth.listUsers(forged), errorCode('FORBIDDEN'));
  assert.throws(() => auth.createUser(forged, { username: 'evil.admin', name: '伪造管理员', role: 'admin' }), errorCode('FORBIDDEN'));
  assert.throws(() => auth.updateUser(forged, user.id, { role: 'admin' }), errorCode('FORBIDDEN'));
  assert.throws(() => auth.resetPassword(forged, admin.id), errorCode('FORBIDDEN'));
  assert.throws(() => auth.createUser(admin, { username: 'ROOT.ADMIN', name: '重名' }), errorCode('USERNAME_EXISTS'));
  assert.throws(() => auth.updateUser(admin, user.id, { password_hash: 'unsafe' }), errorCode('INVALID_INPUT'));
});

test('项目成员管理按项目隔离，负责人可管理本项目但不能越权其他项目，管理层只读', async t => {
  const { db, auth, admin } = await setup(t);
  const manager = await member(auth, admin, 'project.manager');
  const viewer = await member(auth, admin, 'project.viewer');
  for (const id of ['p-one', 'p-two']) db.prepare('INSERT INTO projects(id,data) VALUES(?,?)').run(id, JSON.stringify({ id, name: '测试项目', ownerId: id === 'p-one' ? manager.id : admin.id }));
  auth.setMembership(admin, 'p-one', manager.id, 'product');
  assert.throws(() => auth.setMembership(admin, 'p-one', manager.id, 'manager'), errorCode('INVALID_ROLE'));
  auth.setMembership(manager, 'p-one', viewer.id, 'lead');
  assert.throws(() => auth.setMembership(viewer, 'p-one', viewer.id, 'product'), errorCode('FORBIDDEN'));
  auth.setMembership(manager, 'p-one', viewer.id, 'viewer');
  assert.equal(auth.listMemberships(viewer, 'p-one').length, 2);
  assert.throws(() => auth.setMembership(viewer, 'p-one', viewer.id, 'product'), errorCode('FORBIDDEN'));
  const boss = auth.createUser(admin, { username: 'project.boss', name: '管理层', executive: true }).user;
  assert.equal(boss.executive, true);
  db.prepare("UPDATE users SET status='active',must_change_password=0,password_hash='activated-in-test' WHERE id=?").run(boss.id);
  assert.equal(auth.listMemberships({ id: boss.id }, 'p-two').length, 0);
  assert.throws(() => auth.setMembership({ id: boss.id }, 'p-two', viewer.id, 'viewer'), errorCode('FORBIDDEN'));
  assert.equal(auth.updateUser(admin, boss.id, { executive: false }).executive, false);
  assert.throws(() => auth.updateUser(admin, boss.id, { executive: 'yes' }), errorCode('INVALID_INPUT'));
  assert.throws(() => auth.setMembership(manager, 'p-two', viewer.id, 'developer'), errorCode('FORBIDDEN'));
  assert.throws(() => auth.listMemberships(viewer, 'p-two'), errorCode('FORBIDDEN'));
  assert.equal(auth.setMembership(manager, 'p-one', viewer.id, 'tester').role, 'tester');
  auth.removeMembership(manager, 'p-one', viewer.id);
  assert.throws(() => auth.listMemberships(viewer, 'p-one'), errorCode('FORBIDDEN'));
});

test('审计覆盖账号和会话操作但不记录密码、密码哈希或明文令牌', async t => {
  const { db, auth, admin } = await setup(t);
  const created = auth.createUser(admin, { username: 'member.one', name: '成员' });
  await auth.activate({ token: created.activationToken, password: PASSWORD });
  const session = await auth.login({ username: 'member.one', password: PASSWORD });
  auth.logout(session.token);
  const rows = db.prepare('SELECT * FROM audit ORDER BY id').all();
  const serialized = JSON.stringify(rows);
  for (const secret of [PASSWORD, created.activationToken, session.token, db.prepare('SELECT password_hash FROM users WHERE username=?').get('member.one').password_hash]) assert.ok(!serialized.includes(secret));
  for (const action of ['account.bootstrap_admin', 'account.create', 'account.activate', 'auth.login', 'auth.logout']) assert.ok(rows.some(row => row.action === action));
  for (const user of auth.listUsers(admin)) assert.equal('password_hash' in user, false);
});

test('命令行从标准输入建立管理员，不接受密码参数也不回显密码', t => {
  const folder = mkdtempSync(join(tmpdir(), 'xinghe-auth-cli-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/accounts.mjs', import.meta.url));
  const path = join(folder, 'cli.sqlite');
  const result = spawnSync(process.execPath, [script, 'create-admin', '--db', path, '--username', 'cli.admin', '--name', '命令行管理员'], { input: PASSWORD + '\n', encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('管理员已创建'));
  assert.ok(!result.stdout.includes(PASSWORD) && !result.stderr.includes(PASSWORD));
  const invalid = spawnSync(process.execPath, [script, 'create-admin', '--password', PASSWORD], { input: PASSWORD, encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.ok(!invalid.stdout.includes(PASSWORD) && !invalid.stderr.includes(PASSWORD));
  const db = openDatabase(path);
  try { assert.equal(db.prepare('SELECT username FROM users').get().username, 'cli.admin'); }
  finally { db.close(); }
  const reset = spawnSync(process.execPath, [script, 'reset-user', '--db', path, '--username', 'cli.admin'], { input: NEW_PASSWORD + '\n', encoding: 'utf8' });
  assert.equal(reset.status, 0, reset.stderr);
  assert.ok(!reset.stdout.includes(NEW_PASSWORD) && !reset.stderr.includes(NEW_PASSWORD));
  const reopened = openDatabase(path);
  try {
    const row = reopened.prepare('SELECT role,must_change_password FROM users WHERE username=?').get('cli.admin');
    assert.equal(row.role, 'admin');
    assert.equal(row.must_change_password, 1);
  } finally { reopened.close(); }
});
