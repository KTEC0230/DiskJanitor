// 渲染层逻辑:无框架 vanilla JS。UI 三原则:
//   1. 名称/路径/大小同一视觉层级;
//   2. 风险 = 文字标签 + 非颜色信号(○◐◆ + 边框样式),颜色只是辅助;
//   3. 执行按钮文案 = 计划汇总文本(如「将 3 项移入 staging(1.2 MB)」),禁止"确定/继续"。
// 列表为定高虚拟滚动:可见区按 scrollTop 窗口化,支撑数万行。

const RISK_BADGE = { low: ['○ 低风险', 'low'], medium: ['◐ 中风险', 'mid'], high: ['◆ 高风险', 'high'] };
const REVERS_LABEL = { regenerable: '可重新生成', recoverable: '可恢复', irreplaceable: '不可替代' };
const CAT_ORDER = { recycle: 0, stage: 1, skip: 2 };
const ROW_H = 26;
// 资源管理器式单击/双击判定:单击挂起 260ms,二击 = 打开
let pendingClick = null;
function commitClick(pc) {
  if (!pc) return;
  if (pc.prev) state.selected.add(pc.path); else state.selected.delete(pc.path);
  renderWindow();
  refreshPlanPreview();
}

const state = {
  root: null,
  rowsByPath: new Map(),
  childrenByParent: new Map(),
  expanded: new Set(),
  selected: new Set(),
  mode: 'stage',
  scanning: false,
  paused: false,
  viewMode: 'tree', // 'tree' | 'actionable'
  visible: [], // 当前视图的扁平行 [{row, indent}]
};

const $ = id => document.getElementById(id);

// ---------- 工具 ----------
function fmt(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
/** 父路径;盘根子项特殊:c:/x 的父是 c:/ 而不是 c:(大小写不敏感,norm 保留原盘符大小写) */
function parentOf(p) {
  const i = p.lastIndexOf('/');
  let par = i > 0 ? p.slice(0, i) : null;
  if (par && /^[a-z]:$/i.test(par)) par += '/';
  return par;
}
function actionable(row) {
  const a = row.assessment;
  return a.ruleId !== null && a.suggestedAction !== 'skip' && a.reversibility !== 'irreplaceable';
}

// ---------- 扫描流程 ----------
async function doScan(root) {
  state.scanning = true;
  state.paused = false;
  setScanButtons();
  progressActive(true);
  $('listViewport').querySelector('#listRoot').innerHTML = '';
  state.rowsByPath.clear(); state.childrenByParent.clear();
  state.expanded.clear(); state.selected.clear();
  state.visible = [];
  const t0 = Date.now();
  try {
    const res = await window.dj.scan(root, 3);
    state.root = res.snapshot.root;
    ingestRows(res.rows);
    // 规则默认勾选(仅顶层;可再生缓存)
    for (const p of state.childrenByParent.get(state.root) ?? []) {
      const r = state.rowsByPath.get(p);
      if (actionable(r) && r.assessment.defaultChecked) state.selected.add(p);
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const t = res.snapshot.totals;
    const cancelledNote = res.snapshot.cancelled ? '(已停止,以下为部分结果)' : '';
    setStatus(`${t.files} 文件 / ${t.dirs} 目录 / ${fmt(t.bytes)} — 用时 ${elapsed}s ${cancelledNote}`);
    renderCategoryBar();
    recomputeVisible();
    renderWindow();
    refreshPlanPreview();
  } catch (err) {
    setStatus('扫描失败: ' + (err.message ?? err));
  } finally {
    state.scanning = false;
    state.paused = false;
    setScanButtons();
    progressActive(false);
  }
}

window.dj.onScanProgress(({ bytes, path }) => {
  if (!state.scanning) return;
  setStatus(`扫描中… ${fmt(bytes)} — ${path}`);
});

function setStatus(text) { $('scanStatus').textContent = text; }
function progressActive(on) {
  const f = $('progressFill');
  f.classList.toggle('hidden', !on);
  f.classList.toggle('active', on);
  f.classList.toggle('stopped', false);
}
function setScanButtons() {
  $('scanBtn').classList.toggle('hidden', state.scanning);
  $('pickBtn').disabled = state.scanning;
  $('rootInput').disabled = state.scanning;
  $('pauseBtn').classList.toggle('hidden', !state.scanning);
  $('stopBtn').classList.toggle('hidden', !state.scanning);
  $('pauseBtn').textContent = state.paused ? '继续' : '暂停';
  // 扫描进行中禁止导出报告:rowMap 是半成品,lastScan 还是上一次的,会生成误导性报告
  $('exportBtn').disabled = state.scanning;
}

function ingestRows(rows) {
  for (const r of rows) {
    state.rowsByPath.set(r.path, r);
    const p = parentOf(r.path) ?? '__ROOT__';
    if (!state.childrenByParent.has(p)) state.childrenByParent.set(p, []);
    state.childrenByParent.get(p).push(r.path);
  }
}

// ---------- 虚拟滚动列表 ----------
function sortKids(paths) {
  return paths.slice().sort((a, b) => {
    const ra = state.rowsByPath.get(a), rb = state.rowsByPath.get(b);
    return CAT_ORDER[rb.assessment.suggestedAction] - CAT_ORDER[ra.assessment.suggestedAction] || rb.sizeBytes - ra.sizeBytes;
  });
}

function recomputeVisible() {
  const out = [];
  if (state.viewMode === 'actionable') {
    // 建议清理视图:全部规则命中可执行条目,平铺按大小降序
    for (const r of [...state.rowsByPath.values()].filter(r => actionable(r)).sort((a, b) => b.sizeBytes - a.sizeBytes)) {
      out.push({ row: r, indent: 0 });
    }
  } else {
    const walk = (parent, indent) => {
      const kids = state.childrenByParent.get(parent) ?? [];
      for (const p of sortKids(kids)) {
        if (p === parent) continue; // 盘根自引用防护(parentOf(C:/x) 修复后根会挂到自身)
        if (p === state.root) continue; // 根自身不是清理对象,不进列表
        const r = state.rowsByPath.get(p);
        out.push({ row: r, indent });
        if (r.kind === 'dir' && state.expanded.has(p)) walk(p, indent + 1);
      }
    };
    walk(state.root ?? '__ROOT__', 0);
  }
  state.visible = out;
  $('listSpacer').style.height = `${out.length * ROW_H}px`;
}

let rafPending = false;
function renderWindow() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const vp = $('listViewport');
    const total = state.visible.length;
    const first = Math.max(0, Math.floor(vp.scrollTop / ROW_H) - 4);
    const last = Math.min(total, Math.ceil((vp.scrollTop + vp.clientHeight) / ROW_H) + 4);
    const root = $('listRoot');
    root.innerHTML = '';
    for (let i = first; i < last; i++) root.appendChild(vrowEl(state.visible[i].row, state.visible[i].indent, i * ROW_H));
  });
}

function vrowEl(r, indent, top) {
  const div = document.createElement('div');
  div.className = 'vrow';
  div.style.top = `${top}px`;
  div.style.paddingLeft = `${10 + indent * 18}px`;

  // 未识别(规则未命中)= 中性灰,不恐吓;执行语义仍是 fail-closed(默认不动)
  const unknown = r.assessment.ruleId === null;
  const [label, cls] = unknown ? ['◇ 未识别', 'unk'] : (RISK_BADGE[r.assessment.riskLevel] ?? ['? ', 'high']);
  const canAct = actionable(r);

  const tw = document.createElement('span');
  tw.className = 'twistie';
  tw.textContent = (state.viewMode === 'tree' && r.kind === 'dir') ? (state.expanded.has(r.path) ? '▾' : '▸') : '';
  if (tw.textContent) tw.onclick = e => { e.stopPropagation(); toggleExpand(r); };
  div.appendChild(tw);

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = state.selected.has(r.path);
  if (!canAct) {
    cb.disabled = true;
    cb.title = unknown
      ? '规则未识别,fail-closed 默认不动;确属缓存可在「规则覆盖(TOML)」里添加规则'
      : `本版不支持清理: ${r.assessment.rationale}`;
    div.classList.add('child-locked');
  } else {
    if (r.assessment.defaultChecked) cb.title = '规则默认勾选(可重新生成)';
    cb.onclick = e => e.stopPropagation();
    cb.onchange = () => {
      if (cb.checked) state.selected.add(r.path); else state.selected.delete(r.path);
      refreshPlanPreview();
    };
  }
  div.appendChild(cb);

  // 资源管理器式交互:单击行 = 勾选/取消(260ms 内二击 = 双击打开)
  div.onclick = e => {
    if (e.target.closest('.twistie') || e.target.type === 'checkbox') return;
    if (!canAct) return;
    if (e.detail >= 2) {
      // 双击的第二次 click:撤销挂起的单击变化,打开
      if (pendingClick && pendingClick.path === r.path) {
        clearTimeout(pendingClick.timer);
        if (pendingClick.prev) state.selected.add(r.path); else state.selected.delete(r.path);
        pendingClick = null;
      }
      window.dj.reveal(r.path);
      renderWindow(); refreshPlanPreview();
      return;
    }
    if (pendingClick && pendingClick.path !== r.path) {
      // 点击了不同行:先提交上一行的单击
      clearTimeout(pendingClick.timer);
      commitClick(pendingClick);
      pendingClick = null;
    }
    const prev = state.selected.has(r.path);
    pendingClick = { path: r.path, prev, timer: setTimeout(() => { commitClick(pendingClick); pendingClick = null; }, 260) };
  };

  const badge = document.createElement('span');
  badge.className = `badge ${cls}`;
  badge.textContent = unknown ? '◇ 未识别 · 默认不动' : `${label} · ${REVERS_LABEL[r.assessment.reversibility]}`;
  badge.title = r.assessment.rationale;
  div.appendChild(badge);

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = r.name;
  div.appendChild(name);

  const pathSpan = document.createElement('span');
  pathSpan.className = 'path';
  pathSpan.textContent = r.path;
  pathSpan.title = r.path;
  div.appendChild(pathSpan);

  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = fmt(r.sizeBytes);
  div.appendChild(size);

  const rule = document.createElement('span');
  rule.className = 'rule';
  rule.textContent = r.assessment.ruleId ? `规则 ${r.assessment.ruleId}` : '未识别';
  rule.title = `${r.assessment.rationale}${r.assessment.ruleId ? `(规则 ${r.assessment.ruleId})` : ''}`;
  div.appendChild(rule);
  return div;
}

async function toggleExpand(r) {
  if (r.kind !== 'dir') return;
  if (state.expanded.has(r.path)) {
    state.expanded.delete(r.path);
  } else {
    state.expanded.add(r.path);
    const kids = state.childrenByParent.get(r.path) ?? [];
    if (kids.length === 0 && r.depth >= 3) {
      setStatus('展开扫描中… ' + r.path);
      const res = await window.dj.expand(r.path, 2);
      ingestRows(res.rows);
      renderCategoryBar();
      setStatus('');
    }
  }
  recomputeVisible();
  renderWindow();
}

function renderCategoryBar() {
  const c = { actionable: 0, skipped: 0, unknown: 0 };
  for (const r of state.rowsByPath.values()) {
    const a = r.assessment;
    if (a.ruleId === null) c.unknown++;
    else if (a.suggestedAction === 'skip') c.skipped++;
    else c.actionable++;
  }
  $('catBar').innerHTML =
    `<span>建议清理 <b>${c.actionable}</b></span>` +
    `<span>需用户决定/不可执行 <b>${c.skipped}</b></span>` +
    `<span>规则未识别(默认不动) <b>${c.unknown}</b></span>`;
}

// ---------- 计划预览与执行 ----------
let planDebounce = null;
function refreshPlanPreview() {
  clearTimeout(planDebounce);
  planDebounce = setTimeout(async () => {
    const paths = [...state.selected];
    if (paths.length === 0) {
      $('planSummary').textContent = '尚未选择';
      $('execBtn').disabled = true;
      return;
    }
    const plan = await window.dj.plan(paths, state.mode);
    $('planSummary').textContent = `通道: ${state.mode === 'stage' ? 'staging(可撤销)' : '系统回收站'} — ${plan.summaryText}`;
    const btn = $('execBtn');
    btn.textContent = plan.summaryText;
    btn.disabled = false;
  }, 250);
}

function showModal(html, actions) {
  $('modalBody').innerHTML = html;
  const box = $('modalActions');
  box.innerHTML = '';
  for (const [label, cls, fn] of actions) {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    b.onclick = () => { fn?.(); };
    box.appendChild(b);
  }
  $('modal').classList.remove('hidden');
}
function hideModal() { $('modal').classList.add('hidden'); }

async function onExecute() {
  const paths = [...state.selected];
  if (paths.length === 0) return;
  const plan = await window.dj.plan(paths, state.mode);
  const irreplace = paths.filter(p => state.rowsByPath.get(p)?.assessment.reversibility === 'irreplaceable');
  const blocked = plan.totals.blockedItems;
  let html = `<h3>即将执行</h3><p class="mono">${plan.summaryText}</p>`;
  html += `<table><tr><th>类别</th><th>数量</th><th>字节</th></tr>
    <tr><td>移入回收站</td><td>${plan.totals.recycleItems}</td><td class="mono">${fmt(plan.totals.recycleBytes)}</td></tr>
    <tr><td>移入 staging</td><td>${plan.totals.stageItems}</td><td class="mono">${fmt(plan.totals.stageBytes)}</td></tr>
    <tr><td>被保护名单拦截</td><td>${plan.totals.blockedItems}</td><td>—</td></tr>
    <tr><td>待决定(不执行)</td><td>${plan.totals.skippedItems}</td><td>—</td></tr></table>`;
  if (irreplace.length > 0) html += `<p class="warn-irreplaceable">⚠ 选择中含 ${irreplace.length} 项不可替代数据 —— 这些项已被强制排除,不会执行。</p>`;
  if (blocked > 0) html += `<p class="warn-irreplaceable">⊘ ${blocked} 项命中保护名单,将在执行层拦截。</p>`;
  html += `<p class="hint">撤销方式:完成后在「撤销面板」一键恢复;staging 记录跨重启有效。</p>`;
  showModal(html, [
    ['取消', '', hideModal],
    [plan.summaryText, 'primary', async () => {
      hideModal();
      setStatus('执行中…');
      try {
        const { receipt } = await window.dj.execute(paths, state.mode);
        state.selected.clear();
        await showReceiptModal(receipt);
      } catch (err) {
        showModal(`<h3>执行失败</h3><p class="err-text mono">${String(err.message ?? err)}</p>`, [['关闭', '', hideModal]]);
      }
      setStatus('');
      refreshPlanPreview();
    }],
  ]);
}

async function showReceiptModal(receipt) {
  let html = `<h3>执行完成</h3>
    <p>移动 <b>${receipt.movedItems}</b> 项 / <b>${fmt(receipt.movedBytes)}</b></p>`;
  if (receipt.failures.length > 0) {
    html += `<p class="err-text">失败 ${receipt.failures.length} 项:</p><pre class="mono">${receipt.failures.join('\n')}</pre>`;
  }
  if (receipt.undoRecordId) {
    html += `<p>撤销记录 <span class="mono">${receipt.undoRecordId}</span> —— 可在「撤销面板」恢复</p>`;
    showModal(html, [
      ['立即撤销', '', async () => {
        const r = await window.dj.undo(receipt.undoRecordId);
        showModal(`<h3>撤销完成</h3><p>恢复 <b>${r.restoredItems}</b> 项${r.failures.length ? `;未恢复 ${r.failures.length} 项` : ''}</p>`, [['关闭', '', hideModal]]);
        await doScan(state.root);
      }],
      ['关闭', '', hideModal],
    ]);
  } else {
    showModal(html, [['关闭', '', hideModal]]);
  }
  await doScan(state.root);
}

// ---------- 撤销面板 + 暂存区管理 ----------
async function renderUndo() {
  const root = $('undoRoot');
  try {
    console.log('[dj] renderUndo start');
    const records = await window.dj.undoList();
    console.log('[dj] undoList =', records.length);
    const usage = await window.dj.stagingUsage();
    console.log('[dj] stagingUsage =', JSON.stringify(usage));
    const committed = records.filter(r => r.status === 'committed' && r.mode === 'stage');
    const entriesOf = r => r.entries ?? []; // undo-list 返回瘦身对象(movable/movableBytes),无 entries
    const pendingBytes = usage.reduce((s, u) => s + u.bytes, 0);
    const pendingItems = committed.reduce((s, r) => s + entriesOf(r).filter(e => e.status === 'moved').length, 0);
    const pendingGB = committed.reduce((s, r) => s + entriesOf(r).filter(e => e.status === 'moved').reduce((x, e) => x + e.sizeBytes, 0), 0);

    root.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'staging-head';
    head.innerHTML =
      `<span>暂存区占用:${usage.map(u => `${u.root.split('/')[0]}: ${fmt(u.bytes)}`).join(' · ') || '(空)'} — 共 ${fmt(pendingBytes)}</span>` +
      (committed.length > 0
        ? `<button id="purgeAllBtn" class="danger">清空全部暂存(永久删除 ${pendingItems} 项 / ${fmt(pendingGB)})</button>`
        : '');
    root.appendChild(head);
    head.querySelector('#purgeAllBtn')?.addEventListener('click', () => purgeAll(pendingItems, pendingGB));

    if (records.length === 0) { root.insertAdjacentHTML('beforeend', '<div class="row"><span class="path">(无撤销记录 —— 执行清理后,批次会出现在这里供撤销或永久删除)</span></div>'); return; }
    for (const r of records) {
      const moved = r.entries ? r.entries.filter(e => e.status === 'moved').length : r.movable;
      const bytes = r.entries ? r.entries.filter(e => e.status === 'moved').reduce((s, e) => s + e.sizeBytes, 0) : r.movableBytes;
      const div = document.createElement('div');
      div.className = 'row';
      div.innerHTML = `
        <span class="badge ${r.mode === 'stage' ? 'low' : 'mid'}">${r.mode}</span>
        <span class="name">${r.status}</span>
        <span class="path mono">${r.id} · plan ${r.planId}</span>
        <span class="size">${moved} 项 / ${fmt(bytes)}</span>
        <span class="rule">${r.createdAt}</span>`;
    if (r.status === 'committed' && moved > 0) {
      const u = document.createElement('button');
      u.textContent = `撤销`;
      u.title = '移回原位(可逆)';
      u.onclick = async () => {
        const res = await window.dj.undo(r.id);
        showModal(`<h3>撤销完成</h3><p>恢复 <b>${res.restoredItems}</b> 项${res.failures.length ? `;未恢复 ${res.failures.length} 项:<pre class="mono">${res.failures.join('\n')}</pre>` : ''}</p>`, [['关闭', '', hideModal]]);
        renderUndo();
      };
      div.appendChild(u);
      if (r.mode === 'stage') {
        const p = document.createElement('button');
        p.className = 'danger';
        p.textContent = `永久删除 ${moved} 项(${fmt(bytes)})`;
        p.title = '删除暂存副本,放弃撤销权,空间真正释放 —— 不可恢复';
        p.onclick = () => purgeOne(r.id, moved, bytes);
        div.appendChild(p);
      } else {
        const hint = document.createElement('span');
        hint.className = 'rule';
        hint.textContent = '文件在系统回收站内,清空回收站即最终删除';
        div.appendChild(hint);
      }
    }
      root.appendChild(div);
    }
    console.log('[dj] renderUndo done');
  } catch (err) {
    root.innerHTML = `<div class="row"><span class="path err-text">撤销面板加载失败: ${String(err?.message ?? err).replaceAll('<', '&lt;')}</span></div>`;
    console.error('[dj] renderUndo failed:', err);
  }
}

async function purgeOne(id, items, bytes) {
  showModal(
    `<h3 class="warn-irreplaceable">⚠ 永久删除(不可恢复)</h3>
     <p>将删除暂存批次 <span class="mono">${id}</span> 中的 <b>${items} 项 / ${fmt(bytes)}</b>。</p>
     <p class="hint">这是"删除必可逆"原则中唯一放弃撤销权的操作:删除后这些清理项无法再恢复,空间立即释放。审计会留痕。</p>`,
    [
      ['取消', '', hideModal],
      [`永久删除 ${items} 项(${fmt(bytes)})`, 'danger', async () => {
        hideModal();
        const res = await window.dj.purgeBatch(id);
        showModal(`<h3>已永久删除</h3><p>释放 <b>${fmt(res.freedBytes)}</b>${res.failures.length ? `;失败 ${res.failures.length} 项:<pre class="mono">${res.failures.join('\n')}</pre>` : ''}</p>`, [['关闭', '', hideModal]]);
        renderUndo();
      }],
    ],
  );
}

async function purgeAll(items, bytes) {
  showModal(
    `<h3 class="warn-irreplaceable">⚠ 清空全部暂存(不可恢复)</h3>
     <p>将永久删除全部暂存批次中的 <b>${items} 项 / ${fmt(bytes)}</b>。</p>
     <p class="hint">建议:执行清理后先正常使用电脑一段时间,确认一切正常,再回来清空暂存。</p>`,
    [
      ['取消,我再想想', '', hideModal],
      [`永久删除 ${items} 项(${fmt(bytes)})`, 'danger', async () => {
        hideModal();
        setStatus('清空暂存中…');
        const res = await window.dj.purgeAll();
        setStatus('');
        showModal(`<h3>已清空</h3><p>永久删除 ${res.count} 个批次,释放 <b>${fmt(res.freedBytes)}</b>${res.failures.length ? `;失败 ${res.failures.length} 项:<pre class="mono">${res.failures.join('\n')}</pre>` : ''}</p>`, [['关闭', '', hideModal]]);
        renderUndo();
      }],
    ],
  );
}

// ---------- 规则覆盖编辑器 ----------
async function loadOverlay() {
  const o = await window.dj.overlayLoad();
  $('overlayText').value = o.text;
  setOverlayStatus(o.valid, o.errors, o.applied, o.path);
}
function setOverlayStatus(valid, errors, applied, path) {
  const el = $('overlayStatus');
  if (valid) {
    el.className = 'valid';
    el.textContent = `✓ 有效;已生效 ${applied.length} 项${applied.length ? ':' + applied.join('、') : ''}(${path})`;
  } else {
    el.className = 'invalid';
    el.textContent = '✗ 校验失败:' + errors.join(' ; ');
  }
}
async function saveOverlay() {
  const res = await window.dj.overlaySave($('overlayText').value);
  setOverlayStatus(res.valid, res.errors, res.applied, await (await window.dj.overlayLoad()).path);
  if (res.valid) setStatus('overlay 已生效,重新扫描即应用');
}

// ---------- 视图切换 / 全选 / 导出报告 ----------
function setView(mode) {
  state.viewMode = mode;
  $('viewTree').classList.toggle('active', mode === 'tree');
  $('viewClean').classList.toggle('active', mode === 'actionable');
  recomputeVisible();
  renderWindow();
}
$('viewTree').onclick = () => setView('tree');
$('viewClean').onclick = () => setView('actionable');

$('selectAllBtn').onclick = () => {
  for (const r of state.rowsByPath.values()) {
    if (actionable(r)) state.selected.add(r.path);
  }
  renderWindow();
  refreshPlanPreview();
};
$('clearSelBtn').onclick = () => {
  state.selected.clear();
  renderWindow();
  refreshPlanPreview();
};

$('exportBtn').onclick = async () => {
  if (!state.root) { setStatus('请先扫描再导出报告'); return; }
  const outDir = await window.dj.pickDirectory();
  if (!outDir) return;
  setStatus('报告生成中…');
  try {
    const res = await window.dj.exportReport(outDir);
    setStatus('');
    showModal(
      `<h3>报告已导出</h3>
       <p>本次扫描 ${res.counts.actionable} 项建议清理 / ${res.counts.skipped} 项需确认 / ${res.counts.unknown} 项未识别(md 中列出 ≥10MB 的 ${res.counts.unknownListed} 条,全量在 json)。</p>
       <p class="hint">把 <b>.md</b> 文件发给 AI 即可做未识别条目的二次分析;AI 判定结果可用「规则覆盖(TOML)」固化成规则,下次扫描直接生效。</p>
       <p class="mono">${res.mdPath}</p>
       <p class="mono">${res.jsonPath}</p>`,
      [
        ['打开所在文件夹', '', async () => { await window.dj.reveal(res.mdPath); }],
        ['关闭', '', hideModal],
      ],
    );
  } catch (err) {
    setStatus('');
    showModal(`<h3>导出失败</h3><p class="err-text mono">${String(err.message ?? err)}</p>`, [['关闭', '', hideModal]]);
  }
};

// ---------- 绑定 ----------
$('pickBtn').onclick = async () => {
  const dir = await window.dj.pickDirectory();
  if (dir) { $('rootInput').value = dir; await doScan(dir); }
};
$('scanBtn').onclick = () => { const d = $('rootInput').value.trim(); if (d) doScan(d); };
$('rootInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !state.scanning) $('scanBtn').onclick(); });
$('pauseBtn').onclick = async () => {
  if (state.paused) { await window.dj.scanResume(); state.paused = false; setStatus('扫描中…(继续)'); }
  else { await window.dj.scanPause(); state.paused = true; setStatus('已暂停'); }
  setScanButtons();
};
$('stopBtn').onclick = async () => {
  await window.dj.scanCancel();
  setStatus('停止中…');
};
$('execBtn').onclick = onExecute;
$('undoRefresh').onclick = renderUndo;
$('overlaySave').onclick = saveOverlay;
$('listViewport').addEventListener('scroll', renderWindow, { passive: true });
window.addEventListener('resize', renderWindow);

document.querySelectorAll('.tab').forEach(t => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tab-body').forEach(x => x.classList.toggle('active', x.id === `tab-${t.dataset.tab}`));
    if (t.dataset.tab === 'undo') renderUndo();
    if (t.dataset.tab === 'overlay') loadOverlay();
  };
});
