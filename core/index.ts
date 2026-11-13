// core 对外出口(供 esbuild 打包给 Electron 壳层使用;CLI 工具走 Node 26 原生 .ts,不需要本文件)

export { scan, ScanCancelledSignal } from './src/scanner.ts';
export type { ScanController } from './src/scanner.ts';
export { writeScanReport } from './src/report.ts';
export type { ReportRow, ReportMeta } from './src/report.ts';
export { assessEntry, riskLabel, reversibilityLabel, FAIL_CLOSED_ASSESSMENT, globToRegExp } from './src/risk-engine.ts';
export { buildPlan, suggestSelection } from './src/planner.ts';
export { validateRulePack } from './src/rules-schema.ts';
export type { CleanupRule, RulePack, RuleMatch, ValidateResult } from './src/rules-schema.ts';
export { loadPackWithOverlay, overlayPath, RISK_ORDER, ACTION_ORDER } from './src/rules-overlay.ts';
export { loadConfig, defaultConfig, userConfigPath, stagingRootFor } from './src/config.ts';
export { ManifestUndoManager } from './src/undo-manager.ts';
export { StagingExecutor, RecycleBinExecutor, PermanentDeletionExecutor, guardPlan, dirUsageBytes } from './src/executor.ts';
export { isProtectedPath, assertDeletable, SYSTEM_PROTECTED_PREFIXES, SYSTEM_PROTECTED_EXACT, SYSTEM_PROTECTED_FILES } from './src/protected-paths.ts';
export { BlockedPathError, StagingCapacityError, PlanRejectedError, NotImplementedError } from './src/errors.ts';
export { formatBytes } from './src/types.ts';
export type {
  FsEntry, FsFlags, Snapshot, RiskLevel, Reversibility, CleanupAction,
  RiskAssessment, PlanItem, DeletionPlan, ExecutionReceipt,
  UndoRecord, UndoEntry, UndoEntryStatus, UndoReceipt,
} from './src/types.ts';
