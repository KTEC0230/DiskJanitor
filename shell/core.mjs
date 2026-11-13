// core/src/scanner.ts
import { promises as fs } from "node:fs";
import path from "node:path";
var SCANNER_VERSION = "0.2.0-dry-run";
var ScanCancelledSignal = class extends Error {
  constructor() {
    super("scan cancelled");
    this.name = "ScanCancelledSignal";
  }
};
async function scan(root, opts = {}) {
  const maxDepth = opts.maxDepth ?? 64;
  const concurrency = Math.max(1, opts.concurrency ?? 32);
  const absRoot = path.resolve(root);
  const rootStat = await fs.lstat(absRoot);
  if (!rootStat.isDirectory()) throw new Error(`\u626B\u63CF\u6839\u5FC5\u987B\u662F\u76EE\u5F55: ${absRoot}`);
  const entries = [];
  let totalFiles = 0;
  let totalDirs = 0;
  let totalBytes = 0;
  const dirAcc = /* @__PURE__ */ new Map();
  const norm = (abs) => abs.replaceAll("\\", "/");
  async function statEntry(abs, name, depth, parentAbs) {
    const st = await fs.lstat(abs);
    const isReparse = st.isSymbolicLink?.() ?? false;
    const relPath = norm(abs);
    if (st.isFile()) {
      totalFiles += 1;
      totalBytes += st.size;
      if (parentAbs) {
        const acc = dirAcc.get(parentAbs);
        acc.self += st.size;
        acc.total += st.size;
        acc.childCount += 1;
      }
      if (depth <= maxDepth) {
        entries.push(Object.freeze({
          path: relPath,
          name,
          kind: "file",
          sizeBytes: st.size,
          mtimeMs: st.mtimeMs,
          depth,
          flags: Object.freeze({ isSymlink: false, isReparsePoint: isReparse, isHidden: name.startsWith(".") })
        }));
      }
    } else if (st.isDirectory()) {
      totalDirs += 1;
      dirAcc.set(abs, { self: 0, total: 0, childCount: 0 });
      if (depth <= maxDepth) {
        entries.push(Object.freeze({
          path: relPath,
          name,
          kind: "dir",
          sizeBytes: 0,
          mtimeMs: st.mtimeMs,
          depth,
          flags: Object.freeze({ isSymlink: false, isReparsePoint: isReparse, isHidden: name.startsWith(".") })
        }));
      }
      await readDir(abs, depth);
    }
  }
  async function readDir(abs, depth) {
    const names = await fs.readdir(abs);
    let idx = 0;
    const worker = async () => {
      while (idx < names.length) {
        if (controller) {
          while (controller.paused && !controller.cancelled) {
            await new Promise((r) => setTimeout(r, 150));
          }
          if (controller.cancelled) throw new ScanCancelledSignal();
        }
        const name = names[idx++];
        const child = path.join(abs, name);
        try {
          const st = await fs.lstat(child);
          if (st.isDirectory() && !isReparseChild(st)) {
            await statEntry(child, name, depth + 1, abs);
          } else {
            await statEntry(child, name, depth + 1, abs);
          }
        } catch (err) {
          void err;
        }
        opts.onProgress?.(totalBytes, child);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, names.length)) }, worker));
  }
  function isReparseChild(st) {
    return st.isSymbolicLink();
  }
  const controller = opts.controller;
  let cancelled = false;
  try {
    await statEntry(absRoot, path.basename(absRoot) || norm(absRoot), 0, null);
  } catch (err) {
    if (err instanceof ScanCancelledSignal) {
      cancelled = true;
    } else {
      throw err;
    }
  }
  const dirEntries = [...dirAcc.keys()].sort((a, b) => b.length - a.length);
  const totalOf = (abs) => dirAcc.get(abs)?.total ?? 0;
  const childrenOf = /* @__PURE__ */ new Map();
  for (const abs of dirAcc.keys()) {
    if (abs === absRoot) continue;
    const parent = path.dirname(abs);
    if (!childrenOf.has(parent)) childrenOf.set(parent, []);
    childrenOf.get(parent).push(abs);
  }
  for (const abs of dirEntries) {
    const acc = dirAcc.get(abs);
    for (const c of childrenOf.get(abs) ?? []) acc.total += totalOf(c);
  }
  const sizeByPath = /* @__PURE__ */ new Map();
  for (const [abs, acc] of dirAcc) sizeByPath.set(norm(abs), acc.total);
  const thawed = entries.map(
    (e) => e.kind === "dir" && sizeByPath.has(e.path) ? Object.freeze({ ...e, sizeBytes: sizeByPath.get(e.path) }) : e
  );
  return Object.freeze({
    id: `snap-${Date.now().toString(36)}`,
    root: norm(absRoot),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    scannerVersion: SCANNER_VERSION,
    entries: Object.freeze(thawed),
    totals: Object.freeze({ files: totalFiles, dirs: totalDirs, bytes: totalBytes }),
    ...cancelled ? { cancelled: true } : {}
  });
}

// core/src/report.ts
import { promises as fs2 } from "node:fs";
import path2 from "node:path";
var RISK_LABELS = { low: "\u4F4E\u98CE\u9669", medium: "\u4E2D\u98CE\u9669", high: "\u9AD8\u98CE\u9669" };
var REVERS_LABELS = { regenerable: "\u53EF\u91CD\u65B0\u751F\u6210", recoverable: "\u53EF\u6062\u590D", irreplaceable: "\u4E0D\u53EF\u66FF\u4EE3" };
function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
function table(rows, withRule) {
  const head = withRule ? "| \u5927\u5C0F | \u5BF9\u8C61 | \u8DEF\u5F84 | \u98CE\u9669/\u53EF\u9006\u6027 | \u5EFA\u8BAE | \u5224\u5B9A\u4F9D\u636E(\u89C4\u5219) |" : "| \u5927\u5C0F | \u5BF9\u8C61 | \u8DEF\u5F84 | \u7C7B\u578B |";
  const lines = [head];
  for (const r of rows) {
    const p = r.path.replaceAll("|", "\\|");
    if (withRule) {
      lines.push(
        `| ${fmt(r.sizeBytes)} | ${r.name} | ${p} | ${RISK_LABELS[r.riskLevel] ?? r.riskLevel}\xB7${REVERS_LABELS[r.reversibility] ?? r.reversibility} | ${r.suggestedAction === "recycle" ? "\u56DE\u6536\u7AD9" : r.suggestedAction === "stage" ? "staging" : "\u9700\u786E\u8BA4"} | ${(r.rationale ?? "").replaceAll("|", "\\|")}${r.ruleId ? `(${r.ruleId})` : ""} |`
      );
    } else {
      lines.push(`| ${fmt(r.sizeBytes)} | ${r.name} | ${p} | ${r.kind === "dir" ? "\u76EE\u5F55" : "\u6587\u4EF6"} |`);
    }
  }
  return lines.join("\n");
}
async function writeScanReport(meta, rows) {
  await fs2.mkdir(meta.outDir, { recursive: true });
  const actionable = rows.filter((r) => r.ruleId !== null && r.suggestedAction !== "skip").sort((a, b) => b.sizeBytes - a.sizeBytes);
  const skipped = rows.filter((r) => r.ruleId !== null && r.suggestedAction === "skip").sort((a, b) => b.sizeBytes - a.sizeBytes);
  const unknownAll = rows.filter((r) => r.ruleId === null).sort((a, b) => b.sizeBytes - a.sizeBytes);
  const minBytes = meta.unknownMinBytes ?? 10 * 1024 * 1024;
  const unknownListed = unknownAll.filter((r) => r.sizeBytes >= minBytes);
  const stamp = meta.createdAt.replace(/[:T]/g, "-").slice(0, 19);
  const rootSlug = meta.root.replaceAll(/[\\/:]+/g, "_").replace(/^_+/, "").replace(/_$/, "") || "root";
  const base = `DiskJanitor\u62A5\u544A_${rootSlug}_${stamp}`;
  const mdPath = path2.join(meta.outDir, `${base}.md`);
  const jsonPath = path2.join(meta.outDir, `${base}.json`);
  const md = [
    `# DiskJanitor \u626B\u63CF\u62A5\u544A`,
    ``,
    `- \u626B\u63CF\u6839:${meta.root}`,
    `- \u751F\u6210\u65F6\u95F4:${meta.createdAt}(\u5E94\u7528 v${meta.appVersion})`,
    `- \u626B\u63CF\u603B\u91CF:${meta.totals.files} \u6587\u4EF6 / ${meta.totals.dirs} \u76EE\u5F55 / ${fmt(meta.totals.bytes)}${meta.cancelled ? "(\u5DF2\u505C\u6B62,\u90E8\u5206\u7ED3\u679C)" : ""}`,
    `- \u6761\u76EE\u5206\u7C7B:\u5EFA\u8BAE\u6E05\u7406 ${actionable.length} / \u89C4\u5219\u5224\u5B9A\u9700\u786E\u8BA4 ${skipped.length} / \u672A\u8BC6\u522B ${unknownAll.length}(\u5176\u4E2D \u2265${fmt(minBytes)} \u7684 ${unknownListed.length} \u6761\u5217\u4E8E\u4E0B\u6587;\u5168\u91CF\u660E\u7EC6\u89C1\u540C\u540D .json)`,
    ``,
    `## \u7ED9 AI \u7684\u5206\u6790\u4EFB\u52A1(\u672A\u8BC6\u522B\u6761\u76EE\u4E8C\u6B21\u9A8C\u8BC1)`,
    ``,
    `\u4EE5\u4E0B\u7B2C\u4E09\u8282\u662F\u89C4\u5219\u5F15\u64CE\u672A\u8BC6\u522B\u7684\u6761\u76EE(\u9ED8\u8BA4\u4E0D\u6E05\u7406)\u3002\u8BF7\u9010\u6761\u5206\u6790\u5176\u7528\u9014,\u5E76\u6807\u6CE8\u4EE5\u4E0B\u7C7B\u522B\u4E4B\u4E00:`,
    ``,
    `- **[\u53EF\u5B89\u5168\u6E05\u7406\u7684\u7F13\u5B58/\u4E34\u65F6\u6587\u4EF6]** \u2014\u2014 \u8BF4\u660E\u662F\u4EC0\u4E48\u7F13\u5B58\u3001\u5220\u9664\u540E\u679C\u3001\u662F\u5426\u4F1A\u81EA\u52A8\u91CD\u5EFA`,
    `- **[\u7A0B\u5E8F\u6216\u7CFB\u7EDF\u5FC5\u9700]** \u2014\u2014 \u8BF4\u660E\u5C5E\u4E8E\u54EA\u4E2A\u8F6F\u4EF6/\u7CFB\u7EDF\u7EC4\u4EF6`,
    `- **[\u7528\u6237\u6570\u636E]** \u2014\u2014 \u8BF4\u660E\u53EF\u80FD\u662F\u4EC0\u4E48\u6570\u636E`,
    `- **[\u4E0D\u786E\u5B9A]** \u2014\u2014 \u8BF4\u660E\u9700\u8981\u54EA\u4E9B\u989D\u5916\u4FE1\u606F\u624D\u80FD\u5224\u65AD`,
    ``,
    `> \u5206\u6790\u89C4\u5219:\u5B81\u53EF\u6807"\u4E0D\u786E\u5B9A"\u4E5F\u4E0D\u8981\u731C;\u6D89\u53CA\u7528\u6237\u6587\u6863/\u804A\u5929\u8BB0\u5F55/\u6D4F\u89C8\u5668\u914D\u7F6E\u4E00\u5F8B\u6807\u7528\u6237\u6570\u636E\u3002`,
    ``,
    `## \u4E00\u3001\u5EFA\u8BAE\u6E05\u7406(\u89C4\u5219\u5224\u5B9A,\u9ED8\u8BA4\u53EF\u6267\u884C)`,
    ``,
    actionable.length ? table(actionable, true) : "(\u65E0)",
    ``,
    `## \u4E8C\u3001\u89C4\u5219\u5224\u5B9A\u9700\u7528\u6237\u51B3\u5B9A(\u9ED8\u8BA4\u4E0D\u6267\u884C)`,
    ``,
    skipped.length ? table(skipped, true) : "(\u65E0)",
    ``,
    `## \u4E09\u3001\u672A\u8BC6\u522B\u6761\u76EE(\u9ED8\u8BA4\u4E0D\u52A8 \u2014\u2014 \u8BF7 AI \u91CD\u70B9\u5206\u6790)`,
    ``,
    unknownListed.length ? table(unknownListed, false) : "(\u65E0 \u2265\u9608\u503C\u7684\u6761\u76EE)",
    ``,
    `## \u56DB\u3001\u8BF4\u660E`,
    ``,
    `- \u4FDD\u62A4\u673A\u5236:\u6267\u884C\u5C42\u786C\u62E6\u622A\u7CFB\u7EDF\u76EE\u5F55/\u5377\u6839/\u7528\u6237\u4FDD\u62A4\u540D\u5355;\u6240\u6709\u6E05\u7406\u9ED8\u8BA4\u79FB\u5165 staging \u53EF\u64A4\u9500;\u6C38\u4E45\u5220\u9664\u9700\u72EC\u7ACB\u4E8C\u6B21\u786E\u8BA4\u3002`,
    `- \u672C\u62A5\u544A\u7531 DiskJanitor \u751F\u6210,\u53EA\u8BFB\u5206\u6790,\u672A\u4FEE\u6539\u4EFB\u4F55\u88AB\u626B\u63CF\u6587\u4EF6\u3002`,
    ``
  ].join("\n");
  const json = {
    meta: { root: meta.root, createdAt: meta.createdAt, appVersion: meta.appVersion, cancelled: meta.cancelled, totals: meta.totals },
    counts: { actionable: actionable.length, skipped: skipped.length, unknown: unknownAll.length },
    rows
  };
  await fs2.writeFile(mdPath, md, "utf8");
  await fs2.writeFile(jsonPath, JSON.stringify(json), "utf8");
  return { mdPath, jsonPath, counts: { actionable: actionable.length, skipped: skipped.length, unknown: unknownAll.length, unknownListed: unknownListed.length } };
}

// core/src/risk-engine.ts
var FAIL_CLOSED_ASSESSMENT = Object.freeze({
  riskLevel: "high",
  reversibility: "irreplaceable",
  suggestedAction: "skip",
  defaultChecked: false
});
var RISK_LABELS2 = {
  low: "\u4F4E\u98CE\u9669",
  medium: "\u4E2D\u98CE\u9669",
  high: "\u9AD8\u98CE\u9669"
};
var REVERSIBILITY_LABELS = {
  regenerable: "\u53EF\u91CD\u65B0\u751F\u6210",
  recoverable: "\u53EF\u6062\u590D",
  irreplaceable: "\u4E0D\u53EF\u66FF\u4EE3"
};
function riskLabel(level) {
  return RISK_LABELS2[level] ?? level;
}
function reversibilityLabel(r) {
  return REVERSIBILITY_LABELS[r] ?? r;
}
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
}
function normPath(p) {
  return p.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
}
function matchOne(m, entry, nowMs) {
  const p0 = normPath(entry.path);
  const p = p0;
  const name = entry.name.toLowerCase();
  if (m.path_glob !== void 0) {
    const g = m.path_glob.toLowerCase();
    const p2 = p0;
    const reSelf = globToRegExp(g);
    if (reSelf.test(p2)) {
    } else if (entry.kind === "dir" && globToRegExp(g.endsWith("/**") ? g : g + "/**").test(p2)) {
    } else {
      return false;
    }
  }
  if (m.name_glob !== void 0 && !globToRegExp(m.name_glob.toLowerCase()).test(name)) return false;
  if (m.suffix !== void 0) {
    const dot = name.lastIndexOf(".");
    if (dot < 0 || name.slice(dot + 1) !== m.suffix.toLowerCase()) return false;
  }
  if (m.min_size_bytes !== void 0 && entry.sizeBytes < m.min_size_bytes) return false;
  if (m.older_than_days !== void 0 && nowMs - entry.mtimeMs < m.older_than_days * 864e5) return false;
  return true;
}
function assessEntry(entry, pack, opts = {}) {
  const nowMs = Date.now();
  const rules = pack.rules.filter((r) => r.enabled);
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
        defaultChecked: rule.default_checked
      });
    }
  }
  return Object.freeze({
    target: entry.path,
    riskLevel: opts.fallback?.riskLevel ?? FAIL_CLOSED_ASSESSMENT.riskLevel,
    reversibility: opts.fallback?.reversibility ?? FAIL_CLOSED_ASSESSMENT.reversibility,
    rationale: "\u89C4\u5219\u672A\u547D\u4E2D,fail-closed:\u6309\u9AD8\u98CE\u9669/\u4E0D\u53EF\u66FF\u4EE3\u5904\u7406",
    suggestedAction: opts.fallback?.suggestedAction ?? FAIL_CLOSED_ASSESSMENT.suggestedAction,
    ruleId: null,
    aiGenerated: false,
    defaultChecked: opts.fallback?.defaultChecked ?? FAIL_CLOSED_ASSESSMENT.defaultChecked
  });
}

// core/src/types.ts
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

// core/src/errors.ts
var BlockedPathError = class extends Error {
  path;
  execLayer;
  constructor(path7, execLayer) {
    super(
      execLayer ? `\u6267\u884C\u5C42\u62E6\u622A\u53D7\u4FDD\u62A4\u8DEF\u5F84: ${path7}` : `\u53D7\u4FDD\u62A4\u8DEF\u5F84(\u8BA1\u5212\u4E2D\u5DF2\u62E6\u622A): ${path7}`
    );
    this.name = "BlockedPathError";
    this.path = path7;
    this.execLayer = execLayer;
  }
};
var NotImplementedError = class extends Error {
  constructor(module) {
    super(`${module} \u5C1A\u672A\u5B9E\u73B0(\u5F53\u524D\u5904\u4E8E dry-run \u9636\u6BB5,\u7981\u6B62\u4EFB\u4F55\u5199\u64CD\u4F5C)`);
    this.name = "NotImplementedError";
  }
};
var StagingCapacityError = class extends Error {
  root;
  neededBytes;
  availableBytes;
  constructor(root, neededBytes, availableBytes) {
    super(
      `staging \u5BB9\u91CF\u4E0D\u8DB3: ${root} \u9700 ${neededBytes} \u5B57\u8282,\u4EC5\u5269 ${availableBytes} \u5B57\u8282(\u53EF\u6E05\u7406\u65E7\u6279\u6B21\u6216\u8C03\u9AD8 config.staging.maxBytesPerVolume)`
    );
    this.name = "StagingCapacityError";
    this.root = root;
    this.neededBytes = neededBytes;
    this.availableBytes = availableBytes;
  }
};
var PlanRejectedError = class extends Error {
  constructor(reason) {
    super(`\u8BA1\u5212\u88AB\u62D2\u7EDD: ${reason}`);
    this.name = "PlanRejectedError";
  }
};

// core/src/protected-paths.ts
var SYSTEM_PROTECTED_PREFIXES = [
  "c:/windows",
  "c:/program files",
  "c:/program files (x86)",
  "c:/programdata/microsoft",
  "c:/$recycle.bin",
  "c:/system volume information",
  "c:/recovery"
];
var SYSTEM_PROTECTED_EXACT = [
  "c:/users"
  // 用户目录根本身;深层路径按用户保护名单与规则判断
];
var SYSTEM_PROTECTED_FILES = [
  "c:/pagefile.sys",
  "c:/swapfile.sys",
  "c:/hiberfil.sys",
  "c:/dumpstack.log.tmp"
];
function isProtectedPath(path7, userProtected, execLayer = false) {
  const norm = path7.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  const isFileHit = SYSTEM_PROTECTED_FILES.some((f) => norm === f);
  const isExactHit = SYSTEM_PROTECTED_EXACT.some((p) => norm === p);
  const isPrefixHit = SYSTEM_PROTECTED_PREFIXES.some(
    (p) => norm === p || norm.startsWith(p + "/")
  );
  const isUserHit = userProtected.some((u) => {
    const un = u.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
    return norm === un || norm.startsWith(un + "/");
  });
  const isVolumeRoot = /^[a-z]:\/?$/.test(norm);
  void execLayer;
  return isFileHit || isExactHit || isPrefixHit || isUserHit || isVolumeRoot;
}
function assertDeletable(path7, userProtected, execLayer = true) {
  if (isProtectedPath(path7, userProtected, execLayer)) {
    throw new BlockedPathError(path7, execLayer);
  }
}

// core/src/planner.ts
function normalizeAction(a, risk, channel) {
  if (a === "skip") return "skip";
  if (risk.reversibility === "irreplaceable") return "skip";
  if (channel === "stage") return "stage";
  return a === "recycle" ? "recycle" : "skip";
}
function buildPlan(selected, assessments, opts = {}) {
  const dryRun = opts.dryRun ?? true;
  const userProtected = opts.userProtectedPaths ?? [];
  const channel = opts.channel ?? "stage";
  const items = selected.map((entry) => {
    const assessment = assessments.get(entry.path) ?? {
      target: entry.path,
      riskLevel: "high",
      reversibility: "irreplaceable",
      rationale: "\u65E0\u88C1\u5B9A\u8BB0\u5F55,fail-closed",
      suggestedAction: "skip",
      ruleId: null,
      aiGenerated: false,
      defaultChecked: false
    };
    const blocked = isProtectedPath(entry.path, userProtected);
    const blockReason = blocked ? "\u547D\u4E2D\u4FDD\u62A4\u540D\u5355(\u6267\u884C\u5C42\u5C06\u518D\u6B21\u62E6\u622A,\u4E0E UI \u52FE\u9009\u65E0\u5173)" : null;
    const action = blocked ? "skip" : normalizeAction(assessment.suggestedAction, assessment, channel);
    return Object.freeze({ entry, assessment, action, blocked, blockReason });
  });
  let recycleItems = 0, recycleBytes = 0, stageItems = 0, stageBytes = 0, blockedItems = 0, skippedItems = 0;
  for (const it of items) {
    if (it.blocked) {
      blockedItems++;
      continue;
    }
    if (it.action === "recycle") {
      recycleItems++;
      recycleBytes += it.entry.sizeBytes;
    } else if (it.action === "stage") {
      stageItems++;
      stageBytes += it.entry.sizeBytes;
    } else skippedItems++;
  }
  const parts = [];
  if (recycleItems > 0) parts.push(`\u5C06 ${recycleItems} \u9879\u79FB\u5165\u56DE\u6536\u7AD9(${formatBytes(recycleBytes)})`);
  if (stageItems > 0) parts.push(`\u5C06 ${stageItems} \u9879\u79FB\u5165 staging(${formatBytes(stageBytes)})`);
  if (blockedItems > 0) parts.push(`${blockedItems} \u9879\u88AB\u4FDD\u62A4\u540D\u5355\u62E6\u622A`);
  if (skippedItems > 0) parts.push(`${skippedItems} \u9879\u5F85\u7528\u6237\u51B3\u5B9A`);
  const summaryText = parts.length > 0 ? parts.join("\u3001") : "\u6CA1\u6709\u53EF\u6267\u884C\u9879";
  return Object.freeze({
    id: `plan-${Date.now().toString(36)}`,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    dryRun,
    items: Object.freeze(items),
    totals: Object.freeze({ recycleItems, recycleBytes, stageItems, stageBytes, blockedItems, skippedItems }),
    summaryText
  });
}
function suggestSelection(snapshotEntries, assessments, maxDepth = 1) {
  return snapshotEntries.filter(
    (e) => e.depth <= maxDepth && e.depth > 0 && assessments.get(e.path)?.defaultChecked === true
  );
}

// core/src/rules-schema.ts
var RISK = ["low", "medium", "high"];
var REVERSIBILITY = ["regenerable", "recoverable", "irreplaceable"];
var ACTION = ["recycle", "stage", "skip"];
function validateRulePack(raw) {
  const errors = [];
  const seen = /* @__PURE__ */ new Set();
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["\u9876\u5C42\u5FC5\u987B\u662F\u5BF9\u8C61"] };
  const obj = raw;
  if (typeof obj.version !== "number") errors.push("version \u5FC5\u987B\u662F\u6570\u5B57");
  const rules = [];
  const arr = Array.isArray(obj.rules) ? obj.rules : [];
  arr.forEach((r, i) => {
    const tag = `rules[${i}]`;
    if (typeof r !== "object" || r === null) {
      errors.push(`${tag} \u5FC5\u987B\u662F\u5BF9\u8C61`);
      return;
    }
    const o = r;
    const id = typeof o.id === "string" ? o.id : "";
    if (!id) errors.push(`${tag}.id \u7F3A\u5931`);
    else if (seen.has(id)) errors.push(`${tag}.id \u91CD\u590D: ${id}`);
    else seen.add(id);
    if (typeof o.description !== "string") errors.push(`${tag}.description \u7F3A\u5931`);
    const m = o.match;
    if (typeof m !== "object" || m === null) {
      errors.push(`${tag}.match \u7F3A\u5931`);
      return;
    }
    if (!Object.keys(m).some((k) => m[k] !== void 0)) errors.push(`${tag}.match \u81F3\u5C11\u9700\u8981\u4E00\u4E2A\u6761\u4EF6`);
    if (m.path_glob !== void 0 && typeof m.path_glob !== "string") errors.push(`${tag}.match.path_glob \u5FC5\u987B\u662F\u5B57\u7B26\u4E32`);
    if (!RISK.includes(o.risk_level)) errors.push(`${tag}.risk_level \u5FC5\u987B\u662F ${RISK.join("/")}`);
    if (!REVERSIBILITY.includes(o.reversibility)) errors.push(`${tag}.reversibility \u5FC5\u987B\u662F ${REVERSIBILITY.join("/")}`);
    if (!ACTION.includes(o.suggested_action)) errors.push(`${tag}.suggested_action \u5FC5\u987B\u662F ${ACTION.join("/")}`);
    if (typeof o.default_checked !== "boolean") errors.push(`${tag}.default_checked \u5FC5\u987B\u662F\u5E03\u5C14`);
    if (o.reversibility === "irreplaceable" && o.default_checked === true) {
      errors.push(`${tag} \u8FDD\u53CD\u786C\u7EA6\u675F:reversibility=irreplaceable \u65F6 default_checked \u5FC5\u987B\u4E3A false`);
    }
    if (typeof o.rationale !== "string" || !o.rationale) errors.push(`${tag}.rationale \u7F3A\u5931`);
    if (typeof o.enabled !== "boolean") errors.push(`${tag}.enabled \u5FC5\u987B\u662F\u5E03\u5C14`);
    if (errors.length === 0) rules.push(o);
  });
  const pp = obj.protected_paths;
  if (!Array.isArray(pp) || pp.some((p) => typeof p !== "string")) {
    errors.push("protected_paths \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    pack: {
      version: obj.version,
      rules,
      protected_paths: pp
    }
  };
}

// core/src/rules-overlay.ts
import { promises as fs3 } from "node:fs";
import os from "node:os";
import path3 from "node:path";

// core/src/toml.ts
function splitTopLevel(s, sep = ",") {
  const parts = [];
  let cur = "";
  let inStr = false;
  let depth = 0;
  for (const c of s) {
    if (c === '"') {
      inStr = !inStr;
      cur += c;
      continue;
    }
    if (!inStr) {
      if (c === "[" || c === "{") depth++;
      if (c === "]" || c === "}") depth--;
      if (c === sep && depth === 0) {
        parts.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts.filter((p) => p !== "");
}
function stripComment(line) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && line[i - 1] !== "\\") inStr = !inStr;
    if (c === "#" && !inStr) break;
    out += c;
  }
  return out.trim();
}
function parseScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    if (inner.includes('"')) throw new Error(`TOML \u5B50\u96C6\u4E0D\u652F\u6301\u8F6C\u4E49\u5F15\u53F7: ${raw}`);
    return inner;
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("[") && s.endsWith("]")) {
    return splitTopLevel(s.slice(1, -1)).map(parseScalar);
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const table2 = {};
    for (const part of splitTopLevel(s.slice(1, -1))) {
      const [k, v] = parseKeyVal(part);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        throw new Error(`TOML \u5B50\u96C6\u4E0D\u652F\u6301\u5D4C\u5957\u5185\u8054\u8868: ${part}`);
      }
      table2[k] = v;
    }
    return table2;
  }
  throw new Error(`TOML \u5B50\u96C6\u4E0D\u652F\u6301\u7684\u503C: ${raw}`);
}
function parseKeyVal(line) {
  const eq = line.indexOf("=");
  if (eq <= 0) throw new Error(`TOML \u5B50\u96C6\u89E3\u6790\u5931\u8D25(\u7F3A\u5C11 =): ${line}`);
  const key = line.slice(0, eq).trim().replace(/^"|"$/g, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`TOML \u5B50\u96C6\u4E0D\u652F\u6301\u590D\u6742\u952E: ${key}`);
  return [key, parseScalar(line.slice(eq + 1))];
}
function parseToml(text) {
  const root = {};
  let current = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line === "") continue;
    const secArr = line.match(/^\[\[(.+)\]\]$/);
    const sec = line.match(/^\[(.+)\]$/);
    if (secArr) {
      const keys = secArr[1].split(".");
      let parent = root;
      for (const k2 of keys.slice(0, -1)) {
        const v2 = parent[k2];
        if (!v2 || Array.isArray(v2) || typeof v2 !== "object") {
          parent[k2] = {};
        }
        parent = parent[k2];
      }
      const last = keys[keys.length - 1];
      const arr = Array.isArray(parent[last]) ? parent[last] : [];
      const t = {};
      arr.push(t);
      parent[last] = arr;
      current = t;
      continue;
    }
    if (sec) {
      const keys = sec[1].split(".");
      let t = root;
      for (const k2 of keys) {
        if (!t[k2] || Array.isArray(t[k2]) || typeof t[k2] !== "object") t[k2] = {};
        t = t[k2];
      }
      current = t;
      continue;
    }
    const [k, v] = parseKeyVal(line);
    current[k] = v;
  }
  return root;
}

// core/src/rules-overlay.ts
var RISK_ORDER = { low: 0, medium: 1, high: 2 };
var ACTION_ORDER = { recycle: 0, stage: 1, skip: 2 };
function overlayPath() {
  const appData = process.env.APPDATA ?? path3.join(os.homedir(), "AppData", "Roaming");
  return path3.join(appData, "DiskJanitor", "rules.overlay.toml");
}
async function loadPackWithOverlay(builtinPath) {
  const builtinRaw = JSON.parse(await fs3.readFile(builtinPath, "utf8"));
  const baseRes = validateRulePack(builtinRaw);
  if (!baseRes.ok) return { ok: false, errors: [`\u5185\u7F6E\u89C4\u5219\u5305\u975E\u6CD5: ${baseRes.errors.join("; ")}`], overlayFile: overlayPath() };
  const pack = baseRes.pack;
  const oFile = overlayPath();
  let text;
  try {
    text = await fs3.readFile(oFile, "utf8");
  } catch {
    return { ok: true, pack, applied: [], overlayFile: null };
  }
  const errors = [];
  const applied = [];
  let toml;
  try {
    toml = parseToml(text);
  } catch (err) {
    return { ok: false, errors: [`overlay TOML \u89E3\u6790\u5931\u8D25: ${err.message}`], overlayFile: oFile };
  }
  const byId = new Map(pack.rules.map((r) => [r.id, r]));
  const disable = toml["disable"];
  if (disable !== void 0) {
    if (!Array.isArray(disable) || disable.some((d) => typeof d !== "string")) {
      errors.push("disable \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    } else {
      for (const id of disable) {
        if (!byId.has(id)) errors.push(`disable: \u5185\u7F6E\u89C4\u5219\u4E0D\u5B58\u5728 id "${id}"`);
        else {
          byId.get(id).enabled = false;
          applied.push(`disable:${id}`);
        }
      }
    }
  }
  const overrides = toml["override"];
  if (overrides !== void 0) {
    const arr = Array.isArray(overrides) ? overrides : [overrides];
    for (const o of arr) {
      if (typeof o !== "object" || o === null) {
        errors.push("override \u9879\u5FC5\u987B\u662F\u8868");
        continue;
      }
      const t = o;
      const id = t["id"];
      if (typeof id !== "string" || !byId.has(id)) {
        errors.push(`override: \u5185\u7F6E\u89C4\u5219\u4E0D\u5B58\u5728 id "${String(id)}"`);
        continue;
      }
      const rule = byId.get(id);
      if (t["default_checked"] !== void 0) {
        if (t["default_checked"] !== false) errors.push(`override ${id}: default_checked \u53EA\u80FD\u8BBE\u4E3A false(\u4E0D\u53EF\u653E\u5BBD)`);
        else {
          rule.default_checked = false;
          applied.push(`override:${id}:default_checked=false`);
        }
      }
      if (t["suggested_action"] !== void 0) {
        const v = t["suggested_action"];
        if (!(v === "stage" || v === "skip")) errors.push(`override ${id}: suggested_action \u53EA\u80FD\u662F stage|skip(\u4E0D\u53EF\u653E\u5BBD)`);
        else if (ACTION_ORDER[v] < ACTION_ORDER[rule.suggested_action]) errors.push(`override ${id}: suggested_action \u53EA\u80FD\u6536\u7D27(${rule.suggested_action} \u2192 ${v} \u662F\u653E\u5BBD)`);
        else {
          rule.suggested_action = v;
          applied.push(`override:${id}:suggested_action=${v}`);
        }
      }
      if (t["risk_level"] !== void 0) {
        const v = t["risk_level"];
        if (!(v === "medium" || v === "high")) errors.push(`override ${id}: risk_level \u53EA\u80FD\u662F medium|high(\u4E0D\u53EF\u653E\u5BBD)`);
        else if (RISK_ORDER[v] < RISK_ORDER[rule.risk_level]) errors.push(`override ${id}: risk_level \u53EA\u80FD\u4E0A\u8C03(${rule.risk_level} \u2192 ${v} \u662F\u4E0B\u8C03)`);
        else {
          rule.risk_level = v;
          applied.push(`override:${id}:risk_level=${v}`);
        }
      }
      const forbidden = Object.keys(t).filter((k) => !["id", "default_checked", "suggested_action", "risk_level"].includes(k));
      if (forbidden.length > 0) errors.push(`override ${id}: \u4E0D\u5141\u8BB8\u4FEE\u6539\u5B57\u6BB5 ${forbidden.join(", ")}(overlay \u53EA\u80FD\u6536\u7D27)`);
    }
  }
  const newRules = toml["rule"];
  if (newRules !== void 0) {
    const arr = Array.isArray(newRules) ? newRules : [newRules];
    for (const r of arr) {
      if (typeof r !== "object" || r === null) {
        errors.push("rule \u9879\u5FC5\u987B\u662F\u8868");
        continue;
      }
      const t = r;
      const probe = validateRulePack({ version: pack.version, rules: [t], protected_paths: [] });
      if (!probe.ok) {
        errors.push(`\u8FFD\u52A0\u89C4\u5219\u975E\u6CD5: ${probe.errors.join("; ")}`);
        continue;
      }
      const nr = probe.pack.rules[0];
      if (nr.default_checked !== false) {
        errors.push(`\u8FFD\u52A0\u89C4\u5219 ${nr.id}: default_checked \u5FC5\u987B false(overlay \u65B0\u89C4\u5219\u4E0D\u5141\u8BB8\u9ED8\u8BA4\u52FE\u9009)`);
        continue;
      }
      if (nr.suggested_action !== "stage" && nr.suggested_action !== "skip") {
        errors.push(`\u8FFD\u52A0\u89C4\u5219 ${nr.id}: suggested_action \u53EA\u80FD\u662F stage|skip`);
        continue;
      }
      if (nr.risk_level === "low") {
        errors.push(`\u8FFD\u52A0\u89C4\u5219 ${nr.id}: risk_level \u4E0D\u80FD\u662F low(overlay \u65B0\u89C4\u5219\u81F3\u5C11 medium)`);
        continue;
      }
      if (byId.has(nr.id)) {
        errors.push(`\u8FFD\u52A0\u89C4\u5219 id \u4E0E\u5185\u7F6E\u51B2\u7A81: ${nr.id}`);
        continue;
      }
      byId.set(nr.id, nr);
      pack.rules.push(nr);
      applied.push(`rule:${nr.id}`);
    }
  }
  const pp = toml["protected_paths"];
  if (pp !== void 0) {
    if (!Array.isArray(pp) || pp.some((p) => typeof p !== "string")) {
      errors.push("protected_paths \u5FC5\u987B\u662F\u5B57\u7B26\u4E32\u6570\u7EC4");
    } else {
      for (const p of pp) {
        if (!pack.protected_paths.includes(p)) {
          pack.protected_paths.push(p);
          applied.push(`protected:${p}`);
        }
      }
    }
  }
  const allowedTop = /* @__PURE__ */ new Set(["disable", "override", "rule", "protected_paths"]);
  for (const k of Object.keys(toml)) {
    if (!allowedTop.has(k)) errors.push(`overlay \u4E0D\u8BA4\u8BC6\u7684\u9876\u5C42\u952E "${k}"(\u5141\u8BB8: disable/override/rule/protected_paths)`);
  }
  if (errors.length > 0) return { ok: false, errors, overlayFile: oFile };
  return { ok: true, pack, applied, overlayFile: oFile };
}

// core/src/config.ts
import { promises as fs4 } from "node:fs";
import path4 from "node:path";
function defaultConfig() {
  const appData = process.env.APPDATA ?? path4.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  return {
    staging: {
      dirName: "DiskJanitorStaging",
      maxBytesPerVolume: 20 * 1024 ** 3,
      // 20 GB
      volumeOverride: {}
    },
    undo: {
      dir: path4.join(appData, "DiskJanitor", "undo")
    }
  };
}
function userConfigPath() {
  const appData = process.env.APPDATA ?? path4.join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  return path4.join(appData, "DiskJanitor", "config.json");
}
async function loadConfig() {
  const base = defaultConfig();
  const p = userConfigPath();
  try {
    const raw = JSON.parse(await fs4.readFile(p, "utf8"));
    if (typeof raw === "object" && raw !== null) {
      if (raw.staging && typeof raw.staging === "object") {
        const s = raw.staging;
        if (typeof s.dirName === "string" && s.dirName) base.staging.dirName = s.dirName;
        if (typeof s.maxBytesPerVolume === "number" && s.maxBytesPerVolume > 0) base.staging.maxBytesPerVolume = s.maxBytesPerVolume;
        if (s.volumeOverride && typeof s.volumeOverride === "object") {
          base.staging.volumeOverride = raw.staging.volumeOverride;
        }
      }
      if (raw.undo && typeof raw.undo === "object" && typeof raw.undo.dir === "string") {
        base.undo.dir = raw.undo.dir;
      }
    }
    return { config: base, userConfigFile: p };
  } catch {
    return { config: base, userConfigFile: null };
  }
}
function stagingRootFor(targetPath, cfg) {
  const norm = targetPath.replaceAll("/", "\\");
  const drive = (norm.match(/^([A-Za-z]):/) ?? [])[1]?.toUpperCase() ?? "C";
  const override = cfg.staging.volumeOverride[drive];
  if (override) return override.replaceAll("\\", "/");
  return `${drive}:/${cfg.staging.dirName}`;
}

// core/src/undo-manager.ts
import { promises as fs5 } from "node:fs";
import path5 from "node:path";
import { spawn } from "node:child_process";
import os2 from "node:os";
function sanitizeName(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}
function runPowerShell(scriptFile, timeoutMs = 12e4) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile], {
      windowsHide: true,
      timeout: timeoutMs
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || stdout) resolve(stdout + (stderr ? `
STDERR:${stderr}` : ""));
      else reject(new Error(`powershell exit ${code}: ${stderr || "no output"}`));
    });
  });
}
function psQuote(s) {
  return "'" + s.replace(/'/g, "''") + "'";
}
async function writePsScript(lines) {
  const file = path5.join(os2.tmpdir(), `dj-ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  await fs5.writeFile(file, "\uFEFF" + lines.join("\n"), "utf8");
  return file;
}
var ManifestUndoManager = class {
  deps;
  constructor(opts) {
    this.deps = { undoDir: opts.undoDir, stagingRootFor: opts.stagingRootFor };
  }
  recordFile(id) {
    return path5.join(this.deps.undoDir, `${id}.json`);
  }
  async begin(plan, mode) {
    await fs5.mkdir(this.deps.undoDir, { recursive: true });
    const actionable = plan.items.filter((i) => !i.blocked && (i.action === "recycle" || i.action === "stage"));
    const recordId = `undo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entries = actionable.map((it, idx) => ({
      originalPath: it.entry.path,
      stagedPath: mode === "stage" ? `${this.deps.stagingRootFor(it.entry.path)}/${plan.id}/${String(idx).padStart(4, "0")}_${sanitizeName(it.entry.name)}` : null,
      sizeBytes: it.entry.sizeBytes,
      mtimeMs: it.entry.mtimeMs,
      deletedAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: "pending"
    }));
    const record = {
      id: recordId,
      planId: plan.id,
      mode,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      status: "pending",
      entries
    };
    await fs5.writeFile(this.recordFile(recordId), JSON.stringify(record, null, 2), "utf8");
    return record;
  }
  /** 执行器在移动完成后调用:回写逐条目状态并置 committed */
  async commit(record) {
    record.status = "committed";
    await fs5.writeFile(this.recordFile(record.id), JSON.stringify(record, null, 2), "utf8");
  }
  async list() {
    let names = [];
    try {
      names = (await fs5.readdir(this.deps.undoDir)).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out = [];
    for (const n of names) {
      try {
        const raw = JSON.parse(await fs5.readFile(path5.join(this.deps.undoDir, n), "utf8"));
        if (raw && typeof raw.id === "string") out.push(raw);
      } catch {
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** 永久删除批次:独立于撤销通道;仅 committed 可清;写 PERMANENT 审计 */
  async purgeBatch(undoRecordId, auditLogPath) {
    if (!undoRecordId) throw new Error("\u64A4\u9500 id \u4E3A\u7A7A");
    const file = this.recordFile(undoRecordId);
    const record = JSON.parse(await fs5.readFile(file, "utf8"));
    if (record.status !== "committed") {
      throw new Error(`\u6279\u6B21 ${undoRecordId} \u72B6\u6001\u4E3A ${record.status},\u4E0D\u53EF\u6C38\u4E45\u5220\u9664(\u4EC5 committed \u53EF\u6E05)`);
    }
    const failures = [];
    let freedBytes = 0;
    if (record.mode === "stage") {
      const batchDirs = /* @__PURE__ */ new Set();
      for (const e of record.entries) {
        if (e.status !== "moved" || !e.stagedPath) continue;
        batchDirs.add(path5.dirname(e.stagedPath));
        freedBytes += e.sizeBytes;
      }
      for (const d of batchDirs) {
        try {
          await fs5.rm(d, { recursive: true, force: false, maxRetries: 2 });
        } catch (err) {
          failures.push(`${d}: ${err.message}`);
        }
      }
    }
    record.status = "purged";
    for (const e of record.entries) {
      if (e.status === "moved") e.status = "purged";
    }
    await fs5.writeFile(file, JSON.stringify(record, null, 2), "utf8");
    if (auditLogPath) {
      try {
        await fs5.mkdir(path5.dirname(auditLogPath), { recursive: true });
        await fs5.appendFile(
          auditLogPath,
          `${(/* @__PURE__ */ new Date()).toISOString()}	PERMANENT	PURGE	undo=${undoRecordId}	mode=${record.mode}	freed=${freedBytes}	${failures.length} failures
`,
          "utf8"
        );
      } catch {
      }
    }
    return { freedBytes, failures };
  }
  async undo(undoRecordId) {
    if (!undoRecordId) throw new Error("\u64A4\u9500 id \u4E3A\u7A7A(\u65E0\u53EF\u64A4\u9500\u9879)");
    const file = this.recordFile(undoRecordId);
    const record = JSON.parse(await fs5.readFile(file, "utf8"));
    if (record.status !== "committed") {
      throw new Error(`\u64A4\u9500\u8BB0\u5F55 ${undoRecordId} \u72B6\u6001\u4E3A ${record.status},\u4E0D\u53EF\u64A4\u9500(\u4EC5 committed \u53EF\u64A4\u9500)`);
    }
    const failures = [];
    let restored = 0;
    if (record.mode === "stage") {
      for (const e of record.entries) {
        if (e.status !== "moved") continue;
        try {
          const parent = path5.dirname(e.originalPath);
          await fs5.mkdir(parent, { recursive: true });
          let dest = e.originalPath;
          try {
            await fs5.access(dest);
            dest = `${e.originalPath}.janitor-restored-${Date.now().toString(36)}`;
          } catch {
          }
          await fs5.rename(e.stagedPath, dest);
          e.status = "restored";
          restored++;
        } catch (err) {
          e.status = "restore-failed";
          failures.push(`${e.originalPath}: ${err.message}`);
        }
      }
    } else {
      const want = /* @__PURE__ */ new Map();
      for (const e of record.entries) {
        if (e.status !== "moved") continue;
        try {
          await fs5.access(e.originalPath);
          e.status = "restore-skipped";
          failures.push(`${e.originalPath}: \u76EE\u6807\u5DF2\u5B58\u5728,\u4E3A\u907F\u514D\u8986\u76D6\u672A\u6267\u884C Shell \u8FD8\u539F`);
        } catch {
          const slash = e.originalPath.lastIndexOf("/");
          const dir = (slash > 0 ? e.originalPath.slice(0, slash) : e.originalPath).toLowerCase();
          const name = e.originalPath.slice(slash + 1).toLowerCase();
          want.set(`${dir}/${name}`, e);
        }
      }
      if (want.size > 0) restored += await this.restoreFromRecycleBin(want, failures);
    }
    record.status = "undone";
    if (record.mode === "stage") {
      const batchDirs = /* @__PURE__ */ new Set();
      for (const e of record.entries) {
        if (e.stagedPath) batchDirs.add(path5.dirname(e.stagedPath));
      }
      for (const d of batchDirs) {
        try {
          await fs5.rmdir(d);
        } catch {
        }
      }
    }
    await fs5.writeFile(file, JSON.stringify(record, null, 2), "utf8");
    return { undoId: undoRecordId, restoredItems: restored, failures };
  }
  /** 经 Windows Shell 从回收站还原:按 System.Recycle.DeletedFrom 匹配,动词匹配 还原/restore */
  async restoreFromRecycleBin(want, failures) {
    const lines = [
      "$ErrorActionPreference='Continue'",
      "$shell = New-Object -ComObject Shell.Application",
      "$rb = $shell.NameSpace(10)",
      "$want = @{" + [...want.keys()].map((k) => `${psQuote(k)}=$true`).join(";") + "}",
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
      "    if ($v.Name -match '\u8FD8\u539F|restore|Restore') { $verb = $v; break }",
      "  }",
      "  if ($verb) {",
      '    try { $verb.DoIt(); Write-Output ("OK`t" + $key) ; $used[$key] = $true }',
      '    catch { Write-Output ("FAIL`t" + $key + "`t" + $_.Exception.Message) }',
      "  } else {",
      '    Write-Output ("FAIL`t" + $key + "`tno restore verb")',
      "  }",
      "}"
    ];
    const script = await writePsScript(lines);
    try {
      const out = await runPowerShell(script, 18e4);
      let ok = 0;
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^(OK|FAIL)\t(.+?)(?:\t(.*))?$/);
        if (!m) continue;
        const e = want.get(m[2].toLowerCase());
        if (!e) continue;
        if (m[1] === "OK") {
          e.status = "restored";
          ok++;
        } else {
          e.status = "restore-failed";
          failures.push(`${e.originalPath}: Shell \u8FD8\u539F\u5931\u8D25: ${m[3] ?? "unknown"}`);
        }
      }
      for (const e of want.values()) {
        if (e.status !== "restored") continue;
        try {
          await fs5.access(e.originalPath);
        } catch {
          e.status = "restore-failed";
          failures.push(`${e.originalPath}: Shell \u62A5\u544A\u6210\u529F\u4F46\u539F\u4F4D\u672A\u51FA\u73B0\u6587\u4EF6`);
          ok--;
        }
      }
      return ok;
    } finally {
      fs5.unlink(script).catch(() => {
      });
    }
  }
};

// core/src/executor.ts
import { promises as fs6 } from "node:fs";
import path6 from "node:path";
import { spawn as spawn2 } from "node:child_process";
function actionableItems(plan, channel) {
  return plan.items.filter((i) => !i.blocked && i.action === channel);
}
function guardPlanOrThrow(plan, userProtected) {
  if (plan.dryRun) throw new PlanRejectedError("dry-run \u8BA1\u5212\u4E0D\u53EF\u76F4\u63A5\u6267\u884C(\u5148\u4EE5 dryRun=false \u91CD\u65B0 buildPlan)");
  for (const item of plan.items) {
    if (item.action === "skip") continue;
    assertDeletable(item.entry.path, userProtected, true);
  }
}
async function dirUsageBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let dents;
    try {
      dents = await fs6.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dents) {
      const p = path6.join(dir, d.name);
      if (d.isDirectory()) stack.push(p);
      else {
        try {
          total += (await fs6.lstat(p)).size;
        } catch {
        }
      }
    }
  }
  return total;
}
async function ensureStagingDir(root) {
  await fs6.mkdir(root, { recursive: true });
  spawn2("attrib", ["+h", root], { windowsHide: true, timeout: 1e4 }).on("error", () => {
  });
  return root;
}
async function movePath(src, dst) {
  try {
    await fs6.rename(src, dst);
  } catch (err) {
    const code = err.code;
    if (code !== "EXDEV") throw err;
    await fs6.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
    await fs6.rm(src, { recursive: true, force: false, maxRetries: 2 });
  }
}
var StagingExecutor = class {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  async execute(plan, mode) {
    if (mode !== "stage") throw new PlanRejectedError("StagingExecutor \u4EC5\u63A5\u53D7 mode=stage");
    guardPlanOrThrow(plan, this.deps.userProtectedPaths);
    const items = actionableItems(plan, "stage");
    const failures = [];
    if (items.length === 0) {
      return { planId: plan.id, mode: "stage", movedItems: 0, movedBytes: 0, undoRecordId: "", failures };
    }
    const perVolume = /* @__PURE__ */ new Map();
    for (const it of items) {
      const root = this.deps.stagingRootFor(it.entry.path);
      perVolume.set(root, (perVolume.get(root) ?? 0) + it.entry.sizeBytes);
    }
    for (const [root, needed] of perVolume) {
      const usage = await dirUsageBytes(root);
      if (usage + needed > this.deps.stagingMaxBytesPerVolume) {
        throw new StagingCapacityError(root, needed, this.deps.stagingMaxBytesPerVolume - usage);
      }
    }
    const record = await this.deps.undo.begin(plan, "stage");
    const entries = [...record.entries];
    let movedItems = 0;
    let movedBytes = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const entry = entries[idx];
      try {
        await ensureStagingDir(path6.dirname(entry.stagedPath));
        await movePath(item.entry.path, entry.stagedPath);
        entry.status = "moved";
        movedItems++;
        movedBytes += item.entry.sizeBytes;
      } catch (err) {
        entry.status = "failed";
        failures.push(`${item.entry.path}: ${err.message}`);
      }
    }
    await this.deps.undo.commit(record);
    return {
      planId: plan.id,
      mode: "stage",
      movedItems,
      movedBytes,
      undoRecordId: record.id,
      failures
    };
  }
};
var RecycleBinExecutor = class {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  async execute(plan, mode) {
    if (mode !== "recycle") throw new PlanRejectedError("RecycleBinExecutor \u4EC5\u63A5\u53D7 mode=recycle");
    guardPlanOrThrow(plan, this.deps.userProtectedPaths);
    const items = actionableItems(plan, "recycle");
    const failures = [];
    if (items.length === 0) {
      return { planId: plan.id, mode: "recycle", movedItems: 0, movedBytes: 0, undoRecordId: "", failures };
    }
    const record = await this.deps.undo.begin(plan, "recycle");
    const entries = [...record.entries];
    let trash;
    try {
      trash = (await import("trash")).default;
    } catch (err) {
      for (const e of entries) e.status = "failed";
      await this.deps.undo.commit(record);
      throw new Error(`\u56DE\u6536\u7AD9\u901A\u9053\u9700\u8981 npm \u5305 trash(\u672A\u5B89\u88C5: ${err.message});\u9ED8\u8BA4\u901A\u9053 staging \u4E0D\u53D7\u5F71\u54CD`);
    }
    let movedItems = 0;
    let movedBytes = 0;
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const entry = entries[idx];
      try {
        await trash([item.entry.path]);
        entry.status = "moved";
        movedItems++;
        movedBytes += item.entry.sizeBytes;
      } catch (err) {
        entry.status = "failed";
        failures.push(`${item.entry.path}: ${err.message}`);
      }
    }
    await this.deps.undo.commit(record);
    return { planId: plan.id, mode: "recycle", movedItems, movedBytes, undoRecordId: record.id, failures };
  }
};
var PermanentDeletionExecutor = class {
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  async executePermanent(req) {
    if (req.confirmed_permanent !== true) throw new PlanRejectedError("\u6C38\u4E45\u5220\u9664\u5FC5\u987B\u663E\u5F0F confirmed_permanent=true");
    const plan = req.plan;
    guardPlanOrThrow(plan, this.deps.userProtectedPaths);
    const items = plan.items.filter((i) => !i.blocked && i.action !== "skip");
    const failures = [];
    let movedItems = 0;
    let movedBytes = 0;
    await fs6.mkdir(path6.dirname(this.deps.auditLogPath), { recursive: true });
    const auditLine = (phase, detail) => `${(/* @__PURE__ */ new Date()).toISOString()}	${phase}	plan=${plan.id}	items=${detail.movedItems}/${items.length}	bytes=${detail.movedBytes}	${items.map((i) => i.entry.path).join(" | ")}
`;
    await fs6.appendFile(this.deps.auditLogPath, auditLine("PERMANENT-INTENT", { movedItems: 0, movedBytes: 0 }), "utf8");
    const deletedAt = (/* @__PURE__ */ new Date()).toISOString();
    for (const item of items) {
      try {
        await fs6.rm(item.entry.path, { recursive: true, force: false, maxRetries: 2 });
        movedItems++;
        movedBytes += item.entry.sizeBytes;
      } catch (err) {
        failures.push(`${item.entry.path}: ${err.message}`);
      }
    }
    try {
      await fs6.appendFile(this.deps.auditLogPath, auditLine("PERMANENT-DONE", { movedItems, movedBytes }) + `	deletedAt=${deletedAt}
`, "utf8");
    } catch {
    }
    return { planId: plan.id, mode: "permanent", movedItems, movedBytes, undoRecordId: "", failures };
  }
};
function guardPlan(plan, userProtected) {
  const violations = [];
  for (const item of plan.items) {
    if (item.action === "skip") continue;
    try {
      assertDeletable(item.entry.path, userProtected, true);
    } catch (err) {
      violations.push(`${item.entry.path}: ${err.message}`);
    }
  }
  return violations;
}
export {
  ACTION_ORDER,
  BlockedPathError,
  FAIL_CLOSED_ASSESSMENT,
  ManifestUndoManager,
  NotImplementedError,
  PermanentDeletionExecutor,
  PlanRejectedError,
  RISK_ORDER,
  RecycleBinExecutor,
  SYSTEM_PROTECTED_EXACT,
  SYSTEM_PROTECTED_FILES,
  SYSTEM_PROTECTED_PREFIXES,
  ScanCancelledSignal,
  StagingCapacityError,
  StagingExecutor,
  assertDeletable,
  assessEntry,
  buildPlan,
  defaultConfig,
  dirUsageBytes,
  formatBytes,
  globToRegExp,
  guardPlan,
  isProtectedPath,
  loadConfig,
  loadPackWithOverlay,
  overlayPath,
  reversibilityLabel,
  riskLabel,
  scan,
  stagingRootFor,
  suggestSelection,
  userConfigPath,
  validateRulePack,
  writeScanReport
};
