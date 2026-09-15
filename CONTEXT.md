# CONTEXT — HClaw 领域词汇表

> 本文件由架构巡检（`improve-codebase-architecture`）维护，记录「能力管理域」的权威用语。
> 改命名、加模块前先读这里；用词以本表为准，不要用「组件 / 服务 / API / 边界」替代。

## 能力（Capability）
可被 Agent 循环消费的一等单元：技能（skill）、子代理（agent）、命令（command）、MCP 工具。
以**单条**为粒度，稳定键为 `id`。

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
