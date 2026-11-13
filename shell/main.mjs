// DiskJanitor Electron 主进程:承载 core(唯一持有写权限的进程),渲染层仅经 contextBridge 通信。
// 安全基线:contextIsolation=true, nodeIntegration=false。

import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { existsSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as core from './core.mjs';

const shellDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(shellDir, '..');

let win = null;
// 最近一次扫描的行数据:path -> { entry, assessment }(执行层需要 FsEntry 对象)
let rowMap = new Map();
// 当前扫描的暂停/停止控制器(同时只允许一个活动扫描)
let scanController = null;
// 最近一次扫描的元信息(报告导出用)
let lastScan = null;

// ---------- 自保护与固定盘(吃自己狗粮:应用自身、staging、undo、配置绝不进清理计划) ----------

function fixedDrives() {
  const out = [];
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i);
    try {
      // existsSync 对不存在的盘根返回 false(不抛异常),必须显式判真
      if (existsSync(`${d}:\\`)) out.push(d);
    } catch { /* 无此盘 */ }
  }
  return out;
}

function stagingRootsAll(cfg) {
  const roots = [];
  for (const d of fixedDrives()) {
    const override = cfg.staging.volumeOverride[d];
    roots.push(override ? override.replaceAll('\\', '/') : `${d}:/${cfg.staging.dirName}`);
  }
  return roots;
}

async function selfProtectedPaths() {
  const list = [];
  try {
    list.push(path.dirname(app.getPath('exe')).replaceAll('\\', '/'));
  } catch { /* 打包前开发态也能取到 */ }
  const { config } = await core.loadConfig();
  list.push(config.undo.dir.replaceAll('\\', '/'));
  const appDataDir = (process.env.APPDATA ?? '').replaceAll('\\', '/');
  if (appDataDir) list.push(`${appDataDir}/diskjanitor`);
  for (const r of stagingRootsAll(config)) list.push(r.replaceAll('\\', '/').toLowerCase());
  return list;
}

async function precreateStaging() {
  const log = [];
  try {
    const { config } = await core.loadConfig();
    const drives = fixedDrives();
    log.push(`fixedDrives=${drives.join(',')}`);
    for (const d of drives) {
      const root = `${d}:\\${config.staging.dirName}`;
      await fs.mkdir(root, { recursive: true });
      const { spawn } = await import('node:child_process');
      spawn('attrib', ['+h', root], { windowsHide: true, timeout: 10_000 }).on('error', () => {});
      log.push(`staging ok: ${root}`);
    }
  } catch (err) {
    log.push(`precreateStaging ERROR: ${err.stack ?? err.message}`);
  } finally {
    await writeMainLog(log);
  }
}

/** 主进程诊断日志(%APPDATA%\DiskJanitor\main.log)——启动期异常唯一可观察点 */
async function writeMainLog(lines) {
  try {
    const { config } = await core.loadConfig();
    const dir = path.dirname(config.undo.dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(path.join(dir, 'main.log'), `[${new Date().toISOString()}] ${lines.join(' | ')}\n`, 'utf8');
  } catch { /* 日志失败静默 */ }
}

function row(entry, assessment) {
  return {
    path: entry.path, name: entry.name, kind: entry.kind,
    sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs, depth: entry.depth,
    flags: entry.flags,
    assessment: {
      riskLevel: assessment.riskLevel,
      reversibility: assessment.reversibility,
      rationale: assessment.rationale,
      suggestedAction: assessment.suggestedAction,
      ruleId: assessment.ruleId,
      defaultChecked: assessment.defaultChecked,
    },
  };
}

async function assessAll(entries, pack) {
  const out = new Map();
  for (const e of entries) out.set(e.path, core.assessEntry(e, pack));
  return out;
}

async function ensurePack() {
  const packRes = await core.loadPackWithOverlay(path.join(projectRoot, 'rules', 'default-rules.json'));
  if (!packRes.ok) throw new Error('规则包/overlay 校验失败: ' + packRes.errors.join('; '));
  return packRes;
}

async function makeDeps(pack, { config } = {}) {
  const cfg = config ?? (await core.loadConfig()).config;
  const selfProt = await selfProtectedPaths();
  return {
    undo: new core.ManifestUndoManager({ undoDir: cfg.undo.dir, stagingRootFor: p => core.stagingRootFor(p, cfg) }),
    userProtectedPaths: [...pack.protected_paths, ...selfProt],
    stagingRootFor: p => core.stagingRootFor(p, cfg),
    stagingMaxBytesPerVolume: cfg.staging.maxBytesPerVolume,
  };
}

function entriesForPaths(paths) {
  const entries = [];
  for (const p of paths) {
    const rec = rowMap.get(p);
    if (rec) entries.push(rec.entry);
  }
  return entries;
}

function registerIpc() {
  ipcMain.handle('dj:pick-directory', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dj:scan', async (_e, { root, maxDepth = 3 }) => {
    const packRes = await ensurePack();
    const pack = packRes.pack;
    scanController = { paused: false, cancelled: false };
    try {
      const snapshot = await core.scan(root, {
        maxDepth,
        concurrency: 32,
        controller: scanController,
        onProgress: (bytes, p) => {
          if (win && !win.isDestroyed()) win.webContents.send('dj:scan-progress', { bytes, path: p, root });
        },
      });
      rowMap = new Map();
      const assessments = await assessAll(snapshot.entries, pack);
      const rows = [];
      for (const e of snapshot.entries) {
        const a = assessments.get(e.path);
        rowMap.set(e.path, { entry: e, assessment: a });
        rows.push(row(e, a));
      }
      lastScan = { root: snapshot.root, createdAt: snapshot.createdAt, totals: snapshot.totals, cancelled: snapshot.cancelled };
      return {
        snapshot: { id: snapshot.id, root: snapshot.root, totals: snapshot.totals, createdAt: snapshot.createdAt, cancelled: snapshot.cancelled },
        rows,
        overlayApplied: packRes.applied,
        totalsByCategory: categorize(rows),
      };
    } finally {
      scanController = null;
    }
  });

  ipcMain.handle('dj:export-report', async (_e, { outDir }) => {
    if (scanController) throw new Error('扫描进行中,请等待完成或停止后再导出(当前数据是半成品)');
    if (!lastScan) throw new Error('尚无扫描结果,请先扫描');
    const rows = [...rowMap.values()].map(({ entry, assessment }) => ({
      path: entry.path, name: entry.name, kind: entry.kind,
      sizeBytes: entry.sizeBytes, depth: entry.depth,
      ruleId: assessment.ruleId, riskLevel: assessment.riskLevel,
      reversibility: assessment.reversibility, suggestedAction: assessment.suggestedAction,
      defaultChecked: assessment.defaultChecked, rationale: assessment.rationale,
    }));
    return await core.writeScanReport({
      outDir, root: lastScan.root, createdAt: lastScan.createdAt,
      totals: lastScan.totals, cancelled: !!lastScan.cancelled,
      appVersion: app.getVersion(),
    }, rows);
  });

  ipcMain.handle('dj:reveal', async (_e, { p }) => {
    const winPath = p.replaceAll('/', '\\');
    try {
      if (existsSync(winPath) && statSync(winPath).isFile()) {
        spawn('explorer', ['/select,', winPath], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('explorer', [winPath], { detached: true, stdio: 'ignore' }).unref();
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message ?? err) };
    }
  });

  ipcMain.handle('dj:scan-pause', async () => { if (scanController) scanController.paused = true; return { paused: true }; });
  ipcMain.handle('dj:scan-resume', async () => { if (scanController) scanController.paused = false; return { paused: false }; });
  ipcMain.handle('dj:scan-cancel', async () => { if (scanController) scanController.cancelled = true; return { cancelled: true }; });

  // ---------- 暂存区管理(永久删除) ----------
  ipcMain.handle('dj:staging-usage', async () => {
    const { config } = await core.loadConfig();
    const roots = stagingRootsAll(config);
    const out = [];
    for (const r of roots) {
      out.push({ root: r, bytes: await core.dirUsageBytes(r).catch(() => 0) });
    }
    return out;
  });

  ipcMain.handle('dj:purge-batch', async (_e, { id }) => {
    const { config } = await core.loadConfig();
    const undo = new core.ManifestUndoManager({ undoDir: config.undo.dir, stagingRootFor: p => core.stagingRootFor(p, config) });
    return await undo.purgeBatch(id, path.join(path.dirname(config.undo.dir), 'audit.log'));
  });

  ipcMain.handle('dj:purge-all', async () => {
    const { config } = await core.loadConfig();
    const undo = new core.ManifestUndoManager({ undoDir: config.undo.dir, stagingRootFor: p => core.stagingRootFor(p, config) });
    const records = await undo.list();
    let freedBytes = 0;
    const failures = [];
    let count = 0;
    for (const r of records) {
      if (r.status !== 'committed' || r.mode !== 'stage') continue;
      try {
        const res = await undo.purgeBatch(r.id, path.join(path.dirname(config.undo.dir), 'audit.log'));
        freedBytes += res.freedBytes;
        count++;
        failures.push(...res.failures);
      } catch (err) {
        failures.push(`${r.id}: ${err.message ?? err}`);
      }
    }
    return { freedBytes, failures, count };
  });

  ipcMain.handle('dj:expand', async (_e, { dirPath, maxDepth = 2 }) => {
    const packRes = await ensurePack();
    const pack = packRes.pack;
    const sub = await core.scan(dirPath, { maxDepth });
    const fresh = [];
    const assessments = await assessAll(sub.entries, pack);
    for (const e of sub.entries) {
      if (e.depth === 0) continue;
      if (rowMap.has(e.path)) continue;
      const a = assessments.get(e.path);
      rowMap.set(e.path, { entry: e, assessment: a });
      fresh.push(row(e, a));
    }
    return { rows: fresh };
  });

  ipcMain.handle('dj:plan', async (_e, { paths, mode = 'stage' }) => {
    const packRes = await ensurePack();
    const selfProt = await selfProtectedPaths();
    const entries = entriesForPaths(paths);
    const assessments = new Map(entries.map(en => [en.path, rowMap.get(en.path).assessment]));
    const plan = core.buildPlan(entries, assessments, { dryRun: true, userProtectedPaths: [...packRes.pack.protected_paths, ...selfProt], channel: mode });
    return { summaryText: plan.summaryText, totals: plan.totals };
  });

  ipcMain.handle('dj:execute', async (_e, { paths, mode = 'stage' }) => {
    const packRes = await ensurePack();
    const selfProt = await selfProtectedPaths();
    const entries = entriesForPaths(paths);
    const assessments = new Map(entries.map(en => [en.path, rowMap.get(en.path).assessment]));
    const plan = core.buildPlan(entries, assessments, { dryRun: false, userProtectedPaths: [...packRes.pack.protected_paths, ...selfProt], channel: mode });
    const deps = await makeDeps(packRes.pack);
    const executor = mode === 'recycle' ? new core.RecycleBinExecutor(deps) : new core.StagingExecutor(deps);
    const receipt = await executor.execute(plan, mode);
    return { summaryText: plan.summaryText, receipt };
  });

  ipcMain.handle('dj:undo-list', async () => {
    const { config } = await core.loadConfig();
    const undo = new core.ManifestUndoManager({ undoDir: config.undo.dir, stagingRootFor: p => core.stagingRootFor(p, config) });
    const records = await undo.list();
    return records.map(r => ({
      id: r.id, planId: r.planId, mode: r.mode, status: r.status, createdAt: r.createdAt,
      movable: r.entries.filter(e => e.status === 'moved').length,
      movableBytes: r.entries.filter(e => e.status === 'moved').reduce((s, e) => s + e.sizeBytes, 0),
    }));
  });

  ipcMain.handle('dj:undo', async (_e, { id }) => {
    const { config } = await core.loadConfig();
    const undo = new core.ManifestUndoManager({ undoDir: config.undo.dir, stagingRootFor: p => core.stagingRootFor(p, config) });
    return undo.undo(id);
  });

  ipcMain.handle('dj:overlay-load', async () => {
    const p = core.overlayPath();
    let text = '';
    try { text = await fs.readFile(p, 'utf8'); } catch { text = '# 尚无 overlay;语法示例见注释模板\n'; }
    const res = await core.loadPackWithOverlay(path.join(projectRoot, 'rules', 'default-rules.json'));
    return { path: p, text, valid: res.ok, errors: res.ok ? [] : res.errors, applied: res.ok ? res.applied : [] };
  });

  ipcMain.handle('dj:overlay-save', async (_e, { text }) => {
    const p = core.overlayPath();
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, text, 'utf8');
    const res = await core.loadPackWithOverlay(path.join(projectRoot, 'rules', 'default-rules.json'));
    return { valid: res.ok, errors: res.ok ? [] : res.errors, applied: res.ok ? res.applied : [] };
  });
}

function categorize(rows) {
  const c = { actionable: 0, skipped: 0, blocked: 0, unknown: 0 };
  for (const r of rows) {
    const a = r.assessment;
    if (a.riskLevel === null) continue;
    if (a.ruleId === null) c.unknown++;
    else if (a.suggestedAction === 'skip') c.skipped++;
    else c.actionable++;
  }
  return c;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860,
    title: '磁盘清道夫 DiskJanitor',
    icon: path.join(projectRoot, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(shellDir, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // 渲染层 console/异常转发到 main.log(打包后 DevTools 不可用时的唯一观察点)
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    try {
      fs.appendFile(path.join(path.dirname(core.defaultConfig().undo.dir), 'main.log'),
        `[renderer:${level}] ${message} (${String(sourceId).split(/[\\/]/).pop()}:${line})\n`, 'utf8').catch(() => {});
    } catch { /* 静默 */ }
  });
  // DOM 探针:定位"面板空白但函数执行完成"类问题
  setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.webContents.executeJavaScript(
        'JSON.stringify({dj:typeof window.dj,undoKids:document.getElementById("undoRoot")?.childElementCount,undoHidden:document.getElementById("tab-undo")?document.getElementById("tab-undo").className:"?",view:window.state?.viewMode})'
      ).then(s => fs.appendFile(path.join(path.dirname(core.defaultConfig().undo.dir), 'main.log'),
        `[dom] ${s}\n`, 'utf8').catch(() => {})).catch(() => {});
    }
  }, 8000);
  win.loadFile(path.join(shellDir, 'renderer', 'index.html'));
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    registerIpc();
    precreateStaging();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
app.on('window-all-closed', () => { app.quit(); });
