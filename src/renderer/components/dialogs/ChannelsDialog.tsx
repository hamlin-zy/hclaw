/**
 * ChannelsDialog — 多渠道接入管理
 *
 * 提供渠道列表、状态监控、配置编辑、扫码登录功能。
 *
 * 个人微信使用 iLink 扫码登录流程：
 * 1. 点击"扫码登录" → IPC 获取二维码 URL
 * 2. 使用 qrcode 库渲染二维码图片
 * 3. 轮询扫码状态 → 用户扫描后自动完成
 */
import React, {useCallback, useEffect, useRef, useState} from 'react'
import {Switch} from '../common/Switch'
import {useChannelStore} from '../../stores/channelStore'
import {FeishuIcon, WeChatIcon} from './ChannelIcons'
import type {ChannelConfig, ChannelType} from '@shared/types'
import type {LoginPhase} from '../../stores/wechatLoginStore'
import {useWechatLoginStore} from '../../stores/wechatLoginStore'

// ─── 内置渠道定义 ──────────────────────────────────────

interface ChannelDef {
    type: ChannelType
    label: string
    icon: React.ReactNode
    description: string
}

const CHANNEL_DEFS: ChannelDef[] = [
    {
        type: 'feishu', label: '飞书', icon: <FeishuIcon size={28}/>,
        description: 'WebSocket 长连接，无需公网服务器',
    },
    {
        type: 'wechat', label: '个人微信', icon: <WeChatIcon size={28}/>,
        description: 'ClawBot iLink 协议，扫码登录',
    },
]

// ─── 状态工具 ──────────────────────────────────────────

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
    connected: {dot: 'bg-[#07C160]', label: '已连接'},
    connecting: {dot: 'bg-[#F59E0B] animate-pulse', label: '连接中'},
    disconnected: {dot: 'bg-[#9CA3AF]', label: '未连接'},
    error: {dot: 'bg-[#EF4444]', label: '错误'},
}

// ─── Toast 提示组件 ──────────────────────────────────

function Toast({message, type, onClose}: { message: string; type: 'success' | 'error'; onClose: () => void }) {
    return (
        <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium
            animate-[fade-in-up_0.2s_ease-out]
            ${type === 'success' ? 'bg-[#10B981] text-white' : 'bg-[#EF4444] text-white'}`}
            onClick={onClose}>
            {type === 'success' ? '✅ ' : '❌ '}{message}
        </div>
    )
}

// ─── 配置面板（非微信渠道） ─────────────────────────────

function ConfigFields({channel, savedConfig, onSave}: {
    channel: ChannelDef
    savedConfig?: Record<string, unknown>
    onSave: (config: Record<string, unknown>) => void
}) {
    const [fields, setFields] = useState<Record<string, string>>(() => {
        const result: Record<string, string> = {}
        if (savedConfig) {
            for (const [k, v] of Object.entries(savedConfig)) result[k] = String(v ?? '')
        }
        return result
    })

    const change = (key: string, value: string) => setFields(prev => ({...prev, [key]: value}))

    const inputFields: Array<{ key: string; label: string; placeholder: string; secret?: boolean }> =
        channel.type === 'feishu'
            ? [{key: 'appId', label: 'App ID', placeholder: '应用唯一标识'},
                {key: 'appSecret', label: 'App Secret', placeholder: '应用密钥', secret: true}]
            : []

    return (
        <div className="space-y-3">
            {inputFields.map(f => (
                <div key={f.key}>
                    <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1.5">{f.label}</label>
                    <input type={f.secret ? 'password' : 'text'} value={fields[f.key] || ''}
                           onChange={e => change(f.key, e.target.value)} placeholder={f.placeholder}
                           className="w-full px-3 py-2 text-xs rounded-lg border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:border-[var(--brand-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--brand-primary)]/20"/>
                </div>
            ))}
            <button onClick={() => {
                const cfg: Record<string, unknown> = {}
                for (const f of inputFields) cfg[f.key] = fields[f.key] || ''
                onSave(cfg)
            }}
                    className="w-full py-2 rounded-lg text-sm font-medium text-white bg-[var(--brand-primary)] hover:bg-[var(--brand-primary-hover)] transition-colors">
                保存配置
            </button>
        </div>
    )
}

// ─── 微信扫码登录组件 ──────────────────────────────────

/**
 * 微信扫码登录面板
 *
 * 架构说明：
 * 本组件只负责 UI 渲染和 action 派发，所有业务逻辑（IPC 调用、二维码生成、轮询状态机）
 * 由 wechatLoginStore 托管。Store 是模块级单例，不受 React StrictMode 卸载/重挂影响。
 *
 * 详见：src/renderer/stores/wechatLoginStore.ts
 */
function WeChatLoginPanel({onConnected}: { onConnected: () => void }) {
    const store = useWechatLoginStore()

    // 登录确认后触发父级回调
    const prevPhaseRef = useRef<LoginPhase>(store.phase)
    useEffect(() => {
        if (store.phase === 'confirmed' && prevPhaseRef.current !== 'confirmed') {
            onConnected()
        }
        prevPhaseRef.current = store.phase
    }, [store.phase, onConnected])

    // 清理：组件最终卸载时重置 store
    useEffect(() => {
        return () => store.reset()
    }, [])

    // ── 各阶段渲染 ──

    if (store.phase === 'idle') {
        return (
            <div className="space-y-3">
                <div className="flex items-center gap-3 p-3 rounded-lg bg-[var(--surface-muted)]">
                    <WeChatIcon size={32}/>
                    <div className="text-xs text-[var(--text-secondary)] leading-relaxed">
                        ClawBot 使用扫码登录方式，无需手动配置密钥。
                        点击下方按钮后，使用手机微信扫描二维码即可完成授权。
                    </div>
                </div>
                <button onClick={store.startLogin}
                        className="w-full py-2.5 rounded-lg text-sm font-medium text-white bg-[#07C160] hover:bg-[#06AD56] transition-colors">
                    扫码登录
                </button>
            </div>
        )
    }

    if (store.phase === 'generating') {
        return (
            <div className="flex flex-col items-center gap-3 py-6">
                <div
                    className="w-8 h-8 border-2 border-[var(--brand-primary)] border-t-transparent rounded-full animate-spin"/>
                <span className="text-xs text-[var(--text-secondary)]">正在生成二维码...</span>
            </div>
        )
    }

    const {phase, qrDataUrl, qrUrl, message} = store

    return (
        <div className="flex flex-col items-center gap-3 py-2">
            {/* 二维码 */}
            {qrDataUrl ? (
                <img src={qrDataUrl} alt="微信扫码登录"
                     className="w-44 h-44 rounded-lg border border-[var(--border)]"/>
            ) : qrUrl ? (
                <div
                    className="w-44 h-44 flex items-center justify-center rounded-lg border border-[var(--border)] bg-white">
                    <a href={qrUrl} target="_blank" rel="noopener noreferrer"
                       className="text-xs text-center px-2 text-[var(--brand-primary)] underline">
                        点击打开二维码链接
                    </a>
                </div>
            ) : null}

            {/* 状态信息 */}
            <div className="flex items-center gap-2 text-xs">
                {phase === 'show_qr' && (
                    <>
                        <div className="w-2 h-2 bg-[#F59E0B] rounded-full animate-pulse"/>
                        <span className="text-[var(--text-secondary)]">等待扫码...</span>
                    </>
                )}
                {phase === 'scanning' && (
                    <>
                        <div className="w-2 h-2 bg-[#07C160] rounded-full animate-pulse"/>
                        <span className="text-[#07C160]">{message}</span>
                    </>
                )}
                {phase === 'confirmed' && (
                    <span className="text-[#07C160] font-medium">{message}</span>
                )}
                {phase === 'expired' && (
                    <span className="text-[var(--error)]">{message}</span>
                )}
                {phase === 'error' && (
                    <span className="text-[var(--error)]">{message}</span>
                )}
            </div>

            {/* 二维码倒计时/有效期提示 */}
            {phase === 'show_qr' && (
                <span className="text-2xs text-[var(--text-muted)]">二维码有效期约 5 分钟，过期后可重新生成</span>
            )}

            {/* 操作按钮 */}
            <div className="flex gap-2 mt-1">
                {(phase === 'show_qr' || phase === 'scanning') && (
                    <>
                        <button onClick={store.cancelLogin}
                                className="px-4 py-1.5 text-xs rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--surface-muted)] transition-colors">
                            取消
                        </button>
                        <button onClick={store.startLogin}
                                className="px-4 py-1.5 text-xs rounded-lg bg-[var(--surface-muted)] text-[var(--text-primary)] hover:bg-[var(--border)] transition-colors">
                            刷新二维码
                        </button>
                    </>
                )}
                {(phase === 'expired' || phase === 'error') && (
                    <button onClick={store.startLogin}
                            className="px-4 py-1.5 text-xs rounded-lg bg-[#07C160] text-white hover:bg-[#06AD56] transition-colors">
                        重新扫码
                    </button>
                )}
            </div>
        </div>
    )
}

// ─── 主组件 ────────────────────────────────────────────

export default function ChannelsDialog() {
    const {channels, loading, loadChannels, create, update, remove} = useChannelStore()
    const [expandedType, setExpandedType] = useState<ChannelType | null>(null)
    const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null)
    const [connecting, setConnecting] = useState<ChannelType | null>(null)
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 清除 toast 定时器
    const clearToast = () => {
        if (toastTimer.current) clearTimeout(toastTimer.current)
        setToast(null)
    }

    useEffect(() => {
        loadChannels()
    }, [loadChannels])

    const getChannel = useCallback((type: ChannelType): ChannelConfig | undefined =>
        channels.find(c => c.type === type), [channels])

    const handleSave = async (def: ChannelDef, config: Record<string, unknown>) => {
        setConnecting(def.type)
        try {
            const existing = getChannel(def.type)
            let result: { success: boolean; error?: string }
            if (existing) {
                result = await update(existing.id, {config})
            } else {
                result = await create(def.type, def.label, config)
            }

            if (result.success) {
                setToast({message: '配置已保存', type: 'success'})
                setTimeout(clearToast, 2000)

                // 保存成功后自动尝试连接（保存到 DB 后自动启动）
                // 注意：ChannelManager 已在应用启动时自动连接 enabled=true 的渠道，
                // 此处通过 startWorker 主动触发连接并监听结果
                const channelId = existing?.id || (result as any).id
                if (channelId) {
                    try {
                        const startResult: any = await (window as any).electronAPI?.channel?.startWorker?.(channelId)
                        if (startResult?.success) {
                            setToast({message: '正在连接...', type: 'success'})
                            setTimeout(clearToast, 2000)
                        } else {
                            setToast({message: `连接失败: ${startResult?.error || '未知错误'}`, type: 'error'})
                            setTimeout(clearToast, 3000)
                        }
                    } catch {
                        // 静默，不影响保存成功提示
                    }
                }
            } else {
                setToast({message: `保存失败: ${result.error || '未知错误'}`, type: 'error'})
                setTimeout(clearToast, 3000)
            }
        } finally {
            setConnecting(null)
        }
    }

    const handleToggle = async (type: ChannelType) => {
        const ch = getChannel(type)
        if (!ch) return
        await update(ch.id, {enabled: !ch.enabled})
    }

    const handleConnected = useCallback(() => {
        // 登录成功后刷新列表
        setTimeout(() => loadChannels(), 500)
    }, [loadChannels])

    return (
        <div className="p-4 space-y-3">
            <p className="text-xs text-[var(--text-muted)]">接入各平台，通过聊天渠道与 Agent 交互</p>

            {CHANNEL_DEFS.map(def => {
                const ch = getChannel(def.type)
                const status = ch?.status || 'disconnected'
                const st = STATUS_STYLE[status] || STATUS_STYLE.disconnected
                const isExpanded = expandedType === def.type
                const isWeChat = def.type === 'wechat'

                return (
                    <div key={def.type}
                         className="rounded-xl border border-[var(--border)] bg-[var(--surface)] overflow-hidden transition-shadow hover:shadow-card">
                        {/* ── 行头 ── */}
                        <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                             onClick={() => setExpandedType(isExpanded ? null : def.type)}>
                            <div className="shrink-0">{def.icon}</div>
                            <div className="flex-1 min-w-0">
                                <div className="text-sm font-medium text-[var(--text-primary)]">{def.label}</div>
                                <div className="text-2xs text-[var(--text-muted)] truncate">{def.description}</div>
                            </div>
                            <div className="flex items-center gap-1.5">
                                <div className={`w-2 h-2 rounded-full ${st.dot}`} aria-hidden="true"/>
                                <span className="text-2xs text-[var(--text-secondary)]">{st.label}</span>
                            </div>
                            {ch && (
                                <div onClick={e => e.stopPropagation()}>
                                    <Switch checked={ch.enabled} onChange={() => handleToggle(def.type)} />
                                </div>
                            )}
                        </div>

                        {/* ── 展开配置面板 ── */}
                        {isExpanded && (
                            <div className="px-4 pb-4 border-t border-[var(--border-muted)] pt-3 space-y-3">
                                {isWeChat ? (
                                    <WeChatLoginPanel onConnected={handleConnected}/>
                                ) : (
                                    <>
                                        <ConfigFields channel={def} savedConfig={ch?.config}
                                                      onSave={config => handleSave(def, config)}/>
                                        {ch && (
                                            <button onClick={() => remove(ch.id)}
                                                    className="text-2xs text-[var(--text-muted)] hover:text-[var(--error)] transition-colors">
                                                删除此渠道配置
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                )
            })}
            {toast && <Toast message={toast.message} type={toast.type} onClose={clearToast}/>}
        </div>
    )
}
