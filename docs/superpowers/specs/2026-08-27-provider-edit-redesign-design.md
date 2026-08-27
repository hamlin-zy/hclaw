# 设计文档：添加/编辑服务商界面重构

> 状态：已定稿（前置核实已完成，待实施）
> 日期：2026-08-27
> 范围：服务商配置窗口尺寸、添加/编辑服务商弹窗布局、模型价格配置、原生弹窗治理

## 一、背景与问题

1. 内容紧凑且局促：配置窗口默认宽 620px（`configWindow.ts` DIALOG_SIZES），弹窗固定 `max-w-lg`(512px)，无法利用窗口空间。
2. 自动获取模型列表后渲染结果**默认全选**，误操作风险高（`ProviderEditModal.tsx` handleFetchModels 中 setSelectedIds 预填充）。
3. 模型列表一行一个模型，没有空间为每个模型配置价格（输入/输出/缓存读/缓存写）。
4. 部分弹窗/提示仍使用浏览器原生 `window.confirm` / `alert`，与项目自研 `ConfirmDialog` 组件不一致（详见第五节）。

## 二、设计原则

- 遵循 impeccable 插件 Operate 模式：设置类 UI，扫描性、一致性、原生预期优先。
- 沿用全局主题（brand 色 / CSS 变量 / tailwind 类），不引入新视觉体系。
- 配置项按 API 类型上下文条件渲染并附用途/影响范围说明，全部直接可见、不做隐藏式收纳。

## 三、方案

### A. 服务商配置窗口（src/main/utils/configWindow.ts）

| 项 | 现状 | 目标 |
|---|---|---|
| `'llm-config'` 默认尺寸 | `{width: 620}` | `{width: 840, height: 760, minWidth: 680}` |

> 注：`minHeight` 为 `configWindow.ts` 全局固定值 400（结构上不支持按 dialog 类型覆写），本次不动；实测内容超高由弹窗内滚动兜底，不足再另立议题调整全局机制。
> 尺寸持久化 **不做**（避免为单一 dialog 类型引入特例；后续按类型统一做时再评估）；最大化按钮已有，不动。

### B. 添加/编辑服务商弹窗（ProviderEditModal.tsx）

1. **尺寸**：`max-w-lg max-h-[85vh]` → 弹性 `w-full max-w-[800px] max-h-[88vh]`，随宿主窗口伸缩。不做弹窗内拖拽 resize handle（窗口已可调大，Web 内实现成本高收益低）。
2. **信息架构**：
   - API 类型预设卡片
   - **类型相关设置区**（卡片正下方、服务商名称上方；随 providerType 条件渲染，始终可见、不折叠，每项附一行「作用 + 影响范围」说明）：
     - openai/custom → API 形态（Chat Completions / Responses API）
     - anthropic → system 内容块数组（含 cache_control 说明）
     - google → 认证方式（API Key / Google 账号登录），附「SDK 固定端点无需 Base URL」说明
     - ollama → 文字提示（本地服务，无需凭据）
   - 服务商名称与凭据同行双列、Base URL 独立成行；凭据位随认证形态切换（API Key 输入框或 Google OAuth 授权状态面板）
3. **Google 双认证独立布局**（沿用现有实现逻辑优化呈现）：
   - `google-oauth2`：Base URL 隐藏（SDK 固定端点）；API Key 输入位替换为授权状态面板（已授权账号 / 过期 / 登录按钮 + 切换账号）
   - `api-key`：显示 Google AI Studio 密钥输入框
4. **模型管理**（视觉主体）：表格布局，列 = 模型 ID｜类型｜输入价/输出价/缓存读/缓存写（4 个数字输入框，**列宽自适应内容**；表头单行「输入价($/M)」式，货币符号随切换器显示 `$|￥`；换算参考行与输入框右对齐）｜填充（表头仅示「填充」，点击以 OpenRouter 元数据回填该行空缺价格）｜测试｜删除。
   - **移除「启用」开关列**——使用哪个模型由模型方案中的角色引用（InputArea 下方的模型选择器）决定。已确认：消费方忽略 `enabled` 字段、不做过滤。规则：新增模型行固定 `true`；编辑时原样透传存量值不丢失；无需任何 UI 兜底入口
   - **类型列**：保持单值枚举徽标（`ModelType`）。类型来源分两层：现状拉取模型时仅按模型 ID 命名规则推断（`providerModelFetcher.toModelEntries` → `inferModelType`）；本期 ↧ 填充按钮命中 OpenRouter 元数据时，用 `architecture.input_modalities`（`modelMetaRegistry.getInputModalities()`）更新该行类型与模态展示。悬停徽标显示完整输入模态组合与识别来源。列定宽 + 徽标不换行 + 表格横向滚动兜底，不因多模态挤压布局；数据层不扩为多值字段
   - 测试失败态：图标变红叉，悬停 tips 展示 LLM 请求返回的完整错误包 + 「复制错误信息」按钮；测试通过显示延迟毫秒数
   - 价格输入框宽度 100% 填满单元格、表头单行 nowrap；窄窗口表格整体横向滚动兜底
5. **价格货币切换**（对齐全局汇率管理器 `src/main/exchangeRateRegistry.ts`，`getUsdCnyRate()` 兜底 7.2）：
   - 模型表工具栏提供 `$ 美元｜￥ 人民币` 切换段；价格列表头货币符号随切换显示 `$|￥`
   - 切换货币时已填价格按实时汇率自动换算重显；每个价格输入框下方以小字自动换算显示另一货币参考值（`≈ ￥18.03`），输入时即时联动
   - **落盘边界**：仅当用户在当前货币模式下编辑了该单元格，才按汇率折算写回 USD 存储；纯切换浏览/保存不回写展示舍入值，避免反复切换导致存储价格漂移
   - **存储不变**：内部统一存 USD/token 单一数据源；人民币录入按汇率折算为 USD 后存储。货币仅为展示层行为，不新增存储字段、不影响 `computeUsageCost` 链路
   - 工具栏展示汇率日期（`ExchangeRateRegistry.getDate()`），未同步时显示兜底汇率
   - **模型 ID 参考价填充（按钮触发）**：列标题为「模型 ID」；每行新增 ↧ 填充按钮，点击后按该行模型 ID 查询 OpenRouter 元数据并回填**空缺的**价格列与类型徽标。**不做输入自动联动**——价格配置的数据源是用户为成本校准维护的值（官方价与 OR 价不一致时的校正项），实时联动会让已填价格与配置脱节。覆盖规则：已有价格一律不覆盖；未匹配到元数据时红字提示、无副作用
6. **拉取列表默认不勾选**：`handleFetchModels` 中 `setSelectedIds` 初始改为空集，面板增加「全选 / 清空」快捷操作；拉取结果面板显示在模型列表上方（工具栏与表格之间）。
7. **空列表占位**：模型表为空时显示占位行「暂无模型 · 点击手动添加或从服务商拉取开始」，不再空白无引导。
8. 可交互 HTML Demo（v3，含类型切换、货币换算、按钮触发参考价填充演示）：`docs/superpowers/demos/provider-edit-redesign-demo.html`（随文档入库）

### C. 数据层与价格链路

1. `src/shared/types/model.ts` — `ProviderModel` 新增：

```ts
pricing?: {
  input?: number      // USD / token
  output?: number
  cacheRead?: number
  cacheWrite?: number
}
```

UI 录入单位为 `$ / 1M tokens`，存储时 ÷1e6 转为 USD/token —— 与现有 `computeUsageCost`（tokens × price 直乘，见 `llmUsage.ts:113`）口径零改动兼容。

2. `llmUsage.ts` — `PriceSource` 增加 `cacheWritePrice?: number`（缺省视为 0，向后兼容）。
3. **新增 IPC `model-meta:lookup`**（模式对齐既有 `model-meta:get-window`）：入参 model ID，主进程经 `modelMetaRegistry.ensureLoaded()` 后返回 `{ inputPrice, outputPrice, cacheReadPrice, cacheWritePrice?, contextLength, inputModalities, matchedKey }`（`matchedKey` = 实际命中的 OR 条目 ID，供填充结果提示）。注意：这不是纯暴露——现有 `getMeta()` 不解析缓存写价格，registry 需小扩展读取 OR 原始 `pricing` 的缓存写键（键名按第七节第 3 项结论），缺失则返回 `undefined`。
4. **取价合并**（按 provider 维度精确归属，避免同模型多服务商定价串价）：
   - **现状缺口**：`llm_usage` 记录已有 `providerType` 与 `providerName` 维度（`src/shared/types/infra.ts:205`），但 `providerName` 是用户可改的显示名且历史行可空——不足以精确定位服务商
   - **本期补充**：用量写入链路（`toLlmUsageRecord` / `LlmUsageEventSource`）增加稳定 `providerId`，`llm_usage` 表加可空列（ALTER TABLE 小迁移）；取价合并优先按 `(providerId, model)` 精确匹配该服务商自定义定价
   - **降级链**：历史行无 `provider_id` → 按 `providerName` 匹配（重名/改名场景取确定性首命中，注释声明局限）→ 均未命中自定义定价 → 回退 OpenRouter 全局价目表
   - **重算粒度约束**：成本重算必须在 `(provider, model)` 粒度分组执行、各自独立取价后再汇总——严禁先按 model 聚合跨服务商 token 再取单一价格，否则归属机制失效

## 四、测试与验证

vitest 单测：
- 取价合并优先级与归属链：(providerId, model) 精确命中 → 缺 provider_id 按 providerName 匹配 → 全未命中回退 OpenRouter > 0
- 价格单位换算：$/1M ↔ USD/token 往返（放大 1e6 比较 + 浮点容差）
- 货币切换：USD 录入 → 切￥ → 切回 $，存储值不变；￥ 录入落盘 = 输入值 ÷ 汇率；纯切换浏览不落盘
- 填充按钮：部分空缺回填 / 全满提示「无空缺」且原值不动 / 未匹配红字无副作用
- `PriceSource.cacheWritePrice` 缺省 → 成本计 0
- `model-meta:lookup`：精确命中 / 前缀模糊命中 / 未命中 / 空表降级返回零值与空 `matchedKey`
- 回归守卫：grep 断言 renderer 无 `window.confirm|alert|prompt` 残留

手动验证：
- 添加/编辑全流程；价格填写（含 8 位小数）保存重开回显无损
- Google 双认证两种形态布局（OAuth 隐藏 Base URL + 授权面板 / api-key 密钥框）
- 拉取列表默认不勾选、面板位于列表上方、全选/清空、替换前自研 confirm 弹窗
- 测试失败 tips 展示错误包与复制；成功显示延迟；类型徽标 hover 模态/来源提示
- 窄窗口横向滚动、币种切换重显、`enabled=false` 存量模型编辑后字段未丢失

实现完成后跑 impeccable `polish` 视觉质检

## 五、原生弹窗治理清单（本次一并修改）

项目已有统一确认组件 `src/renderer/components/ConfirmDialog.tsx:25`（导出 Promise 化 `confirm(options)`），以及多处局部 Toast 实现（如 `statsParts.tsx:25` 简易 Toast 成功/错误）。以下调用仍在使用浏览器原生弹窗，需替换：

| # | 位置 | 现状 | 替换方案 |
|---|------|------|---------|
| 1 | `src/renderer/components/dialogs/ProviderEditModal.tsx:285` | `window.confirm("将清空现有 N 个模型并用勾选项替换…")` | 改用 `await confirm({title/message})`（本就在重构范围内） |
| 2 | `src/renderer/components/dialogs/ScheduleDialog.tsx:226` | `alert(\`启动失败: …\`)` | 错误提示改用 Toast（复用 `statsParts.tsx` 的 `Toast` 组件，已确认可跨窗口导入，见第七节第 4 项） |
| 3 | `src/renderer/components/dialogs/ScheduleDialog.tsx:229` | `alert(\`启动异常: …\`)` | 同上 |

> 说明：无 `window.prompt` 使用。其余 dialog（Plugin/MCP/Skills/Settings 等）均已使用自研 `confirm()`，无需处理。Electron 原生 `dialog.showOpenDialog`（文件选择器等系统对话框）语义合理，**不属于本次治理范围**。

## 六、明确不做

- 不新增实时计费/预算/配额等功能模块——provider 归属只是让**既有**用量重算链路的取价更精确，不改变触发时机与计算公式
- 不做弹窗拖拽 resize、不做单类型窗口尺寸持久化
- 不大规模拆分 ProviderEditModal 文件（仅抽取模型表格子组件）

## 七、前置核实结论（2026-08-27 与发起人逐项确认）

| # | 核实项 | 结论 |
|---|--------|------|
| 1 | `enabled` 消费方 | 消费方忽略该字段、不做过滤；新增默认 `true` 即可，无需兜底入口 |
| 2 | 用量记录 provider 维度 | 必须携带稳定维度以防串价：本期新增 `provider_id` 写入 + 表迁移，合并策略见 C-4 降级链 |
| 3 | OR 缓存写字段键名与降级 | 方案认可：实现时按实际键名解析，缺失即 `undefined → 成本计 0` |
| 4 | `statsParts.tsx` Toast 复用性 | 已核实：`Toast` 为纯函数组件导出，可在独立配置窗口内直接 import（UsageWindow 同窗口已有使用先例）；ScheduleDialog 直接复用 |

> 后续如核实结论变化，先更新本表再动代码。
