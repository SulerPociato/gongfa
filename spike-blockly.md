# Blockly Spike（R14）

> 目的：在任务 5 之前确认三件事，避免存档格式返工。需要本地环境（Node + 浏览器）。

## 三个问题

| # | 问题 | 方法 | 通过标准 |
|---|---|---|---|
| 1 | 中文界面是否完整 | 引入 `blockly/msg/zh-hans`，看块名/右键菜单/提示是否全中文 | 无英文残留 |
| 2 | 主题换皮成本 | 用 `Theme` API 改色（墨黑底、灵气青连线、符纸金高亮） | 不改渲染器即可换色 |
| 3 | workspace 序列化格式 | 对比 `Blockly.serialization.workspaces.save()/load()` 与旧 XML | 保存→加载→再保存，两次 JSON 完全一致 |

## 实跑结果（2026-11-18，Blockly 13.4.0，Node 24 + jsdom 无头）

| 问题 | 结果 | 证据 |
|---|---|---|
| 中文界面 | ✅ 完整 | `CONTROLS_REPEAT_TITLE = "重复 %1 次"`、`TEXT_PRINT_TITLE = "输出%1"` |
| 主题换皮 | ✅ 可用 | `Blockly.Theme.defineTheme` 生效，`componentStyles.workspaceBackgroundColour = "#0A0E12"` |
| workspace 序列化 | ✅ JSON 往返稳定 | save→load→save 两次字符串**完全相等**；3 块 232 字节；shadow 输入保留 |

**结论**：
1. 存档用 **JSON**（`Blockly.serialization.workspaces.save/load`），不用 XML
2. 序列化体积很小（3 块 232 B），可直接存进 SaveFile，无需压缩
3. 无头环境（jsdom）可跑序列化测试，**适合放进 CI**
4. **未覆盖**：真实拖拽手感、触摸事件、主题视觉——jsdom 不渲染，这三项仍需一次浏览器手测（任务 5 前完成）

## 产出

- 一个 `spike.html`，能拖 3 块、保存、刷新后还原
- 记录：序列化体积（KB）、是否含函数/变量等不稳定字段
- 结论写回 `02-architecture.md` §3（存档格式决定）

## 不通过时的退路

- 若 JSON 往返不稳定 → 存档只存"自研简化 AST"，Blockly 工作区每次由 AST 重建
- 若中文缺失 → P0 接受英文块名，文案层做中文注释
