// 扫描报告生成器:把一次扫描的全部裁定输出为 Markdown(人读 + AI 分析)+ JSON(机器全量)。
// 纯写文件,不碰被扫描对象。报告第三节专供 AI 二次验证未识别条目。

import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ReportRow {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  sizeBytes: number;
  depth: number;
  ruleId: string | null;
  riskLevel: string;
  reversibility: string;
  suggestedAction: string;
  defaultChecked: boolean;
  rationale: string;
}

export interface ReportMeta {
  outDir: string;
  root: string;
  createdAt: string;
  totals: { files: number; dirs: number; bytes: number };
  cancelled: boolean;
  appVersion: string;
  /** md 中"未识别"节的大小阈值(字节);完整明细始终在 json */
  unknownMinBytes?: number;
}

const RISK_LABELS: Record<string, string> = { low: '低风险', medium: '中风险', high: '高风险' };
const REVERS_LABELS: Record<string, string> = { regenerable: '可重新生成', recoverable: '可恢复', irreplaceable: '不可替代' };

function fmt(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function table(rows: ReportRow[], withRule: boolean): string {
  const head = withRule
    ? '| 大小 | 对象 | 路径 | 风险/可逆性 | 建议 | 判定依据(规则) |'
    : '| 大小 | 对象 | 路径 | 类型 |';
  const lines = [head];
  for (const r of rows) {
    const p = r.path.replaceAll('|', '\\|');
    if (withRule) {
      lines.push(
        `| ${fmt(r.sizeBytes)} | ${r.name} | ${p} | ${RISK_LABELS[r.riskLevel] ?? r.riskLevel}·${REVERS_LABELS[r.reversibility] ?? r.reversibility} | ${r.suggestedAction === 'recycle' ? '回收站' : r.suggestedAction === 'stage' ? 'staging' : '需确认'} | ${(r.rationale ?? '').replaceAll('|', '\\|')}${r.ruleId ? `(${r.ruleId})` : ''} |`,
      );
    } else {
      lines.push(`| ${fmt(r.sizeBytes)} | ${r.name} | ${p} | ${r.kind === 'dir' ? '目录' : '文件'} |`);
    }
  }
  return lines.join('\n');
}

/** 生成并写出报告;返回两个文件路径 */
export async function writeScanReport(meta: ReportMeta, rows: ReportRow[]): Promise<{ mdPath: string; jsonPath: string; counts: { actionable: number; skipped: number; unknown: number; unknownListed: number } }> {
  await fs.mkdir(meta.outDir, { recursive: true });

  const actionable = rows.filter(r => r.ruleId !== null && r.suggestedAction !== 'skip')
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const skipped = rows.filter(r => r.ruleId !== null && r.suggestedAction === 'skip')
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const unknownAll = rows.filter(r => r.ruleId === null)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  const minBytes = meta.unknownMinBytes ?? 10 * 1024 * 1024; // 默认 10MB
  const unknownListed = unknownAll.filter(r => r.sizeBytes >= minBytes);

  const stamp = meta.createdAt.replace(/[:T]/g, '-').slice(0, 19);
  const rootSlug = meta.root.replaceAll(/[\\/:]+/g, '_').replace(/^_+/, '').replace(/_$/, '') || 'root';
  const base = `DiskJanitor报告_${rootSlug}_${stamp}`;
  const mdPath = path.join(meta.outDir, `${base}.md`);
  const jsonPath = path.join(meta.outDir, `${base}.json`);

  const md = [
    `# DiskJanitor 扫描报告`,
    ``,
    `- 扫描根:${meta.root}`,
    `- 生成时间:${meta.createdAt}(应用 v${meta.appVersion})`,
    `- 扫描总量:${meta.totals.files} 文件 / ${meta.totals.dirs} 目录 / ${fmt(meta.totals.bytes)}${meta.cancelled ? '(已停止,部分结果)' : ''}`,
    `- 条目分类:建议清理 ${actionable.length} / 规则判定需确认 ${skipped.length} / 未识别 ${unknownAll.length}(其中 ≥${fmt(minBytes)} 的 ${unknownListed.length} 条列于下文;全量明细见同名 .json)`,
    ``,
    `## 给 AI 的分析任务(未识别条目二次验证)`,
    ``,
    `以下第三节是规则引擎未识别的条目(默认不清理)。请逐条分析其用途,并标注以下类别之一:`,
    ``,
    `- **[可安全清理的缓存/临时文件]** —— 说明是什么缓存、删除后果、是否会自动重建`,
    `- **[程序或系统必需]** —— 说明属于哪个软件/系统组件`,
    `- **[用户数据]** —— 说明可能是什么数据`,
    `- **[不确定]** —— 说明需要哪些额外信息才能判断`,
    ``,
    `> 分析规则:宁可标"不确定"也不要猜;涉及用户文档/聊天记录/浏览器配置一律标用户数据。`,
    ``,
    `## 一、建议清理(规则判定,默认可执行)`,
    ``,
    actionable.length ? table(actionable, true) : '(无)',
    ``,
    `## 二、规则判定需用户决定(默认不执行)`,
    ``,
    skipped.length ? table(skipped, true) : '(无)',
    ``,
    `## 三、未识别条目(默认不动 —— 请 AI 重点分析)`,
    ``,
    unknownListed.length ? table(unknownListed, false) : '(无 ≥阈值的条目)',
    ``,
    `## 四、说明`,
    ``,
    `- 保护机制:执行层硬拦截系统目录/卷根/用户保护名单;所有清理默认移入 staging 可撤销;永久删除需独立二次确认。`,
    `- 本报告由 DiskJanitor 生成,只读分析,未修改任何被扫描文件。`,
    ``,
  ].join('\n');

  const json = {
    meta: { root: meta.root, createdAt: meta.createdAt, appVersion: meta.appVersion, cancelled: meta.cancelled, totals: meta.totals },
    counts: { actionable: actionable.length, skipped: skipped.length, unknown: unknownAll.length },
    rows,
  };

  await fs.writeFile(mdPath, md, 'utf8');
  await fs.writeFile(jsonPath, JSON.stringify(json), 'utf8');
  return { mdPath, jsonPath, counts: { actionable: actionable.length, skipped: skipped.length, unknown: unknownAll.length, unknownListed: unknownListed.length } };
}
