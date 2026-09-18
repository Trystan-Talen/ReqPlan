#!/usr/bin/env node
import { openDatabase } from '../database.mjs';
import { createAuth, resetUserFromCli } from '../auth.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function parseArguments(argv) {
  const [command, ...args] = argv;
  if (!['create-admin', 'bootstrap-admin', 'reset-user'].includes(command)) throw new Error('用法：node backend/scripts/accounts.mjs create-admin --db 数据库路径 --username 用户名 --name 姓名；或 reset-user --db 数据库路径 --username 用户名。密码从标准输入读取。');
  const options = { command };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!['--db', '--username', '--name'].includes(key) || options[key] !== undefined || !args[index + 1]) throw new Error('命令参数无效；密码不能通过命令参数传递');
    options[key] = args[index + 1];
  }
  if (!options['--db'] || !options['--username'] || (command !== 'reset-user' && !options['--name'])) throw new Error('必须提供 --db、--username；创建管理员还需要 --name');
  return options;
}

function readHidden(prompt) {
  process.stderr.write(prompt);
  return new Promise((resolvePassword, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    function cleanup() { process.stdin.off('data', receive); process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause(); process.stderr.write('\n'); }
    function receive(chunk) {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') { cleanup(); reject(new Error('已取消创建管理员')); return; }
        if (char === '\r' || char === '\n') { cleanup(); resolvePassword(value); return; }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char >= ' ') value += char;
        if (Buffer.byteLength(value) > 1024) { cleanup(); reject(new Error('密码不能超过 1024 字节')); return; }
      }
    }
    process.stdin.on('data', receive);
  });
}

async function passwordFromStdin() {
  if (process.stdin.isTTY) {
    const first = await readHidden('新密码（至少 6 个字符，输入不回显）：');
    const second = await readHidden('再次输入密码：');
    if (first !== second) throw new Error('两次输入的密码不一致');
    return first;
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 2048) throw new Error('标准输入过长');
    chunks.push(chunk);
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  if (/[\r\n]/.test(value)) throw new Error('标准输入必须仅包含一行密码');
  return value;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const password = await passwordFromStdin();
  const db = openDatabase(options['--db']);
  try {
    if (options.command === 'reset-user') {
      const user = await resetUserFromCli(db, { username: options['--username'], password });
      process.stdout.write('账号密码已重置：' + user.username + '。原角色保留，旧凭证已撤销，下次登录必须修改密码。\n');
    } else {
      const user = await createAuth(db).bootstrapAdmin({ username: options['--username'], name: options['--name'], password });
      process.stdout.write('管理员已创建：' + user.username + '。请通过应用登录；密码未输出。\n');
    }
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write((error.message || '创建失败') + '\n'); process.exitCode = 1; });
}
