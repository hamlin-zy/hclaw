/**
 * 注入消息降级路径 + metadata 字节隔离测试（spec §5.7 / §5.8）
 *
 * 1. §5.8 降级：无 conversationRepo/sessionId（channel 场景）→ CT/catalog 仅内存注入，
 *    LLM 请求序列仍含两条注入消息；writeMessagesDelta 抛错 → 主循环不阻断，内存态完整。
 * 2. §5.7 隔离：catalog 消息 metadata 任意变化不改变发给 LLM 的 content 字节；
 *    CT（buildCommandTaskContent）输出不依赖任何 metadata。
 *
 * 组装逻辑复刻 controller.ts 真实顺序（与 injectedAppend.prefix.test.ts 同款）：
 * CT 插入（主循环前）→ catalog pre-step → PreprocessCache.normalize 形成请求序列。
 */
import {describe, it, expect, vi} from 'vitest'

vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-injected-degrade-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})

vi.mock('../../../../src/main/plugin/commands', () => {
    return {
        CommandDispatcher: {
            getInstance: () => ({
                getAllCommands: () => ({pluginGroups: new Map(), userCommands: []}),
            }),
        },
    }
})

import {skillRegistry} from '../../../../src/main/agent/skills/registry'
import type {SkillDefinition} from '../../../../src/main/agent/skills/types'
import {runCatalogPreStep, restoreCatalogState, type CatalogState} from '../../../../src/main/agent/loop/catalogPublish'
import {PreprocessCache} from '../../../../src/main/agent/loop/preprocessCache'
import {createLoopState, addMessage, type LoopState} from '../../../../src/main/agent/state'
import type {ChatMessage} from '../../../../src/main/agent/state'
import {buildCommandTaskContent} from '../../../../src/main/agent/utils/userContentBuilder'
import {SOURCE_KIND_CATALOG} from '../../../../src/shared/types/message'
import {randomUUID} from 'crypto'

function makeSkill(id: string, extra: Partial<SkillDefinition> = {}): SkillDefinition {
    return {
        id,
        name: id,
        description: `desc-${id}`,
        whenToUse: `trigger-${id}`,
        enabled: true,
        content: 'body',
        ...extra,
    } as SkillDefinition
}

/** 复刻 controller.ts #mainLoop 的 CT 插入逻辑；persist 分支为 try/catch 包裹的 writeMessagesDelta（Task 4 同款） */
function insertCommandTask(
    state: LoopState,
    commandTemplate: string,
    repo: {writeMessagesDelta: (...args: unknown[]) => unknown} | null,
    sessionId?: string,
): LoopState {
    const ctMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: buildCommandTaskContent(commandTemplate),
    }
    const next = addMessage(state, ctMessage)
    if (repo && sessionId) {
        try {
            // 与 Task 4 controller.ts 一致：best-effort 落库，失败仅 debug，不阻断
            repo.writeMessagesDelta(sessionId, {...ctMessage, timestamp: Date.now()})
        } catch {
            // debug log only（真实实现），此处吞掉即可
        }
    }
    return next
}

const catalogsOf = (messages: ReadonlyArray<ChatMessage>) =>
    messages.filter(m => (m.metadata as Record<string, unknown> | undefined)?.sourceKind === SOURCE_KIND_CATALOG)

const ctOf = (messages: ReadonlyArray<ChatMessage>) =>
    messages.filter(m => String(m.content ?? '').includes('<command-task>'))

function makeState(): LoopState {
    return createLoopState([{id: 'u1', role: 'user', content: '/skill-a 做事'}])
}

describe('注入消息降级路径（spec §5.8）', () => {
    it('无 conversationRepo/sessionId：CT 与 catalog 仅内存注入，请求序列仍含两条注入消息', () => {
        skillRegistry.register(makeSkill('skill-a'))
        let state = makeState()

        // CT 插入：conversationRepo=null → 仅 addMessage，不落库
        state = insertCommandTask(state, '/skill-a 做事', null, undefined)

        // catalog pre-step：conversationRepo=null → 仅内存
        const r = runCatalogPreStep(state, restoreCatalogState(state.messages), null, undefined, false)
        state = r.state

        // 内存态含 CT 与 catalog
        expect(ctOf(state.messages)).toHaveLength(1)
        expect(catalogsOf(state.messages)).toHaveLength(1)
        expect(String(state.messages[1].content)).toContain('<command-task>')

        // LLM 请求序列（PreprocessCache normalize 后）包含两条注入消息，顺序 [u1, CT, catalog]
        const request = new PreprocessCache().process(state.messages)
        expect(request).toHaveLength(3)
        expect(String(request[1].content)).toContain('<command-task>')
        expect((request[2].metadata as Record<string, unknown>).sourceKind).toBe(SOURCE_KIND_CATALOG)
    })

    it('writeMessagesDelta 抛错：CT 与 catalog 落库均不抛出，内存态仍含注入消息', () => {
        skillRegistry.register(makeSkill('skill-a'))
        const repo = {writeMessagesDelta: vi.fn(() => { throw new Error('db down') })}
        const sessionId = 'conv-degrade-1'
        let state = makeState()

        // CT best-effort 落库抛错 → 不阻断（Task 4 try/catch 契约）
        expect(() => { state = insertCommandTask(state, '/skill-a 做事', repo, sessionId) }).not.toThrow()
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(1)

        // catalog pre-step 落库抛错 → 不阻断（catalogPublish.persist try/catch 契约）
        let r!: ReturnType<typeof runCatalogPreStep>
        expect(() => { r = runCatalogPreStep(state, restoreCatalogState(state.messages), repo as never, sessionId, false) }).not.toThrow()
        state = r.state
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(2)

        // 内存态完整：CT + catalog 均已注入
        expect(ctOf(state.messages)).toHaveLength(1)
        expect(catalogsOf(state.messages)).toHaveLength(1)

        // 本轮请求仍携带注入消息
        const request = new PreprocessCache().process(state.messages)
        expect(ctOf(request)).toHaveLength(1)
        expect(catalogsOf(request)).toHaveLength(1)
    })
})

describe('metadata 字节隔离（spec §5.7）', () => {
    it('同一 catalog content + 两组不同 metadata → LLM 请求消息 content 字节逐位相等', () => {
        skillRegistry.register(makeSkill('skill-a'))
        let state = makeState()
        const r = runCatalogPreStep(state, restoreCatalogState(state.messages), null, undefined, false)
        state = r.state

        const published = catalogsOf(state.messages)[0]
        expect(published).toBeDefined()
        const content = published.content

        // 两组不同 metadata，同一 content（模拟 metadata 演化：加字段 / 改 digest 之外字段）
        const metaA = {...(published.metadata as Record<string, unknown>), extraFlag: 'a', revision: 1}
        const metaB = {...(published.metadata as Record<string, unknown>), extraFlag: 'b', revision: 2, extraObj: {deep: true}}

        const reqA = new PreprocessCache().process([{...published, id: 'cat-a', metadata: metaA}])
        const reqB = new PreprocessCache().process([{...published, id: 'cat-b', metadata: metaB}])

        // LLM 侧序列化字节完全一致：metadata 差异不得泄漏进 content
        expect(JSON.stringify(reqA[0].content)).toBe(JSON.stringify(reqB[0].content))
        expect(reqA[0].content).toBe(content)

        // 反向锚点：metadata 确实不同（排除用例本身空转）
        expect(JSON.stringify(metaA)).not.toBe(JSON.stringify(metaB))
    })

    it('CT：buildCommandTaskContent 输出确定且不依赖任何 metadata', () => {
        const template = '/skill-a 做事'
        const c1 = buildCommandTaskContent(template)
        const c2 = buildCommandTaskContent(template)

        // 同一模板两次构造 → 逐字节相等（无时间戳/随机数/环境依赖）
        expect(c1).toBe(c2)
        expect(JSON.stringify(c1)).toBe(JSON.stringify(c2))
        expect(c1).toContain('<command-task>')

        // 两组完全不同的 metadata 下构造的 CT 消息：content 字节一致
        const ctA: ChatMessage = {id: 'ct-a', role: 'user', content: buildCommandTaskContent(template), metadata: {x: 1}}
        const ctB: ChatMessage = {id: 'ct-b', role: 'user', content: buildCommandTaskContent(template), metadata: {y: [2, 3], z: {k: 'v'}}}
        expect(JSON.stringify(ctA.content)).toBe(JSON.stringify(ctB.content))

        // 不同模板输出不同（排除恒等空转）
        expect(buildCommandTaskContent('/skill-a 其他')).not.toBe(c1)
    })
})
