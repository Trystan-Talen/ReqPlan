// npm run import:docs [-- --dry-run] [-- --config 路径]
// 按 docs-import.json 把本地 PRD / 技术方案同步为项目文档：内容变化的文件生成新版本，未变化的跳过。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../database.mjs';
import { createBusiness } from '../business.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function expand(root, entry) {
  if (entry.file) return [entry.file];
  const pattern = entry.glob, directory = path.dirname(pattern), base = path.basename(pattern);
  const matcher = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
  return fs.readdirSync(path.join(root, directory)).filter(name => matcher.test(name)).sort((a, b) => a.localeCompare(b, 'zh', { numeric: true })).map(name => path.join(directory, name));
}
// 标题取文件第一行的一级标题（验收用例取首行注释），去掉末尾的版本号。
function titleOf(file, text) {
  const first = text.replace(/^﻿/, '').split('\n').find(line => line.trim());
  const match = /^#\s+(.+)$/.exec(first || '');
  return match ? match[1].replace(/[（(]v[\d.]+[）)]\s*$/, '').trim() : path.basename(file);
}

export function planImport(config, root) {
  const plan = [];
  for (const entry of config.documents) {
    for (const file of expand(root, entry)) {
      const absolute = path.join(root, file);
      if (!fs.existsSync(absolute)) throw new Error(`找不到源文件：${file}`);
      for (const projectId of entry.projects) plan.push({ file, absolute, projectId, type: entry.type, primary: Boolean(entry.primary) });
    }
  }
  return plan;
}

export function importDocuments({ db, config, root, dryRun = false, log = console.log }) {
  const business = createBusiness(db);
  const actor = db.prepare('SELECT id FROM users WHERE username=? COLLATE NOCASE').get(config.actor);
  if (!actor) throw new Error(`导入账号 ${config.actor} 不存在`);
  const summary = { created: 0, updated: 0, unchanged: 0 };
  for (const item of planImport(config, root)) {
    const buffer = fs.readFileSync(item.absolute), text = buffer.toString('utf8'), name = path.basename(item.file);
    const existing = db.prepare('SELECT id FROM documents WHERE project_id=? AND name=?').get(item.projectId, name);
    if (dryRun) { log(`${existing ? '检查' : '新建'}  ${item.projectId}  ${item.file}`); continue; }
    const result = business.uploadDocument({ id: actor.id }, item.projectId, { name, title: titleOf(item.file, text), type: item.type, primary: item.primary, contentBuffer: buffer, source: 'import' });
    const kind = result.unchanged ? 'unchanged' : result.document.version === 1 ? 'created' : 'updated';
    summary[kind]++;
    if (kind !== 'unchanged') log(`${kind === 'created' ? '新建' : `新版本 v${result.document.version}`}  ${item.projectId}  ${item.file}${result.document.changedSections.length ? `（变更章节：${result.document.changedSections.join('、')}）` : ''}`);
  }
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const configPath = path.resolve(args.includes('--config') ? args[args.indexOf('--config') + 1] : path.join(ROOT, 'docs-import.json'));
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const root = path.resolve(path.dirname(configPath), config.root);
  const db = openDatabase(process.env.DATABASE_PATH || path.join(ROOT, 'backend/var/xinghe.sqlite'));
  try {
    const summary = importDocuments({ db, config, root, dryRun: args.includes('--dry-run') });
    if (!args.includes('--dry-run')) console.log(`完成：新建 ${summary.created}，更新 ${summary.updated}，未变化 ${summary.unchanged}。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { db.close(); }
}
