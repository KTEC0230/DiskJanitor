// 自检:磁盘清道夫 M2 全链路验证。全部发生在 Temp 下的隔离目录,不碰真实数据。
// 覆盖:stage→undo 往返(含 CJK/嵌套)、recycle→undo(Shell 还原)、永久删除(独立类+审计)、
//       容量拒绝、执行层保护拦截(绕过 Planner 的伪造计划)、staging 跨重启撤销(重建 manager)。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scan } from '../core/src/scanner.ts';
import { assessEntry } from '../core/src/risk-engine.ts';
import { buildPlan } from '../core/src/planner.ts';
import { loadPackWithOverlay } from '../core/src/rules-overlay.ts';
import { ManifestUndoManager } from '../core/src/undo-manager.ts';
import { writeScanReport } from '../core/src/report.ts';
import { StagingExecutor, RecycleBinExecutor, PermanentDeletionExecutor } from '../core/src/executor.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchRoot = path.join(os.tmpdir(), `dj-selftest-${Date.now().toString(36)}`);
const stagingRoot = path.join(scratchRoot, 'staging');
const undoDir = path.join(scratchRoot, 'undo');
// 审计文件放场地外(真实应用放 %APPDATA%;若与删除目标同树,INTENT 行仍会留下)
const auditPath = scratchRoot + '.audit.log';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ' —— ' + detail : ''}`); }
}

function deps(overrides = {}) {
  return {
    undo: new ManifestUndoManager({ undoDir, stagingRootFor: () => stagingRoot }),
    userProtectedPaths: [],
    stagingRootFor: () => stagingRoot,
    stagingMaxBytesPerVolume: 1024 ** 3, // 1 GB
    ...overrides,
  };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function mkAssessment(target, overrides = {}) {
  return {
    target, riskLevel: 'low', reversibility: 'regenerable',
    rationale: 'selftest', suggestedAction: 'recycle', ruleId: 'selftest',
    aiGenerated: false, defaultChecked: true, ...overrides,
  };
}

async function main() {
  console.log(`自检目录: ${scratchRoot}`);
  const packRes = await loadPackWithOverlay(path.join(projectRoot, 'rules', 'default-rules.json'));
  if (!packRes.ok) {
    console.error('规则包校验失败:', packRes.errors);
    process.exit(2);
  }
  const pack = packRes.pack;

  // ---------- 0. 场地 ----------
  const nmDir = path.join(scratchRoot, 'project', 'node_modules');
  const cnDir = path.join(nmDir, '中文包');
  await fs.mkdir(cnDir, { recursive: true });
  await fs.mkdir(path.join(scratchRoot, 'project', '__pycache__'), { recursive: true });
  await fs.writeFile(path.join(nmDir, 'index.js'), 'x'.repeat(100));
  await fs.writeFile(path.join(cnDir, '中文.js'), 'y'.repeat(50));
  await fs.writeFile(path.join(scratchRoot, 'project', '__pycache__', 'm.pyc'), 'p'.repeat(10));
  const permFile = path.join(scratchRoot, 'perm-target.txt');
  await fs.writeFile(permFile, 'z'.repeat(30));

  // ---------- 0.5 尺寸正确性(防双计回归) ----------
  console.log('\n[0.5] 目录尺寸无双计');
  {
    const snap = await scan(scratchRoot, { maxDepth: 4 });
    const proj = snap.entries.find(e => e.name === 'project' && e.depth === 1);
    // project = node_modules(100+50) + __pycache__(10) = 160
    check('目录尺寸 = 文件实际累计(160B)', proj.sizeBytes === 160, `实际 ${proj.sizeBytes}`);
    const nm = snap.entries.find(e => e.name === 'node_modules');
    check('叶子目录无翻倍(150B)', nm.sizeBytes === 150, `实际 ${nm.sizeBytes}`);
    check('快照总量一致', snap.totals.bytes === 160 + 30, `实际 ${snap.totals.bytes}`);
  }

  // ---------- 1. stage → undo 往返(含 CJK、跨重启) ----------
  console.log('\n[1] stage → undo 往返');
  {
    const snapshot = await scan(scratchRoot, { maxDepth: 4 });
    const assessments = new Map();
    for (const e of snapshot.entries) if (e.depth >= 1) assessments.set(e.path, assessEntry(e, pack));
    const selected = snapshot.entries.filter(e => assessments.get(e.path)?.defaultChecked === true);
    const plan = buildPlan(selected, assessments, { dryRun: false, userProtectedPaths: [] });
    // __pycache__ 规则=recycle,stage 通道只处理 stage 项(node_modules);
    // 为验证 stage 能力,补一条针对 scratch 的 stage 裁定
    const nmEntry = snapshot.entries.find(e => e.path.replaceAll('\\', '/').endsWith('project/node_modules'));
    assessments.set(nmEntry.path, mkAssessment(nmEntry.path, { suggestedAction: 'stage', ruleId: 'selftest-stage' }));
    const plan2 = buildPlan([nmEntry], assessments, { dryRun: false, userProtectedPaths: [] });

    const exec = new StagingExecutor(deps());
    const receipt = await exec.execute(plan2, 'stage');
    check('stage 移动 1 项', receipt.movedItems === 1, JSON.stringify(receipt));
    check('原位已空', !(await exists(nmDir)));
    const stagedSnap = await scan(stagingRoot, { maxDepth: 4 });
    check('staging 出现批次目录', stagedSnap.entries.some(e => e.kind === 'dir' && e.name === plan2.id));

    // 跨重启:重建 manager,仅凭记录文件撤销
    const undo2 = new ManifestUndoManager({ undoDir, stagingRootFor: () => stagingRoot });
    const list = await undo2.list();
    check('撤销记录持久化', list.length === 1 && list[0].status === 'committed');
    const u = await undo2.undo(receipt.undoRecordId);
    check('undo 恢复 1 项', u.restoredItems === 1, JSON.stringify(u));
    check('node_modules 回到原位', await exists(path.join(nmDir, 'index.js')));
    check('CJK 文件完好', (await fs.readFile(path.join(cnDir, '中文.js'), 'utf8')).length === 50);
    const after = await scan(stagingRoot, { maxDepth: 4 });
    check('staging 批次目录已清理', !after.entries.some(e => e.depth === 1));
  }

  // ---------- 2. recycle → undo(Shell 还原) ----------
  console.log('\n[2] recycle → undo(Shell 还原,尽力而为)');
  let recycleUndoId = null, pycache = null;
  {
    const snapshot = await scan(scratchRoot, { maxDepth: 4 });
    const pycEntry = snapshot.entries.find(e => e.path.replaceAll('\\', '/').endsWith('project/__pycache__'));
    pycache = pycEntry;
    const assessments = new Map([[pycEntry.path, mkAssessment(pycEntry.path, { suggestedAction: 'recycle' })]]);
    const plan = buildPlan([pycEntry], assessments, { dryRun: false, userProtectedPaths: [], channel: 'recycle' });
    const exec = new RecycleBinExecutor(deps());
    const receipt = await exec.execute(plan, 'recycle');
    check('recycle 移动 1 项', receipt.movedItems === 1, JSON.stringify(receipt));
    check('原位已空', !(await exists(pycEntry.path)));
    recycleUndoId = receipt.undoRecordId;
    const u = await new ManifestUndoManager({ undoDir, stagingRootFor: () => stagingRoot }).undo(recycleUndoId);
    check('Shell 还原 1 项', u.restoredItems === 1, JSON.stringify(u));
    check('__pycache__ 回到原位', await exists(pycEntry.path));
  }

  // ---------- 3. 永久删除(独立类 + 审计) ----------
  console.log('\n[3] 永久删除独立类');
  {
    const snapshot = await scan(scratchRoot, { maxDepth: 4 });
    const e = snapshot.entries.find(x => x.path.replaceAll('\\', '/').endsWith('perm-target.txt'));
    const assessments = new Map([[e.path, mkAssessment(e.path, { suggestedAction: 'recycle' })]]);
    const plan = buildPlan([e], assessments, { dryRun: false, userProtectedPaths: [] });
    const exec = new PermanentDeletionExecutor({ userProtectedPaths: [], auditLogPath: auditPath });

    // 类型层强制:伪造非 true 确认在运行时也要被拒
    let rejected = false;
    try { await exec.executePermanent({ plan, confirmed_permanent: false }); } catch { rejected = true; }
    check('缺确认即拒绝', rejected);

    const receipt = await exec.executePermanent({ plan, confirmed_permanent: true });
    check('永久删除 1 项', receipt.movedItems === 1 && receipt.mode === 'permanent');
    check('文件已消失', !(await exists(permFile)));
    const audit = await fs.readFile(auditPath, 'utf8');
    check('审计留痕', audit.includes('PERMANENT') && audit.includes('perm-target.txt'));
  }

  // ---------- 4. 容量拒绝(all-or-nothing) ----------
  console.log('\n[4] staging 容量拒绝');
  {
    const snapshot = await scan(scratchRoot, { maxDepth: 4 });
    const nmEntry = snapshot.entries.find(x => x.path.replaceAll('\\', '/').endsWith('project/node_modules'));
    const assessments = new Map([[nmEntry.path, mkAssessment(nmEntry.path, { suggestedAction: 'stage' })]]);
    const plan = buildPlan([nmEntry], assessments, { dryRun: false, userProtectedPaths: [] });
    const tiny = new StagingExecutor(deps({ stagingMaxBytesPerVolume: 1 }));
    let refused = false;
    try { await tiny.execute(plan, 'stage'); } catch (err) {
      refused = err.name === 'StagingCapacityError';
    }
    check('超限整计划拒绝', refused);
    check('拒绝时原位未动', await exists(path.join(nmDir, 'index.js')));
    const list = await new ManifestUndoManager({ undoDir, stagingRootFor: () => stagingRoot }).list();
    check('拒绝时不产生撤销记录', list.every(r => r.planId !== plan.id), JSON.stringify(list.map(r => r.planId)));
  }

  // ---------- 5. 执行层保护拦截(伪造计划,绕过 Planner) ----------
  console.log('\n[5] 执行层保护拦截(不信任上游)');
  {
    const fakeEntry = Object.freeze({ path: 'C:/Windows/notepad.exe', name: 'notepad.exe', kind: 'file', sizeBytes: 1, mtimeMs: 0, depth: 1, flags: { isSymlink: false, isReparsePoint: false, isHidden: false } });
    const assessments = new Map([[fakeEntry.path, mkAssessment(fakeEntry.path)]]);
    const plan = buildPlan([fakeEntry], assessments, { dryRun: false, userProtectedPaths: [] });
    check('Planner 层已拦截', plan.items[0].blocked === true);

    // 绕过 Planner:手工伪造 blocked=false 的计划,执行层必须兜住
    const forged = Object.freeze({
      id: 'forged-plan', createdAt: new Date().toISOString(), dryRun: false,
      items: [Object.freeze({ entry: fakeEntry, assessment: assessments.get(fakeEntry.path), action: 'stage', blocked: false, blockReason: null })],
      totals: { recycleItems: 0, recycleBytes: 0, stageItems: 1, stageBytes: 1, blockedItems: 0, skippedItems: 0 },
      summaryText: '伪造计划',
    });
    let blocked = false;
    try { await new StagingExecutor(deps()).execute(forged, 'stage'); } catch (err) {
      blocked = err.name === 'BlockedPathError';
    }
    check('执行层兜底拦截', blocked);
    check('系统目录未受影响', await exists('C:/Windows/notepad.exe'));
  }

  // ---------- 6.5 通道升级:recycle 建议在 stage 通道下升级为 stage ----------
  console.log('\n[6.5] 通道升级语义');
  {
    const snapshot = await scan(scratchRoot, { maxDepth: 4 });
    const pycEntry = snapshot.entries.find(x => x.path.replaceAll('\\', '/').endsWith('project/__pycache__'));
    const assessments = new Map([[pycEntry.path, mkAssessment(pycEntry.path, { suggestedAction: 'recycle' })]]);
    const planStage = buildPlan([pycEntry], assessments, { dryRun: false, userProtectedPaths: [], channel: 'stage' });
    check('stage 通道升级 recycle 建议', planStage.items[0].action === 'stage' && planStage.summaryText.includes('staging'), planStage.summaryText);
    const planRecycle = buildPlan([pycEntry], assessments, { dryRun: false, userProtectedPaths: [], channel: 'recycle' });
    check('recycle 通道保持 recycle', planRecycle.items[0].action === 'recycle');
    const nmEntry = snapshot.entries.find(x => x.path.replaceAll('\\', '/').endsWith('project/node_modules'));
    const assessments2 = new Map([[nmEntry.path, mkAssessment(nmEntry.path, { suggestedAction: 'stage' })]]);
    const planRR = buildPlan([nmEntry], assessments2, { dryRun: false, userProtectedPaths: [], channel: 'recycle' });
    check('recycle 通道跳过 stage 建议', planRR.items[0].action === 'skip');
  }

  // ---------- 6.6 扫描控制器:暂停/停止 ----------
  console.log('\n[6.6] 扫描暂停/停止');
  {
    const big = path.join(scratchRoot, 'bigtree');
    for (let i = 0; i < 30; i++) {
      const d = path.join(big, `d${i}`);
      await fs.mkdir(d, { recursive: true });
      for (let j = 0; j < 20; j++) await fs.writeFile(path.join(d, `f${j}.txt`), 'x'.repeat(10));
    }
    const ctrl = { paused: true, cancelled: false };
    const p = scan(big, { maxDepth: 2, controller: ctrl });
    let settled = false;
    p.finally(() => { settled = true; });
    await new Promise(r => setTimeout(r, 400));
    check('暂停时扫描未结束', !settled);
    ctrl.paused = false;
    const partial = await p;
    check('恢复后正常完成', !partial.cancelled && partial.totals.dirs >= 31);

    const ctrl2 = { paused: false, cancelled: true }; // 立即取消:首个 worker 检查即命中
    const p2 = scan(big, { maxDepth: 2, controller: ctrl2 });
    const partial2 = await p2;
    check('停止返回部分数据', partial2.cancelled === true && partial2.entries.length > 0,
      `cancelled=${partial2.cancelled} entries=${partial2.entries.length}`);
    const nmAgain = partial2.entries.find(x => x.name === 'node_modules');
    check('部分数据仍可用于计划', !!nmAgain || partial2.entries.length > 0);
  }

  // ---------- 6.7 扫描报告生成 ----------
  console.log('\n[6.7] 扫描报告(md+json)');
  {
    const snapshot = await scan(scratchRoot, { maxDepth: 4 });
    const rows = snapshot.entries.filter(e => e.depth >= 1).map(e => ({
      path: e.path, name: e.name, kind: e.kind, sizeBytes: e.sizeBytes, depth: e.depth,
      ruleId: e.name === 'node_modules' ? 'node-modules' : null,
      riskLevel: e.name === 'node_modules' ? 'medium' : 'high',
      reversibility: 'regenerable', suggestedAction: e.name === 'node_modules' ? 'stage' : 'skip',
      defaultChecked: false, rationale: 'selftest',
    }));
    const outDir = path.join(scratchRoot, 'report-out');
    const res = await writeScanReport({
      outDir, root: scratchRoot, createdAt: snapshot.createdAt, totals: snapshot.totals,
      cancelled: false, appVersion: 'test', unknownMinBytes: 1,
    }, rows);
    const md = await fs.readFile(res.mdPath, 'utf8');
    check('md 报告已生成', md.includes('# DiskJanitor 扫描报告') && md.includes('给 AI 的分析任务'));
    check('md 含建议清理节', md.includes('node_modules'));
    check('md 含未识别节', md.includes('未识别条目'));
    const json = JSON.parse(await fs.readFile(res.jsonPath, 'utf8'));
    check('json 全量行数一致', json.rows.length === rows.length && json.counts.actionable === 1);
  }

  // ---------- 6.8 永久删除批次(purge) ----------
  console.log('\n[6.8] 暂存批次永久删除(purgeBatch)');
  {
    const auditPath2 = path.join(scratchRoot, 'purge-audit.log');
    const undoMgr = new ManifestUndoManager({ undoDir, stagingRootFor: () => stagingRoot });
    // 造一个 committed stage 批次
    const snap = await scan(scratchRoot, { maxDepth: 4 });
    const nmEntry = snap.entries.find(x => x.path.replaceAll('\\', '/').endsWith('project/node_modules'));
    const assessments = new Map([[nmEntry.path, mkAssessment(nmEntry.path, { suggestedAction: 'stage' })]]);
    const plan = buildPlan([nmEntry], assessments, { dryRun: false, userProtectedPaths: [], channel: 'stage' });
    const receipt = await new StagingExecutor(deps()).execute(plan, 'stage');
    check('stage 批次就绪', receipt.movedItems === 1);

    // undone 批次不可 purge
    const undoneId = (await undoMgr.list()).find(r => r.status === 'undone')?.id;
    let rejected = false;
    try { await undoMgr.purgeBatch(undoneId ?? '', auditPath2); } catch { rejected = true; }
    check('已撤销批次拒绝 purge', rejected);

    // committed 批次 purge:目录消失 + 审计
    const res = await undoMgr.purgeBatch(receipt.undoRecordId, auditPath2);
    check('purge 释放字节数正确', res.freedBytes === 150, `实际 ${res.freedBytes}`);
    const after = await scan(stagingRoot, { maxDepth: 4 });
    check('staging 批次目录已清', after.entries.filter(e => e.depth >= 1).length === 0, `剩余 ${after.entries.filter(e => e.depth >= 1).length} 项`);
    const audit = await fs.readFile(auditPath2, 'utf8');
    check('purge 审计留痕', audit.includes('PURGE') && audit.includes(receipt.undoRecordId));
    const purged = (await undoMgr.list()).find(r => r.id === receipt.undoRecordId);
    check('记录状态 purged', purged?.status === 'purged');
  }

  // ---------- 清理场地(永久删除自证) ----------
  console.log('\n[6] 清理自检场地');
  {
    const snap = await scan(scratchRoot, { maxDepth: 4 });
    const root = snap.entries[0];
    const assessments = new Map([[root.path, mkAssessment(root.path, { suggestedAction: 'stage', reversibility: 'recoverable' })]]);
    const plan = buildPlan([root], assessments, { dryRun: false, userProtectedPaths: [] });
    const r = await new PermanentDeletionExecutor({ userProtectedPaths: [], auditLogPath: auditPath })
      .executePermanent({ plan, confirmed_permanent: true });
    check('场地已清理', !(await exists(scratchRoot)) && r.movedItems === 1,
      `movedItems=${r.movedItems} failures=${JSON.stringify(r.failures)}`);
  }

  console.log(`\n结果: ${passed} PASS / ${failed} FAIL`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('自检异常:', err);
  process.exit(1);
});
