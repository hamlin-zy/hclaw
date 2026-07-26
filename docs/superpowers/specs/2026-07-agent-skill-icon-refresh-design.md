---
title: 'Agent & Skill 卡片图标与格式对齐设计'
date: '2026-07'
status: 'approved'
---

# Agent & Skill 卡片图标与格式对齐

## 背景

Agent 卡片和 Skill 卡片目前共享一些视觉风格（共用 ⚡ 图标），但显示格式不一致。
Agent 卡片有完整的独立行展示（含类型标签、名称），Skill 卡片则混入普通工具芯片中。

**目标：**
1. 图标区分：Agent → 🤖，Skill → 🛠️
2. 格式统一：Skill 卡片的渲染格式向 Agent 对齐

## 图标方案

| 类型 | 旧图标 | 新图标 |
|------|--------|--------|
| Agent | ⚡ | 🤖 |
| Skill | ⚡（共用） | 🛠️ |

## 格式对齐方案

### 当前 Agent 卡片格式（作为对齐标杆）

| 渲染位置 | Agent 格式 |
|----------|------------|
| ToolCallHeader | `agent`（灰）`■ Plan`（品牌色标签）`任务描述`（主色粗体）|
| UltraCompactToolGroup | 独立行：`⚡` + `●` + `agent` + `■ 类型` + `任务名` + 芯片列表 |
| UltraCompactCombinedGroup 芯片 | `⚡ agent名 成功/总数` |
| CombinedCardPopup 芯片 | `⚡ agent名 成功/总数` |
| CompactPopup 标题 | `⚡` + 标题栏 |
| CompactPopup 卡片 | `⚡` + `agent` + `■ 类型` + `名称` + 状态标签 + 时间线 |

### 当前 Skill 卡片格式（待对齐）

| 渲染位置 | Skill 格式 | 对齐后格式 |
|----------|-----------|-----------|
| ToolCallHeader | `skill 加载 技能名` | `🛠️ skill`（灰）`技能名`（主色粗体，与 agent 的 `类型标签 + 名称` 结构一致） |
| UltraCompactToolGroup | 混入普通工具芯片 | 类似 agent 的独立行：`🛠️` + `●` + `skill` + `技能名` + 芯片列表 |
| UltraCompactCombinedGroup 芯片 | `skill 成功/总数` | `🛠️ skill 成功/总数` |
| CombinedCardPopup 芯片 | `skill 成功/总数` | `🛠️ skill 成功/总数` |
| CompactPopup | 无 skill 特殊处理 | `🛠️` + 标题栏 + 卡片（与 agent 卡片格式一致） |

### 关键变更点

1. **新增 `isSkill` 判定** — 在 `messageUtils.ts` 中添加 `isSkillToolCall(tc)` 函数，与 `resolveAgentDisplayName` 对称。判定条件：`tc.name === 'skill'`
2. **透传 `skillDisplayName`** — 确保所有需要显示 skill 的地方都正确拿到 displayName（当前 ToolCallRenderer 已在 prop 中传了 `skillDisplayName`，CombinedCardPopup/CompactPopup 中用到的地方需要补）
3. **芯片渲染** — 在 `CombinedCardPopup.tsx`、`ToolCallRenderer.tsx`、`compact-popup/index.tsx` 中，芯片的 `isAgent` 判断处增加 `isSkill` 分支，显示 🛠️ + 格式化的 `skill` 名称
4. **UltraCompactToolGroup** — 增加 `isSkill` 分支，以独立行展示（与 `isAgent` 类似的 layout）
5. **CompactPopup** — 为 skill 类型的弹窗内容提供专门的渲染布局（类似 agent 卡片已有的事件流/结果展示）

## 涉及文件

| # | 文件 | 变更 |
|---|------|------|
| 1 | `src/renderer/components/message-list/utils/messageUtils.ts` | 新增 `isSkillToolCall()` 函数 |
| 2 | `src/renderer/components/message-list/ToolCallRenderer.tsx` | UltraCompactToolGroup 增加 `isSkill` 分支；UltraCompactCombinedGroup 芯片中 skill 显示 🛠️ |
| 3 | `src/renderer/components/message-list/ToolCallHeader.tsx` | skill 显示格式改为 `🛠️ skill 技能名` |
| 4 | `src/renderer/components/message-list/compact-popup/CombinedCardPopup.tsx` | 芯片和标题中 skill 加 🛠️ |
| 5 | `src/renderer/components/message-list/compact-popup/index.tsx` | CompactPopup 中 skill 独立展示 |
| 6 | `src/renderer/components/skill/SkillBubble.tsx` | ⚡ → 🛠️ |

## 影响范围

- 纯 UI 变更，零逻辑改动
- emoji 替换 + 条件渲染分支增加
- 无回归影响
