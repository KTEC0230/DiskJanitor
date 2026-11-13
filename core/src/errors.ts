/** 执行层/规划层共用的拦截异常 */
export class BlockedPathError extends Error {
  readonly path: string;
  readonly execLayer: boolean;
  constructor(path: string, execLayer: boolean) {
    super(
      execLayer
        ? `执行层拦截受保护路径: ${path}`
        : `受保护路径(计划中已拦截): ${path}`,
    );
    this.name = 'BlockedPathError';
    this.path = path;
    this.execLayer = execLayer;
  }
}

/** dry-run / 未实现阶段的执行层占位异常 */
export class NotImplementedError extends Error {
  constructor(module: string) {
    super(`${module} 尚未实现(当前处于 dry-run 阶段,禁止任何写操作)`);
    this.name = 'NotImplementedError';
  }
}

/** staging 容量不足:整计划拒绝(all-or-nothing) */
export class StagingCapacityError extends Error {
  readonly root: string;
  readonly neededBytes: number;
  readonly availableBytes: number;
  constructor(root: string, neededBytes: number, availableBytes: number) {
    super(
      `staging 容量不足: ${root} 需 ${neededBytes} 字节,仅剩 ${availableBytes} 字节` +
      `(可清理旧批次或调高 config.staging.maxBytesPerVolume)`,
    );
    this.name = 'StagingCapacityError';
    this.root = root;
    this.neededBytes = neededBytes;
    this.availableBytes = availableBytes;
  }
}

/** 计划不可执行的通用拒绝(如 dry-run 计划、含被拦截项) */
export class PlanRejectedError extends Error {
  constructor(reason: string) {
    super(`计划被拒绝: ${reason}`);
    this.name = 'PlanRejectedError';
  }
}
