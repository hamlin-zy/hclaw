/**
 * Task 5：能力目录 pre-step 发布与原地替换 测试（新 decidePublish 契约）
 *
 * 覆盖：
 * 1. 首轮发布一条 capability-catalog user 消息
 * 2. digest 未变时不重复添加
 * 3. 技能启用后原消息被替换且不产生第二条（update-by-id）
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
import {logger} from '../../../../src/main/agent/logger'
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

    it('技能启用后原消息被替换且不产生第二条（update-by-id）', () => {
        let state = createLoopState([])
        let cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        state = r1.state
        cs = r1.catalogState
        const firstId = state.messages.find(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)?.id

        // 目录变化：新增技能 b
        ENTRIES_MOCK.current = () => [
            {name: 'skill-a', type: 'skill', description: 'desc-a'},
            {name: 'skill-b', type: 'skill', description: 'desc-b'},
        ]
        const r2 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        const catalogMsgs = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogMsgs.length).toBe(1)
        expect(catalogMsgs[0].id).toBe(firstId) // 原地替换：id 不变
        expect(String(catalogMsgs[0].content)).toContain('skill-b')
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(2)
        // 第二次写库使用同一消息 id（update-by-id）
        expect((repo.writeMessagesDelta as ReturnType<typeof vi.fn>).mock.calls[1][1].id).toBe(firstId)
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
        expect(cs.publishedMessageId).toBe(presetMsg.id)
        expect(cs.lastDigest).toBe(presetMsg.metadata.catalogDigest)

        const r = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        expect(r.state.messages.length).toBe(1)
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
    })

    it('publishedMessageId 悬空时降级为 publish：追加新消息且更新 publishedMessageId', () => {
        let state = createLoopState([])
        let cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        state = r1.state
        cs = r1.catalogState
        const firstId = state.messages.find(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)?.id

        // 模拟消息被裁剪/异常态：catalog 消息从内存消失，但 catalogState 仍持有其 id
        const remaining = state.messages.filter(m => m.id !== firstId)
        state = createLoopState([...remaining])

        // 目录变化触发 replace 决策
        ENTRIES_MOCK.current = () => [
            {name: 'skill-a', type: 'skill', description: 'desc-a'},
            {name: 'skill-c', type: 'skill', description: 'desc-c'},
        ]
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
        try {
            const r2 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
            const catalogMsgs = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
            expect(catalogMsgs.length).toBe(1) // 追加一条新消息（而非 no-op / throw）
            expect(catalogMsgs[0].id).not.toBe(firstId)
            expect(r2.catalogState.publishedMessageId).toBe(catalogMsgs[0].id)
            // 落库为新行（UPSERT 新 id），非孤儿 update（calls[0] 为首轮 publish，取最后一次）
            const calls = (repo.writeMessagesDelta as ReturnType<typeof vi.fn>).mock.calls
            expect(calls[calls.length - 1][1].id).toBe(catalogMsgs[0].id)
            expect(warnSpy).toHaveBeenCalled()
        } finally {
            warnSpy.mockRestore()
        }
    })

    it('sessionId 为空（conversationRepo null）时仅更新内存态', () => {
        const state = createLoopState([])
        const cs: CatalogState = {incompleteStreak: 0}
        const r = runCatalogPreStep(state, cs, null, undefined, false)
        const count = r.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG).length
        expect(count).toBe(1)
    })

    it('mode 切换（fullDescriptions 变化）触发 replace 且格式对应', () => {
        let state = createLoopState([])
        let cs: CatalogState = {incompleteStreak: 0}
        const r1 = runCatalogPreStep(state, cs, repo, 'conv-1', false)
        state = r1.state
        cs = r1.catalogState
        const firstId = state.messages.find(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)?.id

        const r2 = runCatalogPreStep(state, cs, repo, 'conv-1', true)
        const catalogMsgs = r2.state.messages.filter(m => m.metadata?.sourceKind === SOURCE_KIND_CATALOG)
        expect(catalogMsgs.length).toBe(1)
        expect(catalogMsgs[0].id).toBe(firstId)
        expect(String(catalogMsgs[0].content)).toContain('- [skill]')
    })
})
