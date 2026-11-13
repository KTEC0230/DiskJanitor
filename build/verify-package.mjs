// 打包完整性校验:electron-builder 曾静默丢文件(整丢 renderer 导致 UI 全死)。
// builder 之后必须跑本脚本,任何缺失即退出 1。
// 用法: node build/verify-package.mjs [asar路径(默认 dist/win-unpacked/resources/app.asar)]

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arc = process.argv[2] ?? path.join(projectRoot, 'dist', 'win-unpacked', 'resources', 'app.asar');

// @electron/asar 是 electron-builder 的传递依赖(pnpm 隔离),从它的位置解析
const ebPkg = require.resolve('electron-builder/package.json', { paths: [projectRoot] });
const asar = createRequire(ebPkg)('@electron/asar');
const MUST = [
  'package.json',
  'shell/main.mjs',
  'shell/preload.cjs',
  'shell/core.mjs',
  'shell/renderer/app.mjs',
  'shell/renderer/index.html',
  'shell/renderer/style.css',
  'rules/default-rules.json',
];

const list = asar.listPackage(arc).map(f => f.replaceAll('\\', '/').replace(/^\//, ''));
const missing = [];
for (const f of MUST) {
  if (!list.includes(f)) { missing.push(f); continue; }
  try {
    const buf = asar.extractFile(arc, f.replaceAll('/', '\\'));
    if (buf.length === 0) missing.push(`${f}(空文件)`);
  } catch (err) {
    missing.push(`${f}(extract 失败)`);
  }
}

let mainSrc = '', appSrc = '';
try { mainSrc = asar.extractFile(arc, 'shell\\main.mjs').toString('utf8'); } catch { /* 已在缺失清单 */ }
try { appSrc = asar.extractFile(arc, 'shell\\renderer\\app.mjs').toString('utf8'); } catch { /* 同上 */ }
const checks = [
  ['main 含 purge IPC', mainSrc.includes('dj:purge-batch')],
  ['main 含 renderer 转发', mainSrc.includes('console-message')],
  ['renderer 含暂存管理', appSrc.includes('staging-head')],
  ['renderer 含报告导出', appSrc.includes('exportReport')],
];
for (const [name, ok] of checks) {
  if (!ok) missing.push(`(内容校验失败: ${name})`);
}

if (missing.length > 0) {
  console.error('打包不完整,缺失/异常:');
  for (const m of missing) console.error('  -', m);
  process.exit(1);
}
console.log(`打包校验通过(${MUST.length} 个必须文件 + 内容检查)`);
