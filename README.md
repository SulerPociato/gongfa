# 代码修仙 · 文档索引

> 一句话：**别人挂时间，你挂自己写的算法。**
> 状态：**待外援评审，暂未冻结**。冻结后以 `00-contracts.md` 为唯一权威。

## 当前文档（4 份）

| 文件 | 给谁看 | 内容 |
|---|---|---|
| [00-contracts.md](00-contracts.md) | **所有人先看** | 唯一口径：数值、IR、存档、功法书、心魔、排行榜 |
| [01-design.md](01-design.md) | 玩法 / 策划 | 教育内核、核心循环、功法书、法宝、视觉、演示脚本 |
| [02-architecture.md](02-architecture.md) | 技术 | 分层、内容驱动、VM 摘要、二阶段后端 |
| [03-qoder-brief.md](03-qoder-brief.md) | 开发执行者 | 项目总述 + 任务 1–11 + Blockly 参考程序 |

**评审顺序**：00 → 01 →（需要时）02
**开发顺序**：00 → 03 → 02

## 评审往来（归档）

| 文件 | 说明 |
|---|---|
| [reviews/04-review-response.md](reviews/04-review-response.md) | 第一轮回应（数字已被 05 取代） |
| [reviews/05-review2-response.md](reviews/05-review2-response.md) | 第二轮回应：心魔数学、三基线 |
| [reviews/06-freeze-request.md](reviews/06-freeze-request.md) | 第三轮回应：两个真 bug 修复、冻结申请 |
| [reviews/07-freeze-fixes.md](reviews/07-freeze-fixes.md) | 8 条冻结阻塞项的修复记录 |
| [reviews/08-final-sync.md](reviews/08-final-sync.md) | 10 项文档同步修复 + 自动化自查 |

## 工具

| 文件 | 说明 |
|---|---|
| `tools/prototype/balance-sim.py` | 参考实现，复现目标表；`python balance-sim.py` |
| `tools/prototype/balance-sim.log` | 最近一次运行结果（四境界，三档心魔基线），契约第 3 节数字的来源 |

## 冻结前仍待确认

1. 外援评审对"无杂念下界作为 P0 验收基线"的意见
2. TS 版 `balance-sim` 与原型的 ±1% 一致性（任务 1 产物）
3. 任务 10 用 Blockly 参考程序复现目标表，而非模拟器内部约定

## 修改约定

1. 改数值/结构：**只改 00-contracts**，其它文档引用它，不重复定义数字
2. 改常量：重跑 `balance-sim.py`，同步更新契约第 3 节
3. 评审往来一律放 `reviews/`，不进主目录
