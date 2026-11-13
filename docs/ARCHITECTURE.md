# DiskJanitor 架构文档

磁盘清理桌面应用。核心原则:**分析只读,删除必可逆**。

## 0. 硬约束(逐条落实位置)

| 硬约束 | 落实位置 |
|---|---|
| 扫描绝不修改文件系统;分析引擎不持写权限 | `core/src/scanner.ts` 只用 `fs.lstat/readdir`;模块头禁止 import 删除类模块 |
| 默认清理 = staging(2026-11-09 决策);回收站为可选通道;永久删除独立 + 显式二次确认 | `executor.ts`:`StagingExecutor`(默认)/ `RecycleBinExecutor`(可选)与 `PermanentDeletionExecutor`(独立类,`confirmed_permanent: true` 类型强制)三轨分离 |
| 所有默认删除支持 undo,撤销记录跨重启持久化 | `undo-manager.ts`:manifest JSON 落盘 `%APPDATA%\DiskJanitor\undo\`;`begin()` 在动文件系统**之前**写入;跨重启重建 manager 仍可撤销(selftest 已验证) |
| 每条规则携带风险等级 + 可逆性标记 | `rules-schema.ts`:`risk_level` × `reversibility` 必填,校验器强制 irreplaceable ⇒ default_checked=false |
| 受保护路径在执行层拦截,不依赖 UI | `protected-paths.ts`:`assertDeletable` 是每个 Executor 的准入闸门;伪造 blocked=false 的计划也会被兜住(selftest [5] 已验证) |
| 规则未命中 fail-closed | `risk-engine.ts`:高风险/不可替代/skip/不勾选 |
| 规则只能收紧不能放宽(2026-11-09 决策) | `rules-overlay.ts`:overlay 仅允许 disable / 收紧 override / 追加保守规则;放宽被显式拒绝(双向验证通过) |

## 1. 调研结论(2026-11-08)

| 项目 | 借鉴点 | 链接 |
|---|---|---|
| trash-rs (Rust) | Windows 支持 `delete`/`list`/`restore_all` —— 证明回收站内程序化恢复可行;将来 Rust sidecar 备选 | https://github.com/Byron/trash-rs |
| sindresorhus/trash (npm) | Windows 回收站写入开箱即用(**只进不出** → 撤销必须自建 staging manifest);被采纳为执行层唯一外部依赖 | https://github.com/sindresorhus/trash |
| BleachBit CleanerML | 声明式规则包,每条 action 可带 warning —— 印证"规则自带风险标记" | https://docs.bleachbit.org/cml/cleanerml |
| Czkawka | core 与 GUI/CLI 前端代码级分离;它默认永久删除 —— 我们反着来 | https://github.com/qarmin/czkawka |

## 2. 技术栈与通道决策(2026-11-09 用户确认)

**Electron + TypeScript**:本机 Node v26.12.1 + pnpm 12.6 齐备,Node 26 原生剥离 TS 类型(仅可擦除语法);core 分析层保持 node: 内置零依赖,执行层唯一外部依赖 = npm `trash`(10.1.1)。

**四项已决**:
1. **默认通道 = staging**;回收站为显式可选(Shell 还原,尽力而为)
2. **staging 按卷根放置** `<卷>:\DiskJanitorStaging`(attrib +h 隐藏):保证 rename 原子性、零跨卷拷贝;默认上限 20GB/卷,超限**整计划拒绝**(all-or-nothing);config 可覆盖(`%APPDATA%\DiskJanitor\config.json`)
3. **规则用户级覆盖 = 受限叠加**:TOML overlay(`%APPDATA%\DiskJanitor\rules.overlay.toml`)仅允许 disable / 收紧 override(default_checked→false、action→stage|skip、risk 上调)/ 追加规则(必须 conservative:不默认勾选、action∈{stage,skip}、risk≥medium);放宽即报错;`protected_paths` 仅增不减。内置 JSON 只读,随应用更新
4. **不做 AI 解释**:RiskEngine 纯规则 + fail-closed,砍掉 AI 钩子,软件保持精简

## 3. 模块目录树

```
DiskJanitor/
├── AGENTS.md                  # 交接文档(唯一状态文档)
├── docs/ARCHITECTURE.md       # 本文
├── package.json               # type:module;依赖仅 trash
├── core/src/                  # 核心层(UI 无关)
│   ├── types.ts               # 领域类型(readonly 不可变)+ formatBytes
│   ├── rules-schema.ts        # 规则包 schema + 校验(irreplaceable⇒不默认勾选)
│   ├── rules-overlay.ts       # 受限叠加覆盖(disable/收紧/追加,放宽即拒)
│   ├── toml.ts                # 极小 TOML 子集解析(标量/数组/内联表/表/表数组,非法语法报错)
│   ├── config.ts              # 默认配置 + %APPDATA% 用户覆盖;stagingRootFor(按卷)
│   ├── protected-paths.ts     # 保护名单四类:系统前缀/系统仅全等/系统文件/卷根 + 用户名单
│   ├── errors.ts              # BlockedPathError/StagingCapacityError/PlanRejectedError/...
│   ├── scanner.ts             # Scanner:scan(root, opts) -> Snapshot   [纯读]
│   ├── risk-engine.ts         # RiskEngine:assessEntry(entry, pack) -> RiskAssessment [纯规则]
│   ├── planner.ts             # Planner:buildPlan(selected, assessments) -> DeletionPlan
│   ├── executor.ts            # StagingExecutor / RecycleBinExecutor / PermanentDeletionExecutor
│   └── undo-manager.ts        # ManifestUndoManager(begin 先落盘 / undo Shell 还原)
├── rules/default-rules.json   # 内置规则包 v1(17 条,只读)
└── tools/
    ├── dry-run.mjs            # 纯读预览:扫描→规则→计划→四类打印
    ├── apply.mjs              # 执行:确认文案必须逐字匹配计划汇总(--confirm)
    ├── undo.mjs               # list / <id> 撤销
    └── selftest.mjs           # 全链路自检(隔离目录,23 项断言)
```

## 4. 公开接口签名(权威定义在源码)

```ts
// Scanner(纯读)
scan(root: string, opts?: { maxDepth?; concurrency?; onProgress? }): Promise<Snapshot>

// RiskEngine(纯函数,无 AI)
assessEntry(entry: FsEntry, pack: RulePack, opts?: { fallback? }): RiskAssessment

// Planner
buildPlan(selected: readonly FsEntry[], assessments: ReadonlyMap<string, RiskAssessment>,
          opts?: { dryRun?; userProtectedPaths? }): DeletionPlan

// 规则包加载(内置 + 受限叠加)
loadPackWithOverlay(builtinPath: string): Promise<
  { ok: true; pack: RulePack; applied: string[]; overlayFile: string | null } |
  { ok: false; errors: string[]; overlayFile: string }>

// Executor(默认可逆;只收 plan 对象;执行前 assertDeletable 复检 + UndoManager.begin 先落盘)
class StagingExecutor   { execute(plan, 'stage'): Promise<ExecutionReceipt> }
class RecycleBinExecutor{ execute(plan, 'recycle'): Promise<ExecutionReceipt> }

// 永久删除(独立类;两段审计 PERMANENT-INTENT/DONE;无撤销句柄)
class PermanentDeletionExecutor { executePermanent({ plan, confirmed_permanent: true }): Promise<ExecutionReceipt> }

// UndoManager(持久化 %APPDATA%\DiskJanitor\undo\<id>.json)
class ManifestUndoManager {
  begin(plan, mode): Promise<UndoRecord>;   // 执行前
  commit(record): Promise<void>;            // 执行后
  undo(undoRecordId): Promise<UndoReceipt>; // stage=rename 回原位(不覆盖);recycle=Shell 还原
  list(): Promise<UndoRecord[]>;            // 跨重启
}

// 执行层闸门
assertDeletable(path, userProtected, execLayer?): void  // throws BlockedPathError
```

## 5. 数据流

```
            ┌──────── 只读分析路径(零写权限、零 npm 依赖)────────┐
磁盘/目录 ─▶ Scanner ─▶ Snapshot(不可变) ─▶ RiskEngine(纯规则) ─▶ RiskAssessment[]
                                    ▲ 内置规则包(只读)+ TOML 受限叠加(只能收紧)
            └──────────────────────────────────────────────────────┘
                                    │ 用户勾选(默认勾选随规则;不可替代项强制不勾选)
                                    ▼
                              Planner ──▶ DeletionPlan(blocked 项/逐项风险/summaryText)
                                    │ UI 确认按钮必须显示 summaryText
                                    ▼
            ┌──────── 执行路径(唯一写权限)────────────────────────┤
                                    ▼
   UndoManager.begin(先落盘 manifest)─▶ Executor 选通道:
       stage(默认)   : <卷>:\DiskJanitorStaging\<planId>\...   rename,容量上限,all-or-nothing
       recycle(可选) : npm trash ─▶ 系统回收站
       每一步前 assertDeletable 复检(不信任 UI/Planner)
                                    ▼
                        ExecutionReceipt + commit(record)
                                    ▼
                  UndoManager.undo(recordId):stage=rename 回原位(碰撞不覆盖);
                  recycle=Shell.Application 按 父目录+条目名 匹配还原(尽力而为)
                                    ▼
   永久删除 = 独立类 PermanentDeletionExecutor,须显式 confirmed_permanent=true,
   两段审计(INTENT 在删前落盘,唯一权威留痕),不可撤销。
```

## 6. staging 布局与容量

- 每卷一个根:`C:\DiskJanitorStaging`、`D:\DiskJanitorStaging`…(attrib +h);卷级覆盖经 config
- 批次目录 = `<root>/<planId>/`,条目 = `<0001序号>_<原名>`(无碰撞)
- 容量:执行前按卷统计现用量 + 计划量 vs `maxBytesPerVolume`(默认 20GB),超限整计划拒绝、不产生任何撤销记录
- 撤销后空批次目录自动清理

## 7. 验证记录

**M1 dry-run(2026-11-08)**:`C:\Users\27025\AppData\Local` 17.1s / 248,374 文件 / 26.48GB,四类输出正确;发现并修复 `C:\Users` 前缀误拦、评估深度与规则粒度错位两个设计 bug。

**M2 selftest(2026-11-09):23 PASS / 0 FAIL**,覆盖:
- stage→undo 往返(嵌套目录、CJK 文件、**跨重启重建 manager 仍可撤销**、空批次清理)
- recycle→Shell 还原(真实还原成功;碰撞预检跳过)
- 永久删除独立类(缺 `confirmed_permanent` 拒绝、INTENT/DONE 两段审计)
- 容量 all-or-nothing 拒绝(拒绝时零副作用、零撤销记录)
- 执行层拦截:伪造 `blocked=false` 计划绕过 Planner,仍被 `assertDeletable` 兜住
- 受限叠加双向:收紧(disable/override→skip/追加)全部生效;放宽(default_checked=true、action→recycle)全部被拒

过程中发现并修复的实现级 bug(供后来者引以为鉴):
1. 回收站 `System.Recycle.DeletedFrom` 记录的是**被删项父目录**,匹配键必须 = 父目录+条目名
2. PowerShell 单引号串中 `` `t `` 不是制表符 → 输出解析用双引号串
3. 审计文件若位于删除目标树内,DONE 行要在删除前落盘(INTENT 为权威),否则"删完重建目录"幻觉
4. Node 26 strip-only 模式不支持 TS 参数属性(`constructor(private x)`)

## 8. 里程碑

- **M1 dry-run ✅**(2026-11-08)
- **M2 执行层 ✅**(2026-11-09):三执行器 + ManifestUndoManager + 受限叠加 + CLI(apply/undo/selftest)
- **M3 Electron 壳**:列表 UI(名称/路径/大小同层级;风险=文字标签+非颜色信号;确认按钮 = summaryText;撤销面板)、按需展开扫描、TOML 规则覆盖编辑器
- **M4 打包**:electron-builder + Inno Setup;**更新器目录本身要进保护名单**;staging 卷根目录安装时预创建
- (原 M4 AI 解释已按用户决策移除)

## 9. 已决事项备忘

- staging 目录在 D: 卷根可见(隐藏属性)——用户接受;M4 打包时预创建并写说明文件
- 回收站通道撤销依赖 Shell 动词(还原/restore),跨 locale 已匹配;碰撞时跳过不覆盖,宁可不恢复
- 内置规则更新 = 应用更新自带;用户无放宽通道(符合"受限叠加"原则)
