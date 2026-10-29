// Isolated real-browser fixture. Run with Node 24:
// node backend/tests/support/browser-server.mjs
// Uses the shipped sanitized seed in memory; never opens the workspace database.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../../database.mjs';
import { createApplication } from '../../server.mjs';
import { importLegacy } from '../../scripts/import-legacy.mjs';

const frontend = fileURLToPath(new URL('../../../frontend/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const db = openDatabase(':memory:');
importLegacy(db);
let app;
const server = http.createServer((req, res) => {
  if (!app) { res.writeHead(503); res.end(); return; }
  if (req.url.startsWith('/api/')) { void app.handler(req, res); return; }
  if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); res.end(); return; }
  const file = path.resolve(frontend, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(frontend) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
});

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ db, publicOrigin: origin, secureCookies: false, logger: { info() {}, error: console.error } });
  const password = 'Browser-Test-Only!2026';
  const admin = await app.auth.bootstrapAdmin({ username: 'quality-admin', name: '隔离测试管理员', password });
  const account = app.auth.createUser(admin, { username: 'quality-viewer', name: '隔离测试观察者', role: 'member' });
  await app.auth.redeemToken({ token: account.activationToken, password });
  const project = app.business.getProject(admin, 'p-exec');
  app.business.setMember(admin, project.id, { userId: account.user.id, role: 'viewer', version: project.version });
  console.log(JSON.stringify({ origin, admin: 'quality-admin', viewer: 'quality-viewer', password, database: ':memory:' }));
} catch (error) {
  server.close(); db.close(); throw error;
}

let closing = false;
function stop() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  server.close(() => { db.close(); process.exit(0); });
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
