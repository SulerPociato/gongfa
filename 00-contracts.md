# 《代码修仙》P0 契约（唯一实现口径）

> 状态：**已冻结**（2026-11-18）｜ 最后更新：2026-11-18 ｜ 真相源：[00-contracts.md](00-contracts.md) ｜ G1–G4 已定稿（2026-11-18）

> 状态：**待外援评审，暂未冻结**。冻结后此文件为唯一权威。

> 本文件是数值、IR、存档、功法书的**唯一权威**。其它文档只引用，不再重复定义。
> 改任何常量或结构：先改本文件 → 重跑 `balance-sim` → 更新目标表 → 再改代码。

---

## 1. 时间与单位

| 项 | 值 |
|---|---|
| `TICK_MS` | 100（10 tick/秒） |
| 逻辑时间 | 用 accumulator 累加 `dt`，每满 100ms 执行 1 tick |
| 单帧追帧上限 | **5 tick**（倍速也受此上限约束）（500ms），超出不补，转离线结算 |
| 后台恢复 | `visibilitychange` 后按上述上限补帧，剩余走离线公式 |
| 心魔 | 状态存 **0～1**，UI 显示百分比；公式一律用小数 |
| 灵力 | 存量为 BigNumber；流量为 `number`（每秒） |

---

## 2. 数值公式

### 2.1 每 tick 产出

```
perTickGain = Σ over 本 tick 执行的动作 k:
                baseAction(actionId)
              × actionMult(本 tick 第 k 次)
              × cacheHitMult(k, actionId) // 本 tick 已执行过相同 actionId → 0.7，否则 1.0；仍吃 actionMult
              × realmActionMult
              × bookDecay
              × artifactMult

displayRate = perTickGain × 10        // 灵力/秒，仅用于显示
```

### 2.2 各乘数

| 乘数 | 定义 |
|---|---|
| `baseAction` | 吐纳 = 1；调息 = 0（不产出） |
| `actionMult` | 第 k 次：`1 / (1 + 0.25 × (k-1))`（边际递减） |
| `cacheHitMult` | 装备玉简时：**若本 tick 已执行过相同 `actionId` 则为 0.7，否则 1.0**；乘在 `actionMult` 之后 |
| `realmActionMult` | 炼气 1 / 筑基 3 / 金丹 25 / 元婴 100 |
| `realmPassive` | 不作为乘数，见 2.3 |
| `bookDecay` | `1 / (1 + 0.5 × max(0, 当前境界 - 书指定境界))`；未装备书 = 1 |
| `artifactMult` | 见 2.4 |

### 2.2.1 心魔增长（契约补齐）

```
demonDelta = 动作自身 demonDelta
           + (kind === 'gain' ? 0.00005 × (1 + 0.5 × loopDepth) : 0)

loopDepth = 运行期循环栈深度（VM 在 ACTION 时提供，**不进 IR**）
```

- 只有 `kind === 'gain'` 的动作（吐纳类）触发增长；`调息` 不触发，且自身 `demonDelta = -0.0005`
- `loopDepth` 取运行期值，与 `balance-sim.py` 的静态 `depth` 在参考程序上等价

### 2.3 境界被动

```
perTickTotal = perTickGain + realmPassivePerSec / 10
```

| 境界 | realmPassivePerSec | realmActionMult |
|---|---|---|
| 炼气 | 0 | 1 |
| 筑基 | 5 | 3 |
| 金丹 | 30 | 25 |
| 元婴 | 150 | 100 |

### 2.4 道具（P0 两件）

| 道具 | 效果 |
|---|---|
| **玉简** | 同一 tick 内重复执行**相同 actionId**：第 2 次起 `cacheHitMult = 0.7`（乘在边际递减之后），且**该次 ACTION 步数计 0**；**命中仍照常增长心魔**（§2.2.1 按执行计，不因缓存减免） |
| **算盘** | 指令预算 `+50` |

> 玉简是真实缓存语义（命中便宜但有衰减），不是纯数值乘数——这是 P0 唯一落地的"高级概念"。

---

## 3. 目标表（验收用，由 `balance-sim` 生成）

**假设（必须同时成立，否则表作废）**：

1. P0 只有 1 本《周天吐纳诀》
2. 炼气期装备该书；筑基起**编辑后立即固化**（`bookDecay = 1`）
3. 筑基起装备玉简
4. **参考策略**：每 tick 检查，心魔 > 0.5 时用调息替换第 1 个动作槽，其余槽吐纳（0.5 是安全线，0.7 是杂念风险线）
5. 突破成功 → 心魔归 0（破境涤心）
6. 无走火入魔；离线不计入；渡劫挑战时长不计入

| 境界 | 阈值 | 速率 | 阶段耗时 | 累计 | 程序形态 |
|---|---|---|---|---|---|
| 炼气 | 1e3 | 10/s | 100s | **1:40** | `每tick → 吐纳` |
| 筑基 | 2e4 | 63/s | 317s | **6:57** | `循环3次 吐纳` + 玉简 |
| 金丹 | 4e5 | 626/s | 639s | **17:36** | `循环5次 吐纳` + 玉简 |
| 元婴 | 2.5e6 | 3091/s | 809s | **31:05** | `循环8次 吐纳` + 玉简 |

**四境界 / 30 分钟操作 + 约 1.5 小时日历**（G4 定稿；蓄势 15+60 分钟）。

| 累计操作时长 | 1:40 | 6:57 | 17:36 | 31:05 |
|---|---|---|---|---|
| 现实日历要求 | 1:40 | 至少 15:00 | 至少 1:16:40 | 约 1:30 |
上表为 `balance-sim` 实测（0.00005 基线），累计 31:05，任务 10 校准到 30:00±10%。

**心魔基线**：0.00005 为默认。实测三档累计：

| 心魔基线 | 金丹累计 | 元婴累计 | 走火 |
|---|---|---|---|
| 0.00004 | 17:03 | **30:02** | 0 |
| 0.00005 | 17:36 | **31:05** | 0 |
| 0.00006 | 18:09 | 37:28 | **2（元婴）** |

> 0.00006 在元婴阶段会连续走火，超出 ±20%。**任务 10 的校准区间收窄为 0.00004–0.00005**；0.00006 仅作"过界示例"，不参与验收。

**设计取舍（G4 定稿）**：调息固定 `-0.0005`，**不随境界增强**。元婴 8 动作时心魔增速 `0.0006/tick` 已超过单次调息，玩家必须**减少动作数或接受走火风险**——这是刻意保留的取舍，不是数值缺陷。

**对照场景：全程不调息**（无随机杂念的乐观下界）→ 元婴阶段会明显变慢并触发走火，数值待任务 10 重跑；该结果**不得**作为正式目标表。

**校验规则**：任务 10 用 `0.00004 / 0.00005` 两档各跑一遍，元婴累计须落在 30:00 ±20%；`0.00006` 只记录不验收。

> 改任何常量必须重跑 `tools/balance-sim.ts` 并更新本表与上面的对照场景。


### 3.5 冲关的 VM 语义

- 解锁境界：**筑基**（与「如果 / 循环」同批）

```
冲关执行：
1. 检查 qi ≥ 阈值 且 chargeReadyAt ≤ now
2. 不满足 → no-op，发 challenge-blocked
3. 满足  → 发 challenge-request，暂停 VM
4. 进入渡劫（在线手动/托管）；结束后恢复
5. 恢复前丢弃旧执行状态，在 tick 边界 hotSwap
```

新增事件：

```ts
| { t: 'challenge-blocked'; reason: 'qi' | 'charge' }
| { t: 'challenge-request' }
| { t: 'challenge-success'; realm: number }
| { t: 'challenge-failure'; qi: string }
```

## 4. IR v1 规范

### 4.1 指令集

```ts
type Op =
  | { op: 'PUSH'; value: number }
  | { op: 'LOAD'; key: 'qi' | 'rate' | 'demon' | 'realm' | 'budget' }  // budget = 本 tick 剩余预算
  | { op: 'ADD' | 'SUB' | 'MUL' | 'DIV' }
  | { op: 'CMP'; arg: '<' | '>' | '==' }
  | { op: 'ACTION'; actionId: string }      // 效果由 content/actions.json 解析
  | { op: 'JMP_IF_FALSE'; target: number }
  | { op: 'JMP'; target: number }
  | { op: 'LOOP_BEGIN'; end: number; count: number }
  | { op: 'LOOP_END'; begin: number }
  | { op: 'HALT' }
```

### 4.2 循环语义

```
LOOP_BEGIN(end, count):
  push { begin: pc, end, remaining: count }
  if count === 0 → pc = end + 1
LOOP_END(begin):
  frame = top
  frame.remaining -= 1
  if frame.remaining > 0 → pc = begin + 1
  else pop; pc += 1
```

- 嵌套：用运行期循环栈，栈深上限 16
- `count` 编译期限定 1–10
- **`count = 0` 时不压帧，直接跳 `end + 1`**（压帧会因跳过 LOOP_END 而泄帧，16 层后假死）
- 不允许 `break` / `continue`（P0）

### 4.3 steps 与预算

- **每执行一条指令算 1 步**（含 JMP / LOOP / CMP / PUSH）
- 预算 = `BASE_BUDGET(200) + 算盘加成`
- 超预算：立即中止本程序本 tick，发 `stall`

```ts
interface StallEvent {
  t: 'stall'
  programId: string
  pc: number            // 中止时的指令位置
  steps: number
  tick: number
  reason: 'budget' | 'loopLimit'
}
```

### 4.4 verifier（编译后、执行前）

| 检查 | 规则 |
|---|---|
| 跳转越界 | 所有 `target` ∈ [0, code.length) |
| 循环配对 | 每个 `LOOP_BEGIN` 都有对应 `LOOP_END`，且 `end` 指向该 `LOOP_END` |
| 栈深 | 静态模拟栈深始终 ≥0 且 ≤16 |
| 类型 | 运算/比较的操作数类型合法（number） |
| 入口 | 有且仅有一个事件块 |
| 预算 | 静态指令数 ≤ 500 |
| 动作 | `actionId` 必须在 `content/actions.json` 中存在 |
| 除零 | `DIV` 的右操作数为常量 0 时拒绝编译 |

### 4.5 补帧

```ts
acc += dt
let n = 0
while (acc >= 100 && n < 5) { vm.tick(); acc -= 100; n++ }
if (n === 5 && acc >= 100) { acc = 0; scheduleOfflineSettle() }
```

---

## 5. 存档 v1

### 5.1 Schema

```ts
interface SaveFile {
  schemaVersion: 1
  savedAt: number
  state: GameState
}

interface GameState {
  schemaVersion: 1
  seed: number
  realm: 0 | 1 | 2 | 3
  qi: string                 // BigNumber 序列化
  demon: number              // 0..1
  workspace: unknown         // 真相源：Blockly save() 原样 JSON；加载时用它重编译
  programs: Program[]        // 编译缓存，可存可不读；P0 只用 [0]，类型固定为数组
  budgetPool: number         // 每 tick 总预算；P0 = 200，全部给 programs[0]
  computeLimit: number | null // 占位：算力/频率限制，P0 恒为 null（不启用）
  ownedBooks: string[]       // 已拥有
  equippedBook: string | null
  ownedArtifacts: string[]
  equippedArtifacts: string[]
  offlineRate: number        // 0.6
  stats: { totalQi: string; breakthroughs: number; playMs: number }
  lastSeenAt: number
  speed: 1 | 2 | 3            // 时间倍速，G3
  chargeReadyAt: number       // 蓄势完成时间戳（真实时间）
}
```

**必须区分 `owned*` 与 `equipped*`**：拥有 ≠ 装备。

### 5.2 读取流程（固定顺序）

1. 读原始 envelope，只解析 `schemaVersion`
2. 按版本逐级迁移：`migrate[n]` 把 n 迁到 n+1
3. 对最终结果做结构校验 + 业务不变量（realm ∈ 0..3、demon ∈ 0..1、equipped ⊆ owned）
4. 写入：先写备份槽，再切换主槽（原子）

```ts
const MIGRATIONS: Record<number, (old: unknown) => unknown> = {
}
```

### 5.3 测试 fixture

保留真实的 `save-v1.json`，迁移测试读 fixture 而不是构造新对象。

---

## 6. 功法书生命周期

```
装载 → 克隆 workspace 到 program[0] → 启用 modifiers + decay
  ↓
玩家编辑（program.dirty = true）
  ↓
出现"固化为个人功法"按钮
  ↓
固化 → equippedBook = null → 移除 modifiers/decay → 程序保留
```

规则：

| 问题 | 答案 |
|---|---|
| 改多少块算"自己的"？ | 只要 `dirty`（发生任意编辑）即可固化 |
| 卸下书后 workspace 保留？ | **保留**（固化后属于玩家） |
| 抄出来的程序能免费保留？ | 装载不编辑 → 卸下即丢弃（不可固化） |
| 衰减作用于哪？ | 只作用于**动作产出**（`bookDecay` 乘数） |
| 书境界 > 当前境界？ | `max(0, …)` 保证系数 ≥1，不出现负数 |
| P0 装备几本？ | **1 本**，1 个程序槽 |

---

## 7. 心魔与离线

### 7.0 时间倍速（G3）

| 倍速 | 效果 | 代价 |
|---|---|---|
| 1× | 默认 | — |
| 2× / 3× | 每帧多跑 tick | **心魔增长同倍速** |

- 倍速只影响在线；**离线固定 0.6 效率，不吃倍速**
- 倍速写入存档（`speed` 字段），回放可还原
- 预算仍是 **每 tick 200**，不随倍速放大
- 筑基解锁倍速（与「如果 / 循环」同批）

### 7.1 突破与渡劫（G2 定稿）

| 场景 | 触发 | 成功率 | 失败代价 |
|---|---|---|---|
| 在线 + 写有 `冲关` | 存量 ≥ 阈值 × 1.0 时进入挑战 | 手动 0.85 | 存量 ×0.85、心魔归 0、悟道 +1 |
| 在线 + 托管（挑战 10 秒无操作） | 自动结算 | 0.60 | 同上 |
| 离线 + 开关开 | 每次离线最多 **1 次** | 0.60 | **无惩罚**，停在阈值 |
| 离线 + 开关关 | 不尝试 | — | — |

- 突破不再使用概率公式；`阈值达成 → 可进入渡劫`
- 成功：境界 +1、`qi = 0`、`demon = 0`
- 保底：同一境界连续挑战 3 次，第 3 次必成
- `冲关`：仅在线生效；触发后当前程序暂停，进入挑战态，结束后恢复
- 冷却：每次渡劫后 60 秒内不可再次冲关
- 挑战随机：`drawAt(seed, 1_000_000 + 本境界内第 N 次挑战)`（N 从 1 起），与 tick 无关，
  保证"何时按按钮"不影响结果、Python 可复刻
- 悟道：P0 仅内存计数 + HUD 展示，**不入档**（刷新清零），无消费口

- 离线开关默认**关闭**

### 7.2 离线结算（G3：逐 tick 快进）

```
elapsed = clamp(now - lastSeenAt, 0, 60min)
结果    = fastForward(elapsed / TICK_MS)      // 复用 VM，同一种子
结果    = fastForward(elapsed / TICK_MS)
gained  = Σ(每 tick 产出 × 0.6)    // **逐 tick 折**：阈值判定也按折后存量走
rawGained = Σ(每 tick 全额产出)     // 仅用于报告"同期在线口径"一行
finalQi = 结果.finalQi                // 渡劫成功则 0，失败停在阈值

```

- **封顶 60 分钟**：离线超过 60 分钟仍按 60 分钟结算
- 离线期间**不涨心魔、不触发杂念**
- 离线期间 `demonDelta` **一律归零**（既不涨也不消，防"挂一叠调息白嫖洗心魔"），`demon` 原样带出
- 离线渡劫复用同一 `attempt` 序列，§7.1 的"第 3 次必成"照常生效
- 离线渡劫失败：模拟**停在阈值**，`creditedGained = finalQi = 阈值`（逐 tick 已折 0.6，不再二次折）
- 逐 tick 折算的副作用：离线达到阈值比在线慢 1/0.6 ≈ 1.67 倍，这正是「在线 > 离线」不等式的来源
- 系数以常量 `OFFLINE_RATE = 0.6` 为准，**不采信档面 `state.offlineRate`**（防改档白拿）
（因此与在线不是严格等价，只保证"产出等价"）
- 离线期间最多触发 1 次渡劫（见 7.1）
- 渡劫成功：`rawGained` 累计到成功前一刻，之后按新境界继续；最终 `finalQi = 0`
- 渡劫失败：停在阈值，**剩余 tick 不再产出**（`stoppedReason='threshold'`）
- 离线渡劫使用**存档种子**，同一存档重放结果一致

```ts
interface OfflineResult {
  rawGained: string; creditedGained: string
  breakthroughs: { realm: number; ok: boolean }[]
  finalQi: string; finalRealm: number; stoppedReason?: 'threshold' | 'cap'
}
```
- 上限若以后放大到 6h+，再引入变步长快进（Roadmap）

### 7.3 蓄势（时间墙）

| 渡劫 | 需蓄势 |
|---|---|
| 炼气 → 筑基 | 0（立刻可渡） |
| 筑基 → 金丹 | **15 分钟** |
| 金丹 → 元婴 | **60 分钟** |

- **起点**：存量**首次达到阈值**的那一刻开始计时（不是进入境界时）
- 同一境界内重复挑战不重置蓄势
- 离线结算需记录"达标时刻"，从该时刻起算蓄势
- 演示模式可跳过蓄势
- 蓄势用**真实时间**计时，存 `chargeReadyAt`
- **不受离线 60 分钟产出上限约束**（蓄势是等待，不是产出）
- 蓄势未完成时 `冲关` 无效，按钮置灰并显示剩余时间
- 顶栏常驻：`操作 31 分钟 ｜ 日历约 1.5 小时`

## 8. 排行榜与回放（第二阶段）

> P0 不实现，但接口与哈希口径现在定死。

| 项 | 规则 |
|---|---|
| 种子 | **服务端发放**（防挑种子） |
| 评测窗口 | 固定 60 秒，从 0 开始，无离线 |
| 提交内容 | `engineVersion` + `contentVersion` + 规范化 IR + 操作时间戳 |
| 哈希 | `sha256(IR + 事件序列 + 最终状态)`，不只比数值 |
| 评分 | `score = 总产出 / 总步数`；**总步数为 0 时 score = 0** |
| 作弊 | 纯前端 localStorage **无防作弊能力**，文档不得宣称"防改档" |

---

## 9. 工具链

- TypeScript strict，`balance-sim` 用 **tsx** 执行：

```bash
npx tsx tools/balance-sim.ts
```

- 不直接用 `node` 跑 `.ts`；不产出 `.mjs` 副本。

---

## 10. 必须覆盖的测试

| 类别 | 用例 |
|---|---|
| IR | 跳转越界、循环不配对、栈下溢、除零、嵌套超限 |
| VM | 预算截断、stall 字段完整、5 tick 追帧上限 |
| 存档 | v1 fixture 读取、双槽原子写、损坏回退、负时长 |
| 数值 | 目标表逐行对比（±20%） |
| 内容 | JSON schema、非法 actionId、重复 id |
| 回放 | 固定种子逐 tick 一致（第二阶段） |
