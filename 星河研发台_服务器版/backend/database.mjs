import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PROJECT_ROLES } from '../frontend/workflow.js';

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";
export const SCHEMA_VERSION = 4;
export const ROLE_MIGRATION_KEY = 'role_migration_v3';
const MEMBERSHIPS_TABLE = name => `CREATE TABLE ${name} (
        project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK(role IN (${PROJECT_ROLES.map(role => `'${role}'`).join(',')})),
        PRIMARY KEY(project_id,user_id)
      ) STRICT`;

// Version 3 replaces the single "project manager" role with product manager and
// lead developer. Nobody is guessed: every former manager membership must have an
// explicit target in the saved plan, otherwise the upgrade stops and changes nothing.
export function planRoleMigration(db, plan = {}) {
  const errors = [], mapping = new Map();
  const entries = Array.isArray(plan.memberships) ? plan.memberships : [];
  const hasTable = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  const rows = hasTable('memberships') ? db.prepare(`SELECT m.project_id,m.user_id,m.role,u.name AS user_name,p.data AS project_data FROM memberships m
    LEFT JOIN users u ON u.id=m.user_id LEFT JOIN projects p ON p.id=m.project_id ORDER BY m.project_id,m.user_id`).all() : [];
  const projectName = row => { try { return JSON.parse(row.project_data).name || row.project_id; } catch { return row.project_id; } };
  const existing = new Set(rows.map(row => `${row.project_id}\u0000${row.user_id}`));
  for (const entry of entries) {
    const key = `${entry?.projectId}\u0000${entry?.userId}`;
    if (!PROJECT_ROLES.includes(entry?.role)) errors.push(`${entry?.projectId} / ${entry?.userId}：目标角色 ${entry?.role} 无效`);
    else if (!existing.has(key)) errors.push(`${entry?.projectId} / ${entry?.userId}：该项目成员不存在`);
    else mapping.set(key, entry.role);
  }
  const changes = [], unmapped = [];
  for (const row of rows) {
    const target = mapping.get(`${row.project_id}\u0000${row.user_id}`) ?? (PROJECT_ROLES.includes(row.role) ? row.role : null);
    const item = { projectId: row.project_id, projectName: projectName(row), userId: row.user_id, userName: row.user_name || row.user_id, from: row.role, to: target };
    if (target === null) unmapped.push(item); else if (target !== row.role) changes.push(item);
  }
  const executives = [];
  for (const userId of Array.isArray(plan.executives) ? plan.executives : []) {
    const user = hasTable('users') && db.prepare('SELECT id,name FROM users WHERE id=?').get(userId);
    if (user) executives.push({ userId: user.id, userName: user.name }); else errors.push(`管理层账号 ${userId} 不存在`);
  }
  return { changes, unmapped, errors, executives, unchanged: rows.length - changes.length - unmapped.length };
}

function migrateToVersion3(db) {
  let plan = {};
  const saved = db.prepare('SELECT value FROM app_meta WHERE key=?').get(ROLE_MIGRATION_KEY);
  if (saved) { try { plan = JSON.parse(saved.value); } catch { throw new Error('角色迁移计划格式无效，请重新运行 npm run migrate:roles 预检'); } }
  const result = planRoleMigration(db, plan);
  if (result.errors.length || result.unmapped.length) {
    const names = result.unmapped.map(item => `${item.projectName} · ${item.userName}（${item.from === 'manager' ? '项目经理' : item.from}）`);
    throw new Error(`数据库升级需要先确认角色迁移，未做任何修改。${[...result.errors, ...names].join('；')}。请运行 npm run migrate:roles 预检。`);
  }
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map(row => row.name));
  if (!userColumns.has('executive')) db.exec('ALTER TABLE users ADD COLUMN executive INTEGER NOT NULL DEFAULT 0 CHECK(executive IN (0,1))');
  const current = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memberships'").get();
  if (current && current.sql.includes("'manager'")) {
    const targets = new Map(result.changes.map(item => [`${item.projectId}\u0000${item.userId}`, item.to]));
    db.exec(MEMBERSHIPS_TABLE('memberships_v3'));
    const insert = db.prepare('INSERT INTO memberships_v3(project_id,user_id,role) VALUES(?,?,?)');
    for (const row of db.prepare('SELECT project_id,user_id,role FROM memberships').all()) insert.run(row.project_id, row.user_id, targets.get(`${row.project_id}\u0000${row.user_id}`) ?? row.role);
    db.exec('DROP TABLE memberships; ALTER TABLE memberships_v3 RENAME TO memberships; CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);');
  }
  const setExecutive = db.prepare('UPDATE users SET executive=1 WHERE id=?');
  for (const item of result.executives) setExecutive.run(item.userId);
  if (result.changes.length || result.executives.length) writeAudit(db, null, 'schema.role_migration', 'workspace', null, { changes: result.changes, executives: result.executives });
}

export function openDatabase(path) {
  if (typeof path !== 'string' || !path) throw new Error('请指定数据库路径');
  if (path !== ':memory:') {
    path = resolve(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, 'a', 0o600));
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path, { timeout: 5000 });
  try {
    const schemaVersion = db.prepare('PRAGMA user_version').get().user_version;
    if (schemaVersion > SCHEMA_VERSION) throw new Error('数据库来自更新的软件版本，请先升级服务端，不能降级打开。');
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;`);
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
        executive INTEGER NOT NULL DEFAULT 0 CHECK(executive IN (0,1)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('active','pending','disabled')),
        password_hash TEXT, must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
        auth_version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT ${NOW}, auth_version INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS account_tokens (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('activation','reset')), expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT ${NOW}, created_by TEXT REFERENCES users(id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS account_tokens_user ON account_tokens(user_id);
      CREATE TABLE IF NOT EXISTS login_attempts (
        key TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0,
        window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE TABLE IF NOT EXISTS requirements (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), data TEXT NOT NULL CHECK(json_valid(data)),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}, UNIQUE(id,project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS requirements_project ON requirements(project_id,archived);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), requirement_id TEXT,
        data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
        archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
        created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW},
        FOREIGN KEY(requirement_id,project_id) REFERENCES requirements(id,project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_project ON tasks(project_id,archived);
      CREATE INDEX IF NOT EXISTS tasks_requirement ON tasks(requirement_id);
      ${MEMBERSHIPS_TABLE('IF NOT EXISTS memberships')};
      CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id);
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY, requirement_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
        name TEXT NOT NULL, mime TEXT NOT NULL, content BLOB NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0), created_at TEXT NOT NULL DEFAULT ${NOW},
        created_by TEXT REFERENCES users(id),
        FOREIGN KEY(requirement_id,project_id) REFERENCES requirements(id,project_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachments_requirement ON attachments(requirement_id);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT REFERENCES users(id), action TEXT NOT NULL,
        entity_type TEXT NOT NULL, entity_id TEXT, detail TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(detail)),
        created_at TEXT NOT NULL DEFAULT ${NOW}
      ) STRICT;
      CREATE INDEX IF NOT EXISTS audit_entity ON audit(entity_type,entity_id,id);
      CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS users_last_admin_update BEFORE UPDATE OF status,role ON users
      WHEN OLD.role='admin' AND OLD.status='active' AND (NEW.role<>'admin' OR NEW.status<>'active')
        AND (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active') <= 1
      BEGIN SELECT RAISE(ABORT,'last_active_admin'); END;
      CREATE TRIGGER IF NOT EXISTS users_last_admin_delete BEFORE DELETE ON users
      WHEN OLD.role='admin' AND OLD.status='active'
        AND (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active') <= 1
      BEGIN SELECT RAISE(ABORT,'last_active_admin'); END;
      CREATE TRIGGER IF NOT EXISTS users_revoke_credentials AFTER UPDATE OF password_hash,status,role ON users
      WHEN OLD.password_hash IS NOT NEW.password_hash OR OLD.status<>NEW.status OR OLD.role<>NEW.role
      BEGIN
        DELETE FROM sessions WHERE user_id=NEW.id;
        DELETE FROM account_tokens WHERE user_id=NEW.id;
        UPDATE users SET auth_version=auth_version+1 WHERE id=NEW.id;
      END;
    `);
    if (schemaVersion < 2) {
      const columns = new Set(db.prepare('PRAGMA table_info(attachments)').all().map(row => row.name));
      if (!columns.has('logical_id')) db.exec('ALTER TABLE attachments ADD COLUMN logical_id TEXT');
      if (!columns.has('source')) db.exec(`ALTER TABLE attachments ADD COLUMN source TEXT NOT NULL DEFAULT '{"kind":"legacy"}' CHECK(json_valid(source))`);
      if (!columns.has('historical')) db.exec('ALTER TABLE attachments ADD COLUMN historical INTEGER NOT NULL DEFAULT 0 CHECK(historical IN (0,1))');
      // Every old address continues to resolve to exactly its original bytes.
      // Group only an exact requirement/name/type match, with a stable ordering.
      const chains = new Map();
      const setVersion = db.prepare('UPDATE attachments SET logical_id=?,version=? WHERE id=?');
      for (const row of db.prepare('SELECT id,requirement_id,name,mime FROM attachments ORDER BY created_at,id').all()) {
        const key = JSON.stringify([row.requirement_id,row.name,row.mime]);
        const chain = chains.get(key) || { id: row.id, version: 0 }; chains.set(key, chain);
        setVersion.run(chain.id, ++chain.version, row.id);
      }
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS attachments_chain_version ON attachments(logical_id,version);
      CREATE INDEX IF NOT EXISTS attachments_chain_current ON attachments(logical_id,historical,version DESC);
      CREATE TABLE IF NOT EXISTS attachment_imports (
        source_key TEXT NOT NULL, commit_hash TEXT NOT NULL, file_path TEXT NOT NULL,
        blob_hash TEXT NOT NULL, attachment_id TEXT NOT NULL REFERENCES attachments(id),
        committed_at TEXT NOT NULL, author TEXT NOT NULL,
        PRIMARY KEY(source_key,commit_hash,file_path)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS attachment_imports_attachment ON attachment_imports(attachment_id);
      CREATE TRIGGER IF NOT EXISTS attachments_legacy_chain AFTER INSERT ON attachments
      WHEN NEW.logical_id IS NULL
      BEGIN
        UPDATE attachments SET
          logical_id=COALESCE((SELECT logical_id FROM attachments WHERE requirement_id=NEW.requirement_id AND name=NEW.name AND mime=NEW.mime AND id<>NEW.id ORDER BY version DESC,id LIMIT 1),NEW.id),
          version=COALESCE((SELECT MAX(version) FROM attachments WHERE requirement_id=NEW.requirement_id AND name=NEW.name AND mime=NEW.mime AND id<>NEW.id),0)+1
        WHERE id=NEW.id;
      END;
    `);
    if (schemaVersion < 3) migrateToVersion3(db);
    // Version 4: project documents (PRD, prototypes, specs, acceptance cases) with full version history.
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, title TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('PRD','原型','技术方案','验收用例','其他')), is_primary INTEGER NOT NULL DEFAULT 0 CHECK(is_primary IN (0,1)),
        created_at TEXT NOT NULL DEFAULT ${NOW}, updated_at TEXT NOT NULL DEFAULT ${NOW}, UNIQUE(project_id,name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), version INTEGER NOT NULL CHECK(version > 0),
        mime TEXT NOT NULL, content BLOB NOT NULL, content_hash TEXT NOT NULL,
        sections TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sections)), changed_sections TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(changed_sections)),
        note TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'upload', created_at TEXT NOT NULL DEFAULT ${NOW}, created_by TEXT REFERENCES users(id),
        UNIQUE(document_id,version)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS documents_project ON documents(project_id);
    `);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
    return db;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); db.close(); throw error; }
}

let savepointCounter = 0;
export function transaction(db, operation) {
  const nested = db.isTransaction;
  const name = 'xinghe_sp_' + (++savepointCounter);
  db.exec(nested ? `SAVEPOINT ${name}` : 'BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (result && typeof result.then === 'function') throw new Error('数据库事务内不能执行异步操作');
    db.exec(nested ? `RELEASE SAVEPOINT ${name}` : 'COMMIT');
    return result;
  } catch (error) {
    db.exec(nested ? `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}` : 'ROLLBACK');
    throw error;
  }
}

export function writeAudit(db, userId, action, entityType, entityId, detail = {}) {
  // Callers pass explicit safe metadata, never request bodies, credentials or tokens.
  return db.prepare('INSERT INTO audit(user_id,action,entity_type,entity_id,detail) VALUES(?,?,?,?,?)')
    .run(userId || null, action, entityType, entityId || null, JSON.stringify(detail));
}
