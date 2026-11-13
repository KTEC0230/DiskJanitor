# DiskJanitor 交接文档

> 本文件是项目唯一状态文档。**每次任务结束必须更新本文件**(用户明示要求)。
> 接手先读「当前状态」与「硬约束」,改完必须回写本文件。

## 项目定位

磁盘清理桌面应用。核心原则:**分析只读,删除必可逆**。每个动作写明对象与后果;永久删除独立、显式、二次确认;受保护路径执行层拦截。

## 当前状态(2026-11-09)

**阶段:M5 体验打磨完成(虚拟滚动/进度条/暂停停止/两行头部/卸载询问),已上线 D:\DiskJanitor。**

已完成:
- M1:五层架构 + dry-run(2026-11-08)
- M2:三执行器 + ManifestUndoManager + 受限叠加 + CLI(2026-11-09,selftest 26/26)
- M3:Electron 45 壳(2026-11-09,UI 三原则落地、懒展开、撤销面板、overlay 编辑器、通道升级语义)
- M4:打包上线(2026-11-09):图标、electron-builder、Inno Setup 按用户级安装器、自保护、staging 预创建、main.log
- M5:体验打磨(2026-11-09,用户实测反馈驱动):
  - **扫描控制器**:core ScanController(paused/cancelled)+ IPC dj:scan-pause/resume/cancel;停止返回部分数据(快照带 cancelled 标记)
  - **头部两行化**:输入行与进度/统计行分离,消除 UI 跳动;进度条(动画)+ 暂停/继续/停止按钮状态机
  - **虚拟滚动**:定高 26px 窗口化渲染(visible 扁平树 + spacer),数万行流畅
  - **卸载器询问**:卸载尾声 MsgBox 询问是否清空各盘 staging(默认保留)
  - **M5b 用户反馈二轮**(同日):
    - ★**目录尺寸双计修复**:statEntry 已把文件尺寸计入 self+total,bottom-up 又加 self → 叶子目录翻倍、多层放大(HY 曾虚报 590GB,实际 ~356GB)。删掉重复加行,并加 selftest 尺寸断言(160B/150B)防回归
    - **未识别徽章灰化**:规则未命中渲染为 ◇ 未识别·默认不动(灰色点线),不再红色恐吓;执行语义 fail-closed 不变;tooltip 指引 overlay 加规则
    - **规则包 v2(20 条)**:新增 lunatranslator-cache(low/recycle/默认勾)、beitong-firmware(medium/stage)、vs-package-cache(high/skip)
  - **M5c 反馈三轮**(同日):建议清理直出不翻树 + 资源管理器式交互 + AI 分析报告
    - **视图切换**:树视图 / 建议清理(全部 actionable 条目平铺,大小降序,直接可勾)
    - **工具栏**:全选可清理项 / 清空选择 / 导出报告(供 AI 分析)
    - **资源管理器式交互**:单击行 = 勾选(260ms 挂起区分双击),双击行 = explorer 打开(文件用 /select 定位);twistie/checkbox stopPropagation 不受影响
    - **报告导出**(core/src/report.ts 纯函数 + selftest):用户选目录 → 写 .md(元信息+给 AI 的分析任务说明+三节表格:建议清理/需确认/未识别≥10MB)+ .json(全量明细);弹窗显示路径与「打开所在文件夹」
  - **M5d 完全删除闭环**(同日,用户问"怎么完全删除"):
    - **core UndoManager.purgeBatch**:永久删除 committed 批次(删批次目录、放弃撤销权、PERMANENT-PURGE 审计、状态 purged);undone/pending 拒绝;**只删到批次层,staging 根永不删**(首版误把根 rmdir)
    - **UI 撤销面板扩展**:暂存占用展示(各卷 dirUsageBytes)+ 每批次「撤销/永久删除」双按钮 + 「清空全部暂存」红色二次确认(文案写明项数与字节)
    - main IPC:dj:staging-usage / dj:purge-batch / dj:purge-all
    - **main.log 增加 renderer console 转发 + DOM 探针**(8s 间隔 executeJavaScript 报 undoRoot 子元素数/类名/window.dj 类型)——诊断"面板空白"类问题的决定性工具
    - 实测发现:C:\DiskJanitorStaging 有 4.2GB committed 批次(用户自己执行过一次全选清理,5 项成功/11 项失败),面板数据正确;已部署待用户自行 purge
  - **M5e 自查轮**(同日,用户要求自查):
    - **修复**:扫描进行中导出报告会混用旧 lastScan+新半成品 rows → 渲染层禁用导出按钮 + main 侧 guard;recycle 批次的"永久删除"按钮误导(实际只标记,文件在系统回收站)→ recycle 批次只显示撤销按钮+说明文字;**加单实例锁**(requestSingleInstanceLock,二启聚焦已有窗口)
    - **新护栏**:build/verify-package.mjs——asar 必须文件+内容校验,**每次打包后必跑**;files 配置收紧为显式列表
    - Setup exe 重编(此前版本不含 M5c/M5d 功能)
- selftest 43/43(新增报告生成断言)

C:\ 盘根真机验证(2026-11-09,computer-use):扫描 13.8s/143399 文件/70.78GB 部分结果正确渲染;暂停字节数冻结采样确认;展开 Windows 数千行滚动流畅;根行不再自引用;DiskJanitorStaging 自身显示为不可执行。
D:\ 盘根复测(2026-11-09):17.3s 部分扫描,灰徽章生效,规则 v2 命中(建议清理 17/需决定 128),尺寸与统计一致。

技术栈:Electron + TypeScript;Node 26 原生跑 .ts(仅可擦除语法);core 分析层零依赖,执行层唯一依赖 trash。

## 硬约束(实现时不得违反)

1. 扫描路径绝不写文件系统;scanner 不 import 任何删除类模块
2. 默认删除只允许 staging(2026-11-09 决策)/回收站;永久删除独立类 + `confirmed_permanent: true` 类型强制 + 两段审计(INTENT 为权威)
3. 撤销记录持久化,跨重启可撤销;`UndoManager.begin` 必须在动文件系统**之前**落盘
4. 规则必带 `risk_level` + `reversibility`;irreplaceable ⇒ default_checked=false(校验器强制)
5. 受保护路径由 `assertDeletable` 在执行层拦截;Executor 必须复检,不信任 UI/Planner(伪造计划也拦,selftest [5])
6. 规则未命中 fail-closed:高风险/不可替代/skip/不勾选
7. 规则覆盖只可收紧:overlay 三动词(disable/收紧 override/追加保守规则),放宽即报错
8. 无 AI:RiskEngine 纯规则(2026-11-09 用户决策,勿再加 AI 钩子)

## 关键决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-11-08 | Electron + TS,而非 Tauri/Rust | 本机无 Rust 工具链;Node 26 跑 .ts 零成本;接口数据化保留 Rust sidecar 退路(trash-rs 有 restore_all) |
| 2026-11-08 | 保护路径分"前缀/仅全等/文件/卷根"四类 | `C:\Users` 误用前缀会拦全用户树(dry-run 实测发现) |
| 2026-11-09 | 默认通道 staging;staging 按卷根 `<卷>:\DiskJanitorStaging` | 用户选 staging;按卷放保证 rename 原子、零跨卷拷贝;上限 20GB/卷超限整计划拒绝 |
| 2026-11-09 | 规则覆盖 = 受限叠加 TOML,非直接改内置 | 用户原话"受限叠加覆盖,不是让用户直接改内置规则" |
| 2026-11-09 | 不做 AI 解释 | 用户:软件太过复杂臃肿 |
| 2026-11-09 | staging 通道升级执行 recycle 建议 | UI 实测发现:规则建议 recycle 的项在 staging 通道会被静默跳过;升级后语义一致且更安全 |
| 2026-11-09 | core 经 esbuild 打包供 Electron 用 | Electron 自带 Node 较旧不支持原生 .ts;插件解析 `.ts` 显式导入,trash/electron external |
| 2026-11-09 | 安装器按用户级(PrivilegesRequired=lowest) | 用户 EnableLUA=0,按用户安装无需管理员,顺带规避 UAC 类问题 |
| 2026-11-09 | 实际安装位置 D:\DiskJanitor(非 iss 声明的 {localappdata}) | 现象:DefaultDirName={localappdata} 未生效,静默装到安装器所在盘根;对用户 D 盘应用惯例反而合适,先接受;强制换路径可用 /DIR= 参数 |
| 2026-11-09 | 扫描控制器进 core(Scanner 层持有 paused/cancelled 状态) | 用户要求扫描可暂停/停止;停止=返回部分数据快照(cancelled 标记),不丢弃已扫描结果 |
| 2026-11-09 | 渲染层虚拟滚动(定高 26px 窗口化) | 用户扫 C:\ 4.7 万行会卡;visible=展开树扁平化,scroll 窗口渲染 |
| 2026-11-09 | 自动更新器不做 | 用户决策:避免软件复杂臃肿 |
| 2026-11-09 | 建议清理平铺视图 + 单击选择/双击打开 + 报告导出 | 用户:不能让用户自己找建议项;要资源管理器式交互;要报告给 AI 二次验证未识别条目 |

## 本机实测沉淀(写规则时的事实依据)

- pytest 垃圾曾堆 57.8GB(`Temp/pytest-of-*`)→ 规则 `pytest-garbage`
- DSH/Today/ZCode 更新器目录装的是**待安装包**,非垃圾 → 规则 `electron-updater-pending` high/skip
- pnpm store 全部被活跃项目引用 → medium/stage/不勾选
- 浏览器 User Data / QQ 文件 / xwechat_files 不可替代 → high/irreplaceable/skip

## 实现级坑(踩过即记)

1. 回收站 `System.Recycle.DeletedFrom` = 被删项**父目录**;匹配键 = 父目录+条目名
2. PowerShell 单引号串 `` `t `` 非制表符;需双引号串
3. 审计文件勿放删除目标树内;INTENT 行删除前落盘为权威留痕
4. Node 26 strip-only:禁 TS 参数属性 `constructor(private x)`、enum、namespace
5. PS 脚本文件必须 UTF-8 BOM,否则 zh-CN 下 CJK 变乱码
6. Electron 主进程无法原生 import .ts → esbuild bundle + `.ts` 导入解析插件;改 core 后必须 `pnpm build:core`
7. UI 内同文案按钮(底部执行键 vs 弹窗确认键)用 AX 索引点击可能错位;computer-use 走坐标更稳
8. pnpm 会拦 esbuild 的 postinstall,但二进制由 @esbuild/win32-x64 可选依赖自带,不影响使用
9. **existsSync 对不存在盘根返回 false 而非抛异常**——try/catch 包 existsSync 是逻辑反转,必须显式判真(fixedDrives 曾因此枚举出 26 个盘符)
10. ISCC 相对路径以 .iss 所在目录为基准(build\installer.iss 里引用同目录文件写 `icon.ico`、上级写 `..\dist`)
11. 本机 Inno Setup 无中文语言文件(官方 Unofficial 包 404),安装向导为英文;自定义文案已中文化
12. 静默安装若上版进程未杀干净会卡隐形对话框;先 taskkill 再 /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS
13. Inno [Code] 局部 typed const 数组初始化(`const A: array[0..7] of String = (...)`)编译报 'BEGIN' expected——展开成逐条语句
14. renderer 盘根路径两坑:norm 保留盘符大小写('C:/Windows')→ parentOf 盘根正则必须 /i;根条目 parentOf 后挂到自身 → walk 必须跳过 p===parent 与 p===state.root(否则自引用)
15. computer-use 会话换 pid 后旧帧绑定报 "frame_id does not match"——先 getState({emit:false}) 刷新全局帧再绑定截图;**截图显示"面板空白"先别信,用 DOM 探针查 childElementCount(帧捕获有竞态)**
16. **目录尺寸双计**:扫描器的文件尺寸入账与自底向上汇总各计一次 self → 叶子目录翻倍、多层树放大虚报;两处只留一处,且必须有尺寸断言护栏
17. fail-closed"未识别"是执行语义(默认不动),不是视觉语义——UI 必须区分"规则判定的高风险"(红)与"未识别"(灰),否则满屏红色吓用户
18. **electron-builder 增量打包可能静默丢文件**(曾整丢 preload.cjs+renderer/,asar 清单只剩 3 个 shell 文件,UI 全死)——打包后必须校验 asar 清单;另robocopy 卡死时先杀残留 robocopy 进程
19. 部分(停止)扫描的目录 sizeBytes 是"已扫部分"累计,偏小是已知限制;manifest 记录扫描时点值,purge freedBytes 相应偏小——如实,不算 bug
20. main.mjs 是纯 JS(.mjs),别写 TS 语法(as Error);渲染层错误诊断顺序:main.log renderer 行 → DOM 探针行 → 截图
21. **@electron/asar 的 extractFile 用正斜杠路径会误报 not found(时好时坏)**——校验必须 listPackage(归一化为 `/`)+ 反斜杠 extractFile;曾因正斜杠误报"整丢 renderer"白折腾多轮
22. 部署铁律:builder → **verify-package** → robocopy → **verify 安装目录 asar** → 启动;缺一步就可能把坏包装上机器

## 目录结构

见 `docs/ARCHITECTURE.md` §3。核心 `core/src/`,规则 `rules/`,CLI `tools/`。

## 待办(下一步)

1. **M5 打磨池**(按需排期):扫描进度条可视化、列表虚拟滚动(大目录 3 万行会卡)、undo 面板条目明细、overlay 模板按钮
2. 卸载器清理策略:卸载时询问是否清空 staging(默认保留,防误删未恢复项)
3. 自动更新器(做成后把自己的更新器目录加进保护名单)
4. 小债:`trash` 的回收站测试会在系统回收站留 2 个 selftest 残留 `__pycache__`(各 ~10B);下次跑回收站清理时顺手清
5. 版本发布节奏:改 core → `pnpm build:core`;改壳 → `npx electron-builder --dir` + ISCC 重编 → 覆盖安装目录或重跑安装包

## 工作约定

- core 分析层零依赖(node: 内置之外不加包);执行层唯一依赖 trash;壳层依赖只进壳层
- Node TS:仅可擦除语法(禁参数属性/enum);PS 脚本文件 UTF-8 BOM
- 任何涉及删除路径的改动,必须跑 `node tools/selftest.mjs` 全绿 + dry-run 冒烟
- git 提交禁 `git add -A`,显式列文件(沿用用户惯例)
- 每次任务结束更新本文件(用户明示要求)
