// 执行层保护名单 —— 硬约束的实现位置。
// 硬约束原文:「受保护路径在执行层拦截,不依赖 UI 层的勾选状态。」
// Planner 也会用本模块做展示性拦截,但 Executor 必须在写入前重新调用 assertDeletable(纵深防御)。

import { BlockedPathError } from './errors.ts';

/** 系统级硬保护前缀(前缀或全等;大小写不敏感) */
export const SYSTEM_PROTECTED_PREFIXES: readonly string[] = [
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/programdata/microsoft',
  'c:/$recycle.bin',
  'c:/system volume information',
  'c:/recovery',
];

/** 系统级硬保护条目(仅全等匹配;目录本身,不含子树) */
export const SYSTEM_PROTECTED_EXACT: readonly string[] = [
  'c:/users', // 用户目录根本身;深层路径按用户保护名单与规则判断
];

/** 系统级硬保护文件(卷根上的固定文件) */
export const SYSTEM_PROTECTED_FILES: readonly string[] = [
  'c:/pagefile.sys',
  'c:/swapfile.sys',
  'c:/hiberfil.sys',
  'c:/dumpstack.log.tmp',
];

/** 判断 path 是否受保护:系统名单 ∪ 用户名单。execLayer=true 供 Executor 复检用(语义相同,显式调用以留审计痕迹) */
export function isProtectedPath(
  path: string,
  userProtected: readonly string[],
  execLayer = false,
): boolean {
  const norm = path.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  const isFileHit = SYSTEM_PROTECTED_FILES.some(f => norm === f);
  const isExactHit = SYSTEM_PROTECTED_EXACT.some(p => norm === p);
  const isPrefixHit = SYSTEM_PROTECTED_PREFIXES.some(
    p => norm === p || norm.startsWith(p + '/'),
  );
  const isUserHit = userProtected.some(u => {
    const un = u.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
    return norm === un || norm.startsWith(un + '/');
  });
  // 任何卷根(如 c:/ 、d:/)本身一律保护
  const isVolumeRoot = /^[a-z]:\/?$/.test(norm);
  void execLayer; // 当前语义一致;保留参数以区分审计日志类别
  return isFileHit || isExactHit || isPrefixHit || isUserHit || isVolumeRoot;
}

/** Executor 唯一准入闸门:受保护路径抛 BlockedPathError */
export function assertDeletable(
  path: string,
  userProtected: readonly string[],
  execLayer = true,
): void {
  if (isProtectedPath(path, userProtected, execLayer)) {
    throw new BlockedPathError(path, execLayer);
  }
}
