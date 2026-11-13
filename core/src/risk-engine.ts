// RiskEngine 层:纯规则引擎(2026-11-09 决策:不引入 AI 解释,保持软件精简)。
// 规则先行,glob 匹配;未命中走 fail-closed 默认(高风险/不可替代/skip/不勾选)。

import type { FsEntry, RiskAssessment } from './types.ts';
import type { CleanupRule, RulePack, RuleMatch } from './rules-schema.ts';

export const FAIL_CLOSED_ASSESSMENT: Readonly<{
  riskLevel: 'high';
  reversibility: 'irreplaceable';
  suggestedAction: 'skip';
  defaultChecked: false;
}> = Object.freeze({
  riskLevel: 'high' as const,
  reversibility: 'irreplaceable' as const,
  suggestedAction: 'skip' as const,
  defaultChecked: false as const,
});

const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
};
const REVERSIBILITY_LABELS: Record<string, string> = {
  regenerable: '可重新生成',
  recoverable: '可恢复',
  irreplaceable: '不可替代',
};

export function riskLabel(level: string): string { return RISK_LABELS[level] ?? level; }
export function reversibilityLabel(r: string): string { return REVERSIBILITY_LABELS[r] ?? r; }

/** glob → RegExp:** 跨目录,* 单段;输入已规范化为正斜杠小写 */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // 吞掉紧随的 '/'
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

function normPath(p: string): string {
  return p.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
}

function matchOne(m: RuleMatch, entry: FsEntry, nowMs: number): boolean {
  const p0 = normPath(entry.path);
  const p = p0;
  const name = entry.name.toLowerCase();
  if (m.path_glob !== undefined) {
    const g = m.path_glob.toLowerCase();
    const p = p0;
    // 条目自身命中,或(目录时)视为"该目录及其内容"命中:glob + '/**'
    const reSelf = globToRegExp(g);
    if (reSelf.test(p)) {
      // hit
    } else if (entry.kind === 'dir' && globToRegExp(g.endsWith('/**') ? g : g + '/**').test(p)) {
      // hit: 目录规则默认覆盖其内容
    } else {
      return false;
    }
  }
  if (m.name_glob !== undefined && !globToRegExp(m.name_glob.toLowerCase()).test(name)) return false;
  if (m.suffix !== undefined) {
    const dot = name.lastIndexOf('.');
    if (dot < 0 || name.slice(dot + 1) !== m.suffix.toLowerCase()) return false;
  }
  if (m.min_size_bytes !== undefined && entry.sizeBytes < m.min_size_bytes) return false;
  if (m.older_than_days !== undefined && nowMs - entry.mtimeMs < m.older_than_days * 86400_000) return false;
  return true;
}

export interface AssessOptions {
  /** 未命中规则时的兜底裁定;缺省 = fail-closed */
  fallback?: Partial<Pick<RiskAssessment, 'riskLevel' | 'reversibility' | 'suggestedAction' | 'defaultChecked'>>;
}

/** 对单个条目裁定。纯函数,不做任何 IO,无 AI。 */
export function assessEntry(entry: FsEntry, pack: RulePack, opts: AssessOptions = {}): RiskAssessment {
  const nowMs = Date.now();
  const rules = pack.rules.filter(r => r.enabled);
  for (const rule of rules) {
    if (matchOne(rule.match, entry, nowMs)) {
      return Object.freeze({
        target: entry.path,
        riskLevel: rule.risk_level,
        reversibility: rule.reversibility,
        rationale: rule.rationale,
        suggestedAction: rule.suggested_action,
        ruleId: rule.id,
        aiGenerated: false,
        defaultChecked: rule.default_checked,
      });
    }
  }
  return Object.freeze({
    target: entry.path,
    riskLevel: opts.fallback?.riskLevel ?? FAIL_CLOSED_ASSESSMENT.riskLevel,
    reversibility: opts.fallback?.reversibility ?? FAIL_CLOSED_ASSESSMENT.reversibility,
    rationale: '规则未命中,fail-closed:按高风险/不可替代处理',
    suggestedAction: opts.fallback?.suggestedAction ?? FAIL_CLOSED_ASSESSMENT.suggestedAction,
    ruleId: null,
    aiGenerated: false,
    defaultChecked: opts.fallback?.defaultChecked ?? FAIL_CLOSED_ASSESSMENT.defaultChecked,
  });
}
