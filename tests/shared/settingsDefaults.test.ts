/**
 * DEFAULT_SETTINGS 单一真源（spec §6.4）：
 * 主进程（manager.impl / worker）与渲染端 store 统一引用，消除三副本漂移。
 */
import {describe, expect, it} from 'vitest'
import {readFileSync} from 'fs'
import {resolve} from 'path'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'

describe('DEFAULT_SETTINGS（shared 单一真源）', () => {
    it('形状：7 个分类 + 关键默认值', () => {
        expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(
            ['agent', 'channels', 'linkOpening', 'model', 'shortcuts', 'subagent', 'ui'],
        )
        expect(DEFAULT_SETTINGS.agent.maxTurns).toBe(500)
        expect(DEFAULT_SETTINGS.agent.handoffThresholdTokens).toBe(200_000)
        expect(DEFAULT_SETTINGS.agent.defaultPermissionMode).toBe('safe')
        expect(DEFAULT_SETTINGS.agent.defaultDisplayMode).toBe('detailed')
        expect(DEFAULT_SETTINGS.model.defaultMaxTokens).toBe(50000)
        expect(DEFAULT_SETTINGS.model.imageCompressQuality).toBe(85)
        expect(DEFAULT_SETTINGS.subagent).toEqual({maxConcurrency: 3, maxDepth: 3})
        expect(DEFAULT_SETTINGS.shortcuts).toEqual({overrides: {}})
        // 不引入 fullSkillDescriptions（零行为变化；缺省 = 关闭）
        expect('fullSkillDescriptions' in DEFAULT_SETTINGS).toBe(false)
    })

    it('主进程兜底引用 shared 而非内联副本', () => {
        for (const f of ['src/main/agent/manager.impl.ts', 'src/main/agent/worker.ts']) {
            const src = readFileSync(resolve(process.cwd(), f), 'utf8')
            expect(src, `${f} 未引用 shared 默认值`).toContain('@shared/settingsDefaults')
            expect(src, `${f} 残留内联 mcp 键`).not.toContain('mcpTestTimeout')
        }
    })
})
