// 规则包 schema:声明式、可版本化、TOML/JSON 双载体(JSON 为 dry-run 载体,TOML 为后续人工编辑载体,字段一一对应)。
// 语义:规则按数组顺序匹配,first-match-wins;未命中条目走 fail-closed 默认(高风险/不可替代/需询问/不勾选)。

import type { RiskLevel, Reversibility, CleanupAction } from './types.ts';

/** 匹配条件,至少一个字段;多个字段同时给出 = AND 语义 */
export interface RuleMatch {
  /** 大小写不敏感;** 跨目录,* 单段内通配;按规范化正斜杠路径匹配 */
  path_glob?: string;
  /** 目录/文件名(不含路径)精确或通配 */
  name_glob?: string;
  /** 扩展名,如 "vhdx"(不含点) */
  suffix?: string;
  min_size_bytes?: number;
  /** mtime 距今超过 N 天 */
  older_than_days?: number;
}

/** 单条清理规则 */
export interface CleanupRule {
  /** 全局唯一,稳定 id(进撤销记录与审计日志) */
  id: string;
  description: string;
  match: RuleMatch;
  risk_level: RiskLevel;
  reversibility: Reversibility;
  suggested_action: CleanupAction;
  /** UI 默认勾选。硬约束:reversibility=irreplaceable 时必须为 false(校验器强制) */
  default_checked: boolean;
  /** 给用户看的判定依据(一行) */
  rationale: string;
  enabled: boolean;
}

/** 规则包 = 规则集 + 用户保护名单(执行层拦截,不进 UI) */
export interface RulePack {
  version: number;
  rules: CleanupRule[];
  /** 用户指定保护路径(绝对路径或目录前缀);执行层硬拦截 */
  protected_paths: string[];
}

/** 校验失败明细 */
export type ValidateResult =
  | { ok: true; pack: RulePack }
  | { ok: false; errors: string[] };

const RISK: RiskLevel[] = ['low', 'medium', 'high'];
const REVERSIBILITY: Reversibility[] = ['regenerable', 'recoverable', 'irreplaceable'];
const ACTION: CleanupAction[] = ['recycle', 'stage', 'skip'];

/** 纯校验,无 IO。强制约束:irreplaceable ⇒ default_checked=false;action=skip 的规则必须有 rationale 说明 */
export function validateRulePack(raw: unknown): ValidateResult {
  const errors: string[] = [];
  const seen = new Set<string>();
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['顶层必须是对象'] };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== 'number') errors.push('version 必须是数字');

  const rules: CleanupRule[] = [];
  const arr = Array.isArray(obj.rules) ? obj.rules : [];
  arr.forEach((r, i) => {
    const tag = `rules[${i}]`;
    if (typeof r !== 'object' || r === null) { errors.push(`${tag} 必须是对象`); return; }
    const o = r as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id : '';
    if (!id) errors.push(`${tag}.id 缺失`);
    else if (seen.has(id)) errors.push(`${tag}.id 重复: ${id}`);
    else seen.add(id);
    if (typeof o.description !== 'string') errors.push(`${tag}.description 缺失`);
    const m = o.match as Record<string, unknown> | undefined;
    if (typeof m !== 'object' || m === null) { errors.push(`${tag}.match 缺失`); return; }
    if (!Object.keys(m).some(k => m[k] !== undefined)) errors.push(`${tag}.match 至少需要一个条件`);
    if (m.path_glob !== undefined && typeof m.path_glob !== 'string') errors.push(`${tag}.match.path_glob 必须是字符串`);
    if (!RISK.includes(o.risk_level as RiskLevel)) errors.push(`${tag}.risk_level 必须是 ${RISK.join('/')}`);
    if (!REVERSIBILITY.includes(o.reversibility as Reversibility)) errors.push(`${tag}.reversibility 必须是 ${REVERSIBILITY.join('/')}`);
    if (!ACTION.includes(o.suggested_action as CleanupAction)) errors.push(`${tag}.suggested_action 必须是 ${ACTION.join('/')}`);
    if (typeof o.default_checked !== 'boolean') errors.push(`${tag}.default_checked 必须是布尔`);
    if (o.reversibility === 'irreplaceable' && o.default_checked === true) {
      errors.push(`${tag} 违反硬约束:reversibility=irreplaceable 时 default_checked 必须为 false`);
    }
    if (typeof o.rationale !== 'string' || !o.rationale) errors.push(`${tag}.rationale 缺失`);
    if (typeof o.enabled !== 'boolean') errors.push(`${tag}.enabled 必须是布尔`);
    if (errors.length === 0) rules.push(o as unknown as CleanupRule);
  });

  const pp = obj.protected_paths;
  if (!Array.isArray(pp) || pp.some(p => typeof p !== 'string')) {
    errors.push('protected_paths 必须是字符串数组');
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    pack: {
      version: obj.version as number,
      rules,
      protected_paths: pp as string[],
    },
  };
}
