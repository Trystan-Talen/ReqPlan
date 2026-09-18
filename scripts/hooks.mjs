// 只做一件事：把 app.js 里 `import ... from '/lifecycle.js'` 这种浏览器绝对路径，
// 解析成仓库里真实的那份 lifecycle.js，好让 Node 也 import 得动同一个前端模块。
// 测试专用，不参与产品运行。跑法：node --import ./scripts/hooks.mjs scripts/selftest.mjs
import { register } from 'node:module';

const ROOT = new URL('../', import.meta.url);

register(
  `data:text/javascript,
   const ROOT = ${JSON.stringify(ROOT.href)};
   export async function resolve(specifier, context, next) {
     if (specifier === '/lifecycle.js') return next(new URL('lifecycle.js', ROOT).href, context);
     return next(specifier, context);
   }`,
  import.meta.url,
);
