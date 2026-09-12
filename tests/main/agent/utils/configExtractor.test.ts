import {describe, expect, it} from 'vitest'
import {parseAgentConfig} from '../../../../src/main/agent/utils/configExtractor'

/**
 * RC2：插件 agent（Claude Code 风格）用逗号串写 tools：
 *   tools: Read, Write, Edit, Bash, Grep, Glob
 * js-yaml 会将其解析为「字符串」而非数组，而 parseStringArray 旧实现只接受
 * Array.isArray → allowedTools=[] → filterToolsForAgent 白名单层被静默跳过。
 *
 * 修复：parseStringArray 对非空字符串按逗号分割并 trim、过滤空项。
 */
describe('parseStringArray（经 parseAgentConfig 暴露的 allowedTools 观察）', () => {
    const parse = (raw: Record<string, unknown>) =>
        parseAgentConfig(raw as any, 'sys', {defaultName: 'test-agent'})

    it("tools: 'Read, Write, Edit' → ['Read','Write','Edit']", () => {
        const cfg = parse({name: 'a', tools: 'Read, Write, Edit'})
        expect(cfg?.allowedTools).toEqual(['Read', 'Write', 'Edit'])
    })

    it("tools: 'Bash' → ['Bash']（无逗号单值）", () => {
        const cfg = parse({name: 'a', tools: 'Bash'})
        expect(cfg?.allowedTools).toEqual(['Bash'])
    })

    it('YAML 数组写法仍正常（数组行为不变）', () => {
        const cfg = parse({name: 'a', tools: ['Read', 'Write', 'Edit']})
        expect(cfg?.allowedTools).toEqual(['Read', 'Write', 'Edit'])
    })

    it('数组内非字符串项仍被过滤（行为不变）', () => {
        const cfg = parse({name: 'a', tools: ['Read', 42, null, 'Write']})
        expect(cfg?.allowedTools).toEqual(['Read', 'Write'])
    })

    it('空串 → []', () => {
        const cfg = parse({name: 'a', tools: ''})
        expect(cfg?.allowedTools).toEqual([])
    })

    it('纯逗号 → []', () => {
        const cfg = parse({name: 'a', tools: ', ,,'})
        expect(cfg?.allowedTools).toEqual([])
    })

    it('逗号串含空白项 → trim 并过滤空项', () => {
        const cfg = parse({name: 'a', tools: ' Read , ,Write ,'})
        expect(cfg?.allowedTools).toEqual(['Read', 'Write'])
    })

    it('其他类型（数字/对象/null）→ []', () => {
        expect(parse({name: 'a', tools: 123})?.allowedTools).toEqual([])
        expect(parse({name: 'a', tools: {x: 1}})?.allowedTools).toEqual([])
        expect(parse({name: 'a', tools: null})?.allowedTools).toEqual([])
    })

    it("allowed_tools 兼容键也支持逗号串", () => {
        const cfg = parse({name: 'a', allowed_tools: 'Bash, Grep'})
        expect(cfg?.allowedTools).toEqual(['Bash', 'Grep'])
    })

    it('parseAgentConfig 得到非空数组（回归：不再静默为空）', () => {
        const cfg = parse({
            name: 'a',
            tools: 'Read, Write, Edit, Bash, Grep, Glob',
        })
        expect(Array.isArray(cfg?.allowedTools)).toBe(true)
        expect(cfg?.allowedTools.length).toBe(6)
    })
})
