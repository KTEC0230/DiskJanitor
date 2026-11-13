// 撤销工具:node tools/undo.mjs list | node tools/undo.mjs <undoId>
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManifestUndoManager } from '../core/src/undo-manager.ts';
import { loadConfig, stagingRootFor } from '../core/src/config.ts';
import { formatBytes } from '../core/src/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const arg = process.argv[2];
  const { config } = await loadConfig();
  const undo = new ManifestUndoManager({
    undoDir: config.undo.dir,
    stagingRootFor: p => stagingRootFor(p, config),
  });

  if (!arg || arg === 'list') {
    const records = await undo.list();
    if (records.length === 0) { console.log('(无撤销记录)'); return; }
    for (const r of records) {
      const moved = r.entries.filter(e => e.status === 'moved').length;
      const bytes = r.entries.filter(e => e.status === 'moved').reduce((s, e) => s + e.sizeBytes, 0);
      console.log(`${r.id}  ${r.status.padEnd(9)} ${r.mode.padEnd(7)} 可撤销 ${moved} 项/${formatBytes(bytes)}  ${r.createdAt}`);
    }
    return;
  }

  const receipt = await undo.undo(arg);
  console.log(`撤销完成: 恢复 ${receipt.restoredItems} 项`);
  if (receipt.failures.length > 0) {
    console.log(`未恢复 ${receipt.failures.length} 项:`);
    for (const f of receipt.failures) console.log(`  - ${f}`);
  }
}

main().catch(err => {
  console.error('撤销失败:', err.message ?? err);
  process.exit(1);
});
