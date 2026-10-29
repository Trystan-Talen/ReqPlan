import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = fileURLToPath(new URL('../../', import.meta.url));

// Reconstruct the Dockerfile's local COPY inputs, not the source checkout's full
// module tree. This checks module closure without Docker or a listening socket;
// the CI container smoke test separately checks RUN, user and filesystem rules.
test('接口镜像实际复制的文件足以载入服务入口及全部静态依赖', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xinghe-runtime-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ignorePatterns = fs.readFileSync(path.join(project, '.dockerignore'), 'utf8')
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  assert.ok(ignorePatterns.every(pattern => !pattern.startsWith('!') && !pattern.includes('\\')),
    '打包测试暂不支持排除规则反选或转义，请同步更新复制规则或改用真实容器检查。');
  function ignored(relative) {
    const parts = relative.split('/');
    const ancestors = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    return ignorePatterns.some(pattern => ancestors.some(candidate => path.matchesGlob(candidate, pattern)));
  }
  function include(source) {
    const relative = path.relative(project, source).split(path.sep).join('/');
    if (ignored(relative)) return false;
    assert.ok(!relative.split('/').some(part => ['var', 'backups'].includes(part) || /\.sqlite(?:$|[.-])/.test(part)),
      `镜像复制范围意外包含运行数据：${relative}。请修复排除规则。`);
    assert.ok(!fs.lstatSync(source).isSymbolicLink(), `打包测试不跟随符号链接：${relative}`);
    return true;
  }
  function inImage(absolute) {
    return path.join(root, absolute.replace(/^\/+/, ''));
  }

  let workdir = '/', command, stages = 0, copies = 0;
  const instructions = fs.readFileSync(path.join(project, 'deploy/api.Dockerfile'), 'utf8').split(/\r?\n/);
  for (const raw of instructions) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    assert.ok(!line.endsWith('\\'), '打包测试暂不支持镜像构建指令续行，请同步更新解析逻辑。');
    const [instruction, ...arguments_] = line.split(/\s+/);
    if (instruction === 'FROM') {
      assert.equal(++stages, 1, '多阶段构建应使用真实镜像检查，不可仅模拟本地复制。');
    } else if (instruction === 'WORKDIR') {
      assert.equal(arguments_.length, 1);
      workdir = path.posix.resolve(workdir, arguments_[0]);
      fs.mkdirSync(inImage(workdir), { recursive: true });
    } else if (instruction === 'COPY') {
      const parts = [...arguments_];
      while (/^--(?:chown|chmod)=/.test(parts[0])) parts.shift();
      assert.ok(parts.length >= 2 && parts.every(part => !/[\[\]*?$"'\\]/.test(part) && !part.startsWith('--')),
        '打包测试只支持当前的本地字面路径复制；新复制语法需要同步校验。');
      const destination = parts.pop();
      const target = inImage(path.posix.resolve(workdir, destination));
      for (const source of parts) {
        const absolute = path.resolve(project, source);
        const relative = path.relative(project, absolute);
        assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '复制来源必须在项目目录内。');
        if (!include(absolute)) continue;
        const directory = fs.statSync(absolute).isDirectory();
        const intoDirectory = destination.endsWith('/') || parts.length > 1 || (fs.existsSync(target) && fs.statSync(target).isDirectory());
        const output = !directory && intoDirectory ? path.join(target, path.basename(source)) : target;
        fs.mkdirSync(path.dirname(output), { recursive: true });
        fs.cpSync(absolute, output, { recursive: true, filter: include });
        copies++;
      }
    } else if (instruction === 'CMD') {
      command = JSON.parse(line.slice(3).trim());
    } else {
      assert.ok(['RUN', 'USER', 'ENV', 'EXPOSE'].includes(instruction),
        `出现尚未处理的构建指令 ${instruction}，请核对运行文件检查方式。`);
    }
  }
  assert.ok(copies > 0, '没有找到镜像复制指令。');
  assert.ok(Array.isArray(command) && command.length === 2 && command[0] === 'node',
    '服务启动命令已变化，请同步更新入口检查。');
  const entry = inImage(path.posix.resolve(workdir, command[1]));
  assert.ok(fs.existsSync(entry), '镜像中缺少启动命令指定的服务入口。');
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(entry).href)});`], {
    cwd: inImage(workdir),
    env: { NODE_ENV: 'test', DATABASE_PATH: ':memory:', BACKUP_ENABLED: '0' },
    encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.status, 0, `打包后的服务入口无法载入：\n${result.error?.message || ''}\n${result.stderr}`);
});
