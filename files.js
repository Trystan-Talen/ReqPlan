import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const KINDS = { doc: 'doc', proto: 'proto' };
export const MAX_BYTES = 2 * 1024 * 1024;
const SEG = /^[A-Za-z0-9._一-龥-]{1,120}$/;

let gate = Promise.resolve();
function serial(fn) {
  const next = gate.then(fn, fn);
  gate = next.catch(() => {});
  return next;
}

function run(args, cwd) {
  return new Promise((resolve) => {
    const p = spawn('git', args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => resolve({ ok: false, out, err: e.message }));
    p.on('close', (code) => resolve({ ok: code === 0, code, out, err }));
  });
}

function git(args, cwd, { author } = {}) {
  const a = [
    '-c', 'user.name=' + (author?.name || '系统'),
    '-c', 'user.email=' + (author?.email || 'system@xinghe.local'),
    '-c', 'commit.gpgsign=false',
    '-c', 'core.quotepath=false',
    ...args,
  ];
  return run(a, cwd);
}

export function createStore(root) {
  const cwd = root;

  const safeSeg = (s) => (typeof s === 'string' && SEG.test(s) && s !== '.' && s !== '..' ? s : null);

  // 把用户提供的两个片段拼成仓库内的相对路径；任何异常片段一律拒绝
  function relPath(reqId, kind, name) {
    const r = safeSeg(reqId), k = KINDS[kind], n = safeSeg(name);
    if (!r || !k || !n) return null;
    const rel = `${r}/${k}/${n}`;
    // 二次确认：解析后的绝对路径必须仍在仓库内
    const abs = path.resolve(cwd, rel);
    if (!abs.startsWith(path.resolve(cwd) + path.sep)) return null;
    return { rel, abs, reqId: r, kind: k, name: n };
  }

  async function gitOut(args, author) {
    const r = await git(args, cwd, author ? { author } : undefined);
    if (!r.ok) throw new Error(r.err.trim() || 'git 命令失败');
    return r.out;
  }

  const F = '\x1f'; // ASCII 单元分隔符：正常提交信息与文件名里不会出现，可安全用于字段切分

  async function ensureRepo() {
    try {
      await fs.access(path.join(cwd, '.git'));
    } catch {
      await fs.mkdir(cwd, { recursive: true });
      await gitOut(['init', '-q', '-b', 'main']);
      await gitOut(['config', 'core.autocrlf', 'false']);
    }
  }

  // 版本号：该文件在默认分支上的提交数（旧 → 新），v1 是最早的一次
  async function versionsOf(rel) {
    const out = await gitOut(['log', '--follow', `--format=%H${F}%an${F}%aI${F}%s`, '--', rel]);
    const rec = out.split('\n').map((s) => s.trim()).filter(Boolean).map((line) => {
      const [sha, author, date, subject] = line.split(F);
      return { sha, author, date, subject };
    });
    const n = rec.length;
    return rec.map((x, i) => ({ ...x, version: n - i }));
  }

  async function listFor(reqId) {
    const r = safeSeg(reqId);
    if (!r) return { doc: [], proto: [] };
    const out = { doc: [], proto: [] };
    for (const kind of Object.keys(KINDS)) {
      const dir = path.join(cwd, r, kind);
      let names = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        if (name.startsWith('.')) continue;
        const p = relPath(r, kind, name);
        if (!p) continue;
        const st = await fs.stat(p.abs).catch(() => null);
        if (!st?.isFile()) continue;
        const vs = await versionsOf(p.rel);
        if (!vs.length) continue;
        out[kind].push({
          kind,
          name,
          path: p.rel,
          size: st.size,
          version: vs[0].version,
          sha: vs[0].sha,
          updatedAt: vs[0].date,
          updatedBy: vs[0].author,
          versions: vs,
        });
      }
    }
    return out;
  }

  async function readRaw(reqId, kind, name, version) {
    const p = relPath(reqId, kind, name);
    if (!p) return null;
    const st = await fs.stat(p.abs).catch(() => null);
    if (!st?.isFile()) return null;
    if (version) {
      const vs = await versionsOf(p.rel);
      const hit = vs.find((v) => String(v.version) === String(version));
      if (!hit) return null;
      const r = await git(['show', `${hit.sha}:${p.rel}`], cwd);
      if (!r.ok) return null;
      return { buffer: Buffer.from(r.out, 'utf8'), meta: hit };
    }
    return { buffer: await fs.readFile(p.abs), meta: null };
  }

  async function write(reqId, kind, name, buffer, author) {
    const p = relPath(reqId, kind, name);
    if (!p) return { error: '文件名只能是中文、字母、数字、点、下划线或短横线' };
    if (buffer.length > MAX_BYTES) return { error: `文件超过 ${Math.round(MAX_BYTES / 1024 / 1024)}MB 上限` };
    await ensureRepo();
    await fs.mkdir(path.dirname(p.abs), { recursive: true });
    await fs.writeFile(p.abs, buffer);
    await gitOut(['add', '--', p.rel]);
    const had = (await versionsOf(p.rel)).length > 0;
    const subject = `${had ? '更新' : '上传'} ${kind === 'proto' ? '原型' : '文档'} ${name}`;
    const r = await git(['commit', '-q', '-m', subject, '--', p.rel], cwd, { author });
    if (!r.ok) {
      // 内容与上一版完全一致时 git 会拒绝提交；这不是错误
      if (/nothing to commit/i.test(r.out + r.err)) return { unchanged: true, list: await listFor(reqId) };
      throw new Error(r.err.trim() || '提交失败');
    }
    return { list: await listFor(reqId) };
  }

  async function remove(reqId, kind, name, author) {
    const p = relPath(reqId, kind, name);
    if (!p) return null;
    await gitOut(['rm', '-q', '-r', '--cached', '--', p.rel]);
    const r = await git(['commit', '-q', '-m', `移除 ${name}`, '--', p.rel], cwd, { author });
    if (!r.ok && !/nothing to commit/i.test(r.out + r.err)) throw new Error(r.err.trim());
    return { list: await listFor(reqId) };
  }

  // 启动自检：仓库可用 + 已跟踪文件都在磁盘上（真值在 git，磁盘是工作区）
  async function doctor() {
    await ensureRepo();
    const out = await gitOut(['ls-files']);
    const missing = [];
    for (const f of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      try { await fs.access(path.join(cwd, f)); } catch { missing.push(f); }
    }
    return { tracked: out.split('\n').filter(Boolean).length, missing };
  }

  return { listFor, readRaw, write, remove, doctor, relPath };
}
