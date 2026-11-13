// 执行清理:扫描 → 规则 → 计划 → 【确认文案必须逐字匹配】→ 执行。
// 确认文案 = 计划 summaryText(如「将 2 项移入 staging(1.2 MB)」)—— 不接受"确定/继续"式的空确认。
//
// 预览(默认):  node tools/apply.mjs <目录> [--mode stage|recycle]
// 执行:         node tools/apply.mjs <目录> --mode stage --confirm "<汇总文本>"
// 撤销:         node tools/undo.mjs <undoId>

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../core/src/scanner.ts';
import { assessEntry, riskLabel, reversibilityLabel } from '../core/src/risk-engine.ts';
import { buildPlan } from '../core/src/planner.ts';
import { loadPackWithOverlay } from '../core/src/rules-overlay.ts';
import { ManifestUndoManager } from '../core/src/undo-manager.ts';
import { StagingExecutor, RecycleBinExecutor } from '../core/src/executor.ts';
import { loadConfig, stagingRootFor } from '../core/src/config.ts';
import { formatBytes } from '../core/src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function parseArgs(argv) {
  const out = { target: null, mode: 'stage', rules: path.join(projectRoot, 'rules', 'default-rules.json'), assessDepth: 99, confirm: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--rules') out.rules = path.resolve(argv[++i]);
    else if (a === '--assess-depth') out.assessDepth = Number(argv[++i]);
    else if (a === '--confirm') out.confirm = argv[++i];
    else if (a === '--json') out.json = true;
    else if (!a.startsWith('--') && out.target === null) out.target = a;
  }
  if (!out.target) {
    console.error('用法: node tools/apply.mjs <目标目录> [--mode stage|recycle] [--confirm "<汇总文本>"]');
    process.exit(2);
  }
  if (out.mode !== 'stage' && out.mode !== 'recycle') {
    console.error('--mode 只支持 stage(默认)或 recycle');
    process.exit(2);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const packRes = await loadPackWithOverlay(args.rules);
  if (!packRes.ok) {
    console.error('规则包/overlay 校验失败:');
    for (const e of packRes.errors) console.error('  -', e);
    process.exit(2);
  }
  const pack = packRes.pack;
  if (packRes.overlayFile) {
    console.log(`overlay 已叠加: ${packRes.overlayFile}`);
    for (const a of packRes.applied) console.log(`  · ${a}`);
  }

  const { config } = await loadConfig();
  const snapshot = await scan(args.target, { maxDepth: 3, concurrency: 32 });
  const toAssess = snapshot.entries.filter(e => e.depth >= 1 && e.depth <= args.assessDepth);
  const assessments = new Map();
  for (const e of toAssess) assessments.set(e.path, assessEntry(e, pack));
  const selected = [...toAssess];

  const previewPlan = buildPlan(selected, assessments, { dryRun: true, userProtectedPaths: pack.protected_paths, channel: args.mode });

  if (!args.confirm) {
    console.log('');
    console.log(`计划 ${previewPlan.id} 汇总: ${previewPlan.summaryText}`);
    console.log(`通道: ${args.mode === 'stage' ? 'staging(默认,可撤销)' : '系统回收站(Shell 还原,尽力而为)'}`);
    console.log('');
    console.log('这是预览。要执行,请把上面的汇总文本原样作为确认参数传入:');
    console.log(`  node tools/apply.mjs "${args.target}" --mode ${args.mode} --confirm "${previewPlan.summaryText}"`);
    process.exit(3);
  }

  const norm = s => s.replace(/\s+/g, ' ').trim();
  if (norm(args.confirm) !== norm(previewPlan.summaryText)) {
    console.error('确认文案与计划汇总不一致 —— 拒绝执行(计划可能已变化,请重新预览):');
    console.error(`  期望: ${previewPlan.summaryText}`);
    console.error(`  收到: ${args.confirm}`);
    process.exit(4);
  }

  const undo = new ManifestUndoManager({
    undoDir: config.undo.dir,
    stagingRootFor: p => stagingRootFor(p, config),
  });
  const deps = {
    undo,
    userProtectedPaths: pack.protected_paths,
    stagingRootFor: p => stagingRootFor(p, config),
    stagingMaxBytesPerVolume: config.staging.maxBytesPerVolume,
  };

  // 重新以 dryRun=false 生成正式计划(摘要相同,含义不同)
  const plan = buildPlan(selected, assessments, { dryRun: false, userProtectedPaths: pack.protected_paths, channel: args.mode });
  const executor = args.mode === 'stage' ? new StagingExecutor(deps) : new RecycleBinExecutor(deps);
  const receipt = await executor.execute(plan, args.mode);

  console.log('');
  console.log(`执行完成: 移动 ${receipt.movedItems} 项 / ${formatBytes(receipt.movedBytes)}`);
  if (receipt.failures.length > 0) {
    console.log(`失败 ${receipt.failures.length} 项:`);
    for (const f of receipt.failures) console.log(`  - ${f}`);
  }
  console.log(`撤销记录: ${receipt.undoRecordId || '(无可撤销项)'}`);
  if (receipt.undoRecordId) {
    console.log(`撤销命令: node tools/undo.mjs ${receipt.undoRecordId}`);
  }
}

main().catch(err => {
  console.error('执行失败:', err.message ?? err);
  process.exit(1);
});
