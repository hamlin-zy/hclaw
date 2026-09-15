# 未推送代码简化分析报告

- 分支：`feat/startup-capability-perf`（无 upstream，`git branch -r --contains HEAD` 为空）
- 范围：22 个未推送 commit，相对 `origin/main` 共 242 文件变更（190 源文件 + 48 测试），+14364 / −2764
- 方法：code-simplifier 代理分批只读分析（9 批）
- 生成日期：2026-09-15

## 总体结论

可简化空间 **小到中等**。这批改动以「加固 / 修复 / 防御性」为主——大量看似冗余的代码是刻意的资源清理与安全失败关闭。零风险可清理约 25 处，低风险同构抽取约 21 项，需回归的中收益项约 10 处，另发现 10 项潜在缺陷/风险。

---

## 约束口径（重要）

原始硬约束 A/B/C/D：

- **A** 不影响已实现功能行为（文案文本、事件/消息顺序、返回值形状、序列化形态、时序/并发语义）
- **B** 不破坏缓存控制（key 归一化 / TTL / invalidate 路径）
- **C** 不造成 LLM 请求缓存断裂（system prompt、tools 注册集合与顺序、消息数组构造与稳定序列化、contentBlocks 改写）
- **D** 不破坏内存泄露优化效果（resourceLimits、显式清理/释放、超时取消传播、容器清空、LRU 上限、监听器与定时器清理）

**修订口径（用户 2026-09-15 确认）**：
标注「禁止改动」的敏感点，只要**不影响功能行为与设计初衷**，**允许简化**，前提是：

1. 逐字保留可观测契约：错误/提示文案文本、事件顺序、返回值形状、序列化形态、DOM 结构与测试锚点（`data-name`、role/tabIndex/aria-*）
2. 逐字保留设计初衷：缓存 key 归一化与 TTL 语义、prompt 缓存前缀稳定性、资源释放与取消传播路径
3. **必须有测试用例覆盖**该行为；覆盖不足时先补测试再改，或不动

即：`B/C/D` 的「语义」不可变，但「实现形式」（重复样板、可达性冗余、过度防御、注释失真）可收敛。

---

## 一、零风险随手清理

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/main/index.ts:67` | `{uptime}` 冗余，`startupTrace` 首点已无条件注入同名键 |
| 2 | `src/main/initProgress.ts:66-71` | 死方法 `progress()`，全仓零引用 |
| 3 | `src/main/scheduler/index.ts:136` | `as const` 被外层 `as any` 抹平 |
| 4 | `src/main/common/eventBus.ts:80,88` | 死常量 `CONFIG_UPDATED`/`LOADED` |
| 5 | `src/main/agent/skills/extensions.ts:117-118` | `getSupportedScriptExtensions`/`isSupportedScript` 仅再导出、零消费 |
| 6 | `src/main/agent/ipc/skills.ts:207` | 注释称「不限时重试」，实现已是 30 次上限；`:227-237` 不可达 `cancelled` 守卫 |
| 7 | `src/main/workspace/gitBranch.ts:70-75` | 死参数 `headContent` + `void headContent` |
| 8 | `src/main/agent/mcpWorkerManager.ts:201-207` | error handler 内 no-op 守卫 |
| 9 | `src/main/agent/mcpWorker.ts:293-301` | 泳道 try/catch 不可达 |
| 10 | `src/main/agent/manager.impl.ts:216-220` | 单次使用的 `replacingExisting` 可内联 |
| 11 | `src/main/agent/tools/executor.ts:271`；`loop/controller.ts:333,335` | 陈旧注释；重复日志 |
| 12 | `src/renderer/components/repo/RepoGroupCard.tsx:33,80` | `hideVersionControl` 恒真死 prop + 文件头注释失真 |
| 13 | `src/renderer/components/common/CapabilityCard.tsx:2,14-17,63-70` | `collapsible` 分支及 import 零调用方 |
| 14 | `src/renderer/components/repo/RepoGroupCard.tsx:49,51` | trigger 模式下被忽略的 `onToggle`/`ariaLabel` |
| 15 | `src/renderer/hooks/useCapabilityRefresh.ts:15` | `deps` 参数从未使用（4 调用点全传 `[]`） |
| 16 | `src/renderer/components/common/EmptyState.tsx:8` | `action` 插槽零使用 |
| 17 | `src/renderer/project-manager/ProjectManagerApp.tsx:190,130` | 不可达 `\|\| '项目管理'`；`'.'` 应用 `ROOT_KEY` |
| 18 | `src/renderer/components/message-list/MediaPlayer.tsx:104-109` | 冗余卸载 effect（`[url]` cleanup 已覆盖） |
| 19 | `src/renderer/components/ConversationSidebar.tsx:139-146` | 自写字面量 = `STATUS_CONFIG.initializing` |
| 20 | `src/renderer/components/common/Modal.tsx:16-20` | `SIZE_CLASS.sm` 无调用方 |
| 21 | `src/renderer/env.d.ts:808` | `{seq: number}` 空格风格不一致 |
| 22 | `src/main/channel/messageHandler.ts:580` | `progressTimer` 联合类型含从未赋值的 `setTimeout` 分支 |
| 23 | `src/main/agent/skills/scriptExecutor.ts:155-158` | 遗留 3 连空行 |
| 24 | `src/main/agent/plan/planFileManager.ts:155-158` | 注释与实现不符（只改注释） |

---

## 二、低风险同构抽取

1. **`DoneReason` 类型**：`shared/types/events.ts:93` 导出，`main/agent/stream.ts:26`、`main/agent/manager.impl.ts:695,980` 引用（消除 4 份重复联合）
2. **`skillStore.ts` 7 处写作样板 → `runSkillMutation`**（225-228/264/284/305/327/349/381）——最高收益/风险比
3. **`fileEditTool.ts:203-221`** 单次 `split` 收敛三分支 + 删不可观测的 `replaced++`；`safeUnlink` ×4；错误文案常量（逐字保留）
4. **`executor.ts:346-361`** IIFE+try/finally → `withToolTimeout(...).finally(...)`
5. **`toolResultBatch.ts:71-80`** 双 `delete` 合并；`conversationStore.ts:162` 删恒真 `rewritten.size > 0`
6. **`applyOptimistic` 去掉无用泛型 `T`** + 统一 `snapshot: () => void`；`userCommandStore` 改用 `toErrorMessage`
7. **`userCommandStore.ts` 4 处 → `runCommandMutation`**；`pluginStore.ts:268/342` → `dropPluginCaches`
8. **`plugin/ipc.ts` 7 处 → `refreshCapabilities()`**（11 处调用点）
9. **`repo/ipc.ts:41-45/78-81` → `discoverRepos()`**；`repo/versionManager.ts:37` + `plugin/versionManager.ts:205` → `pruneMap`
10. **`grepTool.ts:121-123,174`** 删 `onAbort`、复用 `killChild`
11. **`taskStore.ts` 7 处 `'default'` → 常量/helper**
12. **`isMac` 6 份 → `renderer/lib/platform.ts`**
13. **`basename` 2 份 → `project-manager/lib/`**
14. **`KeyboardEventLike` 类型 4 份** → `shared/shortcuts.ts`
15. **`InitProgressPayload` 4 份 → 1 份**（`env.d.ts:372,380` + `preload:911` + `main/initProgress.ts:19`）
16. **复制反馈定时器 7 处 → `useTransientFlag(delayMs)`**（延时值 1500/2000 不统一是刻意的，勿归一）
17. **重置式定时器 4 处 → `useResetTimeout`**
18. **`compact-popup/index.tsx:144/211`** badge class 三元提为局部函数（文案三元必须原样）
19. **`ConversationSidebar.tsx:117-131`** `useInitPhase` → `string | null`
20. **命名一致性**：`mcpWorker.unregisterAgents` ↔ `mcpWorkerManager.unregisterAgent`；`manager.impl.disposeEvents` ↔ `powerManager.disposeEventListeners`
21. **死注释修正**：`conversationStore.ts:247-249,322-327`、`ipc/skills.ts:207`、`RepoGroupCard.tsx:1`、`CapabilityHub.entrySignature` 补「content/hasArgs 刻意不参与门控」声明

---

## 三、中收益但需回归（→ 已交接新会话）

| 位置 | 内容 | 风险点 |
|---|---|---|
| `conversationStore.ts:1084-1117 / 1174-1276` | 两处 in-flight 去重样板 → `dedupeInFlight` | 必须保持「非 async + 返回同一 Promise 引用 + finally 清标记」 |
| `conversationStore.ts:1315-1332` vs `releaseConvCaches(555-586)` | 统一 keepIds/delete 两种清理 | 淘汰路径 key 归一化语义 |
| `PluginDialog.tsx:53-62,328-336` | `expanded` 记账只写不读：删 map 直接 `defaultExpanded` | 选「真正受控」则是行为变更 |
| `AgentsDialog:809` / `SkillsDialog:602` / `CommandsDialog:270` / `RepoGroupCard:70` | 批量启停差集 → `computeBatchTargets` | 4 遍重复，下发 id 集合与顺序敏感 |
| 三对话框 | `useCollapsedGroups(keys?)`；「首屏 loading + loadedRef 静默刷新 + useCapabilityRefresh」三态骨架 | 成功后的权威重取路径须逐字保留 |
| `AgentsDialog:519` / `SkillsDialog:229` | 仓库安装行 + 提示条 → `RepoInstallRow`/`InlineBanner` | DOM 与 `data-name` 测试锚点必须原样 |
| `RepoGroupCard.tsx:46-99` | 复包 `PluginGroupCard` | 守住 `repo-group-card-header` 的 role/tabIndex/aria-expanded 断言与「批量按钮在版本控件之前」 |
| `toolNameResolver` vs `openaiAdapter:790,863` | 两套别名表 key 规范不同 | **禁止统一**（会引入新命中，行为变更） |
| `executor.ts:85,91,279` | `aliasApplied` 判定恒真（`resolveToolName` 返回值必 ∈ `getNames()`，而进入分支前提是 ∉） | 仅收敛恒真判断 |
| `MenuDialog.tsx:91-96 vs 113-124` | 拖拽路径缺卸载清理，与 resize 路径不对称 | 补齐属 D 方向；事件顺序须一致 |

---

## 四、敏感点清单（语义不可变）

- **缓存控制**：`gitRepoCache`/`statusCache` 的 `resolve()` key 归一化 + `Date.now()-cached.time < 5000` TTL + `invalidateStatusCache`（`fileSystem.ts:74,79-89`、`git/status.ts:35-78`、`watcher.ts:9-11`）；`commandCache` 清空路径；`plugin/versionManager.prune` 调用点；`createSqliteOwnershipDeps` 按 kind 惰性快照
- **LLM 缓存**：system prompt 构造、tools/skills/agents 注册集合与顺序（`agentLoader.scanAllAgents`/`commandLoader.loadCommands`/`loadSkills` 的 `enabled` 取值与遍历序）、消息数组构造与稳定序列化、`contentBlocks` 截断改写与 `_fullOutputStored` 幂等短路、`DOTS_TOOL_ALIASES` 大小写直查、`CapabilityHub.entrySignature` 门控字段集、`displaySegments.ts:49` 的 `SlicedString` 分支、`events.ts`/`message.ts` 既有字段
- **内存泄漏优化**：`workerLimits.ts` 5 个 `*_RESOURCE_LIMITS` 常量与两处 worker 创建点、`messagesMap` 预热 10 + LRU 20 与 `enforceMessagesMapSizeLimit` 调用顺序、`releaseConvCaches`、`resetBridgeMsgState`/`#rowEnsured.delete`/`streamListeners` 空 key 删除、`clearLoopSilence`、`withToolTimeout`「先 reject 再 onTimeout」、abort 桥接与 `{once:true}`、`dispose*/stop*/unsubscribe*` 全套、所有 `useEffect(() => () => clearTimeout(...))`、Blob revoke 与 ref 置空
- **行为契约**：`waitForWindowShown` 门控 + `createTray` 延后时序、看门狗 25ms 心跳、`sendToConversation` ack 覆盖语义、`truncNote` 文案拼接、首屏水合三态（`undefined` vs `[]`）、切换竞态与并发锁、乐观回滚、`pendingDeleteDirs` 30 次上限、全仓 `color-mix` 迁移结果（`tokenCompliance.*.test.ts` 会 `walkDir('src/renderer')` 扫描字面量）

> **修订口径**：以上「语义」不可变；实现形式（重复样板、可达性冗余、过度防御、注释失真）在测试覆盖下允许收敛。

---

## 五、潜在缺陷/风险（非简化项，→ 已交接新会话）

1. **`planFileManager.ts:150-165`**：探测逻辑实际不可达 —— `spawn` 对 ENOENT 只异步 `emit('error')`，不抛同步异常，故 `auto` 恒返回 `'code'`；新增的空 error 监听正是掩盖 ENOENT。注释与实现不符。
2. **`CapabilityHub.entrySignature:227-241`**：签名不含 `content`/`hasArgs`，只改命令正文/参数不会触发 `replaceAll` 广播 → 前端可能滞留旧内容。
3. **`CommandsDialog.tsx:194-198`、`PluginDialog` handleToggle/handleSwitchVersion**：删除了成功后的权威重取（`capability.getByType`/`loadPlugins`/`syncFromDisk`），改依赖广播 —— 若广播未覆盖对应路径将滞留旧数据。
4. **`MenuDialog` 拖拽路径**缺卸载清理，拖拽中卸载残留 document 监听与 `body` 内联样式。
5. **`ChannelManager.ts:339`**：`init()` 未复位 `stopped`（`shutdown()` 后重新 init 将永久禁用崩溃重启）。
6. **`RepoVersionControl.tsx:99`** 手写红点，未复用本批新增的 `UpdateDot`（与其他 3 处不一致）。
7. **`initProgressStore.ts`**：`mcpDone`/`mcpTotal` 只写不读。
8. **`conversationStore.ts:322`** `isProtectedConv` 注释失真（`cleanupInactiveConversations` 额外保护三种 pending 态）。
9. **`messageHandler`/`gitBranch`** 的 `t.unref?.()` 作用于已明确类型句柄（冗余防御）。
10. **`window.ts:24` vs `watchers`**：`projectWindows` 用原始路径为 key，`watchers` 已 `resolve` 归一化 → 同一目录两种写法会导致第二个 PM 窗口收不到 `pm:file-changed/pm:status-changed`。

---

## 建议执行顺序

1. 零风险清理（24 处，单 commit）
2. 低风险抽取（21 项，拆 2-3 commit；每项跑对应测试：`shortcuts.test.ts`、`tokenCompliance.*`、`conversationStore.*.test.ts`、`repoGroupCard.test.tsx`）
3. 中收益项（第三节）按批回归 —— **交接新会话**
4. 潜在缺陷（第五节）单独立项，**不混入简化 PR** —— **交接新会话**
