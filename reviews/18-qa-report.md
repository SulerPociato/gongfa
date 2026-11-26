# 测试轮报告（2026-11-26）

> 执行依据：[reviews/17-qa-plan.md](17-qa-plan.md)（含三遍对抗性审查）。本文只写结果与证据，不重复方案。
> 范围：自动化门禁 + 浏览器真实流程 + 边界/敌意 + 契约一致性。冻结数值未改。

## 一、结果摘要

| 项 | 改前 | 改后 |
|---|---|---|
| `pnpm typecheck` | 0 错 | **0 错** |
| `pnpm test` | 632 通过 / 46 文件 | **643 通过 / 48 文件**（+11） |
| `pnpm audit:fuzz` | 0 抛异常 | **0 抛异常**（1500 功法，编译成功 1126） |
| `pnpm audit:balance` | 41s / 286s / 152s / 118s | **逐行不变**（未动数值） |
| `npx tsx tools/audit-a11y.ts` | 9 项 ≥4.5 | **9 项全 PASS，失败 0** |
| `pnpm --filter @gongfa/web build` | 1,101.57 kB / gzip 323.55 | **1,103.20 kB / gzip 324.29** |
| 线上 bundle | `index-Dss7U4R7.js`（= HEAD `b58a977`） | 推送后见第六节 |

结论：**7 个问题已修（P1×3、P2×4），0 个 P0**；1 个 P2（离线报告「1小时」）随 Q8 一起修；剩余风险见第五节。

## 二、修了什么（问题 → 证据）

### Q1 承雷三雷点只按命中数点亮（P1，已修）

- **改前**（dev `b2-parry-mask`，中第 1、3 波、漏第 2 波）：
  ```
  hits=2  DOM: ✓ ✓ ⚡   ← 第 2 波明明漏了，灯却亮在 1、2 位
  结算 rate=0.84（数值是对的，UI 在说谎）
  ```
- **改后**：
  ```
  after-wave2-passed: ✓ ✗ ⚡
  after-wave3:        ✓ ✗ ✓
  结算 rate=0.84
  ```
- 实现：`parryWaveStates(hits, elapsed)` 纯函数（core），runtime 派生 `trialParry.waves`，HUD 按索引渲染 `.is-hit/.is-miss/.is-pending`。
- 测试：`packages/core/src/realm/rules.test.ts` 新增 1 条（5 个断言），含「刚好到窗口仍是 pending、+1ms 才 miss」。
- 结算数字未变：漏波仍在 10 秒到期时 `+16%` 心魔 / `−5%` 成功率。

### Q2 移动端「点加」第 2 块起浮空（P1，已修）

- **改前**（dev `c7-mobile-three`，390×844）：
  ```
  第 1 次：rate 10.0/秒，workspace: tick_hat{BODY:breath}
  第 2 次：rate 10.0/秒，workspace 无变化（新块 moveBy(80,120)，无 inputs/next，DOM 重叠）
  第 3 次：rate 10.0/秒，同上
  ```
- **改后**：
  ```
  10.0 / 秒 → 18.1 / 秒 → 24.8 / 秒
  自动存档链长 = 3（刷新后仍是 24.7/秒、3 块）
  ```
- 实现：`palettePlacement()` 纯函数（web），BODY 空→body、已占→沿链尾 next、值积木/无 next→float。
- 测试：`apps/web/src/game/palette.test.ts` 4 条；E2E `h-persist` 验证刷新回读。

### Q3 回退备用槽的提示被吞 / 只在面板里（P1 开发态 + P2 可见性，已修）

- **改前**：主槽坏、备槽好 → dev（StrictMode 双挂载）`issue=null, notices=[]`；生产只在面板 notices 里有一句「主存档（A 槽）不可用，已回退 B 槽继续」，首屏无提示。
- **改后**：
  - dev：首屏琥珀条 `issue-strip is-warning` + 面板 notices 同句；
  - 生产（preview 4173）：`issueClass="issue-strip is-warning"`，文案同上；两槽都坏仍是红条 + 备份 key。
- 实现：模块级 `pendingFallbackNotice` 兜 StrictMode；`HudModel.warning` 进首屏 issue strip（琥珀），不并进红字。
- 未改 core 的读档顺序与备份策略。

### Q4 契约与实现漂移：调息 -0.0005 vs -0.0003（P1 文档，已修）

- **改前**：`content/actions.json` 是 `-0.0003`（11-23 commit `db5326e` 有意收紧），契约 §2.2.1 / §3 G4/G5 仍写 `-0.0005`。
- **改后**：契约追平实现（§2.2.1、G4、G5 数值与表），标注 2026-11-23 调整由来；新增测试钉住真实 `actions.json` 的 `-0.0003` 与 k=2/4 边际递减。
- **没有**改回 `-0.0005`：代码值是 11-23 玩家反馈后的决定，回退会改玩法。

### Q5 渡劫文案仍是旧语义（P2，已修）

- **改前**：
  - 进窗口通知：「10 秒内点『立即冲关』按 85% 算，放手按 60% 托管」；
  - 就绪提示：「窗口内点确认 = 85%，撒手 = 60%」；
  - 但窗口里只有「承雷 / 交给天意」。
- **改后**（`f-copy` 实测）：
  - 就绪提示：「2 / 5 / 8 秒三波雷，接住抬成功率、漏掉掉成功率（55%–95%）；点『交给天意』= 60% 结算。」
  - 面板 lead：「2 / 5 / 8 秒三波天雷：接住压心魔、抬成功率（55%–95%）；不接按承雷战绩结算。」
  - 通知：「承雷命中：心魔 −12%、成功率 +2%；漏一波：心魔 +16%、成功率 −5%……」
  - 全部数值从 core 常量拼，不写死。

### Q6 演示模式渡劫面板重复一行（P2，已修）

- **改前**：`改功法只改接下来的产出，不改成功率。` 渲染两遍（`hud.tsx:810` 与 `:814`）。
- **改后**：`f-copy` 实测 `noteCount=2`、`duplicate=1`（另一条是承雷说明）。

### Q7 契约 §2.2.1 整节重复（P2，已修）

- 两份完全相同的 `2.2.1 心魔增长` 合并为一份，数值改为 `-0.0003`。

### Q8 离线 60 分钟写「60分0秒」（P2，已修）

- **改后**：90 分钟离线 → 报告「闭关 **1小时** ｜ 灵力 +21599（离线效率 60%）」；10 分钟 → 「10分9秒」。
- 新增 `durationText()` 纯函数 + 4 条单测。

## 三、测试矩阵执行结果

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| S1 | 新档首屏 | PASS：无 boot 骨架、无 console error | `a-fresh` |
| S2 | 六步引导 | PASS：1→6 每步「继续」`elementFromPoint` 命中；`gongfa:tutorial=done`；刷新不再出现 | `a-fresh` |
| S3 | 加块与产出 | PASS：移动端点加 10.0→18.1→24.8/秒；刷新链长 3 | `c7` / `h-persist` |
| S4 | 面板 | PASS：桌面 right sheet；390 上滑 743 高、圆角 20、Esc 关闭回视口外 | `e3-sheet` |
| S5 | 承雷（中1漏2中3） | PASS：灯 ✓✗✓、rate 0.84、10.4s 结算出结果层 | `b2` |
| S6 | 交给天意 | PASS（runtime 单测 + 面板按钮存在；E2E 见 S5 结算路径） | `runtime.test` |
| S7 | 冷却 | PASS：失败后按钮「冷却中 还剩 57.1 秒」且 disabled | `i-fail` |
| S8 | 坏档三态 | PASS：A 坏 B 好→琥珀回退条；两槽坏→红条+备份 key；生产同 | `d2` / `d3` |
| S9 | 离线 | PASS：10 分钟出报告 3660；30 秒无报告；90 分钟封顶 60 分钟 = 21600 | `d-save-offline` |
| S10 | 刷新持久化 | PASS：3 块、24.7/秒、qi 回读 | `h-persist` |
| S11 | 390×844 面板 | PASS：y=101、h=743、radius 20、背板在、Esc 关闭 | `e3-sheet` |
| S12 | 键盘 | PASS：首次 Tab = 跳到主按钮，Enter 聚焦 `#main-action` | `e-mobile-keyboard` |
| S13 | 演示模式 | PASS（带程序）：F→金丹 11.4 万、9s 攒满、X 开面板、确认→元婴；R 弹确认、取消不重置 | `g2-demo-flow` |

补充：1280×720 主 CTA/心魔/面板入口都在视口内（y=232/307/330），无横向溢出；reduced-motion 下按钮与面板过渡均为 `1e-05s`。

## 四、对抗性审查落实情况

- 假绿：所有数值断言同时读 DOM 与 `window.__gongfa_debug.state()`；点击走 CDP 真实鼠标 + `elementFromPoint`。
- dev/prod 差异：Q3 在 dev 与 production preview 各跑一遍（这正是 Q3 的来源）。
- 拖拽：桌面合成 PointerEvent 无法可靠触发 Blockly 手势（多次尝试均未连上，且新块落在 flyout 坐标系），**不记为产品缺陷**；改用移动端 palette（真实按钮路径）验证「加块」。
- 计时：每步采样留 ≥250ms 余量；承雷结论用运行时 `lastChallenge.rate` 而非单帧 DOM。

## 五、剩余风险 / 未做

| 项 | 说明 | 处置 |
|---|---|---|
| 桌面拖拽未自动化 | Blockly 手势层对合成事件不买账；本次只验证了几何、编译与移动端点加 | 发布前用真机/真鼠标手测一次；HANDOFF 验收清单已有 |
| 多标签写冲突 | 两标签后写覆盖先写，无 `storage` 同步 | 已知债，赛前不修 |
| 第 3 次保底未做浏览器级 | 需要 3 次渡劫（≥2 分钟 + 冷却） | 单测已覆盖 `attempt>=3`；记录 |
| 旧测试 fixture 仍是 -0.0005 | `settle.test / interpreter.test / preview/curve.test` 自建 fixture 用 -0.0005，测的是公式不是内容表 | 不影响真实行为；未改以免动一批期望值 |
| 移动端主 CTA 在首屏下方 | 52vh 画布 + 下方面板的既定布局，页面可滚；教程第 6 步会滚到目标 | 设计取舍，记录 |
| 演示 F 后不立刻能 X | F 落点是阈值 95%，要有程序/等待才攒满；无程序时 3× 被动也要 ~67s | 演示脚本先拖块再 F，或提前 F；记录 |

## 六、发版

- 代码分 3 个 commit：承雷 UI/文案、移动端点加+回退提示+时长、契约/报告。
- 推送后等 GitHub Pages（约 45–60 秒），取新 `index-*.js`，在线上跑 S5（三雷点）+ S8（坏档）+ 控制台无 error。
- 详细 hash 与线上截图见 commit 后的 `reviews/18` 追加或 HANDOFF。
