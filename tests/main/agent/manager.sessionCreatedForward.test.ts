/**
 * AgentManager Worker 消息转发回归测试 — session_created 必须透传 handoffFromConvId
 *
 * 背景：session_handoff 工具运行在 Worker 中，session_created 消息经 parentPort
 * 到达主进程后由 createMessageHandler 转发给渲染进程。此前转发时重建 payload
 * 只保留 id/title/workspacePath，丢失 handoffFromConvId，导致交接后新会话
 * 不显示「←前会话」按钮（重启后从 SQLite meta 加载才恢复）。
 */
import {describe, expect, it, vi} from 'vitest'

// ── electron 空壳：manager.impl 仅用 BrowserWindow 类型/null 检查 ──
vi.mock('electron', () => ({
    BrowserWindow: class {},
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
    isSafePath: () => true,
    HCLAW_DIR: '/tmp/hclaw-test',
    getHclawDataDir: () => '/tmp/hclaw-test/data',
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

// 组 C · P1-8：handoff 首启路径需要方案/提供方与 maxTurns 读设置 —— 全部桩掉（不触真实 DB）
vi.mock('@/main/agent/runtimeConfigManager', () => ({
    runtimeConfigManager: {
        getScheme: vi.fn(() => ({id: 's1', name: 'test', roles: []})),
        getProviders: vi.fn(() => []),
        getOverride: vi.fn(() => undefined),
    },
}))
vi.mock('@/main/repositories/sqlite/systemSettingsRepository', () => ({
    systemSettingsRepo: {getJson: vi.fn(() => undefined)},
}))

import {AgentManager} from '@/main/agent/manager.impl'
import type {BrowserWindow} from 'electron'

function makeManagerWithFakeWindow() {
    const manager = new AgentManager()
    const send = vi.fn()
    const fakeWin = {
        isDestroyed: () => false,
        webContents: {send},
    } as unknown as BrowserWindow
    // 绕过 setMainWindow（其内部 setAgentManagerRef 有额外副作用，本测试不需要）
    ;(manager as unknown as { mainWindow: BrowserWindow | null }).mainWindow = fakeWin
    return {manager, send}
}

async function invokeSessionCreated(manager: AgentManager, workerMsg: Record<string, unknown>) {
    const handler = (manager as unknown as {
        createMessageHandler: (convId: string, worker: unknown) => (msg: unknown) => Promise<void>
    }).createMessageHandler('conv-source', {})
    await handler({type: 'session_created', conversationId: '', ...workerMsg})
}

describe('AgentManager createMessageHandler — session_created 转发', () => {
    it('透传 handoffFromConvId 到渲染进程（回归：交接后「←前会话」不显示）', async () => {
        const {manager, send} = makeManagerWithFakeWindow()

        await invokeSessionCreated(manager, {
            convId: 'conv-new',
            title: '交接新会话',
            workspacePath: '/ws',
            handoffFromConvId: 'conv-source',
        })

        expect(send).toHaveBeenCalledWith('session_created', expect.objectContaining({
            id: 'conv-new',
            title: '交接新会话',
            workspacePath: '/ws',
            handoffFromConvId: 'conv-source',
        }))
    })

    it('无来源会话时 handoffFromConvId 为 undefined，不影响其余字段', async () => {
        const {manager, send} = makeManagerWithFakeWindow()

        await invokeSessionCreated(manager, {
            convId: 'conv-new',
            title: '普通新会话',
            workspacePath: '/ws',
        })

        const payload = send.mock.calls[0][1] as Record<string, unknown>
        expect(payload.id).toBe('conv-new')
        expect(payload.handoffFromConvId).toBeUndefined()
    })
})

/**
 * 组 C · P1-8：handoff 新会话首启请求体字节确定
 *
 * 契约：`session_handoff` 工具构造的首条 user content（`/${skill}\n${handoffSummary}`，
 * 见 sessionHandoffTool.ts:143）经 worker → 主进程 `session_handoff_start` →
 * `AgentManager.startHandoffSession` → `this.start`，**全程逐字节透传**：
 * manager 不得注入日期 / 毫秒时间戳 / 相对时间词 —— 任何一处注入都会让
 * 「同参数两次交接」产生不同首轮请求体，跨会话的前缀缓存（系统提示 + 工具 + 历史）
 * 在同一个「交接模板」下不再可复用。
 *
 * 判别力：
 * - 若 manager 侧改为 `content: decorate(msg.messages[0].content)`（加时间戳等）→ 用例红；
 * - 反例对照（第二段）证明本文件使用的护栏正则确有判别力（对带日期的输入必然命中）。
 */
describe('AgentManager session_handoff_start — 首条 user content 字节确定', () => {
    /** 驱动 messageHandler 的 handoff 分支，返回 this.start 收到的一次参数 */
    async function startHandoff(manager: AgentManager, content: string) {
        const startSpy = vi.spyOn(manager as unknown as {start: (p: unknown) => Promise<void>}, 'start')
            .mockResolvedValue(undefined)
        try {
            await invokeSessionCreated(manager, {
                type: 'session_handoff_start',
                convId: 'conv-handoff',
                title: '交接新会话',
                messages: [{id: 'msg-1', role: 'user', content}],
                workingDir: '/ws',
            })
            return startSpy.mock.calls[0]![0] as {messages: Array<{role: string; content: string; id: string}>}
        } finally {
            startSpy.mockRestore()
        }
    }

    const handoffSummary = '## 交接总结\n- 已完成：修复前缀缓存断裂\n- 待办：补回归测试'

    it('首条 user content 逐字节透传，不含日期 / 毫秒时间戳 / 相对时间词', async () => {
        const {manager} = makeManagerWithFakeWindow()
        const params = await startHandoff(manager, `/brainstorming\n${handoffSummary}`)

        expect(params.messages).toHaveLength(1)
        expect(params.messages[0].role).toBe('user')
        expect(params.messages[0].content).toBe(`/brainstorming\n${handoffSummary}`)
        expect(params.messages[0].content).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(params.messages[0].content).not.toMatch(/\b1[0-9]{12}\b/)
        expect(params.messages[0].content).not.toMatch(/刚刚|今天|昨天|上周/)
        // 首条 user 的 id 与工具侧预置一致（不因 manager 侧重建而漂移）
        expect(params.messages[0].id).toBe('msg-1')
    })

    it('同参数两次 handoff → 首轮 messages 序列化完全相等（无隐藏时间注入）', async () => {
        const a = await startHandoff(makeManagerWithFakeWindow().manager, `/brainstorming\n${handoffSummary}`)
        const b = await startHandoff(makeManagerWithFakeWindow().manager, `/brainstorming\n${handoffSummary}`)
        expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
    })

    it('护栏判别力对照：同一组正则对含日期/相对时间词的输入必然命中（证明断言非恒真）', () => {
        const DATE_RE = /\d{4}-\d{2}-\d{2}/
        const EPOCH_MS_RE = /\b1[0-9]{12}\b/
        const RELATIVE_RE = /刚刚|今天|昨天|上周/
        // 反例：人为把日期/毫秒戳/相对时间写进交接总结
        const dirty = `## 交接总结（2026-09-22）\n刚刚完成 x，昨天完成 y，ts=${Date.now()}`
        expect(DATE_RE.test(dirty)).toBe(true)
        expect(EPOCH_MS_RE.test(dirty)).toBe(true)
        expect(RELATIVE_RE.test(dirty)).toBe(true)
        // 干净文本三者全不命中（与上面的"必然命中"构成判别力对照）
        expect(DATE_RE.test(handoffSummary)).toBe(false)
        expect(EPOCH_MS_RE.test(handoffSummary)).toBe(false)
        expect(RELATIVE_RE.test(handoffSummary)).toBe(false)
    })
})
