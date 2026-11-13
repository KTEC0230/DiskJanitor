// ManifestUndoManager:撤销记录持久化到 %APPDATA%\DiskJanitor\undo\<id>.json。
// 硬约束:begin 在执行器动文件系统【之前】落盘;撤销接口与执行接口对称;跨重启可撤销。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import type { DeletionPlan, UndoEntry, UndoRecord, UndoReceipt } from './types.ts';

export interface ManifestUndoManagerOptions {
  undoDir: string;
  /** 给定目标路径,返回其所属卷的 staging 根(stage 模式分配 stagedPath 用) */
  stagingRootFor: (targetPath: string) => string;
}

/** UndoManager:与执行通道对称的撤销接口(stage=确定性恢复;recycle=Shell 尽力而为) */
export interface UndoManager {
  /** 执行器动文件系统【之前】调用:生成撤销记录并持久化 */
  begin(plan: DeletionPlan, mode: 'recycle' | 'stage'): Promise<UndoRecord>;
  /** 执行器成功后调用:标记记录为可撤销终态 */
  commit(record: UndoRecord): Promise<void>;
  /** 撤销:按记录把条目移回原位(recycle 模式 = 系统回收站恢复) */
  undo(undoRecordId: string): Promise<UndoReceipt>;
  /** 永久删除一个已提交批次:删 staging 批次目录(recycle 批次仅标记,文件由系统回收站管理)、审计留痕、状态置 purged。
   *  这是"删除必可逆"原则中唯一放弃撤销权的显式路径。 */
  purgeBatch(undoRecordId: string, auditLogPath?: string): Promise<{ freedBytes: number; failures: string[] }>;
  /** 列出所有可撤销记录(跨重启) */
  list(): Promise<UndoRecord[]>;
}

interface UndoManagerDeps {
  undoDir: string;
  stagingRootFor: (targetPath: string) => string;
}

function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

function runPowerShell(scriptFile: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile], {
      windowsHide: true,
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || stdout) resolve(stdout + (stderr ? `\nSTDERR:${stderr}` : ''));
      else reject(new Error(`powershell exit ${code}: ${stderr || 'no output'}`));
    });
  });
}

function psQuote(s: string): string {
  return "'" + s.replace(/'/g, "''") + "'";
}

async function writePsScript(lines: string[]): Promise<string> {
  const file = path.join(os.tmpdir(), `dj-ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  // UTF-8 BOM:Windows PowerShell 5.1 无 BOM 会按 ANSI 读,CJK 会坏
  await fs.writeFile(file, '\ufeff' + lines.join('\n'), 'utf8');
  return file;
}

export class ManifestUndoManager implements UndoManager {
  private readonly deps: UndoManagerDeps;

  constructor(opts: ManifestUndoManagerOptions) {
    this.deps = { undoDir: opts.undoDir, stagingRootFor: opts.stagingRootFor };
  }

  private recordFile(id: string): string {
    return path.join(this.deps.undoDir, `${id}.json`);
  }

  async begin(plan: DeletionPlan, mode: 'recycle' | 'stage'): Promise<UndoRecord> {
    await fs.mkdir(this.deps.undoDir, { recursive: true });
    const actionable = plan.items.filter(i => !i.blocked && (i.action === 'recycle' || i.action === 'stage'));
    const recordId = `undo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entries: UndoEntry[] = actionable.map((it, idx) => ({
      originalPath: it.entry.path,
      stagedPath: mode === 'stage'
        ? `${this.deps.stagingRootFor(it.entry.path)}/${plan.id}/${String(idx).padStart(4, '0')}_${sanitizeName(it.entry.name)}`
        : null,
      sizeBytes: it.entry.sizeBytes,
      mtimeMs: it.entry.mtimeMs,
      deletedAt: new Date().toISOString(),
      status: 'pending' as const,
    }));
    const record: UndoRecord = {
      id: recordId,
      planId: plan.id,
      mode,
      createdAt: new Date().toISOString(),
      status: 'pending',
      entries,
    };
    await fs.writeFile(this.recordFile(recordId), JSON.stringify(record, null, 2), 'utf8');
    return record;
  }

  /** 执行器在移动完成后调用:回写逐条目状态并置 committed */
  async commit(record: UndoRecord): Promise<void> {
    record.status = 'committed';
    await fs.writeFile(this.recordFile(record.id), JSON.stringify(record, null, 2), 'utf8');
  }

  async list(): Promise<UndoRecord[]> {
    let names: string[] = [];
    try {
      names = (await fs.readdir(this.deps.undoDir)).filter(n => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: UndoRecord[] = [];
    for (const n of names) {
      try {
        const raw = JSON.parse(await fs.readFile(path.join(this.deps.undoDir, n), 'utf8'));
        if (raw && typeof raw.id === 'string') out.push(raw as UndoRecord);
      } catch { /* 单条损坏不阻塞列表 */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 永久删除批次:独立于撤销通道;仅 committed 可清;写 PERMANENT 审计 */
  async purgeBatch(undoRecordId: string, auditLogPath?: string): Promise<{ freedBytes: number; failures: string[] }> {
    if (!undoRecordId) throw new Error('撤销 id 为空');
    const file = this.recordFile(undoRecordId);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as UndoRecord;
    if (record.status !== 'committed') {
      throw new Error(`批次 ${undoRecordId} 状态为 ${record.status},不可永久删除(仅 committed 可清)`);
    }
    const failures: string[] = [];
    let freedBytes = 0;

    if (record.mode === 'stage') {
      const batchDirs = new Set<string>();
      for (const e of record.entries as UndoEntry[]) {
        if (e.status !== 'moved' || !e.stagedPath) continue;
        batchDirs.add(path.dirname(e.stagedPath));
        freedBytes += e.sizeBytes;
      }
      for (const d of batchDirs) {
        try {
          await fs.rm(d, { recursive: true, force: false, maxRetries: 2 });
        } catch (err) {
          failures.push(`${d}: ${(err as Error).message}`);
        }
      }
      // 只删批次层目录;staging 根永远保留(下一次清理还要用)
    }
    // recycle 批次:文件在系统回收站,本应用不代管;purge 仅放弃跟踪(用户清空回收站即最终删除)

    record.status = 'purged';
    for (const e of record.entries as UndoEntry[]) {
      if (e.status === 'moved') e.status = 'purged';
    }
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');

    if (auditLogPath) {
      try {
        await fs.mkdir(path.dirname(auditLogPath), { recursive: true });
        await fs.appendFile(
          auditLogPath,
          `${new Date().toISOString()}\tPERMANENT\tPURGE\tundo=${undoRecordId}\tmode=${record.mode}\tfreed=${freedBytes}\t${failures.length} failures\n`,
          'utf8',
        );
      } catch { /* 审计失败不阻塞 */ }
    }
    return { freedBytes, failures };
  }

  async undo(undoRecordId: string): Promise<UndoReceipt> {
    if (!undoRecordId) throw new Error('撤销 id 为空(无可撤销项)');
    const file = this.recordFile(undoRecordId);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as UndoRecord;
    if (record.status !== 'committed') {
      throw new Error(`撤销记录 ${undoRecordId} 状态为 ${record.status},不可撤销(仅 committed 可撤销)`);
    }
    const failures: string[] = [];
    let restored = 0;

    if (record.mode === 'stage') {
      for (const e of record.entries as UndoEntry[]) {
        if (e.status !== 'moved') continue;
        try {
          const parent = path.dirname(e.originalPath);
          await fs.mkdir(parent, { recursive: true });
          let dest = e.originalPath;
          try {
            await fs.access(dest);
            dest = `${e.originalPath}.janitor-restored-${Date.now().toString(36)}`; // 不覆盖任何现存文件
          } catch { /* 原位为空,正常 */ }
          await fs.rename(e.stagedPath as string, dest);
          e.status = 'restored';
          restored++;
        } catch (err) {
          e.status = 'restore-failed';
          failures.push(`${e.originalPath}: ${(err as Error).message}`);
        }
      }
    } else {
      // recycle 模式:先跳过"原位已存在"的(避免 Shell 还原弹碰撞对话框),其余经 Shell 还原
      // 匹配键 = 父目录 + 条目名(System.Recycle.DeletedFrom 记录的是父目录,非被删项自身路径)
      const want = new Map<string, UndoEntry>();
      for (const e of record.entries as UndoEntry[]) {
        if (e.status !== 'moved') continue;
        try {
          await fs.access(e.originalPath);
          e.status = 'restore-skipped';
          failures.push(`${e.originalPath}: 目标已存在,为避免覆盖未执行 Shell 还原`);
        } catch {
          const slash = e.originalPath.lastIndexOf('/');
          const dir = (slash > 0 ? e.originalPath.slice(0, slash) : e.originalPath).toLowerCase();
          const name = e.originalPath.slice(slash + 1).toLowerCase();
          want.set(`${dir}/${name}`, e);
        }
      }
      if (want.size > 0) restored += await this.restoreFromRecycleBin(want, failures);
    }

    record.status = 'undone';
    // 清理空批次目录(stage 模式)
    if (record.mode === 'stage') {
      const batchDirs = new Set<string>();
      for (const e of record.entries as UndoEntry[]) {
        if (e.stagedPath) batchDirs.add(path.dirname(e.stagedPath));
      }
      for (const d of batchDirs) {
        try { await fs.rmdir(d); } catch { /* 非空则保留 */ }
      }
    }
    await fs.writeFile(file, JSON.stringify(record, null, 2), 'utf8');
    return { undoId: undoRecordId, restoredItems: restored, failures };
  }

  /** 经 Windows Shell 从回收站还原:按 System.Recycle.DeletedFrom 匹配,动词匹配 还原/restore */
  private async restoreFromRecycleBin(want: Map<string, UndoEntry>, failures: string[]): Promise<number> {
    const lines: string[] = [
      "$ErrorActionPreference='Continue'",
      "$shell = New-Object -ComObject Shell.Application",
      "$rb = $shell.NameSpace(10)",
      "$want = @{" + [...want.keys()].map(k => `${psQuote(k)}=$true`).join(';') + "}",
      "$used = @{}",
      "foreach ($item in @($rb.Items())) {",
      "  $from = $null",
      "  try { $from = $item.ExtendedProperty('System.Recycle.DeletedFrom') } catch {}",
      "  if (-not $from) { continue }",
      "  $key = ($from.Replace('\\','/').ToLower().TrimEnd('/')) + '/' + $item.Name.ToLower()",
      "  if (-not $want.ContainsKey($key)) { continue }",
      "  if ($used.ContainsKey($key)) { continue }",
      "  $verb = $null",
      "  foreach ($v in $item.Verbs()) {",
      "    if ($v.Name -match '还原|restore|Restore') { $verb = $v; break }",
      "  }",
      "  if ($verb) {",
      "    try { $verb.DoIt(); Write-Output (\"OK`t\" + $key) ; $used[$key] = $true }",
      "    catch { Write-Output (\"FAIL`t\" + $key + \"`t\" + $_.Exception.Message) }",
      "  } else {",
      "    Write-Output (\"FAIL`t\" + $key + \"`tno restore verb\")",
      "  }",
      "}",
    ];
    const script = await writePsScript(lines);
    try {
      const out = await runPowerShell(script, 180_000);
      let ok = 0;
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^(OK|FAIL)\t(.+?)(?:\t(.*))?$/);
        if (!m) continue;
        const e = want.get(m[2].toLowerCase());
        if (!e) continue;
        if (m[1] === 'OK') {
          e.status = 'restored';
          ok++;
        } else {
          e.status = 'restore-failed';
          failures.push(`${e.originalPath}: Shell 还原失败: ${m[3] ?? 'unknown'}`);
        }
      }
      // 逐条复核确实回到原位
      for (const e of want.values()) {
        if (e.status !== 'restored') continue;
        try { await fs.access(e.originalPath); } catch {
          e.status = 'restore-failed';
          failures.push(`${e.originalPath}: Shell 报告成功但原位未出现文件`);
          ok--;
        }
      }
      return ok;
    } finally {
      fs.unlink(script).catch(() => {});
    }
  }
}

export type { UndoManagerDeps };
