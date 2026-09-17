/**
 * config.ts —— 兼容门面（barrel）
 *
 * 历史：本模块曾同时扮演「路径/目录能力 + 仓库装配 + IPC 注册」三角色，使
 * repositories/sqlite/*、config/mcpConfig.ts 等为了 getHclawDir / isSafePath 反向
 * import 本模块，把 25 个模块拉进同一个 SCC（详见
 * docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md）。
 *
 * 治理后的职责归属：
 * - 路径 / 目录能力（只依赖 node 内置的叶子）→ src/main/hclawPaths.ts
 * - 配置目录布局初始化 + 一次性数据迁移      → src/main/config/ensureConfigLayout.ts
 * - 配置类 IPC handler 注册                  → src/main/ipc/configIPC.ts
 *
 * 本文件只保留对叶子的重新导出，使既有调用方（`from './config'`）无需改动；
 * ESM/CJS 的 live binding 保证 `_cachedHclawDir` 全局唯一（缓存语义与原实现同源）。
 */
export {
    HCLAW_DIR,
    getHclawDir,
    setHclawDir,
    isSafePath,
    getHclawDataDir,
    getChannelMediaDir,
    getChannelSessionMediaDir,
    configPath,
} from './hclawPaths';
