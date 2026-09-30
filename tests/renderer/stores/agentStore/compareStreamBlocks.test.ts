// @vitest-environment jsdom
/**
 * compareStreamBlocks 比较器纯函数单测 — 锁死 tie-break 语义（防未来改 comparator 漏站点）
 *
 * 比较器现为渲染端 流式重建（contentBlocks.assembleContentBlocks）/ done 收尾
 * （streamInteraction.handleDone）/ abort 收尾（abortAgent.abortAgentImpl）
 * 三条路径的唯一事实源，并与主进程落库排序（childConvMessages.buildCurrentMessage）同款。
 * 本测试不触达 store，仅验证 comparator 自身语义；mock 与 contentBlocks.offsetTieBreak.test.ts
 * 同构（防止模块图加载副作用）。
 *
 * 判别力口径：
 * - 「timestamp 全序优先」实现（先比 timestamp）→ 用例 4 中 C(ts=0) 排首，fail；
 * - 「仅按 textOffset 稳定排序」旧实现 → 用例 4 输入序 A,B,C 原样保留（B,A 未换序），fail；
 * - 正确语义（offset 升序，同 offset 按 timestamp 升序）→ 全部 pass。
 */
import {describe, it, expect, vi} from 'vitest'

vi.mock('../../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: {
        getState: () => ({convAgentStates: {}}),
    },
}))
vi.mock('../../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: {
        getState: () => ({messagesMap: {}, activeConversationId: null}),
    },
}))
vi.mock('../../../../src/renderer/stores/agentStore/batching/toolResultBatch', () => ({
    getToolResultBatchMap: () => ({}),
    flushToolResultBatch: vi.fn(),
}))

// 导出在 vi.mock 声明之后引用（vitest 对 vi.mock 自动 hoist，先于模块加载生效）
import {compareStreamBlocks} from '../../../../src/renderer/stores/agentStore/contentBlocks'

interface B {
    id: string
    textOffset: number
    timestamp: number
}
const ids = (arr: B[]) => arr.map(b => b.id)

describe('compareStreamBlocks 比较器语义', () => {
    it('同 textOffset：timestamp 升序判序（输入序故意与 timestamp 相反）', () => {
        const input: B[] = [
            {id: 'b', textOffset: 0, timestamp: 200},
            {id: 'a', textOffset: 0, timestamp: 100},
        ]
        expect(ids([...input].sort(compareStreamBlocks))).toEqual(['a', 'b'])
        // 直接断言符号：同 offset 下 timestamp 小的在前（小 ts → 大 ts 为负，反向为正）
        expect(compareStreamBlocks(input[1], input[0])).toBeLessThan(0)
        expect(compareStreamBlocks(input[0], input[1])).toBeGreaterThan(0)
    })

    it('textOffset 不同：timestamp 不参与排序（timestamp 反向相关仍按 offset 序）', () => {
        // C 的 timestamp 最小（0）但 offset 最大（5）→ 必须排在 offset 0 的 B 之后
        const input: B[] = [
            {id: 'A', textOffset: 5, timestamp: 100},
            {id: 'B', textOffset: 0, timestamp: 900},
        ]
        expect(ids([...input].sort(compareStreamBlocks))).toEqual(['B', 'A'])
    })

    it('同 textOffset 且同 timestamp：保持输入稳定序（返回 0 不换位）', () => {
        const input: B[] = [
            {id: 'x', textOffset: 3, timestamp: 42},
            {id: 'y', textOffset: 3, timestamp: 42},
        ]
        expect(compareStreamBlocks(input[0], input[1])).toBe(0)
        expect(ids([...input].sort(compareStreamBlocks))).toEqual(['x', 'y'])
    })

    it('多级混合序：先 offset 后 timestamp（判别力：全序优先 / 仅 offset 稳定序两实现均 fail）', () => {
        const input: B[] = [
            {id: 'A', textOffset: 0, timestamp: 300},
            {id: 'B', textOffset: 0, timestamp: 100},
            {id: 'C', textOffset: 5, timestamp: 0},
        ]
        // 正确语义：B(0,100) < A(0,300) < C(5,0)
        // 「timestamp 全序优先」→ C 排首；「仅 offset 稳定」→ 输入序 A,B,C；均 fail
        expect(ids([...input].sort(compareStreamBlocks))).toEqual(['B', 'A', 'C'])
    })
})
