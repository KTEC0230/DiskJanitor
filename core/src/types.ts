// DiskJanitor 核心领域类型 —— 分析路径与执行路径共享的唯一数据契约。
// 约定:所有接口字段 readonly,快照与计划一经创建不可变(immutable)。

/** 风险等级:低(随便删)/ 中(删了有代价)/ 高(需明确确认) */
export type RiskLevel = 'low' | 'medium' | 'high';

/** 可逆性:可重新生成 / 可恢复(有代价但可找回)/ 不可替代 */
export type Reversibility = 'regenerable' | 'recoverable' | 'irreplaceable';

/** 建议动作:recycle=移入回收站 stage=移入staging skip=需用户决定(计划中置零) */
export type CleanupAction = 'recycle' | 'stage' | 'skip';

/** 文件系统标志位(扫描期只读获取) */
export interface FsFlags {
  readonly isSymlink: boolean;
  readonly isReparsePoint: boolean; // 含 junction / OneDrive 占位符等
  readonly isHidden: boolean;
}

/** 快照中的单个文件/目录条目 */
export interface FsEntry {
  readonly path: string; // 规范化正斜杠、小写盘符以外的原始大小写保留
  readonly name: string;
  readonly kind: 'file' | 'dir';
  readonly sizeBytes: number; // 目录 = 子树累计
  readonly mtimeMs: number;
  readonly depth: number; // 相对扫描根,根 = 0
  readonly flags: Readonly<FsFlags>;
}

/** Scanner 的唯一输出:不可变快照。纯读产物,不含任何删除接口。 */
export interface Snapshot {
  readonly id: string;
  readonly root: string;
  readonly createdAt: string; // ISO
  readonly scannerVersion: string;
  readonly entries: readonly FsEntry[];
  readonly totals: Readonly<{ files: number; dirs: number; bytes: number }>;
  /** 用户中止扫描时为 true(部分数据) */
  readonly cancelled?: boolean;
}

/** RiskEngine 对单个条目的裁定。规则命中时 aiGenerated=false;未命中走 fail-closed 默认。 */
export interface RiskAssessment {
  readonly target: string;
  readonly riskLevel: RiskLevel;
  readonly reversibility: Reversibility;
  readonly rationale: string;
  readonly suggestedAction: CleanupAction;
  readonly ruleId: string | null; // null = 规则未命中(AI/兜底)
  readonly aiGenerated: boolean;
  readonly defaultChecked: boolean; // UI 默认勾选策略随规则走
}

/** 计划项:快照条目 + 裁定 + 执行层最终动作 */
export interface PlanItem {
  readonly entry: FsEntry;
  readonly assessment: RiskAssessment;
  readonly action: CleanupAction; // Planner 归一化后的动作('skip' 表示本轮不处理)
  readonly blocked: boolean; // 执行层保护名单命中(UI 勾选状态对此无影响力)
  readonly blockReason: string | null;
}

/** Planner 的唯一输出。Executor 只接受此对象,不接受裸路径。 */
export interface DeletionPlan {
  readonly id: string;
  readonly createdAt: string;
  readonly dryRun: boolean;
  readonly items: readonly PlanItem[];
  readonly totals: Readonly<{
    recycleItems: number; recycleBytes: number;
    stageItems: number; stageBytes: number;
    blockedItems: number; skippedItems: number;
  }>;
  /** 面向确认按钮的一句话,如「将 12 项移入回收站(3.2 GB)」 */
  readonly summaryText: string;
}

/** Executor 回执 */
export interface ExecutionReceipt {
  readonly planId: string;
  readonly mode: 'recycle' | 'stage' | 'permanent';
  readonly movedItems: number;
  readonly movedBytes: number;
  readonly undoRecordId: string; // 撤销句柄;permanent 模式为空
  readonly failures: readonly string[];
}

/** 撤销记录中单条目的生命周期 */
export type UndoEntryStatus =
  | 'pending'        // 已登记,尚未执行
  | 'moved'          // 已移入 staging/回收站(可撤销)
  | 'failed'         // 执行失败(仍在原位)
  | 'restored'       // 已撤销回原位
  | 'restore-failed' // 撤销失败
  | 'restore-skipped' // 撤销时目标已存在,跳过
  | 'purged';        // 已被用户显式永久删除(放弃撤销权)

export interface UndoEntry {
  readonly originalPath: string;
  readonly stagedPath: string | null; // mode=recycle 时为 null(由 OS 回收站保管)
  readonly sizeBytes: number;
  readonly mtimeMs: number;
  readonly deletedAt: string;
  status: UndoEntryStatus; // 记录内可演进;记录整体仍受版本化管理
}

export interface UndoRecord {
  readonly id: string;
  readonly planId: string;
  readonly mode: 'recycle' | 'stage';
  readonly createdAt: string;
  status: 'pending' | 'committed' | 'undone' | 'purged';
  entries: readonly UndoEntry[];
}

export interface UndoReceipt {
  readonly undoId: string;
  readonly restoredItems: number;
  readonly failures: readonly string[];
}

/** 字节格式化(UI 与 CLI 共用) */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
