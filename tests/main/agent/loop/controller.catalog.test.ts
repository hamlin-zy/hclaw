/**
 * Task 3：能力目录 pre-step 追加式 测试（新 decidePublish 契约）
 *
 * 覆盖：
 * 1. 首轮发布一条 capability-catalog user 消息
 * 2. digest 未变时不重复添加
 * 3. 目录变更后追加第二条 catalog 消息（旧消息内容不变，最后一条生效）
 * 4. 恢复会话：预置带 metadata 的 catalog 消息后首轮零操作
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {randomUUID} from 'crypto'

vi.mock('../../../../src/main/agent/skills/catalogInjector', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../../src/main/agent/skills/catalogInjector')>()
    return {
        ...actual,
        collectCatalogSnapshot: vi.fn(() => ({entries: ENTRIES_MOCK.current(), complete: true})),
    }
})

import {
    restoreCatalogState,
    runCatalogPreStep,
    type CatalogState,
} from '../../../../src/main/agent/loop/catalogPublish'
import type {CatalogEntry} from '@shared/types/message'
import {SOURCE_KIND_CATALOG} from '@shared/types/message'
import {computeDigest} from '../../../../src/main/agent/skills/catalogInjector'
import {createLoopState} from '../../../../src/main/agent/state'
import type {IConversationRepository} from '../../../../src/main/repositories/interfaces'

/** 可变条目源：测试用例间通过它切换目录内容，模拟"技能启用"等变化 */
const ENTRIES_MOCK: {current: () => CatalogEntry[]} = {
    current: () => [
        {name: 'skill-a', type: 'skill', description: 'desc-a'},
    ],
}

function makeRepoMock() {
    return {
        writeMessagesDelta: vi.fn(() => true),
    } as unknown as IConversationRepository & {writeMessagesDelta: ReturnType<typeof vi.fn>}
}

let repo: ReturnType<typeof makeRepoMock>

beforeEach(() => {
    repo = makeRepoMock()
    ENTRIES_MOCK.current = () => [{name: 'skill-a', type: 'skill', description: 'desc-a'}]
})

describe('能力目录 pre-step（catalogPublish）', () => {
    it('首轮发布一条 capability-catalog user 消息', () => {
        const state = createLoopState([])
        const cs: CatalogState = {incompleteStreak: 0}
        const {state: next} = runCatalogPreStep(state, cs, repo, 'conv-1', false)

        const catalogMsgs = next.messages.filter(m => m.role === 'user' && m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogMsgs.length).toBe(1)
        expect(String(catalogMsgs[0].content)).toContain('skill-a')
        // 持久化调用一次（sessionId 非空）
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(1)
    })

    it('digest 未变时不重复添加', () => {
        let state = createLoopState([])
        let cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        state = r1.state
        cs = r1.catalogState

        // 第二轮：目录未变
        const r2 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        const count = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG).length
        expect(count).toBe(1)
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(1) // 仅首轮写库
    })

    it('目录变更后追加第二条 catalog 消息（旧消息内容不变，最后一条生效）', () => {
        let state = createLoopState([])
        let cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        state = r1.state
        cs = r1.catalogState
        const first = state.messages.find(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)!
        const firstContent = first.content

        // 目录变化：新增技能 b → 追加新消息
        ENTRIES_MOCK.current = () => [
            {name: 'skill-a', type: 'skill', description: 'desc-a'},
            {name: 'skill-b', type: 'skill', description: 'desc-b'},
        ]
        const r2 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        const catalogMsgs = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogMsgs.length).toBe(2)
        // 旧消息逐字节不变
        expect(catalogMsgs[0].id).toBe(first.id)
        expect(catalogMsgs[0].content).toBe(firstContent)
        // 新消息包含新技能名
        expect(String(catalogMsgs[1].content)).toContain('skill-b')
        expect(catalogMsgs[1].id).not.toBe(first.id)
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(2)
        // 第二次写库为新消息 id（追加新行）
        expect((repo.writeMessagesDelta as ReturnType<typeof vi.fn>).mock.calls[1][1].id).toBe(catalogMsgs[1].id)
    })

    it('恢复会话：预置带 metadata 的 catalog 消息后首轮零操作', () => {
        const presetMsg = {
            id: randomUUID(),
            role: 'user' as const,
            content: '<system-reminder>catalog</system-reminder>',
            timestamp: Date.now(),
            metadata: {
                sourceKind: SOURCE_KIND_CATALOG,
                catalogEntries: [{name: 'skill-a', type: 'skill' as const, description: 'desc-a'}],
                catalogDigest: undefined as string | undefined,
            },
        }
        presetMsg.metadata.catalogDigest = computeDigest({mode: 'names', entries: ENTRIES_MOCK.current()})

        const state = createLoopState([presetMsg])
        const cs = restoreCatalogState(state.messages)
        expect(cs.lastDigest).toBe(presetMsg.metadata.catalogDigest)
        expect(cs.incompleteStreak).toBe(0)

        const r = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        expect(r.state.messages.length).toBe(1)
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
    })

    it('sessionId 为空（conversationRepo null）时仅更新内存态', () => {
        const state = createLoopState([])
        const cs: CatalogState = {incompleteStreak: 0}
        const r = runCatalogPreStep(state, cs, null, undefined, false)
        const count = r.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG).length
        expect(count).toBe(1)
    })

    it('mode 切换（fullDescriptions 变化）触发追加新消息且格式对应', () => {
        let state = createLoopState([])
        let cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        state = r1.state
        cs = r1.catalogState

        const r2 = runCatalogPreStep(state, cs, repo, 'conv-1', true)
        const catalogMsgs = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogMsgs.length).toBe(2)
        expect(String(catalogMsgs[1].content)).toContain('- [skill]')
    })
})
