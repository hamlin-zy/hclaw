# 设计文档：data-name 组件标识规范

- 日期：2026-08-31
- 状态：已实施（2026-08-31）
- 范围：HClaw renderer（src/renderer）

## 1. 背景与目标

renderer 中部分组件已有 `data-name` 属性（如 `App.tsx` 的 `background-layer`、`ConversationPage.tsx` 的 `message-list-card`），但无统一规范，覆盖不全。

目标：为未来"用户输入自然语言指令 → 精准定位 UI 组件"建立可靠基础。指令定位依赖 `data-name`，因此必须保证：

1. 关键元素**都有** `data-name`（不遗漏）；
2. `data-name` **全局唯一**（不冲突）；
3. 约定**机器可检查**（不依赖记忆和自觉）。

## 2. 覆盖范围

| 类别 | 示例 | 要求 |
|------|------|------|
| 可交互元素 | `button`、可点击 icon（`role="button"` 或带 onClick 的元素）、`input`/`textarea`/`select`、下拉/菜单触发器 | 必须有 `data-name` |
| 关键区域容器 | 页面级卡片、侧栏、面板、列表容器、输入区 | 必须有 `data-name` |
| 纯展示元素 | 文本、分隔线、装饰性图标 | 不加 |
| 内部实现包装 | 无语义、不可被指令指到的包装 div | 不加 |

判定标准：**"未来用户对着它下指令时，需要指到它"的元素才加。**

## 3. 命名规范

- 格式：英文 kebab-case，正则 `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`
- 唯一性：**全局唯一**，同一 `data-name` 在整个 renderer 中只能出现一次
- 命名模式：`<对象>-<角色/位置>`，如 `input-area-card`、`cache-rate-model-switcher`、`message-list-card`
- 同类元素用语义区分（`conversation-quick-entry`、`settings-quick-entry`），禁止 `item-1/item-2` 式编号

## 4. 强制机制（三层防线）

### 4.1 ESLint 规则：防重名

- 自定义规则 `data-name/unique`：扫描 JSX 中所有 `data-name` 字面量值，发现重复报 error。
- 在 `eslint.config.ts` 中注册为 local rule。
- 规则头部注释写明核心规范（见代码即见规范）。
- 缺名不做 ESLint 强制（大量合法无 `data-name` 元素会误报），由测试兜底。

### 4.2 测试守护：防缺名

- 新增 vitest：渲染核心页面（App + 主要 Page 组件），遍历 DOM，断言所有 `button, [role="button"], input, textarea, select` 均有非空 `data-name`。
- 动态渲染/弹层组件逐个补挂载断言。
- 覆盖不到的场景允许白名单，白名单条目必须注明 TODO 及原因。
- 失败信息需指出组件名，便于定位。

### 4.3 Spec 文档：人类可读规范载体

- 本文档为唯一人类可读规范。
- ESLint 规则注释中重复核心规则，不另设 CLAUDE.md / agent.md 约定层（HClaw 不读该层）。

## 5. 落地范围（待 writing-plans 细化）

1. 全量盘点现有 renderer 组件，补齐缺失的 `data-name`。
2. 实现 ESLint `data-name/unique` 规则并接入。
3. 新增缺名守护测试并接入 CI。
4. 白名单初始化（如有）。

### 5.1 实际产出（2026-08-31）

- ESLint 规则：`eslint-rules/data-name-unique.ts`，注册于 `eslint.config.ts`（插件 `data-name`，规则 `data-name/unique`）。检查 JSX 字面量 `data-name` 的全局唯一性与 kebab-case 格式。
- 守护测试：`tests/renderer/components/dataNameGuard.test.tsx`，选择器 `button, [role="button"], input, textarea, select`，断言均有非空 `data-name`。
- 注册表：`src/renderer/components/dataNameGuard.registry.tsx`，当前收录 7 个组件。新组件加入 `GUARD_COMPONENTS` 即自动纳入守护；`WHITELIST` 条目必须注明 TODO 原因。
- 补齐：全 renderer 共 509 个 `data-name`，均为语义命名；同质列表项使用 `${index}` 模板消歧。

## 6. 开放问题

- 无

### 6.1 遗留说明（实施后记录）

- 守护测试只检查非空，格式（kebab-case）与唯一性由 ESLint 规则 `data-name/unique` 互补覆盖。
- 动态模板名（如含 `${index}` 插值的 `data-name`）不在 ESLint 静态唯一检查范围内，依赖运行时语义约定保证唯一。
