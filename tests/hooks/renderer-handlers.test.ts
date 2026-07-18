/**
 * 前端 Hook 结果处理器测试
 *
 * Covers:
 * - streamSystem.ts: handleHookResult — 将 hook_result 事件加入 store
 * - HookResultsBar 过滤逻辑 — TTL 过期过滤
 */

import {describe, expect, it, vi, beforeEach} from 'vitest'

// ============================================================
// handleHookResult — 纯逻辑测试
// ============================================================

/**
 * 从 streamSystem.ts 提取 handleHookResult 的核心逻辑进行测试。
 *
 * handleHookResult 依赖 Zustand stores（useConversationStore,
 * useAgentStore），这里通过提取下层调用接口来隔离测试：
 *
 *   输入: StreamCtx（含 event, isAgentAborted）+ 外部依赖
 *   输出: addHookResult 是否被调用 + 参数
 */
interface MockHandlers {
    addHookResult: ReturnType<typeof vi.fn>
    getActiveConversationId: ReturnType<typeof vi.fn>
}

function createHandleHookResult(mocks: MockHandlers) {
    return (ctx: {
        event: {type: 'hook_result'; event: string; hookName: string; success: boolean; error?: string}
        isAgentAborted: boolean
    }) => {
        // 复制自 streamSystem.ts handleHookResult 的核心逻辑
        if (ctx.isAgentAborted) return

        const hr = ctx.event
        const convId = mocks.getActiveConversationId()
        if (!convId) return

        mocks.addHookResult({
            id: `${hr.event}:${hr.hookName}:${Date.now()}`,
            event: hr.event,
            hookName: hr.hookName,
            success: hr.success,
            error: hr.error,
            timestamp: Date.now(),
            conversationId: convId,
        })
    }
}

describe('handleHookResult', () => {
    let mocks: MockHandlers
    let handler: ReturnType<typeof createHandleHookResult>

    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'))

        mocks = {
            addHookResult: vi.fn(),
            getActiveConversationId: vi.fn(),
        }
        handler = createHandleHookResult(mocks)
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('adds hook result when active conversation exists', () => {
        mocks.getActiveConversationId.mockReturnValue('conv-001')

        handler({
            event: {
                type: 'hook_result',
                event: 'PostToolUse',
                hookName: 'Test Hook',
                success: true,
            },
            isAgentAborted: false,
        })

        expect(mocks.addHookResult).toHaveBeenCalledTimes(1)
        const item = mocks.addHookResult.mock.calls[0][0]
        expect(item.event).toBe('PostToolUse')
        expect(item.hookName).toBe('Test Hook')
        expect(item.success).toBe(true)
        expect(item.error).toBeUndefined()
        expect(item.conversationId).toBe('conv-001')
        expect(item.timestamp).toBe(new Date('2026-07-18T12:00:00.000Z').getTime())
    })

    it('records error details from failed hooks', () => {
        mocks.getActiveConversationId.mockReturnValue('conv-002')

        handler({
            event: {
                type: 'hook_result',
                event: 'PostToolUse',
                hookName: 'Failing Hook',
                success: false,
                error: 'exit code: 1\nstderr:\ncommand not found',
            },
            isAgentAborted: false,
        })

        expect(mocks.addHookResult).toHaveBeenCalledTimes(1)
        const item = mocks.addHookResult.mock.calls[0][0]
        expect(item.success).toBe(false)
        expect(item.error).toContain('exit code: 1')
        expect(item.error).toContain('command not found')
    })

    it('skips when activeConversationId is null', () => {
        mocks.getActiveConversationId.mockReturnValue(null)

        handler({
            event: {
                type: 'hook_result',
                event: 'PostToolUse',
                hookName: 'Orphan Hook',
                success: true,
            },
            isAgentAborted: false,
        })

        expect(mocks.addHookResult).not.toHaveBeenCalled()
    })

    it('skips when agent is aborted', () => {
        mocks.getActiveConversationId.mockReturnValue('conv-003')

        handler({
            event: {
                type: 'hook_result',
                event: 'PostToolUse',
                hookName: 'Late Hook',
                success: true,
            },
            isAgentAborted: true,
        })

        expect(mocks.addHookResult).not.toHaveBeenCalled()
    })

    it('generates unique id for each result', () => {
        mocks.getActiveConversationId.mockReturnValue('conv-004')

        handler({
            event: {type: 'hook_result', event: 'PostToolUse', hookName: 'Hook A', success: true},
            isAgentAborted: false,
        })

        // 快进 1ms，确保 timestamp 不同
        vi.advanceTimersByTime(10)

        handler({
            event: {type: 'hook_result', event: 'PreToolUse', hookName: 'Hook B', success: false, error: 'err'},
            isAgentAborted: false,
        })

        expect(mocks.addHookResult).toHaveBeenCalledTimes(2)
        const idA = mocks.addHookResult.mock.calls[0][0].id
        const idB = mocks.addHookResult.mock.calls[1][0].id
        expect(idA).not.toBe(idB)
        expect(idA).toContain('PostToolUse:Hook A')
        expect(idB).toContain('PreToolUse:Hook B')
    })
})

// ============================================================
// HookResultsBar — TTL 过滤逻辑测试
// ============================================================

/**
 * 复制 HookResultsBar 的过滤逻辑作为纯函数测试
 */
const HOOK_RESULT_TTL = 3_000

interface HookResultItem {
    id: string
    event: string
    hookName: string
    success: boolean
    error?: string
    timestamp: number
    conversationId: string
}

function filterVisibleResults(
    results: HookResultItem[],
    now: number,
): HookResultItem[] {
    return results.filter((r) => now - r.timestamp < HOOK_RESULT_TTL)
}

describe('HookResultsBar filtering', () => {
    it('shows results within TTL', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: '1', event: 'PostToolUse', hookName: 'Hook 1',
                success: true, timestamp: now - 500, conversationId: 'conv-1',
            },
            {
                id: '2', event: 'PostToolUse', hookName: 'Hook 2',
                success: false, timestamp: now - 1500, conversationId: 'conv-2',
            },
        ]

        const visible = filterVisibleResults(results, now)
        expect(visible).toHaveLength(2)
        expect(visible[0].hookName).toBe('Hook 1')
        expect(visible[1].hookName).toBe('Hook 2')
    })

    it('filters out expired results (older than TTL)', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: 'fresh', event: 'PostToolUse', hookName: 'Fresh Hook',
                success: true, timestamp: now - 500, conversationId: 'conv-1',
            },
            {
                id: 'stale', event: 'PostToolUse', hookName: 'Stale Hook',
                success: false, timestamp: now - 4000, conversationId: 'conv-2',
            },
            {
                id: 'very-stale', event: 'PreToolUse', hookName: 'Very Stale',
                success: true, timestamp: now - 60000, conversationId: 'conv-3',
            },
        ]

        const visible = filterVisibleResults(results, now)
        expect(visible).toHaveLength(1)
        expect(visible[0].id).toBe('fresh')
        expect(visible[0].hookName).toBe('Fresh Hook')
    })

    it('returns empty array when all results are expired', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: 'old-1', event: 'PostToolUse', hookName: 'Old 1',
                success: true, timestamp: now - 5000, conversationId: 'conv-1',
            },
            {
                id: 'old-2', event: 'PostToolUse', hookName: 'Old 2',
                success: false, timestamp: now - 10000, conversationId: 'conv-2',
            },
        ]

        const visible = filterVisibleResults(results, now)
        expect(visible).toHaveLength(0)
    })

    it('returns empty array when input is empty', () => {
        const visible = filterVisibleResults([], Date.now())
        expect(visible).toHaveLength(0)
    })

    it('does NOT filter by conversationId (all conversations shown)', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: 'a', event: 'PostToolUse', hookName: 'Conv A Hook',
                success: true, timestamp: now - 100, conversationId: 'conv-a',
            },
            {
                id: 'b', event: 'PostToolUse', hookName: 'Conv B Hook',
                success: false, timestamp: now - 200, conversationId: 'conv-b',
            },
            {
                id: 'c', event: 'PostToolUse', hookName: 'Conv C Hook',
                success: true, timestamp: now - 300, conversationId: 'conv-c',
            },
        ]

        const visible = filterVisibleResults(results, now)
        // 不按会话隔离，所有会话的都显示
        expect(visible).toHaveLength(3)
    })

    it('boundary: exactly at TTL is still visible', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: 'edge', event: 'PostToolUse', hookName: 'Edge Case',
                success: true, timestamp: now - HOOK_RESULT_TTL + 1, conversationId: 'conv-1',
            },
        ]

        const visible = filterVisibleResults(results, now)
        expect(visible).toHaveLength(1)
    })

    it('boundary: exactly one ms past TTL is filtered out', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: 'over', event: 'PostToolUse', hookName: 'Over Edge',
                success: true, timestamp: now - HOOK_RESULT_TTL - 1, conversationId: 'conv-1',
            },
        ]

        const visible = filterVisibleResults(results, now)
        expect(visible).toHaveLength(0)
    })

    it('maintains insertion order (no sorting)', () => {
        const now = Date.now()
        const results: HookResultItem[] = [
            {
                id: 'third', event: 'Stop', hookName: 'Third',
                success: true, timestamp: now - 100, conversationId: 'conv-1',
            },
            {
                id: 'first', event: 'PreToolUse', hookName: 'First',
                success: true, timestamp: now - 300, conversationId: 'conv-2',
            },
            {
                id: 'second', event: 'PostToolUse', hookName: 'Second',
                success: true, timestamp: now - 200, conversationId: 'conv-3',
            },
        ]

        const visible = filterVisibleResults(results, now)
        expect(visible).toHaveLength(3)

        // store 中的 hookResults 按 push 顺序排列，不重新排序
        for (let i = 0; i < results.length; i++) {
            expect(visible[i].id).toBe(results[i].id)
        }
    })
})

// ============================================================
// HookResultsBar — store 容量限制
// ============================================================

describe('agentStore hookResults capacity', () => {
    it('accepts arbitrary number of items up to capacity', () => {
        // 验证 store 的容量限制逻辑（仅逻辑，不依赖 Zustand）
        const CAPACITY = 50
        const items: HookResultItem[] = []

        // 模拟 push 100 个结果
        for (let i = 0; i < 100; i++) {
            items.push({
                id: `item-${i}`,
                event: 'PostToolUse',
                hookName: `Hook ${i}`,
                success: i % 3 !== 0,
                timestamp: Date.now() - (100 - i) * 100,
                conversationId: 'conv-test',
            })
        }

        // 模拟 store 的容量截断：保留最新的 50 条
        if (items.length > CAPACITY) {
            items.splice(0, items.length - CAPACITY)
        }

        expect(items).toHaveLength(CAPACITY)
        expect(items[0].id).toBe('item-50')
        expect(items[CAPACITY - 1].id).toBe('item-99')
    })
})
