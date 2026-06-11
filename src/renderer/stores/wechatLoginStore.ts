/**
 * wechatLoginStore — 微信扫码登录状态管理
 *
 * 架构说明：
 * 将登录业务逻辑（IPC 调用、状态机、轮询）从 React 组件中抽离到 Zustand store，
 * 使登录状态持久化，不受 React StrictMode 卸载/重挂影响。
 *
 * 与 WeChatLoginPanel 组件的职责边界：
 * ┌─ Store（本文件）────────────────────────────────────────┐
 * │  - IPC 调用：startWechatLogin / checkWechatLogin        │
 * │  - 二维码 SVG 生成                                       │
 * │  - 登录状态机（idle→generating→show_qr→scanning→..）      │
 * │  - 轮询调度（模块级定时器，不依赖组件 ref）                    │
 * └────────────────────────────────────────────────────────┘
 * ┌─ WeChatLoginPanel (UI) ─────────────────────────────────┐
 * │  - 读 store.phase 渲染对应 UI                           │
 * │  - 调用 store.startLogin / cancelLogin                  │
 * │  - 不持有任何 IPC / timer / 异步逻辑                      │
 * └────────────────────────────────────────────────────────┘
 */
import {create} from 'zustand'
import QRCode from 'qrcode'
import {useChannelStore} from './channelStore'

// ── 类型定义 ──

export type LoginPhase = 'idle' | 'generating' | 'show_qr' | 'scanning' | 'confirmed' | 'expired' | 'error'

export interface LoginState {
    phase: LoginPhase
    qrDataUrl: string
    qrUrl: string
    sessionKey: string
    message: string
}

export interface LoginActions {
    startLogin: () => Promise<void>
    cancelLogin: () => Promise<void>
    reset: () => void
}

// ── 模块级轮询定时器（不依赖任何组件 ref） ──

let _pollTimer: ReturnType<typeof setTimeout> | null = null
let _pollActive = false
let _channelPollActive = false

function clearPoll(): void {
    if (_pollTimer !== null) {
        clearTimeout(_pollTimer)
        _pollTimer = null
    }
    _pollActive = false
    _channelPollActive = false
}

function schedulePoll(fn: () => Promise<void>, delayMs: number): void {
    if (_pollActive) clearPoll()
    _pollActive = true
    _pollTimer = setTimeout(async () => {
        try {
            await fn()
        } catch (err) {
            console.warn('[WeChatLogin] poll iteration error:', err)
        }
        // 如果轮询仍然活跃（没有被 cancel 或 reset 中断），递归调度
        if (_pollActive && !_channelPollActive) {
            _pollTimer = setTimeout(fn, delayMs)
        }
    }, delayMs)
}

// ── Store ──

export const useWechatLoginStore = create<LoginState & LoginActions>((set, get) => ({
    phase: 'idle',
    qrDataUrl: '',
    qrUrl: '',
    sessionKey: '',
    message: '',

    startLogin: async () => {
        const api = (window as any).electronAPI?.channel
        clearPoll()
        set({phase: 'generating', qrDataUrl: '', qrUrl: '', sessionKey: '', message: ''})

        try {
            const result: any = await api?.startWechatLogin?.()
            if (!result?.success) throw new Error(result?.error || '登录启动失败')

            // 生成二维码 SVG
            let qrDataUrl = ''
            try {
                const svgStr = await QRCode.toString(result.qrcodeUrl, {type: 'svg', width: 220, margin: 2})
                qrDataUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svgStr)))}`
            } catch (err) {
                console.warn('[WeChatLogin] QR code generation failed, will show URL link', err)
            }

            set({
                phase: 'show_qr',
                qrDataUrl,
                qrUrl: result.qrcodeUrl,
                sessionKey: result.sessionKey,
                message: '请用手机微信扫描二维码',
            })

            // 启动轮询（模块级 timer，不受组件生命周期影响）
            startPolling(result.sessionKey, set)
        } catch (err: any) {
            clearPoll()
            set({phase: 'error', message: err.message || '登录启动失败'})
        }
    },

    cancelLogin: async () => {
        clearPoll()
        const {sessionKey} = get()
        if (sessionKey) {
            const api = (window as any).electronAPI?.channel
            await api?.cancelWechatLogin?.(sessionKey)
        }
        set({phase: 'idle', qrDataUrl: '', qrUrl: '', sessionKey: '', message: ''})
    },

    reset: () => {
        clearPoll()
        set({phase: 'idle', qrDataUrl: '', qrUrl: '', sessionKey: '', message: ''})
    },
}))

// ── 模块级轮询函数（不绑组件实例） ──

function startPolling(sessionKey: string, set: any): void {
    if (_pollActive) clearPoll()

    schedulePoll(async () => {
        const api = (window as any).electronAPI?.channel
        const {phase: currentPhase} = useWechatLoginStore.getState()

        // 如果已经终止，不再轮询
        if (currentPhase === 'confirmed' || currentPhase === 'expired' || currentPhase === 'error') {
            clearPoll()
            return
        }

        const result: any = await api?.checkWechatLogin?.(sessionKey)
        if (!result) return

        switch (result.status) {
            case 'confirmed':
                set({phase: 'confirmed', message: '登录成功！'})
                // 切换到渠道状态监控轮询（不要 return，等 schedulePoll 的递归逻辑）
                startChannelStatusPoll(set)
                return // 阻止 schedulePoll 继续调度登录轮询

            case 'scaned':
                set((s: LoginState) => ({...s, phase: 'scanning', message: '已扫描，正在验证...'}))
                break

            case 'expired':
                clearPoll()
                set({phase: 'expired', message: result.message || '二维码已过期，请重新扫码'})
                return // 终态，停止轮询

            case 'binded_redirect':
                clearPoll()
                set({phase: 'error', message: result.message || '该账号已在其他平台连接'})
                return // 终态，停止轮询

            // 'wait' → 继续轮询（schedulePoll 会自动调度下一次）
        }
    }, 2000)
}

// ── 渠道状态监控轮询（确认登录后追踪 Worker 连接状态） ──

/**
 * 登录确认后，持续拉取渠道列表直到 WeChat 渠道状态变为 connected 或 error。
 *
 * 架构说明：
 * Worker 连接是异步的（channelManager.connect() 发消息后不等回复），
 * Worker 连接成功后通过 channel-status-changed IPC 通知渲染进程。
 * 但该 IPC 事件渲染进程监听有时序问题（可能在 loadChannels() 之前到达）。
 * 所以用主动轮询兜底：每 2s 拉一次渠道列表，直到看到终态。
 */
function startChannelStatusPoll(set: any): void {
    _channelPollActive = true
    _pollTimer = setTimeout(async function poll() {
        try {
            const store = useChannelStore.getState()
            await store.loadChannels()

            const wechat = store.channels.find((c: any) => c.type === 'wechat')
            if (wechat) {
                if (wechat.status === 'connected') {
                    set({message: '连接成功！'})
                    _channelPollActive = false
                    return
                }
                if (wechat.status === 'error') {
                    set({phase: 'error' as LoginPhase, message: wechat.statusMessage || '连接失败'})
                    _channelPollActive = false
                    return
                }
                if (wechat.status === 'disconnected') {
                    set({phase: 'error' as LoginPhase, message: wechat.statusMessage || '连接已断开'})
                    _channelPollActive = false
                    return
                }
                // 'connecting' → 继续等待
            }
        } catch { /* store 可能尚未加载 */
        }

        if (_channelPollActive) {
            _pollTimer = setTimeout(poll, 2000)
        }
    }, 2000)
}
