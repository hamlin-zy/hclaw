import {useCallback, useEffect, useRef, useState, type ComponentType} from 'react'
import {Switch} from '../common/Switch'
import {useMcpStore} from '../../stores/mcpStore'
import type {MCPServer} from '@shared/types'
import MCPToolsOverlay from './MCPToolsOverlay'
import MCPUserServerCard from './MCPUserServerCard'
import MCPPluginServerCard from './MCPPluginServerCard'
import MCPEditModal from './MCPEditModal'
import {useMcpErrorDialog} from './MCPErrorHelper'
import {useMcpUpdateStore} from '../../stores/mcpUpdateStore'
import {showToast} from '../../hooks/useMcpVersionSwitch'
import {SuccessIcon, ErrorIcon, InfoIcon, RemoveIcon} from '../icons'
import type {IconProps} from '../icons'

type TabType = 'user' | 'plugin'

type ToastType = 'success' | 'error' | 'info'
interface ToastState { message: string; type: ToastType }

// Local toast — mirrors the pattern used in ChannelsDialog.
// Renders pinned bottom-center; dismiss on click.
function Toast({message, type, onClose}: { message: string; type: ToastType; onClose: () => void }) {
    const styles: Record<ToastType, string> = {
        success: 'bg-[#10B981] text-white',
        error: 'bg-[#EF4444] text-white',
        info: 'bg-[#3B82F6] text-white',
    }
    const icons: Record<ToastType, ComponentType<IconProps>> = {
        success: SuccessIcon,
        error: ErrorIcon,
        info: InfoIcon,
    }
    const ToastIcon = icons[type]
    return (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium
            animate-[fade-in-up_0.2s_ease-out] flex items-center gap-1.5
            ${styles[type]}`}
            onClick={onClose} data-testid="mcpdialog-toast" data-name="mcpdialog-toast">
            <ToastIcon className="w-4 h-4 shrink-0"/>{message}
        </div>
    )
}

export default function MCPDialog() {
    const {
        mcpServers,
        addMCPServer,
        restoreMCPServer,
        removeMCPServer,
        updateMCPServer,
        setServerEnabledLocal,
        setServerStatusesBatch,
    } = useMcpStore()
    const {McpErrorOverlay, showError} = useMcpErrorDialog({
        onNavigateHome: () => window.electronAPI?.windowControls?.close?.(),
    })
    const [activeTab, setActiveTab] = useState<TabType>('user')
    const [editTarget, setEditTarget] = useState<MCPServer | 'add' | null>(null)
    const [toolsModalServer, setToolsModalServer] = useState<MCPServer | null>(null)
    const [pluginMcpServers, setPluginMcpServers] = useState<MCPServer[]>([])
    const [importing, setImporting] = useState(false)
    const [importResult, setImportResult] = useState<{
        imported: number
        skipped: number
        error?: string
    } | null>(null)

    // ─── MCP version meta: register push listener + pull initial cache ───
    // ConfigDialogWindow is a separate window from App.tsx, so the listener
    // registered in App.tsx does NOT reach this window. Must register locally.
    useEffect(() => {
        const unsubscribe = window.electronAPI?.mcp?.onMcpStatusUpdate?.((data: any) => {
            if (data && typeof data === 'object') {
                useMcpUpdateStore.getState().setVersionMeta(data)
            }
        })
        useMcpUpdateStore.getState().refreshFromCache()
        return () => unsubscribe?.()
    }, [])

    // ─── 导入流程的游离定时器（各自独立 ref，对齐上方 toastTimer 的记账范式）───
    // importSyncTimer：导入成功后延迟 500ms 拉取最新状态
    // importResultTimer：导入结果提示 3s 后自动隐藏
    const importSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const importResultTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // 卸载守卫：延迟回调（延迟同步 / 异步 setState）在对话框卸载后必须跳过写入
    const mountedRef = useRef(true)
    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            if (importSyncTimer.current) clearTimeout(importSyncTimer.current)
            if (importResultTimer.current) clearTimeout(importResultTimer.current)
        }
    }, [])

    // ─── 操作防连点（in-flight 锁）───
    // 同一 server 的「启用/禁用」与「重启」请求在飞期间，重复点击必须被忽略：
    // 单次点击会串行打出 set-enabled + start/stop 多个 IPC，连点会造成重复全量同步。
    // inFlightRef 做同步判重（state 更新是异步的，挡不住同一 tick 内的连点）；
    // busyIds 仅用于渲染层禁用反馈。
    const inFlightRef = useRef<Set<string>>(new Set())
    const [busyIds, setBusyIds] = useState<Set<string>>(new Set())

    const markBusy = useCallback((id: string) => {
        setBusyIds(prev => {
            const next = new Set(prev)
            next.add(id)
            return next
        })
    }, [])

    const clearBusy = useCallback((id: string) => {
        setBusyIds(prev => {
            const next = new Set(prev)
            next.delete(id)
            return next
        })
    }, [])

    // ─── Toast (listens to `hclaw:show-toast` CustomEvent) ───
    // Dispatched from checkVersions handler and MCPUserServerCard.upgradeServer.
    const [toast, setToast] = useState<ToastState | null>(null)
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    const clearToast = useCallback(() => {
        if (toastTimer.current) {
            clearTimeout(toastTimer.current)
            toastTimer.current = null
        }
        setToast(null)
    }, [])

    useEffect(() => {
        const handler = (e: Event) => {
            const {type, message, duration} = (e as CustomEvent<{
                type?: ToastType
                message?: string
                duration?: number
            }>).detail ?? {}
            if (!message) return
            clearToast()
            setToast({message, type: type || 'info'})
            toastTimer.current = setTimeout(clearToast, duration || 5000)
        }
        window.addEventListener('hclaw:show-toast', handler)
        return () => {
            window.removeEventListener('hclaw:show-toast', handler)
            if (toastTimer.current) clearTimeout(toastTimer.current)
        }
    }, [clearToast])

    // ─── Sync versions (manual trigger) ───
    const handleSyncVersions = useCallback(async () => {
        const result = await window.electronAPI?.mcp?.checkVersions?.()
        if (result?.success) {
            showToast('success', '版本检测完成')
        } else {
            showToast('error', `版本检测失败: ${result?.error || '未知错误'}`)
        }
    }, [])

    // ─── 同步服务器状态 ─────────────────────

    const syncMcpStatus = useCallback(async () => {
        if (!window.electronAPI?.mcp?.getAllStatus) return
        const statuses = await window.electronAPI.mcp.getAllStatus()
        const result = await window.electronAPI?.mcp?.list?.()
        // ★ 卸载守卫：本函数由 useEffect 与「导入成功后 500ms」的延迟回调调用，
        //   对话框卸载后到达的 await 结果不得再 setState
        if (!mountedRef.current) return
        const mcpServiceList = result?.success ? result.data || [] : []

        const pluginServerConfigMap = new Map<string, any>()
        mcpServiceList.forEach((s: any) => {
            if (s.id.startsWith('plugin:')) pluginServerConfigMap.set(s.id, s)
        })

        const userUpdates: Array<{ id: string; status: any; tools: any; error: string; config: any }> = []
        const pluginList: MCPServer[] = []
        const statusMap = new Map(statuses.map((s: any) => [s.config.id, s]))

        pluginServerConfigMap.forEach((config: any, id: string) => {
            const runtimeStatus = statusMap.get(id)
            pluginList.push({
                id: config.id,
                name: config.name || config.id,
                transport: config.transport,
                status: runtimeStatus?.status || (config.enabled ? 'stopped' : 'disabled'),
                tools: runtimeStatus?.tools || [],
                errorDetail: runtimeStatus?.error || '',
                enabled: config.enabled,
                command: config.command,
                args: config.args,
                env: config.env,
                url: config.url,
                headers: config.headers,
                cwd: config.cwd,
                timeout: config.timeout,
                autoApprove: config.autoApprove,
                denyList: config.denyList,
                pluginEnabled: config.pluginEnabled,
            } as MCPServer & { pluginEnabled?: boolean })
        })
        pluginList.sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
            return a.name.localeCompare(b.name)
        })

        statuses.forEach((s: any) => {
            const config = s.config
            if (!config.id.startsWith('plugin:')) {
                userUpdates.push({id: config.id, status: s.status, tools: s.tools, error: s.error || '', config})
            }
        })

        setPluginMcpServers(pluginList)

        // ★ 用户 MCP 状态同步：只同步 store 中不存在的服务器，或 store 中仍为 'stopped' 的服务器
        // 避免用主进程的旧数据（可能仍未收到 Worker 的 status_batch）覆盖 store 中已由
        // 模块级 onStatusChanged 监听器更新的实时状态（如 'connecting'、'connected'）
        if (userUpdates.length > 0) {
            // 获取当前 store 状态，过滤掉已有非 stopped 状态的服务器
            const storeState = useMcpStore.getState()
            const filtered = userUpdates.filter(u => {
                const storeServer = storeState.mcpServers.find(s => s.id === u.id)
                // 新服务器（store 中不存在）→ 同步
                if (!storeServer) return true
                // store 中已经是 stopped → 用主进程数据（可能有更新）
                if (storeServer.status === 'stopped') return true
                // store 中已有活跃状态（connecting/connected/error/reconnecting）→ 不覆盖
                console.log(`[MCPDialog] syncMcpStatus: SKIP user server ${u.id} (store already has ${storeServer.status}, main says ${u.status})`)
                return false
            })
            if (filtered.length > 0) {
                setServerStatusesBatch(filtered.map(({id, status, tools, error, config}) => ({
                    id, status, tools,
                    errorDetail: error,
                    extra: {
                        name: config.name, transport: config.transport,
                        command: config.command, args: config.args, env: config.env,
                        url: config.url, headers: config.headers, cwd: config.cwd,
                        timeout: config.timeout, autoApprove: config.autoApprove,
                        denyList: config.denyList, userDescription: config.userDescription,
                    },
                })))
            }
        }
    }, [setServerStatusesBatch])

    useEffect(() => { syncMcpStatus() }, [syncMcpStatus])

    // 监听插件 MCP 状态变化
    useEffect(() => {
        const unsubscribe = window.electronAPI?.mcp?.onStatusChanged?.((payload: any) => {
            if (!payload.serverId?.startsWith('plugin:')) return
            setPluginMcpServers(prev => prev.map(srv =>
                srv.id !== payload.serverId ? srv : {
                    ...srv,
                    status: payload.status,
                    errorDetail: payload.error || '',
                    tools: payload.tools || [],
                }
            ))
        })
        return () => unsubscribe?.()
    }, [])

    // ─── 导入 MCP 配置 ─────────────────────

    const handleImportFile = useCallback(async () => {
        const filePath = await window.electronAPI?.selectFilePath?.()
        if (!filePath) return
        setImporting(true)
        setImportResult(null)
        try {
            const mcpApi = window.electronAPI?.mcp as any
            const result = await mcpApi?.importConfig?.(filePath)
            if (result?.success) {
                setImportResult({imported: result.imported?.length || 0, skipped: result.skipped?.length || 0})
                // 延迟同步（等主进程落盘完成）：ref 记账，卸载时清理
                if (importSyncTimer.current) clearTimeout(importSyncTimer.current)
                importSyncTimer.current = setTimeout(() => {
                    importSyncTimer.current = null
                    syncMcpStatus()
                }, 500)
            } else {
                setImportResult({imported: -1, skipped: 0, error: result?.error || '未知错误'})
            }
        } catch (err: any) {
            setImportResult({imported: -1, skipped: 0, error: err?.message || String(err)})
        }
        setImporting(false)
        // 结果提示自动隐藏：ref 记账（先清旧定时器，避免上一次的定时器提前抹掉本次结果）
        if (importResultTimer.current) clearTimeout(importResultTimer.current)
        importResultTimer.current = setTimeout(() => {
            importResultTimer.current = null
            setImportResult(null)
        }, 3000)
    }, [syncMcpStatus])

    // ─── 派生数据 ─────────────────────────

    const userMcpServers = mcpServers
        .filter(s => !s.id.startsWith('plugin:'))
        .sort((a, b) => {
            if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
            return a.name.localeCompare(b.name)
        })

    const userAllEnabled = userMcpServers.length > 0 && userMcpServers.every(s => s.enabled)
    const pluginAllEnabled = pluginMcpServers.length > 0 && pluginMcpServers.every(s => s.enabled)

    // ─── 操作处理函数 ─────────────────────

    const startServer = useCallback(async (server: MCPServer) => {
        return await window.electronAPI?.mcp?.startServer?.(server)
    }, [])

    const stopServer = useCallback(async (serverId: string) => {
        return await window.electronAPI?.mcp?.stopServer?.(serverId)
    }, [])

    const handleToggle = useCallback(async (serverId: string, currentEnabled: boolean) => {
        // 防连点：同一 server 已有请求在飞时直接忽略重复点击
        if (inFlightRef.current.has(serverId)) return
        inFlightRef.current.add(serverId)
        markBusy(serverId)
        try {
            const newEnabled = !currentEnabled
            // ★ 只改本地状态：落盘由主进程 mcp:set-enabled 负责（mcpService.setEnabled 内部 writeMcpConfig）
            setServerEnabledLocal(serverId, newEnabled)
            const server = mcpServers.find(s => s.id === serverId)
            if (server) {
                // ★ setEnabled 的返回值与异常必须检查：主进程写盘失败时 mcp.json 未改，
                //   若渲染层仍显示新状态，UI 与实际配置漂移，重启应用后表现为「开关莫名回退」。
                let setResult: { success?: boolean; error?: string } | undefined
                try {
                    setResult = await window.electronAPI?.mcp?.setEnabled?.(serverId, newEnabled)
                } catch (err) {
                    // 抛错同样属于落盘失败：回滚为进入函数时捕获的原值
                    setServerEnabledLocal(serverId, currentEnabled)
                    showError({server, errorMessage: err instanceof Error ? err.message : String(err), action: 'enable'})
                    return
                }
                if (setResult && !setResult.success) {
                    setServerEnabledLocal(serverId, currentEnabled)
                    showError({server, errorMessage: setResult.error || (newEnabled ? '启用失败' : '禁用失败'), action: 'enable'})
                    return
                }
                if (newEnabled) {
                    // ★ 启动失败/异常同样要回滚本地 enabled：否则 UI 显示已启用而进程并未起来
                    try {
                        const r = await startServer(server)
                        if (r && !r.success) {
                            setServerEnabledLocal(serverId, currentEnabled)
                            showError({server, errorMessage: r.error || '启动失败', action: 'enable'})
                            return
                        }
                    } catch (err) {
                        setServerEnabledLocal(serverId, currentEnabled)
                        showError({server, errorMessage: err instanceof Error ? err.message : String(err), action: 'enable'})
                        return
                    }
                } else {
                    try {
                        const r = await stopServer(serverId)
                        if (r && !r.success) {
                            setServerEnabledLocal(serverId, currentEnabled)
                            showError({server, errorMessage: r.error || '停止失败', action: 'enable'})
                            return
                        }
                    } catch (err) {
                        setServerEnabledLocal(serverId, currentEnabled)
                        showError({server, errorMessage: err instanceof Error ? err.message : String(err), action: 'enable'})
                        return
                    }
                }
            }
        } finally {
            inFlightRef.current.delete(serverId)
            clearBusy(serverId)
        }
    }, [mcpServers, setServerEnabledLocal, startServer, stopServer, showError, markBusy, clearBusy])

    const handleRemove = useCallback(async (serverId: string) => {
        // ★ 删除前先截取快照（含原索引）：写盘失败时用它把该 server 原样恢复回列表
        const snapshotIndex = mcpServers.findIndex(s => s.id === serverId)
        const snapshot = snapshotIndex >= 0 ? mcpServers[snapshotIndex] : undefined
        removeMCPServer(serverId)
        // ★ delete 的返回值与异常必须检查：主进程写盘失败时 mcp.json 仍保留该项，
        //   若渲染层已乐观移除，UI 与配置漂移（重启后「刚删掉的服务器」又回来了）。
        //   失败即用 restoreMCPServer 把**原对象原索引**插回（不改字段、不重算 id、不落盘），
        //   并走既有 showError 反馈；成功路径行为保持原样（不弹提示）。
        let deleteResult: { success?: boolean; error?: string } | undefined
        let deleteError: string | null = null
        try {
            deleteResult = await window.electronAPI?.mcp?.delete?.(serverId)
            if (deleteResult && !deleteResult.success) {
                deleteError = deleteResult.error || '删除失败'
            }
        } catch (err) {
            deleteError = err instanceof Error ? err.message : String(err)
        }
        if (!deleteError || !snapshot) return
        // ★ 不得改用 addMCPServer：它会按 name 重算 slug id（imported:*/中文名项 id 漂移）、
        //   强制 enabled:true / status:'stopped' / 清空 tools，并再走一次 saveServer 落盘——
        //   在「删除写盘失败」场景下会把恢复项写坏还多写一次盘。
        restoreMCPServer(snapshot, snapshotIndex)
        showError({server: snapshot, errorMessage: deleteError, action: 'enable'})
    }, [mcpServers, removeMCPServer, restoreMCPServer, showError])

    const handleReconnect = useCallback(async (serverId: string, _server: MCPServer) => {
        // 防连点：重启同样是多步 IPC，重复点击会叠加重启
        if (inFlightRef.current.has(serverId)) return
        inFlightRef.current.add(serverId)
        markBusy(serverId)
        try {
            const r = await window.electronAPI?.mcp?.restartServer?.(serverId)
            if (r && !r.success) {
                showError({server: _server, errorMessage: r.error || '重连失败', action: 'reconnect'})
            }
        } finally {
            inFlightRef.current.delete(serverId)
            clearBusy(serverId)
        }
    }, [showError, markBusy, clearBusy])

    const handlePluginToggle = useCallback(async (serverId: string, currentEnabled: boolean) => {
        // 防连点：与用户 MCP 开关共用同一把 in-flight 锁
        if (inFlightRef.current.has(serverId)) return
        inFlightRef.current.add(serverId)
        markBusy(serverId)
        try {
            const newEnabled = !currentEnabled
            // ★ 与用户 MCP 分支同理：落盘失败（{success:false} 或抛错）时必须中断，
            //   既不继续 start/stop，也不把 pluginMcpServers 的 enabled 改成新值——
            //   否则 UI 显示「已启用」而 mcp.json 未变，重启后回退。
            let setResult: { success?: boolean; error?: string } | undefined
            let setError: string | null = null
            try {
                setResult = await window.electronAPI?.mcp?.setEnabled?.(serverId, newEnabled)
                if (setResult && !setResult.success) {
                    setError = setResult.error || (newEnabled ? '启用失败' : '禁用失败')
                }
            } catch (err) {
                setError = err instanceof Error ? err.message : String(err)
            }
            if (setError) {
                // 插件项的 enabled 由 pluginMcpServers 持有，回滚落在该本地状态上；
                // 同时调 setServerEnabledLocal 保持与用户 MCP 分支同一回滚入口（插件 id 不命中 store，为安全 no-op）
                setServerEnabledLocal(serverId, currentEnabled)
                setPluginMcpServers(prev => prev.map(s => s.id === serverId ? {...s, enabled: currentEnabled} : s))
                const server = pluginMcpServers.find(s => s.id === serverId)
                if (server) showError({server, errorMessage: setError, action: 'enable'})
                return
            }
            // ★ 与 handleToggle 同构：start/stop 的返回值与异常都必须逐项接管——
            //   失败/异常即保留原 enabled（回滚到进入函数时的原值，不落到末尾的置新值），
            //   走既有 showError 反馈并 return；异常必须在函数内消化，绝不能让 onToggle
            //   的 promise 冒泡（React 事件层会丢弃返回值 → 未处理 Promise 拒绝）。
            if (!newEnabled) {
                const server = pluginMcpServers.find(s => s.id === serverId)
                if (server) {
                    try {
                        const r = await stopServer(serverId)
                        if (r && !r.success) {
                            setPluginMcpServers(prev => prev.map(s => s.id === serverId ? {...s, enabled: currentEnabled} : s))
                            setServerEnabledLocal(serverId, currentEnabled)
                            showError({server, errorMessage: r.error || '停止失败', action: 'enable'})
                            return
                        }
                    } catch (err) {
                        setPluginMcpServers(prev => prev.map(s => s.id === serverId ? {...s, enabled: currentEnabled} : s))
                        setServerEnabledLocal(serverId, currentEnabled)
                        showError({server, errorMessage: err instanceof Error ? err.message : String(err), action: 'enable'})
                        return
                    }
                }
            } else {
                const server = pluginMcpServers.find(s => s.id === serverId)
                if (server) {
                    try {
                        const r = await startServer(server)
                        if (r && !r.success) {
                            setPluginMcpServers(prev => prev.map(s => s.id === serverId ? {...s, enabled: currentEnabled} : s))
                            setServerEnabledLocal(serverId, currentEnabled)
                            showError({server, errorMessage: r.error || '启动失败', action: 'enable'})
                            return
                        }
                    } catch (err) {
                        setPluginMcpServers(prev => prev.map(s => s.id === serverId ? {...s, enabled: currentEnabled} : s))
                        setServerEnabledLocal(serverId, currentEnabled)
                        showError({server, errorMessage: err instanceof Error ? err.message : String(err), action: 'enable'})
                        return
                    }
                }
            }
            setPluginMcpServers(prev => prev.map(s =>
                s.id === serverId ? {...s, enabled: newEnabled} : s
            ))
        } finally {
            inFlightRef.current.delete(serverId)
            clearBusy(serverId)
        }
    }, [pluginMcpServers, setServerEnabledLocal, startServer, stopServer, showError, markBusy, clearBusy])

    // Master Toggle
    // ★ 批量开关采用「全量持锁」（方案 A）：整个 loop 期间持有全部目标 id 的 in-flight 锁。
    //   若只锁当前正在处理的那一项，批量执行期间的单卡片点击会与本循环交叉，
    //   对同一 server 打出方向相反的 setEnabled，最终 enabled 取决于 IPC 到达顺序（不确定）。
    const toggleAll = useCallback(async (servers: MCPServer[], currentAllEnabled: boolean) => {
        if (servers.length === 0) return
        // ★ 按 id 判定互斥（不再全局互斥）：只跳过「自身已有请求在飞」的目标
        //   （单项操作在飞 / 上一批持锁残留），其余目标照常执行。全局互斥会让
        //   任一单项在飞时整批静默失效——用户点「全部开启」没有任何反馈。
        //   同一 id 的互斥不放开：命中在飞集合的目标被跳过，绝不会并发写。
        const skippedIds = new Set(servers.filter(s => inFlightRef.current.has(s.id)).map(s => s.id))
        const runnable = servers.filter(s => !skippedIds.has(s.id))
        if (runnable.length === 0) return   // 全部目标都在飞：与旧行为等价的空操作

        const newEnabled = !currentAllEnabled
        const targetIds = runnable.map(s => s.id)
        // 先同步占位再加 busy 反馈：state 更新是异步的，挡不住同一 tick 内的连点/交叉点击
        targetIds.forEach(id => inFlightRef.current.add(id))
        setBusyIds(prev => {
            const next = new Set(prev)
            targetIds.forEach(id => next.add(id))
            return next
        })
        // 失败项集合：插件侧的批量 enabled 映射要跳过它们，否则会覆盖上面的逐项回滚。
        // 被跳过（在飞）的目标同样入列：它们不属于本批，不得被批量结果改写。
        const failedIds = new Set<string>(skippedIds)
        try {
            for (const server of runnable) {
                // 用户 MCP 需要更新本地 store（不落盘，持久化由主进程 mcp:set-enabled 负责）
                if (!server.id.startsWith('plugin:')) setServerEnabledLocal(server.id, newEnabled)
                // ★ 必须逐项 await 并检查返回值/异常：否则会并发打出多个 setEnabled，
                //   失败无人接管，也无法逐项回滚本地状态
                let setResult: { success?: boolean; error?: string } | undefined
                let setError: string | null = null
                try {
                    setResult = await window.electronAPI?.mcp?.setEnabled?.(server.id, newEnabled)
                    if (setResult && !setResult.success) {
                        setError = setResult.error || (newEnabled ? '启用失败' : '禁用失败')
                    }
                } catch (err) {
                    setError = err instanceof Error ? err.message : String(err)
                }
                if (setError) {
                    // 逐项回滚为该项进入循环前的原值；批量语义是「尽力而为」，继续处理其余项
                    failedIds.add(server.id)
                    if (!server.id.startsWith('plugin:')) setServerEnabledLocal(server.id, server.enabled)
                    showError({server, errorMessage: setError, action: 'enable'})
                    continue
                }
                // ★ 启动/停止的结果同样要检查：失败或异常时按「该项失败」处理并回滚本地状态，
                //   否则批量结束后会出现 UI 显示已启用、实际未启动的不一致。
                let runError: string | null = null
                try {
                    const r = newEnabled ? await startServer(server) : await stopServer(server.id)
                    if (r && !r.success) {
                        runError = r.error || (newEnabled ? '启动失败' : '停止失败')
                    }
                } catch (err) {
                    runError = err instanceof Error ? err.message : String(err)
                }
                if (runError) {
                    failedIds.add(server.id)
                    if (!server.id.startsWith('plugin:')) setServerEnabledLocal(server.id, server.enabled)
                    showError({server, errorMessage: runError, action: 'enable'})
                }
            }
            if (servers[0]?.id.startsWith('plugin:')) {
                // 成功项统一置新值；失败项保持回滚后的原值
                setPluginMcpServers(prev => prev.map(s =>
                    failedIds.has(s.id) ? s : {...s, enabled: newEnabled}
                ))
            }
        } finally {
            // 统一清理：无论循环内抛错/提前 return，锁与 busy 反馈都不能残留
            targetIds.forEach(id => inFlightRef.current.delete(id))
            setBusyIds(prev => {
                const next = new Set(prev)
                targetIds.forEach(id => next.delete(id))
                return next
            })
        }
    }, [setServerEnabledLocal, startServer, stopServer, showError])

    // ─── 渲染 ────────────────────────────

    return (
        <>
        <div className="h-full overflow-y-auto p-4 space-y-3 custom-scrollbar">
            {/* Header */}
            <div className="flex items-center justify-between mb-1">
                <h3 className="text-xs font-medium text-gray-600">MCP 服务器</h3>
                <div className="flex items-center gap-1 p-0.5 bg-gray-100 rounded-lg">
                    <button onClick={() => setActiveTab('user')}
                            className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all ${
                                activeTab === 'user' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                            }`} data-name="mcpdialog-button">用户 MCP</button>
                    <button onClick={() => setActiveTab('plugin')}
                            className={`px-3 py-1 text-[10px] font-medium rounded-md transition-all flex items-center gap-1 ${
                                activeTab === 'plugin' ? 'bg-white text-brand-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                            }`} data-name="mcpdialog-plugin-tab-button">
                        插件 MCP
                        {pluginMcpServers.length > 0 && (
                            <span className="px-1 py-0.5 text-[9px] bg-brand-100 text-brand-600 rounded-full">
                                {pluginMcpServers.length}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            {/* 用户 MCP Tab */}
            {activeTab === 'user' && (
                <>
                    <div className="flex items-center gap-2">
                        <button onClick={() => setEditTarget('add')}
                                className="px-2.5 py-1 text-xs text-brand-500 hover:bg-brand-50 rounded-md transition-colors" data-name="mcpdialog-add-server-button">
                            + 添加服务器
                        </button>
                        <button onClick={handleImportFile} disabled={importing}
                                className="px-2.5 py-1 text-xs text-brand-500 hover:bg-brand-50 rounded-md transition-colors flex items-center gap-1 disabled:opacity-50" data-name="mcpdialog-import-config-button">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                            {importing ? '导入中...' : '导入配置'}
                        </button>
                        <button onClick={handleSyncVersions}
                                className="px-2.5 py-1 text-xs text-brand-500 hover:bg-brand-50 rounded-md transition-colors flex items-center gap-1" data-name="mcpdialog-sync-versions-button"
                                title="检测所有 MCP 服务版本">
                            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M21 12a9 9 0 11-6.219-8.56"/>
                            </svg>
                            同步版本
                        </button>
                        {userMcpServers.length > 0 && (
                            <div className="ml-auto flex items-center gap-2">
                                <span className="text-[10px] font-medium text-gray-500">全部开启</span>
                                <Switch checked={userAllEnabled} onChange={() => toggleAll(userMcpServers, userAllEnabled)} />
                            </div>
                        )}
                    </div>

                    {importResult && (
                        <div className={`p-2 rounded-lg text-[10px] ${importResult.imported > 0 ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)] border border-[color-mix(in_srgb,var(--success)_30%,transparent)]' : 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] text-[var(--error)] border border-[color-mix(in_srgb,var(--error)_30%,transparent)]'}`}>
                            {importResult.imported > 0
                                ? (
                                    <span className="flex items-center gap-1">
                                        <SuccessIcon className="w-3.5 h-3.5 shrink-0"/>
                                        {`成功导入 ${importResult.imported} 个 MCP 服务器${importResult.skipped > 0 ? `，${importResult.skipped} 个已跳过（重复）` : ''}`}
                                    </span>
                                )
                                : <div className="font-medium flex items-center gap-1"><RemoveIcon className="w-3.5 h-3.5 shrink-0"/>{importResult.error || '导入失败'}</div>
                            }
                        </div>
                    )}

                    <div className="space-y-2.5">
                        {userMcpServers.length === 0 ? (
                            <div className="p-8 text-center bg-[var(--surface-muted)] rounded-xl border border-dashed border-gray-200">
                                <svg className="w-10 h-10 mx-auto text-[var(--text-secondary)] mb-3" viewBox="0 0 24 24" fill="none"
                                     stroke="currentColor" strokeWidth="1.5">
                                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                                    <line x1="8" y1="21" x2="16" y2="21"/>
                                    <line x1="12" y1="17" x2="12" y2="21"/>
                                </svg>
                                <p className="text-sm text-gray-400 font-medium">暂无 MCP 服务器</p>
                                <p className="text-[11px] text-[var(--text-secondary)] mt-1">点击上方按钮添加 MCP 服务器</p>
                            </div>
                        ) : (
                            userMcpServers.map(server => (
                                <MCPUserServerCard key={server.id} server={server}
                                    busy={busyIds.has(server.id)}
                                    onToggle={() => handleToggle(server.id, server.enabled)}
                                    onEdit={() => setEditTarget(server)}
                                    onDelete={() => handleRemove(server.id)}
                                    onShowTools={() => setToolsModalServer(server)}
                                    onReconnect={() => handleReconnect(server.id, server)}/>
                            ))
                        )}
                    </div>
                </>
            )}

            {/* 插件 MCP Tab */}
            {activeTab === 'plugin' && (
                <div className="space-y-2.5">
                    <div className="p-3 bg-blue-50/50 rounded-lg border border-blue-100">
                        <p className="text-[10px] text-blue-600">插件 MCP 的启用状态跟随插件，禁用插件将自动断开连接</p>
                    </div>
                    {pluginMcpServers.length > 0 && (
                        <div className="flex items-center justify-end gap-2">
                            <span className="text-[10px] font-medium text-gray-500">全部开启</span>
                            <Switch checked={pluginAllEnabled} onChange={() => toggleAll(pluginMcpServers, pluginAllEnabled)} />
                        </div>
                    )}

                    {pluginMcpServers.length === 0 ? (
                        <div className="p-8 text-center bg-[var(--surface-muted)] rounded-xl border border-dashed border-gray-200">
                            <svg className="w-10 h-10 mx-auto text-[var(--text-secondary)] mb-3" viewBox="0 0 24 24" fill="none"
                                 stroke="currentColor" strokeWidth="1.5">
                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                                <line x1="8" y1="21" x2="16" y2="21"/>
                                <line x1="12" y1="17" x2="12" y2="21"/>
                            </svg>
                            <p className="text-sm text-gray-400 font-medium">暂无插件 MCP</p>
                            <p className="text-[11px] text-[var(--text-secondary)] mt-1">安装带有 MCP 服务器的插件</p>
                        </div>
                    ) : (
                        pluginMcpServers.map(server => (
                            <MCPPluginServerCard key={server.id} server={server}
                                busy={busyIds.has(server.id)}
                                onToggle={() => handlePluginToggle(server.id, server.enabled)}
                                onEdit={() => setEditTarget(server)}
                                onShowTools={() => setToolsModalServer(server)}
                                onReconnect={() => handleReconnect(server.id, server)}/>
                        ))
                    )}
                </div>
            )}

            {/* MCP 编辑/添加弹窗 */}
            {editTarget && (
                <MCPEditModal
                    server={editTarget === 'add' ? null : editTarget}
                    onSave={async (data) => {
                        const target = editTarget
                        if (target === 'add') {
                            const newServer = addMCPServer(data as any)
                            if (newServer?.enabled) {
                                // ★ 必须 await 并捕获：启动失败的 Promise 之前被直接丢弃（未捕获 rejection 静默）
                                try {
                                    const r = await window.electronAPI?.mcp?.startServer?.(newServer)
                                    if (r && !r.success) {
                                        showError({server: newServer, errorMessage: r.error || '启动失败', action: 'enable'})
                                    }
                                } catch (err) {
                                    showError({server: newServer, errorMessage: err instanceof Error ? err.message : String(err), action: 'enable'})
                                }
                            }
                        } else if (target.id.startsWith('plugin:')) {
                            // ★ saveServer 的返回值与异常必须检查：写盘失败时不得把
                            //   pluginMcpServers 合并成新值——否则 UI 显示已保存而 mcp.json
                            //   未变（重启后回退到旧配置）。失败走既有 showError 反馈并保留
                            //   编辑弹窗（本地值保持原样）；成功路径逐字不变。
                            let saveResult: { success?: boolean; error?: string } | undefined
                            let saveError: string | null = null
                            try {
                                saveResult = await window.electronAPI?.mcp?.saveServer?.({...target, ...data})
                                if (saveResult && !saveResult.success) {
                                    saveError = saveResult.error || '保存失败'
                                }
                            } catch (err) {
                                saveError = err instanceof Error ? err.message : String(err)
                            }
                            if (saveError) {
                                showError({server: target, errorMessage: saveError, action: 'enable'})
                                return
                            }
                            setPluginMcpServers(prev => prev.map(s =>
                                s.id === target.id ? {...s, ...data} : s
                            ))
                            if (target.status === 'connected') {
                                await stopServer(target.id)
                                await startServer({...target, ...data})
                                syncMcpStatus()
                            }
                        } else {
                            updateMCPServer(target.id, data)
                        }
                        setEditTarget(null)
                    }}
                    onCancel={() => setEditTarget(null)}
                    onTestError={(server, errorMessage) => showError({server, errorMessage, action: 'test'})}
                />
            )}

            <McpErrorOverlay />
            {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast}/>}
        </div>
        {/* 工具浮层渲染为上面 overflow-y-auto 滚动容器的兄弟节点：对齐 AgentsDialog
            预览弹窗的已知正确结构，避免 fixed 遮罩被滚动容器困住而盖不满标题栏 */}
        {toolsModalServer && (
            <MCPToolsOverlay server={toolsModalServer} onClose={() => setToolsModalServer(null)}/>
        )}
        </>
    )
}
