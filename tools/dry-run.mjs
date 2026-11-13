// 最小可运行 dry-run:扫描 → 规则 → 计划 → 打印。不执行任何删除。
// 用法: node tools/dry-run.mjs <目标目录> [--assess-depth 1] [--rules <规则包>] [--json]

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../core/src/scanner.ts';
import { assessEntry, riskLabel, reversibilityLabel } from '../core/src/risk-engine.ts';
import { buildPlan } from '../core/src/planner.ts';
import { loadPackWithOverlay } from '../core/src/rules-overlay.ts';
import { formatBytes } from '../core/src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

function parseArgs(argv) {
  const out = { target: null, rules: path.join(projectRoot, 'rules', 'default-rules.json'), assessDepth: 99, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rules') out.rules = path.resolve(argv[++i]);
    else if (a === '--assess-depth') out.assessDepth = Number(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (!a.startsWith('--') && out.target === null) out.target = a;
  }
  if (!out.target) {
    console.error('用法: node tools/dry-run.mjs <目标目录> [--assess-depth N] [--rules <规则包>] [--json]');
    process.exit(2);
  }
  return out;
}

async function loadRules(rulesPath) {
  const res = await loadPackWithOverlay(rulesPath);
  if (!res.ok) {
    console.error('规则包/overlay 校验失败:');
    for (const e of res.errors) console.error('  -', e);
    process.exit(2);
  }
  if (res.overlayFile) {
    console.log(`(overlay 已叠加: ${res.overlayFile} —— ${res.applied.length} 项生效)`);
  }
  return res.pack;
}

const CHECK = '✓默认勾选';
const UNCHECK = '□不勾选';

function printHuman(snapshot, assessments, plan, pack) {
  const lines = [];
  lines.push(`快照 ${snapshot.id}  根: ${snapshot.root}  生成于 ${snapshot.createdAt}`);
  lines.push(`扫描总量: ${snapshot.totals.files} 文件 / ${snapshot.totals.dirs} 目录 / ${formatBytes(snapshot.totals.bytes)}`);
  lines.push(`规则包 v${pack.version}: ${pack.rules.length} 条规则, 保护名单 ${pack.protected_paths.length} 条(执行层拦截)`);
  lines.push('');

  const items = plan.items;
  const actionable = items.filter(i => !i.blocked && i.action !== 'skip');
  const blocked = items.filter(i => i.blocked);
  const skipRuled = items.filter(i => !i.blocked && i.action === 'skip' && i.assessment.ruleId !== null);
  const unknown = items.filter(i => !i.blocked && i.action === 'skip' && i.assessment.ruleId === null);

  lines.push('—— 建议清理项(默认勾选,按大小降序)——');
  if (actionable.length === 0) lines.push('  (无 —— 没有规则建议默认清理的条目)');
  for (const it of [...actionable].sort((a, b) => b.entry.sizeBytes - a.entry.sizeBytes)) {
    const a = it.assessment;
    lines.push(
      `[${a.defaultChecked ? CHECK : UNCHECK}] ${riskLabel(a.riskLevel)}/${reversibilityLabel(a.reversibility)}  ` +
      `${formatBytes(it.entry.sizeBytes).padEnd(9)}  ${it.entry.name}  <${it.entry.path}>  依据: ${a.rationale} (规则 ${a.ruleId})`,
    );
  }
  lines.push('');
  lines.push(`—— 需用户决定(规则命中但建议 skip)—— 共 ${skipRuled.length} 项`);
  for (const it of [...skipRuled].sort((a, b) => b.entry.sizeBytes - a.entry.sizeBytes).slice(0, 12)) {
    const a = it.assessment;
    lines.push(
      `[${UNCHECK}] ${riskLabel(a.riskLevel)}/${reversibilityLabel(a.reversibility)}  ` +
      `${formatBytes(it.entry.sizeBytes).padEnd(9)}  ${it.entry.name}  <${it.entry.path}>  依据: ${a.rationale} (规则 ${a.ruleId})`,
    );
  }
  if (skipRuled.length > 12) lines.push(`  ...另有 ${skipRuled.length - 12} 项`);
  lines.push('');
  lines.push(`—— 保护名单拦截 —— 共 ${blocked.length} 项`);
  for (const it of [...blocked].sort((a, b) => b.entry.sizeBytes - a.entry.sizeBytes).slice(0, 12)) {
    lines.push(
      `[⊘拦截] ${riskLabel(it.assessment.riskLevel)}/${reversibilityLabel(it.assessment.reversibility)}  ` +
      `${formatBytes(it.entry.sizeBytes).padEnd(9)}  ${it.entry.name}  <${it.entry.path}>  拦截原因: ${it.blockReason}`,
    );
  }
  if (blocked.length > 12) lines.push(`  ...另有 ${blocked.length - 12} 项`);
  lines.push('');
  lines.push(`—— 规则未识别(默认不动,不勾选)—— 共 ${unknown.length} 项 / ${formatBytes(unknown.reduce((s, i) => s + i.entry.sizeBytes, 0))}`);
  for (const it of [...unknown].sort((a, b) => b.entry.sizeBytes - a.entry.sizeBytes).slice(0, 8)) {
    lines.push(`  ${formatBytes(it.entry.sizeBytes).padEnd(9)}  ${it.entry.name}  <${it.entry.path}>`);
  }
  if (unknown.length > 8) lines.push(`  ...另有 ${unknown.length - 8} 项(fail-closed:未识别不清理)`);
  lines.push('');
  lines.push(`计划 ${plan.id} 汇总: ${plan.summaryText}`);
  lines.push('dry-run:未执行任何删除。执行层已实现(见 tools/apply.mjs),本命令保持纯读。');
  console.log(lines.join('\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pack = await loadRules(args.rules);

  const t0 = Date.now();
  const snapshot = await scan(args.target, { maxDepth: 3, concurrency: 32 });
  const scanMs = Date.now() - t0;

  // 裁定:深度 ≤ assessDepth 的条目(不含根自身)
  const toAssess = snapshot.entries.filter(e => e.depth >= 1 && e.depth <= args.assessDepth);
  const assessments = new Map();
  for (const e of toAssess) assessments.set(e.path, await assessEntry(e, pack));

  // 建计划:选集 = 全部已裁定条目(Planner 会把 skip/不可替代项归一为 skip,计划里仍可见)
  const selected = [...toAssess];
  const plan = buildPlan(selected, assessments, { dryRun: true, userProtectedPaths: pack.protected_paths });

  if (args.json) {
    console.log(JSON.stringify({ snapshot: { id: snapshot.id, root: snapshot.root, totals: snapshot.totals, scanMs }, assessments: [...assessments.values()], plan }, null, 2));
    return;
  }
  console.log(`(扫描耗时 ${(scanMs / 1000).toFixed(1)}s, 裁定 ${assessments.size} 项)`);
  console.log('');
  printHuman(snapshot, assessments, plan, pack);
}

main().catch(err => {
  console.error('dry-run 失败:', err);
  process.exit(1);
});
