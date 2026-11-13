// Executor 层:只接受 Planner 输出的 DeletionPlan,不接受原始路径。
// 硬约束:
//  1. 默认通道 = staging(2026-11-09 用户决策);recycle 为可选通道;
//  2. 永久删除是独立类,入参类型强制 confirmed_permanent=true;
//  3. 写入前必须复检 assertDeletable(不信任 UI 与 Planner);
//  4. 执行前先调 UndoManager.begin 落盘撤销记录,再动文件系统。
// 依赖政策:本文件是执行层,唯一外部依赖 = npm 包 trash(回收站写入,动态导入);
// 分析层(scanner/risk-engine/planner)保持 node: 内置零依赖。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { DeletionPlan, ExecutionReceipt, PlanItem, UndoRecord } from './types.ts';
import { formatBytes } from './types.ts';
import { assertDeletable } from './protected-paths.ts';
import { BlockedPathError, PlanRejectedError, StagingCapacityError } from './errors.ts';
import type { UndoManager } from './undo-manager.ts';

export interface ExecutorDeps {
  undo: UndoManager;
  /** 执行层保护名单(用户部分;系统部分内置) */
  userProtectedPaths: readonly string[];
  stagingRootFor: (targetPath: string) => string;
  stagingMaxBytesPerVolume: number;
}

/** 从计划中取可执行项:按执行器通道过滤(与 UndoManager.begin 的过滤保持同一顺序) */
function actionableItems(plan: DeletionPlan, channel: 'recycle' | 'stage'): PlanItem[] {
  return plan.items.filter(i => !i.blocked && i.action === channel);
}

/** 执行层闸门:逐条复检保护名单。任何命中即整体拒绝(all-or-nothing) */
function guardPlanOrThrow(plan: DeletionPlan, userProtected: readonly string[]): void {
  if (plan.dryRun) throw new PlanRejectedError('dry-run 计划不可直接执行(先以 dryRun=false 重新 buildPlan)');
  for (const item of plan.items) {
    if (item.action === 'skip') continue;
    assertDeletable(item.entry.path, userProtected, true); // 命中即抛 BlockedPathError
  }
}

// ---------- staging 基础设施 ----------

/** 统计目录占用(供暂存区管理展示;纯读) */
export async function dirUsageBytes(root: string): Promise<number> {
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let dents;
    try { dents = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const d of dents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else {
        try { total += (await fs.lstat(p)).size; } catch { /* 消失即忽略 */ }
      }
    }
  }
  return total;
}

async function ensureStagingDir(root: string): Promise<string> {
  await fs.mkdir(root, { recursive: true });
  // 隐藏属性;失败不影响功能
  spawn('attrib', ['+h', root], { windowsHide: true, timeout: 10_000 }).on('error', () => {});
  return root;
}

/** 跨卷兜底:rename 失败(EXDEV)时 copy+delete。此时 manifest 已先行落盘,两处路径均可恢复。 */
async function movePath(src: string, dst: string): Promise<void> {
  try {
    await fs.rename(src, dst);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV') throw err;
    await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
    await fs.rm(src, { recursive: true, force: false, maxRetries: 2 });
  }
}

// ---------- 默认通道:StagingExecutor ----------

export class StagingExecutor {
  private readonly deps: ExecutorDeps;
  constructor(deps: ExecutorDeps) { this.deps = deps; }

  async execute(plan: DeletionPlan, mode: 'stage'): Promise<ExecutionReceipt> {
    if (mode !== 'stage') throw new PlanRejectedError('StagingExecutor 仅接受 mode=stage');
    guardPlanOrThrow(plan, this.deps.userProtectedPaths);
    const items = actionableItems(plan, 'stage');
    const failures: string[] = [];

    if (items.length === 0) {
      return { planId: plan.id, mode: 'stage', movedItems: 0, movedBytes: 0, undoRecordId: '', failures };
    }

    // 容量检查(按卷分组;超限整计划拒绝)
    const perVolume = new Map<string, number>();
    for (const it of items) {
      const root = this.deps.stagingRootFor(it.entry.path);
      perVolume.set(root, (perVolume.get(root) ?? 0) + it.entry.sizeBytes);
    }
    for (const [root, needed] of perVolume) {
      const usage = await dirUsageBytes(root);
      if (usage + needed > this.deps.stagingMaxBytesPerVolume) {
        throw new StagingCapacityError(root, needed, this.deps.stagingMaxBytesPerVolume - usage);
      }
    }

    // 先落盘撤销记录,再动文件系统
    const record: UndoRecord = await this.deps.undo.begin(plan, 'stage');
    const entries = [...(record.entries as { originalPath: string; stagedPath: string | null; sizeBytes: number; status: string }[])];

    let movedItems = 0;
    let movedBytes = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const entry = entries[idx];
      try {
        await ensureStagingDir(path.dirname(entry.stagedPath as string));
        await movePath(item.entry.path, entry.stagedPath as string);
        entry.status = 'moved';
        movedItems++;
        movedBytes += item.entry.sizeBytes;
      } catch (err) {
        entry.status = 'failed';
        failures.push(`${item.entry.path}: ${(err as Error).message}`);
      }
    }
    await this.deps.undo.commit(record);

    return {
      planId: plan.id,
      mode: 'stage',
      movedItems,
      movedBytes,
      undoRecordId: record.id,
      failures,
    };
  }
}

// ---------- 可选通道:RecycleBinExecutor(npm trash) ----------

export class RecycleBinExecutor {
  private readonly deps: ExecutorDeps;
  constructor(deps: ExecutorDeps) { this.deps = deps; }

  async execute(plan: DeletionPlan, mode: 'recycle'): Promise<ExecutionReceipt> {
    if (mode !== 'recycle') throw new PlanRejectedError('RecycleBinExecutor 仅接受 mode=recycle');
    guardPlanOrThrow(plan, this.deps.userProtectedPaths);
    const items = actionableItems(plan, 'recycle');
    const failures: string[] = [];

    if (items.length === 0) {
      return { planId: plan.id, mode: 'recycle', movedItems: 0, movedBytes: 0, undoRecordId: '', failures };
    }

    const record: UndoRecord = await this.deps.undo.begin(plan, 'recycle');
    const entries = [...(record.entries as { originalPath: string; stagedPath: string | null; sizeBytes: number; status: string }[])];

    // 动态导入 trash:缺失时给出明确安装指引
    let trash: (paths: string[]) => Promise<void>;
    try {
      trash = (await import('trash')).default;
    } catch (err) {
      for (const e of entries) e.status = 'failed';
      await this.deps.undo.commit(record);
      throw new Error(`回收站通道需要 npm 包 trash(未安装: ${(err as Error).message});默认通道 staging 不受影响`);
    }

    let movedItems = 0;
    let movedBytes = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const entry = entries[idx];
      try {
        await trash([item.entry.path]);
        entry.status = 'moved';
        movedItems++;
        movedBytes += item.entry.sizeBytes;
      } catch (err) {
        entry.status = 'failed';
        failures.push(`${item.entry.path}: ${(err as Error).message}`);
      }
    }
    await this.deps.undo.commit(record);

    return { planId: plan.id, mode: 'recycle', movedItems, movedBytes, undoRecordId: record.id, failures };
  }
}

// ---------- 永久删除:独立类,不可逆,审计留痕 ----------

export interface PermanentDeletionRequest {
  readonly plan: DeletionPlan;
  readonly confirmed_permanent: true; // 类型层面强制
}

export class PermanentDeletionExecutor {
  private readonly deps: { userProtectedPaths: readonly string[]; auditLogPath: string };
  constructor(deps: { userProtectedPaths: readonly string[]; auditLogPath: string }) { this.deps = deps; }

  async executePermanent(req: PermanentDeletionRequest): Promise<ExecutionReceipt> {
    if (req.confirmed_permanent !== true) throw new PlanRejectedError('永久删除必须显式 confirmed_permanent=true');
    const plan = req.plan;
    guardPlanOrThrow(plan, this.deps.userProtectedPaths);
    // 永久删除不区分通道:凡计划中未被跳过且未拦截的项都可执行
    const items = plan.items.filter(i => !i.blocked && i.action !== 'skip');
    const failures: string[] = [];

    let movedItems = 0;
    let movedBytes = 0;
    // 不可逆操作必须留痕:先记意图(在删除前),再记结果 —— 防止审计文件位于删除目标内时"删完重建"
    await fs.mkdir(path.dirname(this.deps.auditLogPath), { recursive: true });
    const auditLine = (phase, detail) =>
      `${new Date().toISOString()}\t${phase}\tplan=${plan.id}\titems=${detail.movedItems}/${items.length}\tbytes=${detail.movedBytes}\t${items.map(i => i.entry.path).join(' | ')}\n`;
    await fs.appendFile(this.deps.auditLogPath, auditLine('PERMANENT-INTENT', { movedItems: 0, movedBytes: 0 }), 'utf8');

    const deletedAt = new Date().toISOString();
    for (const item of items) {
      try {
        await fs.rm(item.entry.path, { recursive: true, force: false, maxRetries: 2 });
        movedItems++;
        movedBytes += item.entry.sizeBytes;
      } catch (err) {
        failures.push(`${item.entry.path}: ${(err as Error).message}`);
      }
    }
    // DONE 行尽力而为(目标可能连审计文件一起被删;INTENT 行才是权威留痕)
    try {
      await fs.appendFile(this.deps.auditLogPath, auditLine('PERMANENT-DONE', { movedItems, movedBytes }) + `\tdeletedAt=${deletedAt}\n`, 'utf8');
    } catch { /* 审计文件随目标被删:以 INTENT 行为准 */ }

    // 不可逆:无 undoRecordId(接口对称性由 staging/recycle 保证)
    return { planId: plan.id, mode: 'permanent', movedItems, movedBytes, undoRecordId: '', failures };
  }
}

/** 诊断辅助:列出计划中会被执行层拒绝的项(不执行) */
export function guardPlan(plan: DeletionPlan, userProtected: readonly string[]): string[] {
  const violations: string[] = [];
  for (const item of plan.items) {
    if (item.action === 'skip') continue;
    try {
      assertDeletable(item.entry.path, userProtected, true);
    } catch (err) {
      violations.push(`${item.entry.path}: ${(err as Error).message}`);
    }
  }
  return violations;
}
