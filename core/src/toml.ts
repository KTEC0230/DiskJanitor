// 极小 TOML 子集解析器(仅覆盖 rules.overlay.toml 需要的语法,零依赖)。
// 支持:字符串(双引号)、数字、布尔、标量数组、[section]、[[array of tables]]、注释。
// 遇到不支持的语法直接抛错(fail-closed),不做静默降级。

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = Record<string, TomlValue | TomlTable | TomlTable[]>;

/** 按顶层逗号切分(引号内的逗号不切;子集不支持转义引号,故引号即开关) */
function splitTopLevel(s: string, sep = ','): string[] {
  const parts: string[] = [];
  let cur = '';
  let inStr = false;
  let depth = 0;
  for (const c of s) {
    if (c === '"') { inStr = !inStr; cur += c; continue; }
    if (!inStr) {
      if (c === '[' || c === '{') depth++;
      if (c === ']' || c === '}') depth--;
      if (c === sep && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    }
    cur += c;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts.filter(p => p !== '');
}

function stripComment(line: string): string {
  let out = '';
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== '\\') inStr = !inStr;
    if (c === '#' && !inStr) break;
    out += c;
  }
  return out.trim();
}

function parseScalar(raw: string): TomlValue {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    if (inner.includes('"')) throw new Error(`TOML 子集不支持转义引号: ${raw}`);
    return inner;
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // 标量数组 ["a", "b"]
  if (s.startsWith('[') && s.endsWith(']')) {
    return splitTopLevel(s.slice(1, -1)).map(parseScalar);
  }
  // 内联表 { key = value, ... }(值不含嵌套内联表,出现即报错)
  if (s.startsWith('{') && s.endsWith('}')) {
    const table: TomlTable = {};
    for (const part of splitTopLevel(s.slice(1, -1))) {
      const [k, v] = parseKeyVal(part);
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        throw new Error(`TOML 子集不支持嵌套内联表: ${part}`);
      }
      table[k] = v;
    }
    return table;
  }
  throw new Error(`TOML 子集不支持的值: ${raw}`);
}

function parseKeyVal(line: string): [string, TomlValue] {
  const eq = line.indexOf('=');
  if (eq <= 0) throw new Error(`TOML 子集解析失败(缺少 =): ${line}`);
  const key = line.slice(0, eq).trim().replace(/^"|"$/g, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`TOML 子集不支持复杂键: ${key}`);
  return [key, parseScalar(line.slice(eq + 1))];
}

/** 解析 TOML 子集。不支持多行数组/多行字符串/内联表 —— 出现即报错。 */
export function parseToml(text: string): TomlTable {
  const root: TomlTable = {};
  let current: TomlTable | TomlTable[] = root; // 当前写入目标(数组时写入其末元素)
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === '') continue;
    const secArr = line.match(/^\[\[(.+)\]\]$/);
    const sec = line.match(/^\[(.+)\]$/);
    if (secArr) {
      const keys = secArr[1].split('.');
      let parent: TomlTable = root;
      for (const k of keys.slice(0, -1)) {
        const v = parent[k];
        if (!v || Array.isArray(v) || typeof v !== 'object') { parent[k] = {}; }
        parent = parent[k] as TomlTable;
      }
      const last = keys[keys.length - 1];
      const arr = Array.isArray(parent[last]) ? (parent[last] as TomlTable[]) : [];
      const t: TomlTable = {};
      arr.push(t);
      parent[last] = arr;
      current = t;
      continue;
    }
    if (sec) {
      const keys = sec[1].split('.');
      let t: TomlTable = root;
      for (const k of keys) {
        if (!t[k] || Array.isArray(t[k]) || typeof t[k] !== 'object') t[k] = {};
        t = t[k] as TomlTable;
      }
      current = t;
      continue;
    }
    const [k, v] = parseKeyVal(line);
    (current as TomlTable)[k] = v;
  }
  return root;
}
