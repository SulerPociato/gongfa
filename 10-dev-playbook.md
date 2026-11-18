# 开发手册（今晚预制，明天直接用）

## A. 任务 1–3 的 Prompt（直接复制进 Qoder）

### 任务 1｜脚手架 + 数值曲线

```
背景：这是 gongfa 项目任务 1。仓库已初始化，目前只有文档，没有代码。
目标：搭出 pnpm workspace + core 骨架，让命令行能跑出灵力曲线。
约束：
- 只新建接口约定里的目录，不要建 ui 相关代码
- TypeScript strict；不要引入 BigNumber 库，qi 用 number
- 数值严格按 00-contracts 第 2 节：perTickGain → ×10 = displayRate
- 不实现心魔、渡劫、离线
产出：
1. pnpm-workspace.yaml、tsconfig、vitest 配置
2. packages/core/src/number/bignum.ts（先包一层 number）
3. packages/core/src/content/loader.ts（读 content/*.json）
4. tools/balance-sim.ts（硬编码 [breath]，跑 600 tick，每秒打印 qi）
验收：npx tsx tools/balance-sim.ts 输出 0s:0 … 60s:600
先给我文件清单和改动计划，等我确认再写代码。
```

### 任务 2｜VM + verifier

```
背景：任务 1 已完成，core 能在命令行跑单块积木。
目标：实现 IR 执行器与静态校验。
约束：
- 只改 packages/core/src/vm/
- IR 指令严格按 00-contracts 第 4 节（不要加 CALL、不要加 eval）
- 预算 budgetPool=200，超出发 stall{pc,steps,tick,reason}
- 循环用 LOOP_BEGIN/LOOP_END + 运行期栈，深度上限 16
- verifier 七条：跳转越界、循环配对、栈深、类型、入口唯一、静态指令≤500、actionId 存在
验收：跑 1 万 tick 不崩；构造死循环，200 步内被截断并返回 stall
先给计划。
```

### 任务 3｜Blockly 接入

```
背景：VM 已完成，能在 Node 跑 IR。
目标：页面里能拖块并编译成 IR 后运行。
约束：
- 积木定义、编译器、主题放 packages/blocks/src/；apps/web 只放 React 宿主
- 先用 Blockly 官方 CDN/包，不自己写渲染器
- 只做 1 个块：每 tick → 吐纳
- 不做存档、不做心魔
验收：拖一块，右侧数字每秒 +10
先给计划。
```

## B. 视觉资产清单

### 配色（只用这 5 个）

| 用途 | Hex |
|---|---|
| 底色（墨黑） | `#0A0E12` |
| 面板（宣纸灰） | `#1C2228` |
| 主色（灵气青） | `#35E0C8` |
| 强调（符纸金） | `#E8C978` |
| 危险（入魔红） | `#E04B3A` |

### 字体

| 用途 | 字体 | 来源 |
|---|---|---|
| 标题/古风 | 思源宋体 | https://github.com/adobe-fonts/source-han-serif |
| 正文 | 得意黑 | https://github.com/atelier-anchor/smiley-sans |
| 数字/代码 | JetBrains Mono | https://www.jetbrains.com/lp/mono/ |

### 图标（Lucide，MIT）

`flame`（灵力）、`brain`（心魔）、`scroll`（功法书）、`gem`（玉简）、`calculator`（算盘）、`timer`（蓄势）、`play` `pause`（运行）、`git-branch`（境界）、`activity`（曲线）

### 纹理/背景

- Kenney：https://kenney.nl/assets（CC0，选 "UI Pack"、"Particle Pack"）
- 不要用"修仙素材包"——版权不明

### 音效（CC0）

- freesound.org 搜：`whoosh`、`chime`、`deep impact`
- 三条足够：吐纳（轻 whoosh）、突破（chime）、失败（低沉 impact）

## C. 3 分钟演示分镜

| # | 时间 | 画面 | 操作 | 台词 |
|---|---|---|---|---|
| 1 | 0:00 | 两套功法并排（10/s vs 24/s） | 不动 | "同样的时间，差 2.4 倍——差在算法" |
| 2 | 0:15 | 点"用乙" | 点击 | "一句话就讲清楚了" |
| 3 | 0:25 | 拖入"循环"，数字跳 | 拖拽 | "你写的每一块，都在替它修炼" |
| 4 | 0:45 | 点"预估"，曲线出现 | 点击 | "改之前就知道会变快多少" |
| 5 | 1:05 | 心魔条升到 50% | 等待 | "跑得快，代价来了" |
| 6 | 1:20 | 加"调息"条件 | 拖拽 | "得自己写刹车" |
| 7 | 1:40 | 点突破 → 渡劫界面 | 点击 | "境界不是等出来的" |
| 8 | 2:10 | 渡劫成功，符箓展开 | 演出 | "成了" |
| 9 | 2:30 | 关页面 → 重开 → 闭关报告 | 关闭/打开 | "你不在时，它按你的算法修炼" |
| 10 | 2:50 | 定格在四境界图 | — | "接下来，看你能优化到哪一层" |

拍法：1080p 录屏，鼠标放大 1.5 倍，语速放慢。
