// Scanner 层:纯读扫描,输出不可变快照。
// 硬约束:本模块(及其依赖)不得 import 任何具备删除能力的模块/接口;只允许 fs 读类调用。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { FsEntry, Snapshot } from './types.ts';

const SCANNER_VERSION = '0.2.0-dry-run';

/** 扫描控制器:渲染层经 IPC 远程操控 暂停/继续/停止 */
export interface ScanController {
  paused: boolean;
  cancelled: boolean;
}

/** 停止信号:扫描被用户中止,已收集的部分数据仍可返回 */
export class ScanCancelledSignal extends Error {
  constructor() {
    super('scan cancelled');
    this.name = 'ScanCancelledSignal';
  }
}

export interface ScanOptions {
  /** 快照收录的最大相对深度(目录大小始终整树累计,depth 只影响收录) */
  maxDepth?: number; // 默认 64
  concurrency?: number; // 默认 32
  /** 进度回调(已扫描字节数、当前路径) */
  onProgress?: (scannedBytes: number, currentPath: string) => void;
  /** 暂停/停止控制(可选) */
  controller?: ScanController;
}

interface DirAccum {
  self: number; // 直接子文件字节
  total: number; // 子树累计
  childCount: number;
}

/**
 * 扫描 root,返回不可变快照。
 * - 目录大小 = 子树累计(lstat,不读取文件内容,不触发 OneDrive 水合)
 * - 重解析点(junction/symlink/OneDrive 占位目录)不跟随,按叶节点记录
 */
export async function scan(root: string, opts: ScanOptions = {}): Promise<Snapshot> {
  const maxDepth = opts.maxDepth ?? 64;
  const concurrency = Math.max(1, opts.concurrency ?? 32);
  const absRoot = path.resolve(root);
  const rootStat = await fs.lstat(absRoot);
  if (!rootStat.isDirectory()) throw new Error(`扫描根必须是目录: ${absRoot}`);

  const entries: FsEntry[] = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;

  // 目录大小汇总:child -> parent 自底向上累加
  const dirAcc = new Map<string, DirAccum>();

  const norm = (abs: string): string => abs.replaceAll('\\', '/');

  async function statEntry(abs: string, name: string, depth: number, parentAbs: string | null): Promise<void> {
    const st = await fs.lstat(abs);
    const isReparse = (st as unknown as { isSymbolicLink?: () => boolean }).isSymbolicLink?.() ?? false;
    const relPath = norm(abs);
    if (st.isFile()) {
      totalFiles += 1;
      totalBytes += st.size;
      if (parentAbs) {
        const acc = dirAcc.get(parentAbs)!;
        acc.self += st.size;
        acc.total += st.size;
        acc.childCount += 1;
      }
      if (depth <= maxDepth) {
        entries.push(Object.freeze({
          path: relPath, name, kind: 'file' as const,
          sizeBytes: st.size, mtimeMs: st.mtimeMs,
          depth, flags: Object.freeze({ isSymlink: false, isReparsePoint: isReparse, isHidden: name.startsWith('.') }),
        }));
      }
    } else if (st.isDirectory()) {
      totalDirs += 1;
      dirAcc.set(abs, { self: 0, total: 0, childCount: 0 });
      if (depth <= maxDepth) {
        entries.push(Object.freeze({
          path: relPath, name, kind: 'dir' as const,
          sizeBytes: 0, mtimeMs: st.mtimeMs,
          depth, flags: Object.freeze({ isSymlink: false, isReparsePoint: isReparse, isHidden: name.startsWith('.') }),
        }));
      }
      await readDir(abs, depth);
    }
    // 其余类型(块设备等)忽略
  }

  async function readDir(abs: string, depth: number): Promise<void> {
    const names = await fs.readdir(abs);
    // 简单并发池
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < names.length) {
        if (controller) {
          while (controller.paused && !controller.cancelled) {
            await new Promise(r => setTimeout(r, 150));
          }
          if (controller.cancelled) throw new ScanCancelledSignal();
        }
        const name = names[idx++];
        const child = path.join(abs, name);
        // 重解析目录:记录但不深入
        try {
          const st = await fs.lstat(child);
          if (st.isDirectory() && !isReparseChild(st)) {
            await statEntry(child, name, depth + 1, abs);
          } else {
            await statEntry(child, name, depth + 1, abs);
          }
        } catch (err) {
          void err; // 无权限/正在消失:静默跳过,快照如实缺失
        }
        opts.onProgress?.(totalBytes, child);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, names.length)) }, worker));
  }

  // Node lstat 无直接 isSymbolicLink 于 Stats?有:Stats.prototype.isSymbolicLink —— 上面的封装兼容两种
  function isReparseChild(st: fs.Stats): boolean {
    return st.isSymbolicLink();
  }

  // 并发遍历;每步之间响应暂停/停止
  const controller = opts.controller;
  let cancelled = false;
  try {
    await statEntry(absRoot, path.basename(absRoot) || norm(absRoot), 0, null);
  } catch (err) {
    if (err instanceof ScanCancelledSignal) {
      cancelled = true; // 用户停止:以已收集的部分数据出快照
    } else {
      throw err;
    }
  }

  // 自底向上回填目录尺寸(路径长的先算 = 子目录先于父目录)
  const dirEntries = [...dirAcc.keys()].sort((a, b) => b.length - a.length);
  const totalOf = (abs: string): number => dirAcc.get(abs)?.total ?? 0;
  // 构建 parent->children 索引
  const childrenOf = new Map<string, string[]>();
  for (const abs of dirAcc.keys()) {
    if (abs === absRoot) continue;
    const parent = path.dirname(abs);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent)!.push(abs);
  }
  for (const abs of dirEntries) {
    const acc = dirAcc.get(abs)!;
    for (const c of childrenOf.get(abs) ?? []) acc.total += totalOf(c);
    // 注意:文件尺寸在 statEntry 时已同时计入 self 与 total,此处不再加 self(曾因重复加导致目录尺寸双计虚报)
  }

  // 回填 entries 中目录的 sizeBytes(冻结前一次性重建)
  const sizeByPath = new Map<string, number>();
  for (const [abs, acc] of dirAcc) sizeByPath.set(norm(abs), acc.total);
  const thawed = entries.map(e =>
    e.kind === 'dir' && sizeByPath.has(e.path)
      ? Object.freeze({ ...e, sizeBytes: sizeByPath.get(e.path)! })
      : e,
  );

  return Object.freeze({
    id: `snap-${Date.now().toString(36)}`,
    root: norm(absRoot),
    createdAt: new Date().toISOString(),
    scannerVersion: SCANNER_VERSION,
    entries: Object.freeze(thawed),
    totals: Object.freeze({ files: totalFiles, dirs: totalDirs, bytes: totalBytes }),
    ...(cancelled ? { cancelled: true } : {}),
  });
}
