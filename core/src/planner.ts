// Planner 层:输入 选中条目 + 快照 + 规则裁定,输出删除计划(含拦截项与每项风险)。
// 硬约束:输出 DeletionPlan 是 Executor 的唯一合法输入;受保护路径在计划中标记 blocked,
// 但这不替代 Executor 的复检(纵深防御)。

import type { FsEntry, PlanItem, DeletionPlan, RiskAssessment, CleanupAction } from './types.ts';
import { formatBytes } from './types.ts';
import { isProtectedPath } from './protected-paths.ts';

export interface PlannerOptions {
  dryRun?: boolean; // 默认 true;false 只能由执行阶段显式传入
  /** 用户的保护名单(通常来自 RulePack.protected_paths) */
  userProtectedPaths?: readonly string[];
  /** 执行通道(2026-11-09):默认 stage。stage 通道可升级执行 recycle 建议(staging 恒比回收站安全);
   *  recycle 通道只执行 recycle 建议(stage 建议跳过,留给 staging)。 */
  channel?: 'stage' | 'recycle';
}

/** 归一化动作:按通道映射;skip 或不可替代 → 本轮跳过 */
function normalizeAction(a: CleanupAction, risk: RiskAssessment, channel: 'stage' | 'recycle'): CleanupAction {
  if (a === 'skip') return 'skip';
  if (risk.reversibility === 'irreplaceable') return 'skip'; // 不可替代项不允许进计划动作
  if (channel === 'stage') return 'stage'; // recycle 建议 → 升级为 stage(更安全的通道)
  return a === 'recycle' ? 'recycle' : 'skip'; // recycle 通道不执行 stage 建议
}

/**
 * 生成删除计划。
 * @param selected 用户勾选的条目(UI 传 FsEntry[];CLI dry-run 传规则建议集)
 */
export function buildPlan(
  selected: readonly FsEntry[],
  assessments: ReadonlyMap<string, RiskAssessment>,
  opts: PlannerOptions = {},
): DeletionPlan {
  const dryRun = opts.dryRun ?? true;
  const userProtected = opts.userProtectedPaths ?? [];
  const channel = opts.channel ?? 'stage';

  const items: PlanItem[] = selected.map(entry => {
    const assessment =
      assessments.get(entry.path) ??
      ({
        target: entry.path,
        riskLevel: 'high',
        reversibility: 'irreplaceable',
        rationale: '无裁定记录,fail-closed',
        suggestedAction: 'skip',
        ruleId: null,
        aiGenerated: false,
        defaultChecked: false,
      } satisfies RiskAssessment);

    const blocked = isProtectedPath(entry.path, userProtected);
    const blockReason = blocked
      ? '命中保护名单(执行层将再次拦截,与 UI 勾选无关)'
      : null;
    const action = blocked ? 'skip' : normalizeAction(assessment.suggestedAction, assessment, channel);
    return Object.freeze({ entry, assessment, action, blocked, blockReason });
  });

  let recycleItems = 0, recycleBytes = 0, stageItems = 0, stageBytes = 0, blockedItems = 0, skippedItems = 0;
  for (const it of items) {
    if (it.blocked) { blockedItems++; continue; }
    if (it.action === 'recycle') { recycleItems++; recycleBytes += it.entry.sizeBytes; }
    else if (it.action === 'stage') { stageItems++; stageBytes += it.entry.sizeBytes; }
    else skippedItems++;
  }

  const parts: string[] = [];
  if (recycleItems > 0) parts.push(`将 ${recycleItems} 项移入回收站(${formatBytes(recycleBytes)})`);
  if (stageItems > 0) parts.push(`将 ${stageItems} 项移入 staging(${formatBytes(stageBytes)})`);
  if (blockedItems > 0) parts.push(`${blockedItems} 项被保护名单拦截`);
  if (skippedItems > 0) parts.push(`${skippedItems} 项待用户决定`);
  const summaryText = parts.length > 0 ? parts.join('、') : '没有可执行项';

  return Object.freeze({
    id: `plan-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    dryRun,
    items: Object.freeze(items),
    totals: Object.freeze({ recycleItems, recycleBytes, stageItems, stageBytes, blockedItems, skippedItems }),
    summaryText,
  });
}

/** CLI/dry-run 便利:从快照中取"深度 ≤ maxDepth 且有裁定且规则建议可执行"的建议集(不含 blocked) */
export function suggestSelection(
  snapshotEntries: readonly FsEntry[],
  assessments: ReadonlyMap<string, RiskAssessment>,
  maxDepth = 1,
): FsEntry[] {
  return snapshotEntries.filter(
    e => e.depth <= maxDepth && e.depth > 0 && assessments.get(e.path)?.defaultChecked === true,
  );
}
