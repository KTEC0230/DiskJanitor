// 应用配置:默认值 + 可选用户覆盖(%APPDATA%\DiskJanitor\config.json)。
// 2026-11-09 决策:默认清理通道 = staging;staging 按卷根放置(保证 rename 原子性、零跨卷拷贝)。

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DiskJanitorConfig {
  staging: {
    /** 每个卷的 staging 目录名(位于该卷根,自动加隐藏属性) */
    dirName: string;
    /** 单卷 staging 容量上限(字节);超限整计划拒绝 */
    maxBytesPerVolume: number;
    /** 覆盖某卷的 staging 根(如把 C 卷 staging 放到别处);null = 用默认卷根 */
    volumeOverride: Record<string, string>;
  };
  undo: {
    /** 撤销记录目录 */
    dir: string;
  };
}

export function defaultConfig(): DiskJanitorConfig {
  const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
  return {
    staging: {
      dirName: 'DiskJanitorStaging',
      maxBytesPerVolume: 20 * 1024 ** 3, // 20 GB
      volumeOverride: {},
    },
    undo: {
      dir: path.join(appData, 'DiskJanitor', 'undo'),
    },
  };
}

export function userConfigPath(): string {
  const appData = process.env.APPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
  return path.join(appData, 'DiskJanitor', 'config.json');
}

/** 读默认配置 + 可选用户覆盖(仅浅合并 top-level 两节;字段缺失沿用默认) */
export async function loadConfig(): Promise<{ config: DiskJanitorConfig; userConfigFile: string | null }> {
  const base = defaultConfig();
  const p = userConfigPath();
  try {
    const raw = JSON.parse(await fs.readFile(p, 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      if (raw.staging && typeof raw.staging === 'object') {
        const s = raw.staging as Record<string, unknown>;
        if (typeof s.dirName === 'string' && s.dirName) base.staging.dirName = s.dirName;
        if (typeof s.maxBytesPerVolume === 'number' && s.maxBytesPerVolume > 0) base.staging.maxBytesPerVolume = s.maxBytesPerVolume;
        if (s.volumeOverride && typeof s.volumeOverride === 'object') {
          base.staging.volumeOverride = raw.staging.volumeOverride as Record<string, string>;
        }
      }
      if (raw.undo && typeof raw.undo === 'object' && typeof (raw.undo as Record<string, unknown>).dir === 'string') {
        base.undo.dir = (raw.undo as { dir: string }).dir;
      }
    }
    return { config: base, userConfigFile: p };
  } catch {
    return { config: base, userConfigFile: null }; // 无用户配置是常态
  }
}

/** 给定绝对路径,推导其所在卷的 staging 根(尊重 volumeOverride) */
export function stagingRootFor(targetPath: string, cfg: DiskJanitorConfig): string {
  const norm = targetPath.replaceAll('/', '\\');
  const drive = (norm.match(/^([A-Za-z]):/) ?? [])[1]?.toUpperCase() ?? 'C';
  const override = cfg.staging.volumeOverride[drive];
  if (override) return override.replaceAll('\\', '/');
  return `${drive}:/${cfg.staging.dirName}`;
}
