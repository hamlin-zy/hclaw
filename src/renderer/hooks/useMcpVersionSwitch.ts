import {useState, useCallback, useEffect} from 'react'
import {confirm} from '../components/ConfirmDialog'
import type {MCPServer} from '@shared/types'

type ToastType = 'success' | 'error' | 'info'

/**
 * 派发 `hclaw:show-toast` CustomEvent（MCPDialog 等监听方弹 toast）。
 * duration 缺省 5000ms。
 */
export function showToast(type: ToastType, message: string, duration = 5000): void {
    window.dispatchEvent(new CustomEvent('hclaw:show-toast', {
        detail: {type, message, duration},
    }))
}

/**
 * MCP 版本切换共享逻辑（MCPUserServerCard / MCPPluginServerCard 共用）：
 *   - availableVersions：versionMeta 升序列表反转（最新在上）
 *   - switching + handleVersionSwitch：confirm → switchVersion → toast
 */
export function useMcpVersionSwitch(
    server: Pick<MCPServer, 'id' | 'name'>,
    versionMeta?: {current?: string | null; availableVersions?: string[]} | null,
) {
    const [availableVersions, setAvailableVersions] = useState<string[]>([])
    const [switching, setSwitching] = useState(false)

    // Load available versions when versionMeta is available
    // 主进程按 compareVersionAsc 升序返回；UI 侧反转 → 最新在上
    useEffect(() => {
        if (!versionMeta?.availableVersions?.length) return
        setAvailableVersions([...versionMeta.availableVersions].reverse())
    }, [versionMeta?.availableVersions])

    const handleVersionSwitch = useCallback(async (targetVersion: string) => {
        if (targetVersion === versionMeta?.current) return
        setSwitching(true)
        try {
            await confirm({
                title: '切换版本',
                message: `确认将 ${server.name} 切换到版本 ${targetVersion}？此操作将重启 MCP 服务。`,
                confirmText: '切换',
                confirmVariant: 'warning',
                onConfirm: async () => {
                    let result: {success: boolean, error?: string} | undefined
                    try {
                        result = await window.electronAPI?.mcp?.switchVersion?.(server.id, targetVersion)
                    } catch (err: any) {
                        result = {success: false, error: err?.message || '未知错误'}
                    }
                    if (!result?.success) {
                        showToast('error', `切换失败: ${result?.error || '未知错误'}`, 5000)
                    } else {
                        showToast('success', `已切换到 ${targetVersion}`, 3000)
                    }
                },
            })
        } finally {
            setSwitching(false)
        }
    }, [server.id, server.name, versionMeta?.current])

    return {availableVersions, switching, handleVersionSwitch}
}
