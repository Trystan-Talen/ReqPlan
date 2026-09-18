import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { transaction, writeAudit } from './database.mjs';
import { PROJECT_ROLES } from '../frontend/workflow.js';

const derive = promisify(scrypt);
const SCRYPT = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 128 * 1024 * 1024 });
export { PROJECT_ROLES };
export const GLOBAL_ROLES = Object.freeze(['admin', 'member']);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^scrypt\$32768\$8\$3\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

export class AuthError extends Error {
  constructor(status, code, message) { super(message); this.name = 'AuthError'; this.status = status; this.code = code; }
}
function reject(status, code, message) { throw new AuthError(status, code, message); }
function plain(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(400, 'INVALID_INPUT', '输入格式不正确');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!allowed.includes(key) || !descriptor || !Object.hasOwn(descriptor, 'value')) reject(400, 'INVALID_INPUT', '输入包含未知字段');
  }
}
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) reject(400, 'INVALID_INPUT', label + '格式不正确');
  return value.trim();
}
function username(value) {
  const name = text(value, 80, '用户名').toLowerCase();
  if (!/^[a-z0-9][a-z0-9._@-]{2,79}$/.test(name)) reject(400, 'INVALID_USERNAME', '用户名需为 3–80 位字母、数字或 . _ @ -');
  return name;
}
export function validatePassword(password) {
  if (typeof password !== 'string' || Array.from(password).length < 6 || Buffer.byteLength(password, 'utf8') > 1024 || !password.trim()) reject(400, 'WEAK_PASSWORD', '密码至少 6 个字符，且不能超过 1024 字节或全部为空白');
  return password;
}
export async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}
export async function verifyPassword(password, encoded) {
  const bounded = typeof password === 'string' && Buffer.byteLength(password, 'utf8') <= 1024;
  const match = typeof encoded === 'string' && HASH_PATTERN.exec(encoded);
  const salt = match ? Buffer.from(match[1], 'base64url') : Buffer.alloc(16, 0x5a);
  const expected = match ? Buffer.from(match[2], 'base64url') : Buffer.alloc(64);
  const actual = await derive(bounded ? password : '', salt, 64, SCRYPT);
  return Boolean(bounded && match && timingSafeEqual(actual, expected));
}
export function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function safeUser(row) {
  return { id: row.id, username: row.username, name: row.name, role: row.role, executive: Boolean(row.executive), status: row.status, needsActivation: !row.password_hash, mustChangePassword: Boolean(row.must_change_password), createdAt: row.created_at, updatedAt: row.updated_at };
}

// Shared by authenticated account management and the operator-only recovery
// export. Call only inside a transaction after checking the caller's authority.
function mintAccountToken(db, { actorId, userId, kind, now, tokenTtlMs, auditAction }) {
  const instant = now();
  const at = new Date(instant).toISOString();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(instant + tokenTtlMs).toISOString();
  // Clear the old password before inserting the replacement reset token: the
  // credential-change trigger intentionally deletes existing account tokens.
  if (kind === 'reset') db.prepare('UPDATE users SET password_hash=NULL,updated_at=? WHERE id=?').run(at, userId);
  db.prepare('DELETE FROM account_tokens WHERE user_id=?').run(userId);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId);
  db.prepare('INSERT INTO account_tokens(token_hash,user_id,kind,expires_at,created_at,created_by) VALUES(?,?,?,?,?,?)').run(hashToken(token), userId, kind, expiresAt, at, actorId || null);
  writeAudit(db, actorId || null, auditAction || 'account.issue_' + kind, 'user', userId, { expiresAt });
  return { token, expiresAt };
}

// Trusted local/server-terminal entry point. Never expose this through HTTP:
// possession of the resulting token authorizes replacing an administrator's
// password. Only the token's hash is persisted; callers handle the raw token
// in memory and open the existing activation/reset page via a URL fragment.
export function issueAdminRecoveryFromCli(db, input = {}) {
  plain(input, ['username', 'now', 'tokenTtlMs']);
  const selectedUsername = input.username === undefined ? null : username(input.username);
  const clock = input.now === undefined ? (() => Date.now()) : input.now;
  const tokenTtlMs = input.tokenTtlMs === undefined ? 30 * 60 * 1000 : input.tokenTtlMs;
  if (typeof clock !== 'function') reject(400, 'INVALID_INPUT', '恢复时钟配置无效');
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs < 1 || tokenTtlMs > 30 * 60 * 1000) reject(400, 'INVALID_INPUT', '管理员恢复链接有效期应为 1 毫秒至 30 分钟');
  const instant = clock();
  if (!Number.isSafeInteger(instant) || !Number.isFinite(new Date(instant + tokenTtlMs).getTime())) reject(400, 'INVALID_INPUT', '恢复时钟配置无效');
  return transaction(db, () => {
    let user;
    if (selectedUsername !== null) {
      user = db.prepare('SELECT id,username,role,status FROM users WHERE username=? COLLATE NOCASE').get(selectedUsername);
      if (!user) reject(404, 'NOT_FOUND', '指定账号不存在');
      if (user.role !== 'admin' || user.status !== 'active') reject(403, 'ADMIN_RECOVERY_NOT_ALLOWED', '只能恢复已启用的系统管理员账号');
    } else {
      const admins = db.prepare("SELECT id,username,role,status FROM users WHERE role='admin' AND status='active' ORDER BY id").all();
      if (!admins.length) reject(404, 'ADMIN_NOT_FOUND', '没有可恢复的已启用系统管理员');
      if (admins.length !== 1) reject(409, 'ADMIN_USERNAME_REQUIRED', '存在多名已启用管理员，请明确指定要恢复的用户名');
      [user] = admins;
    }
    const result = mintAccountToken(db, { actorId: null, userId: user.id, kind: 'reset', now: () => instant, tokenTtlMs, auditAction: 'account.cli_issue_admin_recovery' });
    return { username: user.username, ...result };
  });
}

// Operator-only recovery, deliberately excluded from createAuth's HTTP-facing
// service object. The CLI requires a new password through hidden standard input.
export async function resetUserFromCli(db, input, options = {}) {
  plain(input, ['username', 'password']);
  const name = username(input.username);
  if (!db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(name)) reject(404, 'NOT_FOUND', '账号不存在');
  const passwordHash = await hashPassword(input.password);
  const at = new Date(options.now ? options.now() : Date.now()).toISOString();
  return transaction(db, () => {
    const user = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(name);
    if (!user) reject(404, 'NOT_FOUND', '账号不存在');
    const status = user.status === 'pending' ? 'active' : user.status;
    db.prepare('UPDATE users SET password_hash=?,status=?,must_change_password=1,updated_at=? WHERE id=?').run(passwordHash, status, at, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM account_tokens WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM login_attempts WHERE key=?').run('user:' + hashToken(user.username));
    writeAudit(db, null, 'account.cli_password_reset', 'user', user.id, { username: user.username, role: user.role, status, mustChangePassword: true });
    return safeUser(db.prepare('SELECT * FROM users WHERE id=?').get(user.id));
  });
}

export function createAuth(db, options = {}) {
  const now = options.now || (() => Date.now());
  const secureCookies = options.secureCookies !== false;
  const cookieName = options.cookieName || 'xinghe_session';
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) throw new Error('会话名称格式不正确');
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  const tokenTtlMs = options.tokenTtlMs ?? 24 * 60 * 60 * 1000;
  const maxLoginAttempts = options.maxLoginAttempts ?? 8;
  const maxIpLoginAttempts = options.maxIpLoginAttempts ?? 80;
  const loginWindowMs = options.loginWindowMs ?? 15 * 60 * 1000;
  for (const duration of [sessionTtlMs, tokenTtlMs, loginWindowMs]) if (!Number.isSafeInteger(duration) || duration < 1 || duration > 30 * 86400000) throw new Error('认证期限配置无效');
  if (!Number.isSafeInteger(maxLoginAttempts) || maxLoginAttempts < 1 || maxLoginAttempts > 100) throw new Error('登录尝试次数配置无效');
  if (!Number.isSafeInteger(maxIpLoginAttempts) || maxIpLoginAttempts < 1 || maxIpLoginAttempts > 10000) throw new Error('地址登录尝试次数配置无效');
  const stamp = () => new Date(now()).toISOString();
  const getRow = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
  function activeActor(actor) {
    const id = typeof actor === 'string' ? actor : actor?.id;
    const row = typeof id === 'string' ? getRow(id) : null;
    if (!row || row.status !== 'active') reject(401, 'UNAUTHENTICATED', '请先登录');
    return row;
  }
  function administrator(actor) {
    const user = activeActor(actor);
    if (user.role !== 'admin') reject(403, 'FORBIDDEN', '需要系统管理员权限');
    if (user.must_change_password) reject(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改密码');
    return user;
  }
  function projectAccess(actor, projectId, manage = false) {
    const user = activeActor(actor);
    if (user.must_change_password) reject(403, 'PASSWORD_CHANGE_REQUIRED', '请先修改密码');
    const project = db.prepare('SELECT id,data,archived FROM projects WHERE id=?').get(projectId);
    if (!project) reject(404, 'NOT_FOUND', '项目不存在');
    const membership = db.prepare('SELECT role FROM memberships WHERE project_id=? AND user_id=?').get(projectId, user.id);
    let ownerId = ''; try { ownerId = JSON.parse(project.data).ownerId || ''; } catch { /* Malformed projects have no owner. */ }
    if (user.role !== 'admin' && ((!membership && !user.executive) || (manage && ownerId !== user.id))) reject(403, 'FORBIDDEN', '无权管理此项目成员');
    if (manage && project.archived) reject(409, 'PROJECT_ARCHIVED', '请先恢复项目再管理成员');
    return user;
  }
  function clearCookie() { return `${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`; }
  function sessionCookie(token, expiresAt) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(0, Math.floor((Date.parse(expiresAt) - now()) / 1000))}${secureCookies ? '; Secure' : ''}`;
  }
  function tokenFromCookie(header) {
    if (typeof header !== 'string' || header.length > 8192) return '';
    const matches = header.split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName + '='));
    if (matches.length !== 1) return '';
    const token = matches[0].slice(cookieName.length + 1);
    return TOKEN_PATTERN.test(token) ? token : '';
  }
  function csrfFor(token) { return hashToken('xinghe-csrf-v1:' + token); }
  function verifyCsrf(token, value) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token) || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) return false;
    return timingSafeEqual(Buffer.from(csrfFor(token), 'hex'), Buffer.from(value, 'hex'));
  }
  function authenticate(token) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
    const hash = hashToken(token);
    const session = db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hash);
    if (!session) return null;
    const user = getRow(session.user_id);
    if (!user || user.status !== 'active' || session.auth_version !== user.auth_version || session.expires_at <= stamp()) {
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash);
      return null;
    }
    return { user: safeUser(user), csrfToken: csrfFor(token), expiresAt: session.expires_at };
  }
  function attemptKeys(name, ip) { return ['user:' + hashToken(name), 'ip:' + hashToken(String(ip || 'unknown').slice(0, 100))]; }
  function checkAttempts(keys) {
    for (const key of keys) {
      const entry = db.prepare('SELECT locked_until FROM login_attempts WHERE key=?').get(key);
      if (entry && entry.locked_until > now()) reject(429, 'TOO_MANY_ATTEMPTS', '登录尝试过于频繁，请稍后重试');
    }
  }
  function failedAttempt(keys) {
    transaction(db, () => {
      for (const key of keys) {
        const old = db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key);
        const reset = !old || old.window_start + loginWindowMs <= now();
        const failures = reset ? 1 : old.failures + 1;
        const threshold = key.startsWith('ip:') ? maxIpLoginAttempts : maxLoginAttempts;
        db.prepare('INSERT INTO login_attempts(key,failures,window_start,locked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET failures=excluded.failures,window_start=excluded.window_start,locked_until=excluded.locked_until')
          .run(key, failures, reset ? now() : old.window_start, failures >= threshold ? now() + loginWindowMs : 0);
      }
    });
  }
  async function login(input) {
    plain(input, ['username', 'password', 'ip']);
    let name;
    try { name = username(input.username); } catch { name = String(input.username || '').slice(0, 80).toLowerCase(); }
    const keys = attemptKeys(name, input.ip);
    checkAttempts(keys);
    const original = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(name);
    const valid = await verifyPassword(input.password, original?.password_hash);
    return transaction(db, () => {
      const user = original && getRow(original.id);
      if (!valid || !user || user.status !== 'active' || user.password_hash !== original.password_hash || user.auth_version !== original.auth_version) {
        failedAttempt(keys);
        writeAudit(db, null, 'auth.login_failed', 'authentication', null, {});
        return { failed: true };
      }
      checkAttempts(keys);
      db.prepare('DELETE FROM login_attempts WHERE key=?').run(keys[0]);
      db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(stamp());
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(now() + sessionTtlMs).toISOString();
      db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at,auth_version) VALUES(?,?,?,?,?)').run(hashToken(token), user.id, expiresAt, stamp(), user.auth_version);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash NOT IN (SELECT token_hash FROM sessions WHERE user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 20)').run(user.id, user.id);
      writeAudit(db, user.id, 'auth.login', 'user', user.id);
      return { user: safeUser(user), token, csrfToken: csrfFor(token), expiresAt, cookie: sessionCookie(token, expiresAt) };
    });
  }
  // Keep failed-login accounting committed before returning the generic error.
  const loginOperation = login;
  async function loginPublic(input) {
    const result = await loginOperation(input);
    if (!result || result.failed) reject(401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    return result;
  }
  function logout(token) {
    if (typeof token === 'string' && TOKEN_PATTERN.test(token)) transaction(db, () => {
      const row = db.prepare('SELECT user_id FROM sessions WHERE token_hash=?').get(hashToken(token));
      db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));
      if (row) writeAudit(db, row.user_id, 'auth.logout', 'user', row.user_id);
    });
    return { cookie: clearCookie() };
  }
  async function bootstrapAdmin(input) {
    plain(input, ['username', 'name', 'password']);
    const name = username(input.username);
    const displayName = text(input.name, 80, '姓名');
    if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) reject(409, 'ADMIN_EXISTS', '管理员已存在，请使用账号重置流程');
    const passwordHash = await hashPassword(input.password);
    return transaction(db, () => {
      if (db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()) reject(409, 'ADMIN_EXISTS', '管理员已存在');
      const existing = db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(name);
      if (existing && (existing.status !== 'pending' || existing.password_hash)) reject(409, 'USERNAME_EXISTS', '用户名已存在且不属于待激活导入账号');
      const id = existing ? existing.id : 'u-' + randomUUID();
      if (existing) db.prepare("UPDATE users SET name=?,role='admin',status='active',password_hash=?,must_change_password=0,updated_at=? WHERE id=?").run(displayName, passwordHash, stamp(), id);
      else db.prepare("INSERT INTO users(id,username,name,role,status,password_hash,must_change_password,created_at,updated_at) VALUES(?,?,?,'admin','active',?,0,?,?)").run(id, name, displayName, passwordHash, stamp(), stamp());
      writeAudit(db, id, 'account.bootstrap_admin', 'user', id, { username: name, reusedImportedAccount: Boolean(existing) });
      return safeUser(getRow(id));
    });
  }
  function listUsers(actor) { administrator(actor); return db.prepare('SELECT * FROM users ORDER BY created_at,id').all().map(safeUser); }
  function mintToken(actorId, userId, kind) {
    return mintAccountToken(db, { actorId, userId, kind, now, tokenTtlMs });
  }
  function createUser(actor, input) {
    plain(input, ['username', 'name', 'role', 'executive']);
    const admin = administrator(actor);
    const name = username(input.username);
    const displayName = text(input.name, 80, '姓名');
    const role = input.role === undefined ? 'member' : input.role;
    if (!GLOBAL_ROLES.includes(role)) reject(400, 'INVALID_ROLE', '账号角色无效');
    if (input.executive !== undefined && typeof input.executive !== 'boolean') reject(400, 'INVALID_INPUT', '管理层标记必须是布尔值');
    const executive = input.executive === true;
    return transaction(db, () => {
      if (db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE').get(name)) reject(409, 'USERNAME_EXISTS', '用户名已存在');
      const id = 'u-' + randomUUID();
      db.prepare("INSERT INTO users(id,username,name,role,executive,status,must_change_password,created_at,updated_at) VALUES(?,?,?,?,?,'pending',1,?,?)").run(id, name, displayName, role, executive ? 1 : 0, stamp(), stamp());
      const activation = mintToken(admin.id, id, 'activation');
      writeAudit(db, admin.id, 'account.create', 'user', id, { username: name, role, executive });
      return { user: safeUser(getRow(id)), activationToken: activation.token, activation };
    });
  }
  function issueToken(actor, userId, kind = 'reset') {
    const admin = administrator(actor);
    const user = getRow(userId);
    if (!user) reject(404, 'NOT_FOUND', '账号不存在');
    if (!['activation', 'reset'].includes(kind) || (kind === 'activation' && user.status !== 'pending') || (kind === 'reset' && user.status !== 'active')) reject(409, 'INVALID_ACCOUNT_STATE', '该账号状态不支持此操作');
    return transaction(db, () => ({ user: safeUser(user), ...mintToken(admin.id, user.id, kind) }));
  }
  function resetPassword(actor, userId) {
    const user = getRow(userId);
    const result = issueToken(actor, userId, user?.status === 'pending' ? 'activation' : 'reset');
    return { ...result, activationToken: result.token };
  }
  function validAccountToken(token, kind) {
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) reject(400, 'INVALID_TOKEN', '激活或重置链接无效、已使用或已过期');
    const row = db.prepare('SELECT * FROM account_tokens WHERE token_hash=?').get(hashToken(token));
    const user = row && getRow(row.user_id);
    if (!row || !user || row.expires_at <= stamp() || (kind && row.kind !== kind) || (row.kind === 'activation' ? user.status !== 'pending' : user.status !== 'active')) reject(400, 'INVALID_TOKEN', '激活或重置链接无效、已使用或已过期');
    return { row, user };
  }
  async function redeemToken(input) {
    plain(input, ['token', 'password', 'kind']);
    validAccountToken(input.token, input.kind);
    const passwordHash = await hashPassword(input.password);
    return transaction(db, () => {
      const { row, user } = validAccountToken(input.token, input.kind);
      db.prepare("UPDATE users SET password_hash=?,status='active',must_change_password=0,updated_at=? WHERE id=?").run(passwordHash, stamp(), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM account_tokens WHERE user_id=?').run(user.id);
      db.prepare('DELETE FROM login_attempts WHERE key=?').run('user:' + hashToken(user.username));
      writeAudit(db, user.id, 'account.' + (row.kind === 'activation' ? 'activate' : 'password_reset'), 'user', user.id);
      return { user: safeUser(getRow(user.id)) };
    });
  }
  async function changePassword(actor, input, sessionToken) {
    plain(input, ['currentPassword', 'newPassword']);
    const original = activeActor(actor);
    if (sessionToken !== undefined && authenticate(sessionToken)?.user.id !== original.id) reject(401, 'UNAUTHENTICATED', '会话已失效，请重新登录');
    if (!(await verifyPassword(input.currentPassword, original.password_hash))) reject(400, 'INVALID_PASSWORD', '当前密码不正确');
    const passwordHash = await hashPassword(input.newPassword);
    return transaction(db, () => {
      const current = activeActor(actor);
      if (current.password_hash !== original.password_hash || current.auth_version !== original.auth_version) reject(409, 'CREDENTIALS_CHANGED', '账号凭据已更改，请重新登录');
      db.prepare('UPDATE users SET password_hash=?,must_change_password=0,updated_at=? WHERE id=?').run(passwordHash, stamp(), current.id);
      writeAudit(db, current.id, 'account.password_change', 'user', current.id);
      return { user: safeUser(getRow(current.id)) };
    });
  }
  function updateUser(actor, userId, input) {
    plain(input, ['name', 'role', 'status', 'executive']);
    const admin = administrator(actor);
    return transaction(db, () => {
      const user = getRow(userId);
      if (!user) reject(404, 'NOT_FOUND', '账号不存在');
      const name = input.name === undefined ? user.name : text(input.name, 80, '姓名');
      const role = input.role === undefined ? user.role : input.role;
      const status = input.status === undefined ? user.status : input.status;
      if (input.executive !== undefined && typeof input.executive !== 'boolean') reject(400, 'INVALID_INPUT', '管理层标记必须是布尔值');
      const executive = input.executive === undefined ? Boolean(user.executive) : input.executive;
      if (!GLOBAL_ROLES.includes(role) || !['active', 'pending', 'disabled'].includes(status)) reject(400, 'INVALID_INPUT', '账号角色或状态无效');
      if (status === 'active' && !user.password_hash) reject(409, 'ACTIVATION_REQUIRED', '请先通过一次性链接激活账号');
      if (status === 'pending' && user.status !== 'pending' && user.password_hash) reject(409, 'INVALID_ACCOUNT_STATE', '已激活账号不能退回待激活状态');
      if (user.role === 'admin' && user.status === 'active' && (role !== 'admin' || status !== 'active') && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get().n <= 1) reject(409, 'LAST_ADMIN', '至少保留一名启用的系统管理员');
      db.prepare('UPDATE users SET name=?,role=?,executive=?,status=?,updated_at=? WHERE id=?').run(name, role, executive ? 1 : 0, status, stamp(), userId);
      writeAudit(db, admin.id, 'account.update', 'user', userId, { before: { name: user.name, role: user.role, executive: Boolean(user.executive), status: user.status }, after: { name, role, executive, status } });
      return safeUser(getRow(userId));
    });
  }
  function listMemberships(actor, projectId) {
    projectAccess(actor, projectId);
    return db.prepare('SELECT m.project_id,m.role AS project_role,u.* FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.name,u.id').all(projectId)
      .map(row => ({ projectId: row.project_id, userId: row.id, role: row.project_role, user: safeUser(row) }));
  }
  function setMembership(actor, projectId, userId, role) {
    const manager = projectAccess(actor, projectId, true);
    if (!PROJECT_ROLES.includes(role)) reject(400, 'INVALID_ROLE', '项目角色无效');
    const user = getRow(userId);
    if (!user || user.status === 'disabled') reject(409, 'INVALID_ACCOUNT_STATE', '请选择待激活或已启用账号');
    return transaction(db, () => {
      db.prepare('INSERT INTO memberships(project_id,user_id,role) VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(projectId, userId, role);
      writeAudit(db, manager.id, 'membership.set', 'project', projectId, { userId, role });
      return { projectId, userId, role, user: safeUser(user) };
    });
  }
  function removeMembership(actor, projectId, userId) {
    const manager = projectAccess(actor, projectId, true);
    return transaction(db, () => {
      const result = db.prepare('DELETE FROM memberships WHERE project_id=? AND user_id=?').run(projectId, userId);
      if (!result.changes) reject(404, 'NOT_FOUND', '项目成员不存在');
      writeAudit(db, manager.id, 'membership.remove', 'project', projectId, { userId });
      return { removed: true };
    });
  }
  return Object.freeze({ login: loginPublic, authenticate, logout, tokenFromCookie, verifyCsrf, clearCookie, sessionCookie, bootstrapAdmin, listUsers, createUser, issueToken, resetPassword, redeemToken, activate: redeemToken, changePassword, updateUser, listMemberships, setMembership, removeMembership });
}
