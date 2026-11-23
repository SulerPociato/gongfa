# 代码修仙 · 文档索引

> 一句话：**别人挂时间，你挂自己写的算法。**
> 状态：**可玩（初赛版）**。以 `00-contracts.md` 为唯一权威；改动需走评审。

## 立即试玩

- **演示版（推荐，工具箱全开 + 3× 倍速 + F/R/X 快捷键）**：
  <https://sulerpociato.github.io/gongfa/?demo=1>
- 正式版（从新档开始，含六步引导）：
  <https://sulerpociato.github.io/gongfa/>

演示版按键：`F` 跳到下一境界达标前 5%（金丹），`X` 打开渡劫面板，`R` 清档重开。

## 当前文档（6 份）

| 文件 | 给谁看 | 内容 |
|---|---|---|
| [00-contracts.md](00-contracts.md) | **所有人先看** | 唯一口径：数值、IR、存档、功法书、心魔、排行榜 |
| [01-design.md](01-design.md) | 玩法 / 策划 | 教育内核、核心循环、功法书、法宝、视觉、演示脚本 |
| [02-architecture.md](02-architecture.md) | 技术 | 分层、内容驱动、VM 摘要、二阶段后端 |
| [03-qoder-brief.md](03-qoder-brief.md) | 开发执行者 | 项目总述 + 任务 1–11 + Blockly 参考程序 |
| [04-mapping-roadmap.md](04-mapping-roadmap.md) | 设计 / 开发 | P0 教育映射边界、P1 候选闸门、P2 研究池 |
| [12-teaching.md](12-teaching.md) | 设计 / 评审 | 教育理念、竞品对照、算法↔修仙命名原则 |

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
| [reviews/09-mapping-adversarial-review.md](reviews/09-mapping-adversarial-review.md) | 映射路线图三轮对抗审查与优化记录 |

## 工具

| 文件 | 说明 |
|---|---|
| `tools/prototype/balance-sim.py` | 参考实现，复现目标表；仓库根执行 `python tools/prototype/balance-sim.py` |
| `tools/prototype/balance-sim.log` | 最近一次运行结果（四境界，三档心魔基线），契约第 3 节数字的来源；**由人工重定向生成，不随 `pnpm test` 更新**：`python tools/prototype/balance-sim.py > tools/prototype/balance-sim.log` |
| `tools/reference-run.ts` | 任务 10 产物：VM 与 sink 双路径对账，证明参考程序按契约能跑出 1:40 / 4:12 / 7:04 / 11:09 |

## 部署

### 本地开发

```bash
pnpm install
pnpm dev          # 启动 Vite 开发服务器，默认 :5173
pnpm --filter @gongfa/web build    # 构建生产产物到 apps/web/dist/（约 1.1MB，其中 JS 1,019.62 kB / gzip 295.02 kB，主要来自 Blockly）
pnpm --filter @gongfa/web preview  # 预览构建产物，默认 :4173
```

根 `package.json` 只有 `dev` / `sim` / `sim:table` / `test` / `typecheck`，`build` 与 `preview` 在 `@gongfa/web` 里，所以要用 `--filter` 调。
`@gongfa/core` 与 `@gongfa/blocks` 没有构建步骤（`exports` 直接指向 `.ts` 源码），新克隆 `pnpm install` 后即可直接构建。

### 字体

构建用 `apps/web/public/fonts/`（`global.css` 的 `@font-face` 从这里取），仓库根的 `assets/fonts/` 保留为源文件。
换字体时两处都要更新，否则 `assets/` 会变成一份没人读的旧副本。

### GitHub Pages 部署

仓库为 private 时 Pages 不可用，需在比赛提交时转为 public。转换后：

1. **Settings → Pages → Source** 选择 `gh-pages` 分支
2. **构建命令**（在仓库根目录执行）：

```bash
MSYS_NO_PATHCONV=1 VITE_BASE=/gongfa/ pnpm --filter @gongfa/web build
# Windows CMD 用户：set VITE_BASE=/gongfa/ && pnpm --filter @gongfa/web build
```

3. **部署产物**：将 `apps/web/dist/` 推送到 `gh-pages` 分支

```bash
git subtree push --prefix apps/web/dist origin gh-pages
```

4. **访问地址**：`https://<username>.github.io/gongfa/`

### 演示模式

评审或演示时，在 URL 添加 `?demo=1` 进入演示模式：

- **3× 倍速**：真实时间 3 秒 = 模拟时间 9 秒
- **F 键**：一键跳到金丹（元婴前一境），qi = 金丹阈值 × 0.95
- **R 键**：清档重置（需确认）
- **渡劫**：跳过蓄势与 10 秒挑战，点「可渡劫」当场按 85% 结算

示例：`https://<username>.github.io/gongfa/?demo=1`

### 数值验证

```bash
pnpm sim          # 60s=600 基线校验（任务 1 产物）
pnpm test         # 371 测试 / 26 文件
pnpm typecheck    # 4 个项目类型检查
```

任务 10 的双路径对账：`npx tsx tools/reference-run.ts`，输出 VM 路径与 sink 直算的逐境界对比，偏差 < 0.1%。

## 冻结前仍待确认

1. 外援评审对"无杂念下界作为 P0 验收基线"的意见
2. TS 版 `balance-sim` 与原型的 ±1% 一致性（任务 1 产物）
3. 任务 10 用 Blockly 参考程序复现目标表，而非模拟器内部约定

## 修改约定

1. 改数值/结构：**只改 00-contracts**，其它文档引用它，不重复定义数字
2. 改常量：重跑 `balance-sim.py`，同步更新契约第 3 节
3. 评审往来一律放 `reviews/`，不进主目录
