# 《代码修仙》总体架构

> 状态：**待冻结**（外援评审中）｜ 最后更新：2026-11-18 ｜ 真相源：[00-contracts.md](00-contracts.md) ｜ G1–G4 已定稿（2026-11-18）

> 本文件描述技术分层与实现约束；玩法见《游戏设计文档》，**数值/IR/存档/功法书的精确口径见《P0 契约》**，开发任务见《Qoder 开发任务书》。

---

## 一、设计原则

| 原则 | 落地 |
|---|---|
| **核心可移植** | `core` 只注入 `Storage / Clock / Rng`，不碰 DOM 与浏览器 API |
| **IR 是契约** | 编辑器只产 IR，VM 只消费 IR；IR 规范以《P0 契约》第 4 节为准 |
| **内容即数据** | 积木、动作、功法书、道具、境界全部 JSON |
| **确定性** | 固定 tick + 种子 RNG；回放与排行榜依赖这一点 |
| **失败可见** | 预算耗尽、死循环、非法积木 → 事件，不静默 |
| **不宣称做不到的事** | localStorage 无防作弊能力，文档与 UI 都不暗示"防改档" |

---

## 二、分层

```
┌──────────────────────────────────────────────┐
│ apps/web（Vite + React + Blockly）            │
│  ├─ editor/   Blockly 封装 + 编译 + 主题       │
│  ├─ game/     HUD / 对比面板 / 粒子 / 音效      │
│  └─ adapters/ localStorage / clock / rng      │
├──────────────────────────────────────────────┤
│ packages/core（纯 TS）                        │
│  ├─ vm/        调度、执行、预算、verifier       │
│  ├─ number/    BigNumber                      │
│  ├─ content/   blocks / actions / books / artifacts │
│  ├─ modifier/  修正器结算                      │
│  ├─ save/      schema + 迁移链                 │
│  └─ offline/   公式结算                        │
├──────────────────────────────────────────────┤
│ content/*.json（数据）                         │
└──────────────────────────────────────────────┘
```

---

### 2.5 依赖方向

```
apps/web ──▶ packages/blocks ──▶ packages/core
   │              │                 ▲
   └──────────────┴─────────────────┘   （web 可直接用 core，但 blocks 不反向依赖 web）
```

| 规则 | 说明 |
|---|---|
| `core` 不依赖 `blocks`、`ui`、DOM | 可在 Node 跑批 |
| `Op`（IR 指令）与 `GameEvent` **住在 core** | blocks 只生产 `Op`，ui 只消费事件 |
| `blocks` 只依赖 `core` 的类型 | 编译器放这里，不放 `apps/web` |
| 目录包含 `packages/blocks` | 修正此前把编译器塞进 web 的分层错误 |

### 2.6 注入接口（core 的唯一外部通道）

```ts
interface Clock { now(): number }                    // 毫秒时间戳
interface Rng   { next(): number }                   // [0,1)，种子由调用方持有
interface Storage { load(): string | null; save(s: string): void; clear(): void }

// 存档用按 key 访问的端口（双槽 + 指针 + 损坏备份都需要多个 key）
interface SaveStorage {
  read(key: string): string | null
  write(key: string, value: string): boolean         // 失败返回 false，不抛
  remove(key: string): void
  keys(): string[]
}
```

`core` 只通过这四个接口访问外部；`Program` / `GameState` / `SaveFile` 的**类型定义在 `core/src/save/schema.ts`**，`core/src/types.ts` 只做 re-export 聚合。

---

## 三、内容驱动（四类数据）

### 3.1 积木 `content/blocks.json`

```json
{
  "id": "breath",
  "kind": "action",
  "name": { "zh": "吐纳", "en": "Breathe" },
  "concept": "sequence",
  "params": [],
  "unlockRealm": 0
}
```

### 3.2 动作 `content/actions.json`（与积木分离）

```json
{
  "id": "breath",
  "baseGain": 1,
  "demonDelta": 0,
  "kind": "gain"
}
```

> **关键修正**：`ACTION` 指令只带 `actionId`，效果在这里查表。新增"采药"只加 JSON，不改 IR 联合类型。

### 3.3 功法书 `content/books/*.json`

```json
{
  "id": "book_zhoutian",
  "tier": 1,
  "realm": 0,
  "name": { "zh": "周天吐纳诀" },
  "workspace": { "blocks": { "blocks": [] } },
  "modifiers": [{ "target": "demonRate", "kind": "mul", "value": 0.95 }],
  "decayCoefficient": 0.5   // 与契约 §6 的 0.5 系数一致
}
```

实例化与固化流程见《P0 契约》第 6 节。

### 3.4 道具 / 境界

```json
{ "id": "abacus", "name": { "zh": "算盘" }, "modifiers": [{ "target": "budget", "kind": "add", "value": 50 }] }
{ "id": "jade", "name": { "zh": "玉简" }, "cache": { "sameActionId": true, "hitGainMultiplier": 0.7, "hitStepCost": 0 } }
{ "id": 1, "name": { "zh": "筑基" }, "threshold": "2e4", "passivePerSec": 5, "actionMult": 3 }
```

---

## 四、Modifier

```ts
type Target = 'rate' | 'demonRate' | 'budget' | 'offlineRate' | 'slot'
interface Modifier { id: string; target: Target; kind: 'mul' | 'add'; value: number }
```

- 结算顺序固定：**先加后乘**
- 来源：功法书、境界被动；**道具分两类**——普通修正走 `Modifier`，行为型（如玉简的 `cache`）走独立字段，不塞进乘数
- 存档只存"装备了哪些"，**不存算好的数值**
- 移除来源时必须成对移除，单测覆盖"重复装备 / 负值 / 上限"

---

## 五、VM（摘要，完整规范见契约第 4 节）

| 项 | 约定 |
|---|---|
| 循环 | `LOOP_BEGIN(end,count)` + `LOOP_END(begin)` + 运行期循环栈（深 ≤16） |
| 动作 | `ACTION { actionId }`，效果查 `actions.json` |
| steps | **每条执行的指令计 1 步**（含跳转/循环/比较） |
| 预算 | `budgetPool = 200 + 算盘加成`，P0 全部分给 `programs[0]`；超出即 `stall` |
| 算力 | 占位 `computeLimit: number | null`，P0 = null，VM 不读取 |
| 曲线预览 | 简化模型跑 600 tick（约 5 ms），不启动完整 VM；仅 UI 层使用 |
| hotSwap | **P0 必须实现**：渡劫时暂停程序 → 重编译 → tick 边界原子装载；状态机 `RUNNING → PAUSED → RUNNING` |
| verifier | 跳转越界、循环配对、栈深、类型、入口唯一、静态指令 ≤500、actionId 存在、常量除零 |
| 补帧 | accumulator；单帧最多 5 tick，剩余转离线 |

---

## 六、数据模型

以《P0 契约》第 5 节为准。要点：

- `schemaVersion` **全局只有一个**，`SaveFile` 与 `GameState` 同版本
- 必须有 `ownedBooks / equippedBook`、`ownedArtifacts / equippedArtifacts`
- BigNumber 以字符串序列化
- `seed`、`offlineRate` 入档

---

## 七、离线

```
ticks = clamp(now - lastSeenAt, 0, 60min) / TICK_MS
vm.fastForward(ticks)      // 与在线同一套 VM；关闭心魔增长与随机事件
gained = qi × 0.6
```

- 60 分钟 = 36,000 tick，单次耗时 < 0.3 s，**不需要变步长**
- 离线期间不涨心魔、不触发杂念；最多 1 次渡劫（见契约 7.1）
- 等价性测试：`fastForward` 关闭心魔与随机事件，**不与在线 tick 做严格逐 tick 等价**；只校验同参数下两次运行结果一致
- 蓄势（`chargeReadyAt`）按真实时间推进，**不受 60 分钟上限约束**
- 倍速实现：`ticksThisFrame = speed × dt / TICK_MS`，上限 5 tick/帧（与契约一致）；预算仍按 tick 计

## 八、存档

读取顺序固定：

1. 读 envelope，只解析 `schemaVersion`
2. 连续迁移 `n → n+1`
3. 结构校验 + 业务不变量（realm 范围、demon 范围、equipped ⊆ owned）
4. 写备份槽 → 切主槽（原子）

```ts
const MIGRATIONS: Record<number, (old: unknown) => unknown> = {
}
```

测试保留真实 fixture（`save-v1.json`），不测试"刚生成的对象"。

---

## 九、多语言（第二阶段）

P0 只做中文，界面文案集中在一个模块里，方便以后加英文。**不在 P0 建 `i18n/` 目录**。


## 十、二阶段：后端 / 排行榜 / 多人

> P0 不实现，但口径现在定死（契约第 8 节）。

### 10.1 评分

```
score = 总产出 / 总步数      // 步数为 0 → score = 0（不记 ∞）
```

固定 60 秒评测窗口，从 0 开始，**不含离线收益**。

### 10.2 防作弊与回放

| 项 | 做法 |
|---|---|
| 种子 | **服务端发放**，客户端不能自选 |
| 提交 | `engineVersion` + `contentVersion` + 规范化 IR + 操作时间戳 |
| 校验 | 服务端用同一 VM 重放，比对 `sha256(IR + 事件序列 + 最终状态)` |
| 版本 | 版本不一致直接拒收，避免"旧引擎高分" |

### 10.3 接口草案

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 账号 |
| GET/PUT | `/api/save` | 云存档，基于 revision 做冲突处理（不用"取新"） |
| POST | `/api/run` | 提交回放 |
| GET | `/api/leaderboard?realm=2` | 分境界榜 |
| POST | `/api/books` | 社区功法投稿（Roadmap） |

---

## 十一、自定义代码块审核（Roadmap）

```
客户端静态检查 → 提交 → 规则引擎 → 人工队列 → 上线
```

| 规则 | 检查 |
|---|---|
| 有输入输出 | 参数/返回值非空 |
| 效率上限 | 单块 effect ≤ 标准块 ×1.5 |
| 无递归 | 依赖图无环 |
| 静态预算 | 展开后 ≤30 条指令 |

---

## 十二、目录

```
code-cultivation/
├─ packages/core/
├─ packages/blocks/src/{definitions, compiler, theme}
├─ packages/core/src/{vm, number, content, modifier, save, offline, rng, demon, realm}
│  ├─ src/number/bignum.ts
│  ├─ src/content/{loader.ts, schema.ts}
│  ├─ src/modifier/
│  ├─ src/save/{storage.ts, migrate.ts}
│  └─ src/offline/
├─ apps/web/
│  ├─ src/game/{hud.tsx, compare.tsx, fx.ts, loop.ts}
│  ├─ src/adapters/
│  └─ src/main.tsx
├─ content/{blocks.json, actions.json, realms.json, artifacts.json, books/*.json}
└─ tools/balance-sim.ts      # tsx 执行
```

---

## 十三、实施顺序（先契约，后代码）

> 步骤 0 不产出代码，只冻结契约；步骤 1 起与《Qoder 开发任务书》的任务 1–11 一一对应。

| 步骤 | 交付 |
|---|---|
| 0 | **冻结《P0 契约》**：数值公式、IR v1、存档 v1、功法书生命周期 |
| 1 | 内容 schema + `balance-sim`（tsx），产出目标表 |
| 2 | IR 编译器 + verifier + 单测（验收含：`computeLimit` 是只读占位，全流程无任何读取） |
| 3 | VM + 确定性与补帧测试 |
| 4 | 存档版本链 + 双槽 + 损坏回退 |
| 5 | Blockly 编译 + **移动端冒烟** |
| 6 | 功法书装载 / 编辑 / 固化 |
| 7 | 境界 / 心魔 / 突破 |
| 8 | Modifier + 玉简缓存 + 离线 |
| 9 | 视觉 / 音效 / 演示模式 |
| 10 | 数值调平（对照契约第 3 节目标表） |
| 11 | 部署 + 录屏 |

> 第 0 步不产出代码，但它是后面所有步骤不返工的前提。

---

## 十四、测试

| 类别 | 用例 |
|---|---|
| 内容 | JSON schema、非法 actionId、重复 id |
| IR | 跳转越界、循环不配对、栈下溢、除零、嵌套超限 |
| VM | 预算截断、stall 字段、5 tick 追帧上限 |
| 数值 | 目标表逐行对比（±20%） |
| 存档 | fixture 迁移、原子写、损坏回退、负时长 |
| 回放 | 固定种子逐 tick 一致（第二阶段） |
| UI | 移动端 Blockly 拖拽（任务 5 就做，不拖到最后） |

---

## 十五、移植矩阵

| 目标 | 复用 | 必须重写 |
|---|---|---|
| Tauri 桌面 | 95% | storage adapter |
| 移动 H5 | 80% | 触摸交互 |
| 微信小游戏 | 40% | 渲染 + Blockly |
| Unity | 40% | UI + 编辑器；core 转 C# 或 WASM |

**core 可移植，编辑器不可移植**——既定前提。
