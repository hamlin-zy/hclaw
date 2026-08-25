# 变更日志

所有重要变更均记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

---

## [Unreleased]

---

## [v0.4.12] - 2026-08-25

### 新增
- **会话级权限与显示模式** — 每个会话可独立设置权限模式和显示模式，输入栏新增分段切换控件，不同会话互不干扰（`ConvModeSegs.tsx` / `runtimeConfigManager.ts`）
- **侧边栏全新重构** — 常用工具入口移至侧边栏底部工具行，设置入口改为齿轮菜单，折叠状态下菜单图标完整可见，文案更清晰（`ConversationSidebar.tsx` / `menuItems.tsx`）

### 变更
- **新会话默认模式移至通用设置** — 全局默认权限/显示模式统一在设置中配置，显示模式文案精简更易读（`settingsStore.ts`）
- **用量统计按服务商分组显示** — 不同服务商用量正确分组，同名模型带服务商徽章，历史消耗一目了然（`llmUsageRepository.ts` / `UsageWindow.tsx`）

### 修复
- **长对话与长时间运行体验优化** — 修复长对话流式输出时界面响应变慢、长时间运行后占用升高的问题，整体运行更平稳（`InterleavedContent.tsx` / `toolCallsStore.ts`）
- **界面交互细节优化** — 提示气泡不再闪烁错位、方案选择器弹出与文本截断修复、四套主题恢复专属图标（`TooltipPortal.tsx` / `SchemeSelector.tsx`）
- **危险操作确认框统一** — 删除等操作的确认提示迁移至统一组件，操作更安全清晰（`ConfigDialogWindow.tsx` / `UsageStatsDialog.tsx`）

---

## [v0.4.11] - 2026-08-25

### 新增
- **LLM 调用日志（LLM Trace）** — 新增时间线视图，按会话查看每次模型调用的完整轨迹与用量详情，长对话排查问题更直观（`LlmLogsWindow.tsx` / `llmTraceRecorder.ts`）
- **跨轮任务恢复增强** — 会话恢复路径重构升级，中断的对话可更可靠地续跑，恢复时任务上下文更完整（`manager.impl.ts` / `seedApplication.ts`）
- **内存诊断工具** — 新增内存水位采样与增长趋势检测，便于开发期定位内存问题（`memoryWatermark.ts` / `growthDetector.ts`）

### 变更
- **Electron 升级至 43** — 运行时内核升级，新增版本断言与原生模块校验脚本，兼容性更稳（`package.json`）

### 修复
- **修复切换模型不即时生效的问题** — 重试前重新解析模型配置，倒计时期间切换模型立即生效（`loop/execute.ts`）
- **修复纯工具调用被误判的问题** — 增加 LLM 空响应检测，修复纯工具调用误判回归（`loop/execute.ts`）

---

## [v0.4.10] - 2026-08-24

### 新增
- **任务批次管理** — 待办任务支持按批次分组，批量创建、整批完成，长任务列表更有条理（`taskStore.ts` / `taskCreateTool.ts`）
- **消息内查找（Ctrl+F）** — 对话中随时按 Ctrl+F 搜索历史消息，快速定位内容（`InterleavedContent.tsx`）
- **会话来源导航** — 消息列表右下角新增"← 父会话 / ← 前会话"入口，跨会话跳转一键直达（`MessageList.tsx`）
- **多模态能力自适应** — 根据模型视觉能力自动过滤图片类工具，多模态请求失败时自动降级重试，对话不中断（`loop/controller.ts`）

### 变更
- **移除 Hook 系统** — 架构精简，Hook 相关配置不再生效（破坏性变更）
- **界面布局优化** — 待办列表迁移至输入区顶部常驻展示，移除右侧边栏；权限规则迁入独立窗口管理

### 修复
- **修复长时间运行内存持续增长的问题** — 渲染进程内存泄漏已修复，超大工具结果自动截断
- **修复渲染进程崩溃后的恢复体验** — 崩溃后可自动恢复，交接引导上下文更准确
- **修复 Windows 下命令输出显示异常** — PowerShell 环境下工具输出正常展示（`bashTool.ts`）

---

## [v0.4.9] - 2026-08-21

### 新增
- **用量徽章按模型切换查看** — 徽章卡片顶部可切换查看各服务商/模型的用量统计，历史模型消耗一目了然（`CacheRateTooltip.tsx`）
- **Hook 结果支持固定通知** — 固定通知可常驻展示，命令徽标卡片化重设计，展示更清晰（`HookResultsBar.tsx` / `CommandBadge.tsx`）

### 修复
- **修复助手消息偶发重复展示** — 子会话切换/首次打开场景下助手消息仍可能重复，现已彻底修复（`stream.ts` / `streamCore.ts`）
- **修复用量统计重复计数** — 用量统计改为单一数据源，不再出现重复累加（`llmUsageRepository.ts`）
- **修复工具调用偶发误执行** — 正文中疑似工具调用需严格校验后才执行，易混淆命令正确识别（`openaiAdapter.ts` / `bashTool.ts`）

---

## [v0.4.8] - 2026-08-21

### 新增
- **用量统计自定义时间范围与小时粒度趋势** — 用量窗口可选择任意时间范围查看消耗，并支持按小时查看用量趋势，各入口 KPI 口径统一（`UsageWindow.tsx` / `llmUsageRepository.ts`）
- **默认主力模型 + 方案智能校验** — 不再先做意图识别再选模型，对话直接走默认主力模型，方案配置更精简；模型角色按需动态切换（`modelSelector.ts` / `agentTool.ts`）
- **Agent 循环稳定性增强** — 重试逻辑加固、错误处理更完善、模型提示词缓存，长时间运行更可靠（`loop/execute.ts` / `llmCaller.ts`）

### 修复
- **修复助手消息偶发重复（幽灵双写）** — 某些交互场景下助手消息出现两次的问题（`streamCore.ts` / `messageHandler.ts`）
- **修复实体命令与技能气泡重复展示** — 执行 skills/agents 命令时不再与技能气泡重复（`streamSkills.ts`）
- **修复气泡状态注记、错误详情提取、工具调用解析等问题** — 对话气泡展示更准确（`MessageBubble.tsx` / `StatusIndicators.tsx`）
- **用量成本支持实时汇率换算** — 成本按最新汇率实时折算 USD/CNY（`exchangeRateRegistry.ts`）

---

## [v0.4.7] - 2026-08-19

### 新增
- **会话级模型选择器** — 每个会话可独立指定模型：服务商→模型 2 级菜单，默认跟随全局配置；新建子会话自动继承父会话模型，长对话不再被全局模型限制（`ModelSelector`）
- **Responses API 支持** — OpenAI 兼容服务商可切换 Responses 协议路径，流式输出与用量统计均已适配

### 变更
- **模型方案固定 6 角色** — 移除自定义角色与生成类死角色，模型角色更精简明确

---

## [v0.4.6] - 2026-08-18

### 新增
- **交接引导系统** — 长对话不再被自动截断：上下文占用接近上限时，发送前弹窗询问"交接新会话 / 继续 / 取消"，对话中途溢出也会自动提示并引导交接，避免 AI 记忆错乱；触发阈值与处理模式可配置（`agent.handoffThresholdRatio` 默认 50%、`agent.midLoopOverflowMode` 默认自动交接）
- **用量统计增强** — 用量窗口新增按时间走势的用量曲线；会话成本支持按分组切换 USD/CNY 货币

### 修复
- **修复子会话运行时长恒为 0 的问题** — 子会话耗时统计显示异常（`childConvMessages.ts`）
- **修复新建子会话后项目选择器丢失其他项目的问题** — 新会话不再覆盖工作区配置（`conversationStore.ts`）

---

## [v0.4.5] - 2026-08-18

### 新增
- **新增用量统计窗口** — 菜单栏可随时打开，查看各模型/服务商的 token 消耗与费用，支持按会话下钻、成本换算与货币切换（USD/CNY）
- **配置界面升级为独立窗口** — 设置、插件、会话、模型方案等 17 种对话框均可独立打开，多窗口同时查看互不遮挡；主题、模型方案、插件状态等修改在所有窗口间实时同步，无需手动刷新

### 修复
- **修复长对话中 AI 记忆偶发错乱的问题** — 长时间对话或切换会话后，AI 对之前的上下文理解更准确，回复不再遗漏关键信息

---

## [v0.4.4] - 2026-08-16

### 修复
- **修复长时间连续对话中内存占用持续增长的问题** — 大量工具输出或长会话场景下内存会随对话时间不断上升并可能卡顿，现改为增量式持久化并移除常驻缓存，内存占用恢复平稳（`conversationStore.ts`, `textBatch.ts` 等）

### 重构
- **渲染端持久化逻辑简化** — 移除工具输出旁路缓存与全量写兜底，块级增量成为唯一落库方式，逻辑更简洁可靠（`conversationStore.ts`）

---

## [v0.4.3] - 2026-08-15

### 优化
- **流式响应更流畅** — 高频流式输出下的界面渲染与事件处理性能提升，长对话连续输出更稳定顺滑（`streamBatch.ts`, `manager.accumulator.ts`, `textBatch.ts`, `thinkingBatch.ts`, `InterleavedContent.tsx` 等）

### 修复
- **修复并行执行工具时倒计时偶发显示超时的问题** — 工具实际已完成但界面倒计时仍在走，改为完成即同步显示（`toolExecutor.ts`, `streamTools.ts` 等）

---

## [v0.4.2] - 2026-08-14

### 新增
- **官网上线** — Astro 静态站点 + GitHub Pages 自动部署，含首页英雄区、功能特性、时间线与文档体系 (`website/`)

### 修复
- **跨 flush 增量覆盖导致历史正文残缺** — 增量写入会话边界对齐，修复并发 flush 场景下消息块被覆盖丢失 (`src/main/repositories/sqlite/conversationRepository.ts`)
- **opencode 网关孤儿 tool 消息导致的 400 错误** — adapter 增量转换对孤儿 tool 消息容错，preprocess 缓存清理策略修正 (`src/main/agent/loop/execute.ts`, `src/main/agent/loop/preprocessCache.ts`, `src/main/agent/model/openaiAdapter.ts`, `src/main/agent/model/anthropicAdapter.ts`, `src/main/agent/model/googleAdapter.ts`)
- **长任务最小化后 UI 卡死与布局溢出** — 后台节流下流式转发改用 gcScheduler 调度，窗口恢复时延迟滚动避免布局错位 (`src/main/agent/manager.streamForward.ts`, `src/main/agent/stream.ts`, `src/main/window.ts`, `src/renderer/App.tsx`, `src/renderer/lib/gcScheduler.ts`)

### 重构
- **代码简化** — 消除重复逻辑与死代码，插件技能路径提示与根部辅助文件扫描逻辑收敛 (`src/main/agent/skills/extensions.ts`, `src/main/agent/skills/guidance.ts`, `src/main/providerModelFetcher.ts`, `src/renderer/components/dialogs/ProviderEditModal.tsx`)

---

## [v0.4.1] - 2026-08-14

### 新增
- **模型管理增强** — 服务商智能识别填充（输入名称自动匹配 DeepSeek 等预设模型、预设卡片补全 baseUrl）、Base URL 格式校验（blur 触发，无法解析的 URL 不再误告警）、一键拉取模型列表 + 就地结果面板（搜索/类型筛选/全选/替换/合并）、模型单行测试 + 一键批量测试（✔/✖ 状态位 + 进度 + 取消 + 结果失效清空）、google 类型保存时自动写入固定 baseUrl、测试日志密钥脱敏、拉取结果面板适配暗色主题；新增 provider:fetch-models / provider:test-model IPC (`src/main/providerModelFetcher.ts`, `src/main/llmProviderIPC.ts`, `src/shared/modelPresets.ts`, `src/renderer/components/dialogs/ProviderEditModal.tsx`, `tests/modelPresets.test.ts`, `tests/providerModelFetcher.test.ts`)

### 修复
- **插件技能/Agent 路径提示与根部辅助文件扫描** — system.directories 提示词补充 skills/ 多来源说明（public/custom/~/.agents/skills）与 plugins/<name>/ 内技能/Agent 位置；能力索引表格插件来源条目追加 (插件名) 后缀；扩展扫描器新增扫描技能目录根部辅助文件（.md/.sh/.ts 等），使 SKILL.md 正文引用的同目录文件可被发现；guidance 扩展资源路径改用相对路径拼接 (`src/main/agent/systemPrompt.ts`, `src/main/agent/skills/extensions.ts`, `src/main/agent/skills/guidance.ts`, `src/shared/prompts.ts`, `src/shared/skillTypes.ts`)

---

## [v0.4.0] - 2026-08-09

### 新增
- **块级增量持久化全链路** — 消息块增量写入（writeBlockDelta → 渲染端 dirty 记账 → handler 接入 → metadata 瘦身 → 保险丝 → FK/CASCADE 修复），块 id 统一规范 + think id 段序号派生防碰撞 (`src/main/agent/manager.impl.ts`, `src/main/repositories/sqlite/messageBlockHelper.ts`, `src/renderer/stores/conversationStore.ts`)
- **session_handoff 会话交接工具** — 长会话上下文超限时生成结构化交接总结，新会话自动续接 + 多级子 Agent 级联清理 (`src/main/agent/tools/builtin/sessionHandoffTool.ts`)
- **agent tool whitelist 重构** — 共享解析器 + 命令模式过滤 + 类型安全，MCP 工具结果豁免截断 (`src/main/agent/tools/filter.ts`, `src/main/agent/tools/toolNameResolver.ts`, `src/main/agent/tools/executor.ts`)
- **ask_user 参数归一化容错** — v1 基础容错 + v2 schema 宽进与清洗、字符串 options 拆分防误拆（括号保护 + 强分隔符优先 + 字母序号误判降级）、JSON 数组容错 (`src/main/agent/tools/builtin/askUserTool.ts`)
- **系统提示词注入当前日期** — 本地时区日期工具，缓存跨天自动重建 (`src/main/agent/utils/dateUtils.ts`, `src/main/agent/systemPrompt.ts`)
- **file_edit diff 输出简化** — 输出收敛到 @@ hunk (`src/main/agent/tools/builtin/fileEditTool.ts`)
- **数据库复合索引** — messages (conv_id+ts) 与 message_blocks (msg_id+seq) (`src/main/repositories/sqlite/index.ts`)
- **isSyntheticToolResult 精确谓词** — 区分合成工具结果 (`src/main/agent/agentTemplateConverter.ts`)

### 优化
- **消息增量转换缓存（AdapterConvertCache）** — Anthropic/OpenAI/Google 三路 adapter 消息增量转换（限制 no-new-user 场景），消除重复全量转换 (`src/main/agent/model/anthropicAdapter.ts`, `src/main/agent/model/openaiAdapter.ts`, `src/main/agent/model/googleAdapter.ts`)
- **incremental normalize 流水线（PreprocessCache）** — source-count 缓存 + 增量 Set + zero-copy normalize，ChunkedMessages 持久 append 结构 (`src/main/agent/loop/preprocessCache.ts`, `src/main/agent/state.ts`)
- **结构化截断移到会话边界** — agent_start 时执行，移除循环内截断；remove compact 全部残留（事件类型/处理器/压缩循环/死代码） (`src/main/agent/loop/compress.ts`, `src/main/agent/loop/controller.ts`)
- **LLMCaller 简化** — 删除死配置/接口、提取 recordAdapter 消除双路径重复、adapter 管理收归 LLMCaller（补 workMode/suggestedModel 重建检测）、删除 setup 平行路径 (`src/main/agent/loop/llmCaller.ts`, `src/main/agent/loop/setup.ts`)
- **持久化落库优化** — 30s 兜底 + 段边界触发 + worker_threads WAL checkpoint + 心跳移除 + 防竞态 (`src/main/repositories/sqlite/checkpointWorker.ts`, `src/main/agent/manager.impl.ts`)
- **渲染冻结优化** — ThrottledMarkdown + toolResultBatch hidden 冻结 + 窗口恢复滚动延迟 (`src/renderer/components/message-list/InterleavedContent.tsx`)
- **agent-start handler 消除 spread 拷贝** — push 替代 (`src/main/agent/ipc/execution.ts`)
- **ThinkStart/ThinkEnd hook 按实际思考行为门控** — 首段思考 chunk 触发、完全配对，清理过时注释与 as-any 类型 (`src/main/agent/loop/execute.ts`)

### 修复
- **multi-conversation memory leak** — unbounded tool output cache 修复 + weight model（含 conversationStore / toolCallsStore 简化） (`src/renderer/stores/conversationStore.ts`, `src/renderer/stores/toolCallsStore.ts`)
- **context-length 错误不再重试** — 与设计文档 v2 决策一致，失败给出明确指引 (`src/main/agent/loop/controller.ts`)
- **保护 running/pending-agent 会话不被空闲清理** (`src/main/agent/manager.impl.ts`)
- **usage-stats 弹窗展示口径对齐** — 总 token 含缓存流量、缓存写入按协议条件展示 (`src/main/agent/model/`)
- **error 收尾补 endedAt 防竞态** — ThrottledMarkdown hidden 中不启动 rAF (`src/renderer/components/message-list/ThrottledMarkdown.tsx`)
- **切换父会话时折叠其他已展开的父会话分支** (`src/renderer/components/ConversationSidebar.tsx`)

### 删除
- **compact 死代码全面清理** — compress 循环、PreCompact/PostCompact 幽灵 hook、compact 事件类型与处理器 (`src/main/agent/loop/compress.ts`, `src/main/agent/stream.ts`, `src/main/agent/loop/controller.ts`)
- **manager.persister.ts / manager.backup.ts 死代码** — 合并入 manager.impl.ts (`src/main/agent/manager.persister.ts`, `src/main/agent/manager.backup.ts`)

---

## [v0.3.7] - 2026-08-05

### 新增
- **Attention 提醒机制** — 窗口隐藏/最小化时，权限对话框（permission）和用户提问（ask_user）通过任务栏闪烁 + 自定义系统托盘图标叠加角标提醒用户，防止长期阻塞 (`src/main/attention.ts`, `src/main/agent/manager.impl.ts`, `src/main/window.ts`, `tests/main/attention.test.ts`)
- **工作区切换重构为右侧悬浮抽屉** — 侧边栏工作区下拉框改为右侧滑出面板，带过渡动画和悬停关闭，UI 更整洁 (`src/renderer/components/ConversationSidebar.tsx`, `tests/renderer/components/ConversationSidebar.workspace-selector.test.tsx`)

### 优化
- **attention.ts 圆角角标生成性能优化** — `Math.sqrt` 平方根计算改为平方比较 `r²`，减少循环内浮点运算 (`src/main/attention.ts`)

### 修复
- **OpenAI/Gemini usage token 语义对齐 Anthropic 基准** — `prompt_tokens`/`completion_tokens`/`total_tokens` 映射标准化，消除三方模型 Token 统计偏差 (`src/main/agent/model/openaiAdapter.ts`, `src/main/agent/model/googleAdapter.ts`)
- **scheme-selector 下拉框无法切换选项** — 修复模型方案选择器点击无响应问题 (`src/renderer/components/SchemeSelector.tsx`)
- **attention.ts 状态管理修正** — `_flashFrameCalled` 在 `stopBlinking()` 开头显式重置，替代原本依赖 `flashFrame(false)` 回调后再置 false 的竞态隐患；`_testInternals.reset()` 同步重置 (`src/main/attention.ts`)

### 删除
- **openaiAdapter 死代码清理** — 移除已废弃的 `_injectAdditionalContext` 方法 (`src/main/agent/model/openaiAdapter.ts`)

---

## [v0.3.6] - 2026-08-05

### 新增
- **设置支持按分类/全部恢复默认** — settings store 支持按分类/全部恢复默认（进 pending 不写盘），设置弹窗各 Tab 添加恢复默认按钮与恢复全部按钮 (`src/renderer/stores/settingsStore.ts`, `src/renderer/components/dialogs/SettingsDialog.tsx`)

### 重构
- **Agent 仅展示最终输出并释放过程数据** — 运行中的 Agent 工具保留实时进度时间轴，已完成/已取消的 Agent 只展示最终输出（+ 错误信息 + Token 用量）；新增 clearAgentProcessData 清理 progressLog / subAgentStream，避免长会话过程数据常驻内存 (`src/renderer/components/message-list/SubAgentViewer.tsx`, `src/renderer/stores/toolCallsStore.ts`)
- **message-list 流式渲染性能优化** — 用 requestAnimationFrame 帧级合并替代 200ms 节流，流式渲染流畅度约提升 12 倍；仅订阅当前活跃会话的流式状态，避免 60fps 空转 (`src/renderer/components/message-list/InterleavedContent.tsx`)

### 修复
- **会话切换回运行时助手气泡正文截断** — 运行中会话合并方向反转为内存流式消息为权威，SQLite 仅补缺，完成态仍以 SQLite 为准防重复气泡 (`src/renderer/stores/conversationStore.ts`)
- **resetAllToDefault 显式展开分类修复 TS2322 类型错误** — 恢复默认功能的评审改进（基座分支测试/timer 清理/注释）(`src/renderer/stores/settingsStore.ts`, `src/renderer/components/dialogs/SettingsDialog.tsx`)

---

## [v0.3.5] - 2026-08-05

### 新增
- **Todo 任务按会话隔离** — 任务存储从扁平 Map 重构为按会话分层的 Map<convId, Map<taskId, Task>>，三个内置任务工具通过 conversationId 隔离作用域，子会话 todo 不再泄漏到主会话 (`src/main/agent/tasks/taskStore.ts`, `src/main/agent/tools/builtin/taskCreateTool.ts`)

### 重构
- **流式渲染性能优化** — thinking 块新增 thinkingBatch 与 textBatch 镜像合并策略，微任务内一次刷新合并 N 次块重建；文本块 id 改为基于消息 id + 偏移量派生，React 复用 DOM 节点避免整条消息气泡重挂载；ThrottledMarkdown 流式期间 200ms 节流；滚动跟随按帧合并 (`src/renderer/stores/agentStore/batching/thinkingBatch.ts`, `src/renderer/components/message-list/InterleavedContent.tsx`, `src/renderer/stores/agentStore/contentBlocks.ts`)

### 修复
- **渲染进程崩溃恢复放弃时通知用户** — 崩溃恢复冷却期内再次崩溃时，弹出带崩溃原因与退出码的错误对话框并给出建议，不再静默无响应 (`src/main/window.ts`)
- **会话首次激活时滚动到底部** — 增加 done 标记使异步历史加载完成后 init effect 重新执行，抽取共享 stop()/scheduleSettle() 帮助函数 (`src/renderer/components/message-list/MessageList.tsx`)

---

## [v0.3.4] - 2026-08-05

### 新增
- **工具执行超时倒计时显示** — 工具调用头部实时显示超时倒计时，紧凑弹窗卡片同步支持 (`src/renderer/components/message-list/ToolCountdown.tsx`, `src/renderer/hooks/useToolCountdown.ts`)
- **子会话保留完整执行过程（单条消息模式）** — 子 Agent 会话以单条消息模式合并完整执行链，新增 childConvMessages 链路 (`src/main/agent/tools/builtin/childConvMessages.ts`, `src/main/agent/tools/builtin/agentTool.ts`)
- **子 Agent 运行中实时跳转子会话** — 子会话运行时可实时跳转并刷新状态 (`src/main/agent/tools/builtin/agentTool.ts`)

### 重构
- **清理未使用的 props、状态与调试日志** — 移除多处死代码与调试输出，净删 56 行 (`src/renderer/components/MainWorkspace.tsx`, `src/renderer/components/dialogs/ChannelsDialog.tsx`)

### 修复
- **子 Agent 工作报告结果集不再被多级截断** — 修复嵌套工具调用结果逐级截断的问题 (`src/main/agent/tools/executor.ts`)
- **历史 /能力 消息徽章丢失** — 修复历史命令消息能力徽章不渲染 (`src/renderer/components/message-list/MessageBubble.tsx`, `src/renderer/lib/userCommandParse.ts`)
- **会话切换滚动错位** — 等待历史消息加载完成后才滚动到底部 (`src/renderer/components/MessageList.tsx`)
- **条件 Hook 调用（rules-of-hooks）** — 修复违反 Hook 规则的调用并补专项回归测试 (`src/renderer/components/message-list/`)
- **删除确认弹窗取消误执行** — 修复 confirmed 返回值被忽略导致取消仍继续删除 (`src/renderer/components/`)
- **bash 工具输出截断阈值对齐** — 输出截断阈值与内部上限 2MB 对齐 (`src/main/agent/tools/executor.ts`)

### 变更
- **copy-native-modules 构建加固** — 原生模块缺失/复制失败改为终止构建并加完整性校验 (`vite.main.config.mjs`)
- **dependency-cruiser 依赖图护栏** — 新增依赖图规则与已知违规基线，防依赖退化 (`package.json`, `.dependency-cruiser.js`)
- **lint 规则修复与批量清理** — 修复 Function/空对象/this 别名类型规则、require 静态化、死代码清理 (`package.json`, `src/`)
- **零风险清理** — deferred minors 5 项清理，移除冗余依赖 (`package.json`, `package-lock.json`)

---

## [v0.3.3] - 2026-08-03

### 变更
- **CSS 压缩器指定为 esbuild** — 在渲染端 Vite 构建配置中显式指定 `cssMinify: 'esbuild'` (`vite.renderer.config.mjs`)

---

## [v0.3.2] - 2026-08-03

### 新增
- **会话用量统计完整功能** — 用量聚合纯函数 + IPC 链路（repository/handler/preload）+ 弹窗组件 + 右键菜单入口，tool 块计数改用 tool_call 类型 (`src/main/usageStats.ts`, `src/main/conversation.ts`, `src/renderer/components/dialogs/UsageStatsDialog.tsx`, `src/renderer/components/ConversationSidebar.tsx`)
- **命令面板类型 tab** — 添加类型 tab、Alt+←/→ 切换与快捷键提示，用户命令消息渲染能力徽章（图标+名称+类型标签+任务内容） (`src/renderer/components/plugin/CommandPalette.tsx`, `src/renderer/components/plugin/CommandList.tsx`, `src/renderer/lib/paletteTabs.ts`, `src/renderer/components/message-list/UserCommandBubble.tsx`)
- **agent 参数强制校验与通用角色** — 强制校验 agent 参数并新增通用内置 Agent 角色，工具派遣引导语 + 单元测试锁定 (`src/main/agent/tools/builtin/agentTool.ts`, `src/main/agent/defaults/general.md`)
- **技能图标统一** — 技能图标统一为 🛠️（Ctrl+K 弹窗 + 内联补全） (`src/renderer/components/plugin/CommandList.tsx`, `src/renderer/components/InlineCommandPicker.tsx`)

### 重构
- **命令解析纯函数化** — 命令解析逻辑抽取为纯函数，Ctrl+K 发送命令时命令名与任务内容以换行分隔 (`src/main/agent/loop/commandTextParser.ts`, `src/renderer/lib/userCommandParse.ts`)
- **formatTokenCount 抽取** — 抽取公共模块并重构用量统计弹窗 (`src/renderer/lib/format.ts`, `src/renderer/components/dialogs/UsageStatsDialog.tsx`)
- **collectDescendants 迁移至 shared** — 新增 ConversationUsageStats 类型 (`src/shared/utils/conversationTree.ts`, `src/shared/types/infra.ts`)
- **测试目录规范** — 迁移 src/ 下 2 个孤儿测试到 tests/ 约定目录 (`tests/main/agent/loop/`)
- **会话右键菜单简化** — 提取布局常量、去重菜单项样式、抽取 stopAndClose (`src/renderer/components/ConversationSidebar.tsx`)

### 修复
- **内置 Agent 种子文件健壮性** — 完整性校验损坏时自动重建、避免覆盖同名用户文件、兼容 BOM 与标记判定 (`src/main/agent/defaults/seedAgentFiles.ts`)
- **用量统计断链** — 后代数据断链 + 弹窗重试失效 (`src/main/conversation.ts`, `src/renderer/components/dialogs/UsageStatsDialog.tsx`)
- **右键菜单定位漂移** — 会话列表右键菜单改用 createPortal 挂载 body，修复 fixed 定位漂移 (`src/renderer/components/ConversationSidebar.tsx`)
- **Alt+上下切换会话** — 切换时排除子会话 (`src/renderer/hooks/useGlobalHotkeys.ts`)
- **背景启用时侧栏失衡** — 修复左右侧栏深浅失衡 (`src/renderer/App.tsx`, `src/renderer/styles/globals.css`)

---

## [v0.3.1] - 2026-08-02

### 修复
- **TitleBar 层级修复** — 标题栏添加 `relative z-10`，解决与背景图等元素的层级遮挡问题 (`src/renderer/components/TitleBar.tsx`)

---

## [v0.2.99] - 2026-08-02

### 新增
- **sharp 原生模块打包支持** — vite 打包时将 `sharp` 及其 `@img` 平台二进制（win32-x64 等）一并拷贝到 `.vite/node_modules`，解决打包后运行时无法加载原生模块的问题 (`vite.main.config.mjs`)

---

## [v0.2.98] - 2026-08-02

### 新增
- **背景图功能** — 支持背景图配置/选图/裁边/毛玻璃/透明度滑杆/历史图管理，无框窗口最大化贴齐工作区、图片删除与预览 (`src/main/ipc/background.ts`, `src/renderer/components/dialogs/SettingsDialog.tsx`, `src/renderer/stores/themeStore.ts`)

### 重构
- **模型适配器重构** — anthropic/google 适配器重写，统一流式解析与错误处理 (`src/main/agent/model/anthropicAdapter.ts`, `src/main/agent/model/googleAdapter.ts`)

### 修复
- **skillTool 修复** — 技能调用工具缺陷修正 (`src/main/agent/tools/builtin/skillTool.ts`)

### 变更
- **.gitignore 更新** — 添加 `temp/` 目录忽略 (`/.gitignore`)

---

## [v0.2.97] - 2026-08-01

### 新增
- **子会话 LLM 调用统计持久化** — agent 工具创建的子会话在运行期间收集各轮 `llm_call_done` 事件（token 数、provider/model、耗时、缓存命中），随 assistant 消息持久化到数据库，打开子会话即可查看缓存命中率 (`src/main/agent/tools/builtin/agentTool.ts`, `src/main/repositories/sqlite/messageBlockHelper.ts`)

---

## [v0.2.96] - 2026-08-04

### 修复
- **子会话抢占激活态修复** — 新增 `isRootConversation` 判断（无父级或父级已删除即为根会话），工作区激活、删除会话后切换、启动初始化时仅激活/加载/渲染根会话。此前列表按 updatedAt 排序，agent 工具创建的子会话因更新时间较新常排在前，导致错误激活子会话 (`src/renderer/stores/conversationStore.ts`)

---

## [v0.2.95] - 2026-07-28

### 新增
- **父子会话级联清理** — 父会话终止时自动清理所有子会话的运行状态，即使 Worker 侧消息丢失也从主进程兜底发送 done 事件到渲染进程 (`src/main/agent/manager.impl.ts`)
- **定时任务状态实时推送** — 定时任务完成后通过 IPC 推送 `conversation-updated` 事件到渲染进程，侧边栏实时刷新状态 pulse 动画 (`src/main/scheduler/index.ts`)

### 变更
- **conversation-updated 事件类型扩展** — `onConversationUpdated` 回调新增 `status` 字段支持 (`src/renderer/env.d.ts`)
- **会话 Store 状态同步** — `conversationStore` 支持通过 `conversation-updated` 事件更新 status (`src/renderer/stores/conversationStore.ts`)

---

## [v0.2.94] - 2026-07-28

### 修复
- **流式消息合并条件收紧** — 切换会话时仅在 Agent 仍在流式运行（`running`/`thinking`）时合并 streaming 消息，避免已完成（idle）的会话出现重复消息 (`src/renderer/stores/conversationStore.ts`)

---

## [v0.2.93] - 2026-07-28

### 新增
- **MCP 工具结果格式化共享函数** — 从 discovery.ts 和 mcpWorker.ts 中抽取重复的 `formatMcpResult` 逻辑，独立为 `formatResult.ts`；失败时错误信息分离到 `error` 字段，避免 LLM 混淆 (`src/main/agent/mcp/formatResult.ts`, `discovery.ts`, `mcpWorker.ts`)

### 重构
- **seedAgentFiles 改进** — 重命名 `DEFAULT_AGENTS` → `MD_FILES`，补充注释说明维护约定；优化 Implementer 和 Code Reviewer Agent 定义文案 (`src/main/agent/defaults/seedAgentFiles.ts`)

### 修复
- **工具结果 output 丢失修复** — `success=false` 时不再丢弃 output 内容，确保 LLM 能读取工具部分输出（`manager.accumulator.ts`, `toolResultBatch.ts`）
- **closeDialog 调用修正** — 匹配函数签名，移除多余参数 (`src/renderer/components/dialogs/UpdateNoticeDialog.tsx`)
- **测试类型标注修正** — `ReturnType<typeof vi.fn>` → `Mock` 类型 (`tests/hooks/renderer-handlers.test.ts`)

### 变更
- **MenuDialogType 扩展** — 添加 `'update-notice'` 类型 (`src/shared/types/settings.ts`)
- **.gitignore 更新** — 添加 `.superpowers` 和 `docs/superpowers` 目录 (`/.gitignore`)

---

## [v0.2.92] - 2026-07-28

### 新增
- **插件名点击跳转仓库链接** — PluginDialog 插件名支持点击跳转 repository/homepage，根据 linkOpening 三种模式（builtin/system/ask）分别执行内置浏览器打开、系统浏览器打开或弹出选择菜单；提取公共 `getErrorMessage()` 错误解析函数 (`src/renderer/components/dialogs/PluginDialog.tsx`)

### 修复
- **插件 Hook 默认状态修正** — 新安装插件提供的 Hook 默认 `enabled: false`，防止未经用户确认自动激活 (`src/main/config/hookConfig.ts`)
- **Windows 插件卸载失败兜底** — 新增 `clearReadOnly` 递归清理 Git 目录只读属性 + `rmdir /s /q` 兜底，解决 Git 克隆目录因只读文件导致的删除失败 (`src/main/plugin/installer.ts`)

### 重构
- **弹窗宽度调整** — Agents 弹窗宽度从 450 调整为 600，Hooks 弹窗宽度从 520 调整为 693 (`src/renderer/components/MenuDialogRenderer.tsx`)

---

## [v0.2.91] - 2026-07-28

### 新增
- **插件版本管理** — 支持 Git 插件版本查看（tags/branches）、切换版本、同步远程版本；启动时后台检测更新，菜单栏 Plugins 按钮红点提示 (`src/main/plugin/installer.ts`, `src/main/plugin/versionManager.ts`, `src/main/plugin/ipc.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/App.tsx`, `src/renderer/components/MenuBar.tsx`, `src/renderer/components/dialogs/PluginDialog.tsx`, `src/renderer/stores/pluginUpdateStore.ts`, `src/renderer/env.d.ts`)

### 重构
- **logger 简化** — 移除文件日志系统（LogBuffer、轮转、文件 I/O），改为 console-only 输出，消除 IPC 开销 (`src/main/agent/logger.ts`)
- **versionManager 实例复用** — PluginVersionManagerImpl 复用 PluginInstaller 实例，消除每次操作创建新对象 (`src/main/plugin/versionManager.ts`)

### 修复
- **Agent 前缀匹配修复** — 修复 `getRealCounts` 和 `getCapabilityDetails` 中 Agent 前缀匹配逻辑，支持 `pluginName/dirName` + `local-` 前缀 + `@github/@gitee/@gitlab` 后缀变体 (`src/main/plugin/ipc.ts`)

---

## [v0.2.90] - 2026-07-27

### 重构
- **截断模块 v4 简化** — 移除 token 预算门（maxContext/budget 依赖），低价值工具判断从 `lowValueNames` 改为 `highValueNames`，简化 `truncateForLlmCall` 调用接口 (`structuredTruncation.ts`, `truncateBeforeLlm.ts`)
- **execute.ts 清理** — 移除废弃的 `safeGetAdapterMaxCtx` 函数，简化截断调用 (`src/main/agent/loop/execute.ts`)

### 修复
- **logger import 路径修复** — `../../config` 修正为 `../config` (`src/main/agent/logger.ts`)

### 新增
- **CacheRateTooltip 裁剪提示** — 添加低价值上下文自动裁剪说明 (`CacheRateTooltip.tsx`)

### 删除
- **清理废弃设计文档** — 删除 Agent skill icon refresh 设计文档 (`docs/superpowers/specs/2026-07-agent-skill-icon-refresh-design.md`)

---

## [v0.2.89] - 2026-07-26

### 新增
- **Skill 工具调用 UI 展示** — 新增 `isSkill`/`skillDisplayName` props、🛠️ 图标标识、`resolveToolDisplayName` 统一工具显示名解析函数；Compact 模式下 Skill 展示名称和状态 (`InterleavedContent.tsx`, `ToolCallRenderer.tsx`, `ToolCallHeader.tsx`, `messageUtils.ts`)
- **Agent 图标更新** — Compact 模式下 Agent 从 ⚡ 改为 🤖 图标 (`ToolCallRenderer.tsx`)
- **agentStore types 扩展** — Conversation 和 AgentStore 类型新增 `isSkill`/`skillDisplayName` 字段 (`types.ts`)

### 变更
- **Skill 状态图标更新** — SkillBubble 和 ToolCallHeader 中 icon 从 ⚡ 改为 🛠️ (`SkillBubble.tsx`, `ToolCallHeader.tsx`)

### 重构
- **MCP 进程清理提取 killServerProcess** — 将 Windows 进程树销毁逻辑提取为独立方法，调整 kill 顺序为先 taskkill 再 SDK close，确保子树能被完整遍历 (`src/main/agent/mcp/client.ts`)

### 删除
- **清理废弃 isAgentDisplayName 函数** — 删除 messageUtils 中不再使用的工具函数 (`messageUtils.ts`)

---

## [v0.2.88] - 2026-07-24

### 新增
- **自动更新检查模块** — 版本对比引擎、后台静默检查、IPC 桥接、更新通知弹窗、preload API 暴露、单元测试 (`src/main/updater/updateChecker.ts`, `src/main/updater/compareVersions.ts`, `src/main/updater/constants.ts`, `src/renderer/stores/updaterStore.ts`, `src/renderer/components/dialogs/UpdateNoticeDialog.tsx`, `src/shared/types/updater.ts`, `tests/main/updater/compareVersions.test.ts`, `tests/main/updater/updateChecker.test.ts`)

### 重构
- **AboutDialog 增加更新交互** — 检查更新按钮 + 5 种状态文案 + GitHub/网盘下载按钮 (`src/renderer/components/dialogs/AboutDialog.tsx`)

### 变更
- **启动流程集成静默更新** — 启动时 fire-and-forget 检查更新并推送状态到渲染进程 (`src/main/index.ts`)
- **IPC 注册更新接口** — 注册 updater:get-status 和 updater:check-for-update (`src/main/window.ts`)
- **MenuBar 更新提示** — 关于菜单按钮有新版本时显示红色小圆点 (`src/renderer/components/MenuBar.tsx`)

---

## [v0.2.87] - 2026-07-25

### 修复
- **CombinedCardPopup 思考块内容实时更新** — 弹窗打开后从实时消息流（messagesMap）订阅最新 thinkBlock，替代打开时的快照；预构建 Map 查找表避免渲染循环中 O(n×m) 查找 (`src/renderer/components/message-list/compact-popup/CombinedCardPopup.tsx`)

### 变更
- **弹窗数据类型扩展** — `combinedPopupData` 新增 `convId`、`messageId` 字段，ToolCallRenderer 获取并透传 convId，InterleavedContent 透传 messageId (`src/renderer/stores/agentStore/types.ts`, `src/renderer/components/message-list/ToolCallRenderer.tsx`, `src/renderer/components/message-list/InterleavedContent.tsx`)

## [v0.2.86] - 2026-07-25

### 重构
- **工具名别名系统** — 将 Claude Code / Codex 的工具名（Read/Write/Edit）映射到 HClaw 实际工具名，兼容 everything-claude-code 等插件的 Agent 定义 (`src/main/agent/tools/filter.ts`)
- **toolCallsStore 默认状态 pending→running** — 消除首次渲染延迟，提交 commit 时直接以 running 状态注册 (`src/renderer/stores/toolCallsStore.ts`)
- **ToolCallRenderer 透传真实进度 props** — 将硬编码假值改为透传有效进度/状态/ETA 到 Header (`src/renderer/components/message-list/ToolCallRenderer.tsx`)

### 修复
- **agent 崩溃恢复标记 cancelled** — 死亡 agent 的 toolCalls 标记为 `cancelled` 并同步消息级别状态，替代此前错误的"恢复中"文案 (`src/renderer/stores/agentStore/index.ts`)
- **streamTools 事件处理增强** — 工具开始事件丢失时自动注册 running 状态，进度事件缺失时同步注册，详情事件补充 status:running (`src/renderer/stores/agentStore/handlers/streamTools.ts`)

### 新增
- **子 Agent contentBlocks 同步** — 模式切换后子 Agent toolCall 能正确显示 (`src/renderer/stores/agentStore/handlers/streamSubAgents.ts`)
- **紧凑弹窗动态刷新文本** — 运行中 Agent 和子 Agent 的工具显示实时进度文本 (`src/renderer/components/message-list/compact-popup/CombinedCardPopup.tsx`, `index.tsx`)
- **ToolCallHeader 进度透传** — 非折叠状态的 progressBar/progressText 显示 (`src/renderer/components/message-list/ToolCallHeader.tsx`)
- **cancelled 状态类型** — ToolCall 类型新增 `cancelled` 状态常量 (`src/shared/types/message.ts`)

## [v0.2.85] - 2026-07-22

### 新增
- **askUserTool 选项空字符串校验** — 检查 options 中是否包含空白字符串，所有选项为空时提前返回明确错误提示，部分选项为空时打印警告日志 (`src/main/agent/tools/builtin/askUserTool.ts`)

## [v0.2.84] - 2026-07-16

### 新增
- **第三方 API 检测函数** — 新增 `isThirdPartyAnthropicAPI()` 判断当前模型是否指向非官方端点（DeepSeek/MiMo 等兼容 API），自动适配 thinking 块格式 (`src/main/agent/model/utils.ts`)
- **第三方 API thinking 块兼容** — 处理跨供应商环境下 thinking/signature 格式差异，自动注入空 thinking 块以满足 DeepSeek/MiMo 的格式校验 (`src/main/agent/model/anthropicAdapter.ts`)

### 修复
- **第三方 API signature 检查跳过** — DeepSeek 等兼容 API 不要求 signature，跳过不必要的 thinking 块完整性检查，避免因缺失 signature 导致的降级 (`src/main/agent/loop/execute.ts`)

## [v0.2.83] - 2026-07-12

### 修复
- **缓存命中率计算公式修正** — 从 `read/(read+write)` 改为 `read/(input+read)`，此前分母使用了错误的 write 字段导致比率失真 (`src/renderer/components/CacheRateTooltip.tsx`)

### 重构
- **tooltip 从 CSS hover 改为 Portal 渲染到 body** — 使用 `createPortal` 将 tooltip 挂载到 `document.body`，突破祖先容器 `overflow:hidden` 裁剪，同时增加 hover 进入/离开延迟防抖 (`src/renderer/components/CacheRateTooltip.tsx`)

### 新增
- **tooltip 底部公式展示** — 增加命中率公式与上下文窗口计算明细 (`src/renderer/components/CacheRateTooltip.tsx`)

### 变更
- **移除 cacheWriteTokens 统计** — 命中率公式不再依赖 write 值，表格移除"写入"行，"读取"标签改为"缓存命中"，"输出"行移入表格 (`src/renderer/components/CacheRateTooltip.tsx`)

## [v0.2.82] - 2026-07-12

### 重构
- **彻底移除压缩系统，全面采用结构感知截断** — 删除 `/compact` 命令和 LLM 摘要自动压缩（`executeCompactCommand`、`autoCompressIfNeeded`、`compressConversation` 等），新增 `structuredTruncation.ts`（保留首条 user + 最近 N 轮 + 中间按 turn 配对剥离失败 toolCall）与 `truncateBeforeLlm.ts`（每次 LLM 调用前的截断编排）。`Controller` 中 `compactLevel`、`lastActualInputTokens`、`messagesAtLLMCall` 状态字段全部移除，`isContextLengthError` 兼容导出清理 (`src/main/agent/compact/*`, `src/main/agent/loop/compress.ts`, `src/main/agent/loop/controller.ts`, `src/main/agent/loop/execute.ts`)
- **压缩相关默认值与导出清理** — `context.ts` 中仅保留 `estimateMessagesTokens`/`estimateTokens` 等纯 token 估算函数；`compress.ts` 退化为只含 `emitLlmCallDone`、`handleNoToolCalls`、`getLastUserMessage` 等公共 helper；`detectCommandContext` 中 `commandName === 'compact'` 判断恒为 `false` (`src/main/agent/context.ts`, `src/main/agent/loop/compress.ts`, `src/main/agent/loop/setup.ts`)

### 新增
- **`resolveMaxContextTokens()` 集中解析模型上下文窗口** — ModelScheme > adapter > 默认 128000 三级 fallback，新增 provider 只需改这一个文件 (`src/main/agent/loop/modelMaxContext.ts`)
- **`truncateForLlmCall()` 接入主循环** — 在 `executeLlmCallWithRetry` 中、ContextRetrieval 之后、image 过滤之前调用，超出预算时自动触发结构截断并记录日志 (`src/main/agent/loop/execute.ts`)
- **结构截断单测覆盖** — `structuredTruncation.test.ts` 覆盖「纯文本轮丢弃 / 混合轮配对剥离 / 全失败 turn 当文本处理 / 保留首条 user + 最近 10 轮」；`truncateBeforeLlm.test.ts` 覆盖「budget 内 passthrough / 超 budget 触发截断」 (`src/main/agent/loop/structuredTruncation.test.ts`, `src/main/agent/loop/truncateBeforeLlm.test.ts`)
- **本地 vitest 配置** — `vitest.config.local.ts` 声明 `@` 路径别名与测试文件 include 范围 (`vitest.config.local.ts`)

### 变更
- **`compactThreshold` 配置项彻底移除** — 不再出现在 `AgentSettings`/`SystemSettings` 默认值、设置对话框、`systemManageTool` schema、`manager.impl.ts` 与 `worker.ts` 初始化逻辑中 (`src/shared/types/settings.ts`, `src/renderer/stores/settingsStore.ts`, `src/renderer/components/dialogs/SettingsDialog.tsx`, `src/main/agent/tools/builtin/systemManageTool.ts`, `src/main/agent/manager.impl.ts`, `src/main/agent/worker.ts`)

## [v0.2.81] - 2026-07-11

### 修复
- **CDN 地址不再随 API baseUrl 覆盖** — 移除 `this.cdnBase = this.apiBase` 赋值，确保 CDN 地址独立于 API 地址 (`src/main/channel/adapters/wechatAdapter.ts`)

### 变更
- **CDN 默认地址更新** — `DEFAULT_BASE_URL` 从 `https://ilinkai.weixin.qq.com` 更新为 `https://novac2c.cdn.weixin.qq.com/c2c` (`src/main/channel/constants.ts`)

## [v0.2.80] - 2026-07-07

### 重构
- **提取 `compileGlobPattern()` 私有方法** — 将 `addRule` 和 `setRules` 中重复的 glob pattern 编译逻辑提取为私有方法，减少代码重复 (`src/main/agent/tools/permission.ts`)
- **清理未使用常量** — 删除 `_RULES_FILE`、`_CONFIG_FILE` 两个已不再使用的常量 (`src/main/agent/tools/permission.ts`)

### 新增
- **Auto 模式命令放行逻辑** — `checkPlannedCommands()` 新增 Auto 模式处理：非危险命令自动放行，危险命令仍被安全拦截返回提示信息 (`src/main/agent/tools/permission.ts`)

## [v0.2.79] - 2026-07-01

### 重构
- **Channel Worker 从 ESM 切换为 CJS（`channelWorker.cjs`）** — 使用 `.cjs` 扩展名确保 Node.js 始终以 CommonJS 模式加载 Worker，解决 Node.js 24 ESM 模式下动态 `require` 不兼容的问题。移除 `type: 'module'` 配置，`format` 改为 `cjs`，external 列表从飞书 SDK 依赖简化为 electron/native addon 等 Worker 不需要的模块 (`ChannelManager.ts`, `vite.main.config.mjs`)
- **Worker 错误/退出事件接入 logger** — `on('error')` 和 `on('exit')` 回调通过 logger 记录日志，替代之前的静默吞错，便于排查 Worker 崩溃原因 (`ChannelManager.ts`)

### 新增
- **缓存写入（cacheWriteTokens）统计展示** — CacheRateTooltip 新增「写入」行，展示累计写入和当前写入的 token 数量，与缓存读取并列显示 (`CacheRateTooltip.tsx`)
- **缓存命中率算法优化** — 分母从 `inputTokens + cacheReadTokens` 改为 `cacheReadTokens + cacheWriteTokens`，命中率 = 读取/(读取+写入)，更准确反映缓存效果 (`CacheRateTooltip.tsx`)

### 变更
- **依赖更新** — `@anthropic-ai/sdk` ^0.100.1 → ^0.107.0，`openai` ^6.37.0 → ^6.45.0，新增 devDependency `weixin-agent-sdk@^0.5.0` (`package.json`)

### 修复
- **`CHANNEL_VERSION` 与 weixin-agent-sdk 版本对齐** — 版本号从 `2.4.3` 改为 `0.5.0`，与 devDependency `weixin-agent-sdk` 保持一致，新增注释说明版本对齐规则 (`constants.ts`)

## [v0.2.78] - 2026-06-27

### 重构
- **agent 工具简化为单任务架构，移除内置并行编排** — 移除 tasks 数组、parallel 模式、complexity 字段、agentType 自动匹配、worktree 隔离等 ~230 行代码。并行交由 LLM 原生 parallel function call 实现，槽位满时直接拒绝并告知上限、由父 Agent 自行决定重试策略。新增 `capabilities` 参数支持从 skillRegistry/agentRegistry 查找指定能力，注入子 Agent 上下文 (`agentTool.ts`)
- **提取 `gracefulRestart()` 统一重启入口** — 新增 `src/main/utils/restart.ts`，封装 relaunch 标记 → MCP Worker 关闭 → app.exit 的标准化优雅重启流程，替换 `manager.impl.ts`、`config.ts`、`tray.ts` 三处重复的 `app.relaunch()`/`app.exit()` 调用，确保重启前 MCP 连接正确关闭

### Bug 修复
- **bashTool TypeScript 严格空值检查** — `proc.stdout`/`proc.stderr`/`proc.stdin` 添加非空断言 `!`，使用显式 `SpawnOptions` 类型替代 `as const` 断言，消除 strict 模式下的类型错误 (`bashTool.ts`)
- **MCP Client pid 空值安全** — `state.sdkTransport.pid` 添加 `?? undefined` 空值合并，防止 pid 为 null 时类型校验失败 (`client.ts`)

## [v0.2.77] - 2026-07-01

### Bug 修复
- **MCP 断开时通过 `killProcessTree` 兜底清理僵尸子进程** — MCP Server 连接失败时，先捕获 `StdioClientTransport.pid`，关闭 transport 后再调用 `killProcessTree(pid)` + `waitForProcessExit(pid)` 强制清理子进程树，防止 stdio 子进程残留占用资源（`client.ts:386-399`）

---

## [v0.2.76] - 2026-06-25

### 重构
- **MCP Transport 子进程环境变量从完整 `process.env` 继承** — 将 `enrichEnvPath()` 重命名为 `buildChildEnv()`，策略改为从完整 `process.env` 构建子进程环境变量（而非仅继承 SDK 的 12 个白名单变量），确保 `UV_CACHE_DIR`、`HTTP_PROXY`、`NODE_EXTRA_CA_CERTS` 等用户全局环境变量正常传递到 MCP 子进程。macOS/Linux 额外注入 nvm/Homebrew 等版本管理器路径，`mcp.json` 显式配置的 `env` 拥有最高优先级覆盖 (`stdio.ts:60-195`)
- **`getAllCandidateDirs()` 简化去重逻辑** — 三组 PATH 目录已知不重叠，移除 `Set` 去重，直接展平合并 (`stdio.ts:65-68`)

---

## [v0.2.75] - 2026-06-27

### 重构
- **Zod schema 并发硬上限 `SCHEMA_MAX_PARALLEL_TASKS` 改为动态读取** — 从硬编码 `10` 改为 `Math.max(10, subAgentScheduler.maxConcurrency)`，使 schema 校验上限与实际系统配置保持一致，避免配置了更大并发时被 schema 层误拦截 (`agentTool.ts:118`)

---

## [v0.2.74] - 2026-06-23

### Bug 修复
- **修复并行子 Agent 重复 subagent_start 导致前端重复注册 toolCall** — 移除 `agentTool.ts` 中并行模式下手动发送的 `subagent_start` 事件（`executeSingleTask` 内部的 `subAgentScheduler.executeTask()` 已通过 for-await 事件循环自动发送），在 `streamSubAgents.ts` 的 `handleSubagentStart` 中添加防御性去重检查 (`agentTool.ts:479-489`, `streamSubAgents.ts:110-135`)
- **修复 Agent/Skill 加载错误提示中可选属性 `.split()` 崩溃** — `AgentsDialog.tsx` 和 `SkillsDialog.tsx` 中 `LoadErrorBanner` 的 `name` 提取逻辑增加空值守卫，防止 `e.agentName` / `e.filePath` / `e.skillDir` 为 `undefined` 时掉用 `.split()` 导致页面白屏 (`AgentsDialog.tsx:439`, `SkillsDialog.tsx:159`)

### 重构
- **子 Agent 并发上限从硬编码改为动态读取** — `agentTool.ts` 中所有硬编码的 `3` 个并发上限替换为 `subAgentScheduler.maxConcurrency` 动态值，提取 Zod schema 硬上限常量 `SCHEMA_MAX_PARALLEL_TASKS = 10` 和缓存 TTL 常量 `AGENT_CACHE_TTL_MS`，错误提示同步改为动态显示当前上限 (`agentTool.ts:116-121, 161-162, 455-463, 558`)

---

## [v0.2.73] - 2026-06-23

### 重构
- **提取 MCP Client `createTransport()` 方法** — 将 `testConnection()` 和 `doConnect()` 中两份重复的 transport 创建 switch 合并为私有方法 `createTransport()`，新增 `http` 作为 `streamable-http` 的传输别名。净减少 ~40 行重复代码（`client.ts:628-662`）

---

## [v0.2.72] - 2026-06-16

### Bug 修复
- **MCP JSON 解析传输协议未从 URL 推断** — 在 MCP 管理页面粘贴 HTTP 类型 JSON 配置（只有 `url` 无显式 `transport`）时，解析按钮未从 URL 推断传输协议，导致表单保持默认 `'stdio'`。添加三段式推断逻辑：`transport → type → url`，与后端 `mcpConfig.ts` 行为一致（`MCPEditCard.tsx:137-139`）

---

## [v0.2.71] - 2026-06-16

### 重构
- **PowerShell 命令执行方式重构** — 将 PowerShell 命令通过 `-Command` 参数传递（`CreateProcessW` UTF-16LE），替代原先 stdin 写入方式，彻底解决 GB2312/936 默认编码导致的中文乱码问题
  - 同时注入 `InputEncoding=UTF8`，补齐原先仅设置 `OutputEncoding` 的缺口
  - `bashTool.ts`：spawn 分支逻辑改为 Windows PowerShell 走 `-NoProfile -Command <init>\n<command>\nexit`，其他 shell 保持 stdin 方式不变（约 30 行重构，净减少 1 行）

---

## [v0.2.70] - 2026-06-15

### 杂项
- **版本号更新** — v0.2.69 → v0.2.70

---

## [v0.2.69] - 2026-06-13

### 重构
- **MCP 工具命名重构** — 将 MCP 工具名从不可读的 `mcp_<hash>_<tool>` 统一改为可读的 `m_<serverName>_<tool>` / `mp_<serverName>_<tool>` 格式，LLM 看到的 function name 直接用可读服务名，消除去前缀行为
  - 新增 `src/shared/utils/mcpShortId.ts` 共享工具函数（~150 行），包含 isMcpToolName/parseMcpToolName/resolveMcpDisplayName 等全套解析函数
  - 服务端：discovery.ts/worker.ts/bootstrap.ts/mcpWorker.ts/systemPrompt.ts 全面使用新命名逻辑
  - 前端：ToolCallHeader/ToolCallBody/ToolCallRenderer/PopupToolCard/messageUtils 支持可读显示名 + 颜色分层的 MCP 工具展示（前缀用品牌色/70，服务名用品牌色，工具名用主色）
  - 兼容旧 mcp_ 格式，历史消息仍可正确识别和渲染

---

## [v0.2.64] - 2026-06-08

### Bug 修复
- **消息列表滚动定位算法重写**
- **macOS/Linux MCP Transport PATH 自动修复**

### UI 改进
- **内置浏览器标题**
- **新增"关于"界面**
- **托盘菜单新增"重启"按钮**

---

### [v0.2.56] - 2026-06-07

#### 改进
- Bash工具增强
- UI性能优化
- MCP服务管理优化
- 工具调用详情优化
- 可用能力搜索优化

---

### [v0.2.38] - 2026-06-05

#### 改进
- 统一管理不同主题下的Switch样式
- 定时任务交互优化
- 启动速度优化


#### Fix BUG
- agent\skill 更新问题


---

## [v0.2.32] - 2026-06-05

### 新增功能
- **名称复制按钮** — 在 Agents、Skills、Commands 管理页面、MCP 服务器卡片（插件/用户）、Plugin 列表、Tools 列表和 CommandList 中，为每条记录的名称添加始终可见的复制按钮。点击后图标切换为绿色对勾反馈（2 秒恢复），方便用户快速复制名称到剪贴板

### 杂项
- 新增 `.gitignore` 中 `temp_*` 模式，避免临时文件被误提交
- 清理意外提交的临时文件

---

## [v0.2.31] - 2026-06-05

### UI 改进
- **空状态 Logo 替换** — 将空聊天页面的 SVG 图标替换为 HClaw 应用 Logo，视觉更统一
- **欢迎页 Logo 放大** — 欢迎页 Logo 尺寸从 `w-32` 放大至 `w-56`，首屏视觉更突出
- **新增素材** — 新增透明版 Logo 和 Logo 素材，为后续界面优化做准备


