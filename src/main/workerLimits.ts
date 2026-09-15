/**
 * Worker 线程资源上限 + 会话 Worker 并发闸门（主进程）
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 为什么需要显式 resourceLimits
 *
 * 主进程以 `--max-old-space-size=2048 --max-semi-space-size=16` 启动
 *（见 src/main/index.ts 的 js-flags；dev 下由 dev.js 注入）。worker_threads 的
 * isolate **继承该 V8 参数**：不传 resourceLimits 时，每个 Worker 各自拿到
 * 2048MB 的 old-gen 上限 —— 5 个并发会话就是「5 × 2GB」的数量级。
 *（实测：加 resourceLimits 后 isolate 的 v8.heap_size_limit 从 4288MB 降到 280MB，
 *  每 isolate 固定开销从 ~7.3–8.5MB 压到 ~4.8–5.7MB，见
 *  tests/diag/main-process-rss.diag.test.ts。）
 *
 * 因此这里为**每个** Worker 站点显式封顶：上限只用于「兜住正常负载 + 拦住失控增长」，
 * 不是「按需分配」——V8 的 maxOldGenerationSizeMb 只是上限，未用到的部分不占用内存。
 *
 * ⚠️ 超限行为：达到上限后分配失败，Worker 被以 `ERR_WORKER_OUT_OF_MEMORY` 终止。
 *    会话 Worker 的终止由 AgentManager 的 onWorkerError / onWorkerExit → cleanup
 *    接住（渲染进程收到 error/done，会话回到 idle/error）；其余站点各自有
 *    崩溃重启或同步降级路径。改动上限时请一并确认这些路径仍然可达。
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 取值依据总览
 *  · 会话 Agent Worker：唯一「会长大」的 worker（跑完整 agent loop）→ 512MB。
 *  · 其余 4 个：常驻小 worker（协调 / 心跳 / 单次 checkpoint / 渠道 I/O）→ 256MB。
 *  · young gen（semi-space）统一 16MB，与主进程 `--max-semi-space-size=16` 对齐：
 *    流式循环产生大量短期垃圾，semi-space 过大反而让垃圾囤积（见 index.ts 注释）。
 * ─────────────────────────────────────────────────────────────────────────
 */

import type {ResourceLimits} from 'node:worker_threads'

/** 典型值的注释模板：old-gen 上限（MB）/ young-gen(semi-space) 上限（MB） */
const OLD_GEN_NORMAL_MB = 256
const YOUNG_GEN_MB = 16

/**
 * 会话 Agent Worker（src/main/agent/manager.impl.ts）资源上限。
 *
 * old-gen = 512MB，理由：
 *  · 正常负载远小于此：agent loop 的实测堆在**数十 MB** 量级
 *    （tests/diag/agent-loop-heap.diag.test.ts：40 轮 × 64KB payload 约 30MB）。
 *  · 但历史上出现过 500MB → 2GB 的异常膨胀（大附件 / 长历史 / 未及时 GC），
 *    故不能按「实测 30MB」贴着设——512MB 给真实长会话留足余量，
 *    同时把单个 isolate 的失控上限从继承来的 2048MB 压到 1/4。
 *  · 与并发闸门（MAX_CONCURRENT_SESSION_WORKERS）配合，最坏情况
 *    6 × 512MB = 3GB 上限，而非 6 × 2GB = 12GB。
 *
 * young-gen = 16MB，与主进程 `--max-semi-space-size=16` 一致（同款流式分配形状）。
 */
export const SESSION_AGENT_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: YOUNG_GEN_MB,
}

/**
 * MCP Worker（src/main/agent/mcp/mcpWorkerManager.ts）资源上限。
 *
 * 该 worker 只做**协调**：真正的 MCP server 是它 spawn 出去的独立子进程
 * （stdio/http），worker 侧只持有状态缓存与 MessagePort 消息转发。负载是
 * 短小 JSON 消息，256MB 远超所需；封顶可避免其随配置/工具结果膨胀。
 */
export const MCP_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: OLD_GEN_NORMAL_MB,
  maxYoungGenerationSizeMb: YOUNG_GEN_MB,
}

/**
 * SQLite WAL checkpoint Worker（src/main/repositories/sqlite/index.ts）资源上限。
 *
 * 单次 TRUNCATE 合并，生命周期极短、不持业务对象，256MB 已是宽松上限。
 * 超限被杀时该站点本身即「静默降级为同步 checkpoint」路径，无用户可见影响。
 */
export const CHECKPOINT_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: OLD_GEN_NORMAL_MB,
  maxYoungGenerationSizeMb: YOUNG_GEN_MB,
}

/**
 * Scheduler cron Worker（src/main/scheduler/index.ts）资源上限。
 *
 * 仅做定时检测 + postMessage 派发（agentLoop 在会话 Worker 里跑，不在此 worker），
 * 常驻但负载极轻，256MB 充裕。
 */
export const SCHEDULER_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: OLD_GEN_NORMAL_MB,
  maxYoungGenerationSizeMb: YOUNG_GEN_MB,
}

/**
 * Channel Worker（src/main/channel/ChannelManager.ts）资源上限。
 *
 * 渠道 I/O 与消息编排（每个渠道的 agent 运行仍走会话 Worker），常驻、负载轻，
 * 256MB 充裕。
 */
export const CHANNEL_WORKER_RESOURCE_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: OLD_GEN_NORMAL_MB,
  maxYoungGenerationSizeMb: YOUNG_GEN_MB,
}

/**
 * 同时运行的**会话 Agent Worker** 上限（不含 MCP / checkpoint / scheduler / channel）。
 *
 * 为什么是这个值：本闸门的目的**不是省内存**，而是给「每 isolate 一份 old-gen 上限」
 * 封顶 —— 无闸门时 N 个会话就是 N × 上限，进程级峰值随会话数线性发散。
 * 6 的取法：正常人手同时对话 1–3 个；给「主会话 + 系统提示里的子任务/交接会话」留余量后
 * 取 6，最坏 6 × 512MB = 3GB，仍在主进程可承受范围。
 *
 * 语义：**拒绝启动**（抛出可读错误），不排队、不静默丢弃、不打断已有会话。
 */
export const MAX_CONCURRENT_SESSION_WORKERS = 6
