// core 打包脚本:esbuild + .ts 扩展导入解析插件。
// CLI 工具用 Node 26 原生 .ts;Electron 自带 Node 较旧,所以壳层用本产物 shell/core.mjs。
// 用法: pnpm build:core

import esbuild from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const shellDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(shellDir, '..');

await esbuild.build({
  entryPoints: [path.join(projectRoot, 'core', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile: path.join(shellDir, 'core.mjs'),
  // core 内部以 './x.ts' 显式扩展导入(Node 26 原生运行所需);esbuild 默认不解析,这里映射
  plugins: [{
    name: 'ts-explicit-ext',
    setup(build) {
      build.onResolve({ filter: /\.ts$/ }, args => {
        if (args.path.startsWith('.')) {
          return { path: path.resolve(args.resolveDir, args.path), namespace: 'file' };
        }
      });
    },
  }],
  external: ['trash', 'electron'],
});

console.log('shell/core.mjs 构建完成');
