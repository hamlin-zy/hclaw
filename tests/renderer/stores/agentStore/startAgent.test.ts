// @vitest-environment jsdom
/**
 * startAgent — force 旁路回归测试
 *
 * 背景：PM 窗口「发送到会话」由 sendToConversation 执行器以主进程 agentStatus 判定
 * 目标会话是否在运行；若判定为非运行则调用 startAgent 启动 loop。但渲染端
 * convAgentStates 可能残留 paused（/thinking/running）状态，旧守卫会静默 no-op，
 * 导致 user 消息只进内存、agent 永不启动。
 *
 * 修复：给 startAgent 增加可选 force 旁路（仅执行器使用），保持 InputArea /
 * MessageActions 等普通调用点在残留状态下行为完全不变。
 *
 * 本文件直接测试真实 startAgentImpl（不经 store 包装），只 mock 掉其外部依赖。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

// ── 依赖 mock：conversationStore / convHelpers（避免拉起整棵 store 依赖树） ──
const convMock = vi.hoisted(() => ({
    messagesMap: {} as Record<string, any>,
    updateMessageForConv: vi.fn(),
}))
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {getState: () => convMock},
    flatString: (s: string) => s,
}))
vi.mock('../../../../src/renderer/stores/agentStore/helpers/convHelpers', () => ({
    clearAllBatches: vi.fn(),
}))

import {startAgentImpl} from '../../../../src/renderer/stores/agentStore/handlers/startAgent'
import {createDefaultConvData, IDLE_STATE} from '../../../../src/renderer/stores/agentStore/defaultState'

const CONV = 'conv-1'

/** 构造最小 store 替身：只保留 startAgentImpl 实际使用的 get/updateConvData */
function makeStore(status: string) {
    const store: any = {
        convAgentStates: {
            [CONV]: {...createDefaultConvData(), agentState: {...IDLE_STATE, status}},
        },
        updateConvData: (convId: string, updates: any) => {
            const prev = store.convAgentStates[convId] || createDefaultConvData()
            store.convAgentStates = {...store.convAgentStates, [convId]: {...prev, ...updates}}
        },
    }
    const get = () => store
    const set = vi.fn()
    return {store, get, set}
}

beforeEach(() => {
    convMock.messagesMap = {}
    convMock.updateMessageForConv.mockClear()
})

describe('startAgent — force 旁路', () => {
    it('paused 残留 + force:true ⇒ 真实调用 electronAPI.agentStart（复现 PM 发送 bug）', async () => {
        const {get, set} = makeStore('paused')
        const agentStart = vi.fn(async () => ({success: true}))
        ;(window as any).electronAPI = {agentStart}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi', force: true} as any)

        expect(agentStart).toHaveBeenCalledTimes(1)
        expect(agentStart).toHaveBeenCalledWith(expect.objectContaining({conversationId: CONV, message: 'hi'}))
    })

    it('thinking 残留 + force:true ⇒ 真实调用 electronAPI.agentStart', async () => {
        const {get, set} = makeStore('thinking')
        const agentStart = vi.fn(async () => ({success: true}))
        ;(window as any).electronAPI = {agentStart}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi', force: true} as any)

        expect(agentStart).toHaveBeenCalledTimes(1)
    })

    it('running + 无 force ⇒ 不调用（防重启正在跑的 loop / 兼容普通调用点）', async () => {
        const {get, set} = makeStore('running')
        const agentStart = vi.fn(async () => ({success: true}))
        ;(window as any).electronAPI = {agentStart}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi'} as any)

        expect(agentStart).not.toHaveBeenCalled()
    })

    it('paused + 无 force ⇒ 不调用（普通调用点行为不变）', async () => {
        const {get, set} = makeStore('paused')
        const agentStart = vi.fn(async () => ({success: true}))
        ;(window as any).electronAPI = {agentStart}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi'} as any)

        expect(agentStart).not.toHaveBeenCalled()
    })
})

describe('startAgent — 启动失败兜底置 error', () => {
    it('electronAPI.agentStart 缺失 ⇒ 状态为 error 而非 thinking', async () => {
        const {get, set, store} = makeStore('idle')
        ;(window as any).electronAPI = {}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi', force: true} as any)

        expect(store.convAgentStates[CONV].agentState.status).toBe('error')
        expect(store.convAgentStates[CONV].errorMessage).toBeTruthy()
    })

    it('agentStart 返回 undefined ⇒ 状态为 error', async () => {
        const {get, set, store} = makeStore('idle')
        ;(window as any).electronAPI = {agentStart: vi.fn(async () => undefined)}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi', force: true} as any)

        expect(store.convAgentStates[CONV].agentState.status).toBe('error')
    })

    it('agentStart 返回 {success:false} ⇒ 状态为 error 且保留 errorMessage', async () => {
        const {get, set, store} = makeStore('idle')
        ;(window as any).electronAPI = {agentStart: vi.fn(async () => ({success: false, error: 'boom'}))}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi', force: true} as any)

        expect(store.convAgentStates[CONV].agentState.status).toBe('error')
        expect(store.convAgentStates[CONV].errorMessage).toBe('boom')
    })

    it('成功路径不受影响 ⇒ 状态保持 running/thinking（不误置 error）', async () => {
        const {get, set, store} = makeStore('idle')
        ;(window as any).electronAPI = {agentStart: vi.fn(async () => ({success: true}))}

        await startAgentImpl(set, get, {conversationId: CONV, message: 'hi', force: true} as any)

        expect(store.convAgentStates[CONV].agentState.status).toBe('thinking')
        expect(store.convAgentStates[CONV].errorMessage).toBeNull()
    })
})
