// 规则"受限叠加覆盖"(2026-11-09 用户决策):
// 内置规则包(default-rules.json)只读、随应用版本更新;用户通过 TOML overlay 只能**收紧**,不能放宽。
//
// overlay 允许的三类操作(其余一律拒绝):
//   1. disable  = ["规则id", ...]            —— 停用内置规则
//   2. [[override]] id="..." + tighten 字段   —— 对已有规则收紧:
//        default_checked = false             —— 只能 true→false
//        suggested_action = "stage"|"skip"   —— 只能往更保守方向
//        risk_level = "medium"|"high"        —— 只能往上调
//   3. [[rule]] 新增规则                      —— 结构上无法放宽:
//        default_checked 必须 false; suggested_action ∈ {stage, skip};
//        risk_level ∈ {medium, high}(可保守,不可激进)
//   另:protected_paths 追加(仅增不减)。

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseToml, type TomlTable, type TomlValue } from './toml.ts';
import { validateRulePack, type CleanupRule, type RulePack } from './rules-schema.ts';

export const RISK_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };
export const ACTION_ORDER: Record<string, number> = { recycle: 0, stage: 1, skip: 2 }; // 越大越保守

export function overlayPath(): string {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'DiskJanitor', 'rules.overlay.toml');
}

export type OverlayResult =
  | { ok: true; pack: RulePack; applied: string[]; overlayFile: string | null }
  | { ok: false; errors: string[]; overlayFile: string };

/** 加载内置规则包并叠加用户 overlay。overlay 文件不存在 = 返回原包。 */
export async function loadPackWithOverlay(builtinPath: string): Promise<OverlayResult> {
  const builtinRaw = JSON.parse(await fs.readFile(builtinPath, 'utf8'));
  const baseRes = validateRulePack(builtinRaw);
  if (!baseRes.ok) return { ok: false, errors: [`内置规则包非法: ${baseRes.errors.join('; ')}`], overlayFile: overlayPath() };
  const pack: RulePack = baseRes.pack;

  const oFile = overlayPath();
  let text: string;
  try {
    text = await fs.readFile(oFile, 'utf8');
  } catch {
    return { ok: true, pack, applied: [], overlayFile: null };
  }

  const errors: string[] = [];
  const applied: string[] = [];
  let toml: TomlTable;
  try {
    toml = parseToml(text);
  } catch (err) {
    return { ok: false, errors: [`overlay TOML 解析失败: ${(err as Error).message}`], overlayFile: oFile };
  }

  const byId = new Map(pack.rules.map(r => [r.id, r]));

  // 1. disable
  const disable = toml['disable'];
  if (disable !== undefined) {
    if (!Array.isArray(disable) || disable.some(d => typeof d !== 'string')) {
      errors.push('disable 必须是字符串数组');
    } else {
      for (const id of disable as string[]) {
        if (!byId.has(id)) errors.push(`disable: 内置规则不存在 id "${id}"`);
        else { (byId.get(id) as CleanupRule).enabled = false; applied.push(`disable:${id}`); }
      }
    }
  }

  // 2. [[override]] —— 只允许收紧字段
  const overrides = toml['override'];
  if (overrides !== undefined) {
    const arr = Array.isArray(overrides) ? overrides : [overrides];
    for (const o of arr) {
      if (typeof o !== 'object' || o === null) { errors.push('override 项必须是表'); continue; }
      const t = o as TomlTable;
      const id = t['id'];
      if (typeof id !== 'string' || !byId.has(id)) { errors.push(`override: 内置规则不存在 id "${String(id)}"`); continue; }
      const rule = byId.get(id) as CleanupRule;
      if (t['default_checked'] !== undefined) {
        if (t['default_checked'] !== false) errors.push(`override ${id}: default_checked 只能设为 false(不可放宽)`);
        else { rule.default_checked = false; applied.push(`override:${id}:default_checked=false`); }
      }
      if (t['suggested_action'] !== undefined) {
        const v = t['suggested_action'] as string;
        if (!(v === 'stage' || v === 'skip')) errors.push(`override ${id}: suggested_action 只能是 stage|skip(不可放宽)`);
        else if (ACTION_ORDER[v] < ACTION_ORDER[rule.suggested_action]) errors.push(`override ${id}: suggested_action 只能收紧(${rule.suggested_action} → ${v} 是放宽)`);
        else { rule.suggested_action = v as CleanupRule['suggested_action']; applied.push(`override:${id}:suggested_action=${v}`); }
      }
      if (t['risk_level'] !== undefined) {
        const v = t['risk_level'] as string;
        if (!(v === 'medium' || v === 'high')) errors.push(`override ${id}: risk_level 只能是 medium|high(不可放宽)`);
        else if (RISK_ORDER[v] < RISK_ORDER[rule.risk_level]) errors.push(`override ${id}: risk_level 只能上调(${rule.risk_level} → ${v} 是下调)`);
        else { rule.risk_level = v as CleanupRule['risk_level']; applied.push(`override:${id}:risk_level=${v}`); }
      }
      const forbidden = Object.keys(t).filter(k => !['id', 'default_checked', 'suggested_action', 'risk_level'].includes(k));
      if (forbidden.length > 0) errors.push(`override ${id}: 不允许修改字段 ${forbidden.join(', ')}(overlay 只能收紧)`);
    }
  }

  // 3. [[rule]] 追加 —— 结构上禁止放宽
  const newRules = toml['rule'];
  if (newRules !== undefined) {
    const arr = Array.isArray(newRules) ? newRules : [newRules];
    for (const r of arr) {
      if (typeof r !== 'object' || r === null) { errors.push('rule 项必须是表'); continue; }
      const t = r as TomlTable;
      const probe = validateRulePack({ version: pack.version, rules: [t], protected_paths: [] });
      if (!probe.ok) { errors.push(`追加规则非法: ${probe.errors.join('; ')}`); continue; }
      const nr = probe.pack.rules[0];
      if (nr.default_checked !== false) { errors.push(`追加规则 ${nr.id}: default_checked 必须 false(overlay 新规则不允许默认勾选)`); continue; }
      if (nr.suggested_action !== 'stage' && nr.suggested_action !== 'skip') { errors.push(`追加规则 ${nr.id}: suggested_action 只能是 stage|skip`); continue; }
      if (nr.risk_level === 'low') { errors.push(`追加规则 ${nr.id}: risk_level 不能是 low(overlay 新规则至少 medium)`); continue; }
      if (byId.has(nr.id)) { errors.push(`追加规则 id 与内置冲突: ${nr.id}`); continue; }
      byId.set(nr.id, nr);
      pack.rules.push(nr);
      applied.push(`rule:${nr.id}`);
    }
  }

  // protected_paths 追加
  const pp = toml['protected_paths'];
  if (pp !== undefined) {
    if (!Array.isArray(pp) || pp.some(p => typeof p !== 'string')) {
      errors.push('protected_paths 必须是字符串数组');
    } else {
      for (const p of pp as string[]) {
        if (!pack.protected_paths.includes(p)) { pack.protected_paths.push(p); applied.push(`protected:${p}`); }
      }
    }
  }

  // 顶层多余键拒绝(防拼错字段名导致静默失效)
  const allowedTop = new Set(['disable', 'override', 'rule', 'protected_paths']);
  for (const k of Object.keys(toml)) {
    if (!allowedTop.has(k)) errors.push(`overlay 不认识的顶层键 "${k}"(允许: disable/override/rule/protected_paths)`);
  }

  if (errors.length > 0) return { ok: false, errors, overlayFile: oFile };
  return { ok: true, pack, applied, overlayFile: oFile };
}

export type { TomlValue };
