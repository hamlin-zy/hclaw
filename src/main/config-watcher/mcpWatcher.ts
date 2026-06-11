import fs from 'fs'
import {getMcpConfigPath, readMcpConfig} from '../config/mcpConfig'
import type {McpServer} from '../../shared/types/mcp'
import {mcpService} from '../services/mcpService'
import {mcpWorkerManager} from '../agent/mcp/mcpWorkerManager'
import {logger} from '../agent/logger'

const DEBOUNCE_MS = 500

/**
 * 比较两个 McpServer 的配置是否实质不同（忽略运行时状态字段）
 */
function configChanged(a: McpServer, b: McpServer): boolean {
    if (a.enabled !== b.enabled) return true
    if (a.command !== b.command) return true
    if (a.url !== b.url) return true
    if (a.cwd !== b.cwd) return true
    if (a.timeout !== b.timeout) return true
    if (a.userDescription !== b.userDescription) return true
    if (a.transport !== b.transport) return true
    if (JSON.stringify(a.args || []) !== JSON.stringify(b.args || [])) return true
    if (JSON.stringify(a.env || {}) !== JSON.stringify(b.env || {})) return true
    if (JSON.stringify(a.headers || {}) !== JSON.stringify(b.headers || {})) return true
    if (JSON.stringify(a.autoApprove || []) !== JSON.stringify(b.autoApprove || [])) return true
    if (JSON.stringify(a.denyList || []) !== JSON.stringify(b.denyList || [])) return true
    return false
}

export class McpWatcher {
    private watcher: fs.FSWatcher | null = null
    private cachedServers: McpServer[] = []
    private debounceTimer: ReturnType<typeof setTimeout> | null = null

    start(): void {
        const configPath = getMcpConfigPath()
        if (!fs.existsSync(configPath)) {
            try {
                fs.writeFileSync(configPath, JSON.stringify({mcpServers: {}}, null, 2), 'utf-8')
            } catch {
                logger.warn('[McpWatcher] could not create mcp.json')
                return
            }
        }

        try {
            this.cachedServers = readMcpConfig()
            this.watcher = fs.watch(configPath, {encoding: 'utf-8'}, (eventType) => {
                // Windows 下 writeFileSync 可能触发 'rename'，需要同时处理
                if (eventType !== 'change' && eventType !== 'rename') return
                // rename 后检查文件是否还存在（可能是删除）
                if (eventType === 'rename' && !fs.existsSync(configPath)) return
                if (this.debounceTimer) clearTimeout(this.debounceTimer)
                this.debounceTimer = setTimeout(() => this.handleChange(), DEBOUNCE_MS)
            })
        } catch (_err: any) {
        }
    }

    stop(): void {
        if (this.watcher) {
            this.watcher.close()
            this.watcher = null
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer)
            this.debounceTimer = null
        }
    }

    /**
     * 处理 mcp.json 文件变更
     *
     * Phase 2: 不再直接操作 mcpClient（主线程单例），改为：
     * 1. 更新 mcpService 缓存
     * 2. 通知 MCP Worker 同步配置（Worker 统一管理连接生命周期）
     *
     * 避免主线程和 Worker 各自 spawn 子进程导致重复进程泄露。
     */
    private async handleChange(): Promise<void> {
        try {
            const newServers = readMcpConfig()
            const oldServers = this.cachedServers

            // 检测是否有实质变更（避免空刷新）
            const hasChanges = newServers.length !== oldServers.length ||
                newServers.some(s => {
                    const old = oldServers.find(o => o.id === s.id)
                    return !old || configChanged(s, old)
                }) ||
                oldServers.some(o => !newServers.find(s => s.id === o.id))

            // 同步回 mcpService 缓存，防止 UI 用旧数据覆盖文件
            mcpService.reloadServers(newServers)
            this.cachedServers = newServers

            // 通知 Worker 全量同步配置（Worker 内部 diff 后精准启停）
            if (hasChanges) {
                mcpWorkerManager.syncConfigs()
            }
        } catch (err: any) {
            logger.error('[McpWatcher] handleChange failed:', {error: err.message})
        }
    }
}
