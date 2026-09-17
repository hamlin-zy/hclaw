# CONTEXT — HClaw 领域词汇表

> 本文件由架构巡检（`improve-codebase-architecture`）与设计盘问（`grill-with-docs`）维护，记录本项目的权威用语。
> 当前覆盖四个域：「能力管理域」「项目管理窗口（PM）快速导航」「任务批次域」与「定时任务域」。
> 改命名、加模块前先读这里；用词以本表为准，不要用「组件 / 服务 / API / 边界」替代。

## 能力（Capability）
可被 Agent 循环消费的一等单元：技能（skill）、子代理（agent）、命令（command）。
以**单条**为粒度，稳定键为 `id`。

MCP 工具**不是**能力——它是 Agent 循环的**工具**，与能力不在同一层级，也不进入本域的注册表与投影。
_Avoid_: 把「工具」「MCP 服务」当作能力的同义词

## 能力获取（Capability Acquisition）
渲染进程取得「当前可选能力列表」的过程。
**唯一权威来源是 CapabilityHub**；任何绕过它、直连旧注册表 IPC 的取数路径都属于待消除的历史旁路。
_Avoid_: 能力加载、能力同步

## 能力注册表（Registry）
三类独立注册表，是能力的权威持有者：
- `agentRegistry`（`src/main/agent/agentRegistry.ts`）
- `skillRegistry`（`src/main/agent/skills/registry.ts`）
- `CommandDispatcher`（`src/main/plugin/commands.ts`）

## PowerManager
加载/聚合中枢（`src/main/agent/powerManager.ts`）。**唯一真实写入口**：扫描磁盘/SQLite → 写入各 registry；`refresh()` 后把结果投影到 CapabilityHub。

## CapabilityHub
面向 UI 的**只读查询投影**（`src/main/capability/CapabilityHub.ts`）。
对外接口仅三项：只读 query 组 + `replaceAll(entries)` 写 seam + `onChanged` 订阅。
变更经 IPC `capability:changed` 推送，载荷仅为 `{ seq }`（单调序号）；消费端收到后整表重取，快照不进 IPC。

## 插件归属（Plugin Ownership）
「一条能力属于哪个插件 / 该插件是否启用 / 该能力是否启用」的判定。
**唯一权威实现**：`src/main/common/pluginOwnership.ts`。
规范插件 ID = `manifest.name`（= `plugins` 表 `name` 列）；目录名 `${name}@{source}` 与路径仅作定位，加载时一次性映射到 `manifest.name`。禁止再用目录名 / 路径 / id 前缀做归属判断。

## 能力启用判定优先级
1. **插件禁用** → 强制 off（对所有能力类型，含 command）
2. **单条能力 override 表值**（`agent_overrides` / `skill_overrides` / `command_overrides`）
3. **文件 / manifest 默认值**

## 工作区（Workspace）
PM 窗口当前打开、只读浏览的本地目录。是「最近打开」「面板布局」「目录缓存」等状态的归属键：切换工作区即整体失效。

## PM 快速导航（Quick Navigation）
PM 窗口内三组高频跳转能力的统称，均由 QuickOpen 浮层承载。

**QuickOpen**：
PM 窗口内承载快速导航的单一浮层——一个输入框、一个结果列表、一块选中项预览。
_Avoid_: 快速打开弹窗、命令面板、搜索框

**File Search**：
按文件路径名匹配工作区文件、选中后在主编辑区打开的模式。
_Avoid_: 文件名搜索、模糊查找、goto file

**Recent Files**：
按打开时间倒序排列的最近打开文件，最多保留 100 条；重复打开同一文件只更新时间、不新增条目。
_Avoid_: 历史记录、最近访问

**Find in Files**：
在工作区文件内容中检索的模式；每条结果是一个「文件 + 行号 + 行文本」的命中项。
_Avoid_: 全局搜索、内容搜索、grep

**命中项（Match）**：
Find in Files 结果的最小单位：一处命中 = 一个文件 + 一个行号 + 该行文本。页大小与结果上限一律以命中项计，不以文件计。
_Avoid_: 结果行、条目、文件

## 任务批次域（Task Batch）

**批次（Batch）**：
任务按一次请求为单位组织落库的单位，锚点为 `task_batches.id`。同时是任务历史的展示单位与删除单位——选中的是批次，删除的也是批次，不是其下的单条任务。
_Avoid_: 任务组、任务列表、task group

**活跃批次（Active Batch）**：
某会话中唯一 `status = 'active'` 的批次，由 InputArea 上方 TodoStrip 展示；批次完成即整体隐藏。
_Avoid_: 当前批次、进行中任务组

**批次作用域（Batch Scope）**：
任务历史的两种数据边界：「全量」= 当前工作区的全部会话，「当前会话」= 单个会话。作用域只改变数据来源，不改变窗口结构——批次列表与删除操作在两作用域下语义一致。
_Avoid_: 模式、视图模式

## 定时任务域（Scheduled Task）

**定时任务（Scheduled Task）**：
由 cron 表达式触发、在指定工作目录下执行一次能力或脚本的持久化条目，稳定键为 `id`。
_Avoid_: 计划任务、作业、cron job

**定时任务窗口（Scheduled Task Window）**：
配置窗口（ConfigDialogWindow）中以 tab 承载定时任务列表与编辑的界面，不是独立窗口。
_Avoid_: 定时任务对话框、调度器面板

**调度会话（Schedule Conversation）**：
定时任务每轮触发所创建的会话，`channel === 'schedule'`。脚本类型任务**不**产生调度会话。
_Avoid_: 执行会话、任务会话

**执行记录（Run History）**：
一轮触发留下的痕迹，**有两种载体**：调度会话（agent / skill / command）与脚本日志（script）。
两者不是同一物——「执行记录」是两者的统称，不得单指其一。
_Avoid_: 运行历史、执行日志

**触发来源（Fire Source）**：
一次执行是「cron 到点」还是「用户手动立即执行」。以 `ScheduleFireSource`（`'cron' | 'manual'`）为唯一来源，由执行器的调用方**显式传入**，不从执行状态反推、不复用字面量。
它决定两件可观察的事：是否向 cron 引擎发送 ack（只有到点触发拥有「本轮已认领」的语义），以及应用控制台输出里记录的 `source` 字段（本仓日志为 Console-only，打包版没有可查的持久化日志文件）。
_Avoid_: 触发类型、执行方式、用 `'cron'` 兼表手动

**暂停（Pause）/ 恢复（Resume）**：
单条任务的运行态开关——暂停 = 「先别跑，配置都留着」：记录与表达式原样保留，引擎停止触发，恢复后按原表达式继续。与「禁用」的区别是它回答的问题不同：禁用是「这个任务不该存在」。
暂停是**独立动作**（`paused` / `pausedAt` 落库 + 引擎侧运行时状态），不是「更新一条记录」的副作用；它跨重启保留。
_Avoid_: 停用、停掉、关闭任务

**脚本日志（Script Log）**：
脚本类型任务的执行记录载体：一轮触发落一个文件，路径为 `{hclawDir}/logs/schedules/{任务 id}-{开始时间戳}.log`。脚本任务**不**产生调度会话（见「执行记录」）。
_Avoid_: 执行日志、运行日志
