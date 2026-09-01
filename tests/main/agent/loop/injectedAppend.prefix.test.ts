/**
 * 注入消息追加式 KV cache 前缀契约测试（spec §5.5 / §5.6）
 *
 * Task 4 后 CT（<command-task>）与 catalog 均为真实持久化消息（追加式）：
 * - 命令轮内每次 LLM 调用共享稳定前缀（call2 = [...call1, a1, t1]）
 * - 目录变更只追加不改写（旧 catalog 消息 content 字节不动）
 * - 多命令会话：CT1 驻留原位、CT2 紧跟 u3（spec §5.6）
 *
 * 组装逻辑复刻 controller.ts 真实顺序：CT 插入（主循环前）→ catalog pre-step
 * → assistant/tool 消息追加（Task 2 契约：DB 读回 == 插入顺序，无需重定位）。
 */
import {describe, it, expect, vi} from 'vitest'

vi.mock('../../../../src/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-injected-append-' + Date.now())
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
import {createLoopState, addMessage, type LoopState} from '../../../../src/main/agent/state'
import type {ChatMessage} from '../../../../src/main/agent/state'
import {buildCommandTaskContent} from '../../../../src/main/agent/utils/userContentBuilder'
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

/** 复刻 controller.ts #mainLoop 的 CT 插入逻辑（conversationRepo=null 时不落库） */
function insertCommandTask(state: LoopState, commandTemplate: string): LoopState {
    const ctMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: buildCommandTaskContent(commandTemplate),
    }
    return addMessage(state, ctMessage)
}

const seq = (messages: ReadonlyArray<ChatMessage>) => JSON.stringify(messages)

describe('注入消息追加式：请求前缀单调增长', () => {
    it('命令轮内每次调用共享稳定前缀：call2 = [...call1, a1, t1]', () => {
        skillRegistry.register(makeSkill('skill-a'))
        let state = createLoopState([{id: 'u1', role: 'user', content: '/skill-a 做事'}])

        // ★ CT 主循环前插入（controller.ts 同款）
        state = insertCommandTask(state, '/skill-a 做事')

        // catalog pre-step（首轮发布）
        let cs: CatalogState = restoreCatalogState(state.messages)
        const r1 = runCatalogPreStep(state, cs, null, undefined, false)
        state = r1.state
        cs = r1.catalogState

        // call1 = [u1, CT, catalog]
        const call1 = state.messages
        expect(call1).toHaveLength(3)
        expect(String(call1[1].content)).toContain('<command-task>')

        // 轮内 LLM 返回 a1 → 工具结果 t1 → call2
        state = addMessage(state, {id: 'a1', role: 'assistant', content: 'ok'} as ChatMessage)
        state = addMessage(state, {id: 't1', role: 'tool', toolCallId: 'tc1', content: 'done'} as ChatMessage)
        const call2 = state.messages

        expect(call2).toHaveLength(5)
        expect(call2[3].id).toBe('a1')
        expect(call2[4].id).toBe('t1')
        // KV cache 契约：call2 前 |call1| 项与 call1 逐字节相等
        expect(seq(call2.slice(0, call1.length))).toBe(seq(call1))
    })

    it('目录变更只追加不改写：旧 catalog content 字节不动，新 catalog 追加尾部', () => {
        skillRegistry.register(makeSkill('skill-a'))
        let state = createLoopState([{id: 'u1', role: 'user', content: '/skill-a 做事'}])
        state = insertCommandTask(state, '/skill-a 做事')
        let cs: CatalogState = restoreCatalogState(state.messages)
        const r1 = runCatalogPreStep(state, cs, null, undefined, false)
        state = r1.state
        cs = r1.catalogState

        const prev = state.messages
        const oldCatalog = prev.find(m => (m.metadata as Record<string, unknown> | undefined)?.sourceKind === 'capability-catalog')
        expect(oldCatalog).toBeDefined()
        const oldCatalogContent = oldCatalog!.content

        // 轮次推进 + 新技能启用 → 下一轮目录变更
        state = addMessage(state, {id: 'a1', role: 'assistant', content: 'ok'} as ChatMessage)
        state = addMessage(state, {id: 't1', role: 'tool', toolCallId: 'tc1', content: 'done'} as ChatMessage)
        skillRegistry.register(makeSkill('skill-b'))

        const r2 = runCatalogPreStep(state, cs, null, undefined, false)
        state = r2.state

        const next = state.messages
        const catalogs = next.filter(m => (m.metadata as Record<string, unknown> | undefined)?.sourceKind === 'capability-catalog')
        expect(catalogs).toHaveLength(2)
        // 旧 catalog content 字节不变（Task 3 追加式契约）
        expect(catalogs[0].content).toBe(oldCatalogContent)
        // 前缀单调：next 前 |prev| 项与 prev 逐字节相等（追加 a1/t1 与 catalog2，共 +3）
        expect(next).toHaveLength(prev.length + 3)
        expect(seq(next.slice(0, prev.length))).toBe(seq(prev))
    })

    it('多命令会话（spec §5.6）：纯文本轮无新 CT，CT1 驻留原位、CT2 紧跟 u3', () => {
        skillRegistry.register(makeSkill('skill-a'))
        let state = createLoopState([{id: 'u1', role: 'user', content: '/skill-a cmd1'}])

        // ── cmd1 轮 ──
        state = insertCommandTask(state, '/skill-a cmd1')
        let cs: CatalogState = restoreCatalogState(state.messages)
        const r1 = runCatalogPreStep(state, cs, null, undefined, false)
        state = r1.state
        cs = r1.catalogState
        state = addMessage(state, {id: 'a1', role: 'assistant', content: 'r1'} as ChatMessage)
        state = addMessage(state, {id: 't1', role: 'tool', toolCallId: 'tc1', content: 'd1'} as ChatMessage)

        const cmd1Call = state.messages
        // [u1, CT1, cat1, a1, t1]
        expect(cmd1Call.map(m => m.id).slice(0, 3)).toHaveLength(3)
        expect(String(cmd1Call[1].content)).toContain('<command-task>')

        // ── 纯文本轮（无新命令、无目录变更）──
        state = addMessage(state, {id: 'u2', role: 'user', content: '继续'} as ChatMessage)
        const r2 = runCatalogPreStep(state, cs, null, undefined, false)
        state = r2.state
        cs = r2.catalogState
        state = addMessage(state, {id: 'a2', role: 'assistant', content: 'r2'} as ChatMessage)
        state = addMessage(state, {id: 't2', role: 'tool', toolCallId: 'tc2', content: 'd2'} as ChatMessage)

        const textCall = state.messages
        // 前缀单调：cmd1Call 完整保留；纯文本轮无新 CT
        expect(seq(textCall.slice(0, cmd1Call.length))).toBe(seq(cmd1Call))
        expect(textCall.some(m => String(m.content ?? '').includes('<command-task>'))).toBe(true) // 仅 CT1
        expect(textCall.filter(m => String(m.content ?? '').includes('<command-task>'))).toHaveLength(1)

        // ── cmd2 轮 ──
        state = addMessage(state, {id: 'u3', role: 'user', content: '/skill-a cmd2'} as ChatMessage)
        state = insertCommandTask(state, '/skill-a cmd2')
        const r3 = runCatalogPreStep(state, cs, null, undefined, false)
        state = r3.state

        const final = state.messages
        // [u1, CT1, cat1, a1, t1, u2, a2, t2, u3, CT2]
        expect(final.map(m => m.id)).toEqual([
            'u1', final[1].id, final[2].id, 'a1', 't1', 'u2', 'a2', 't2', 'u3', final[9].id,
        ])
        expect(String(final[1].content)).toBe(buildCommandTaskContent('/skill-a cmd1'))
        expect(String(final[9].content)).toBe(buildCommandTaskContent('/skill-a cmd2'))
        // CT1 驻留原位（u1 之后）、CT2 紧跟 u3
        expect(final[0].id).toBe('u1')
        expect(final[8].id).toBe('u3')
        // 前缀单调：cmd2 轮请求以纯文本轮请求为前缀（逐字节）
        expect(seq(final.slice(0, textCall.length))).toBe(seq(textCall))
    })
})
