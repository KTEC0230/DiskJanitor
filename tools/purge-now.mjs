// 清空全部暂存批次(用户已明确授权):stage+committed 批次逐个永久删除,审计留痕
import * as core from '../shell/core.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const { config } = await core.loadConfig();
const undo = new core.ManifestUndoManager({ undoDir: config.undo.dir, stagingRootFor: p => core.stagingRootFor(p, config) });
const auditLog = path.join(path.dirname(config.undo.dir), 'audit.log');

const records = await undo.list();
let freedBytes = 0, count = 0;
const failures = [];
for (const r of records) {
  if (r.status !== 'committed' || r.mode !== 'stage') continue;
  try {
    const res = await undo.purgeBatch(r.id, auditLog);
    freedBytes += res.freedBytes;
    count++;
    failures.push(...res.failures);
  } catch (err) {
    failures.push(`${r.id}: ${err.message ?? err}`);
  }
}
console.log(`已永久删除 ${count} 个批次,释放 ${(freedBytes / 1024 ** 3).toFixed(2)} GB`);
if (failures.length) { console.log('失败项:'); failures.forEach(f => console.log(' -', f)); }
// 验证暂存根已空
for (const r of config.staging.volumeOverride ? Object.values(config.staging.volumeOverride) : []) void r;
const roots = ['C:/DiskJanitorStaging', 'D:/DiskJanitorStaging'];
for (const root of roots) {
  try {
    const kids = await fs.readdir(root);
    console.log(root, '剩余条目:', kids.length);
  } catch { console.log(root, '(不存在)'); }
}
