import {describe, it, expect} from 'vitest'
import {
    getAgentToolRestrictions,
    filterToolsByAgentType,
} from '../../../../src/main/agent/agentTypes/configs'
import {makeToolDefinition} from '../tools/testHelpers'

const POOL = ['file_read', 'file_write', 'file_edit', 'bash', 'notebook_edit', 'agent', 'glob', 'grep']
    .map(makeToolDefinition)
const POOL_NAMES = POOL.map(t => t.name)

describe('getAgentToolRestrictions', () => {
    it('Plan 限制含 CC 风格工具名（原始配置不被误改）', () => {
        expect(getAgentToolRestrictions('Plan').disallowed).toEqual(
            ['Write', 'Edit', 'Bash', 'NotebookEdit', 'TaskWrite', 'Agent'],
        )
    })

    it('General 限制为通配允许（现状不变）', () => {
        expect(getAgentToolRestrictions('General')).toEqual({allowed: ['*'], disallowed: undefined})
    })
})

describe('filterToolsByAgentType', () => {
    it('Plan 限制经别名解析：写工具/agent 被移除，只读工具保留（核心回归，修复前失败）', () => {
        const result = filterToolsByAgentType(POOL, getAgentToolRestrictions('Plan'))
        const names = result.map(t => t.name)
        expect(names).toEqual(['file_read', 'glob', 'grep'])
    })

    it('Explore 限制同 Plan 组合', () => {
        const result = filterToolsByAgentType(POOL, getAgentToolRestrictions('Explore'))
        expect(result.map(t => t.name)).toEqual(['file_read', 'glob', 'grep'])
    })

    it('CodeReviewer 限制（Write/Edit/NotebookEdit/Agent）经别名解析', () => {
        const result = filterToolsByAgentType(POOL, getAgentToolRestrictions('CodeReviewer'))
        expect(result.some(t => t.name === 'file_write')).toBe(false)
        expect(result.some(t => t.name === 'file_edit')).toBe(false)
        expect(result.some(t => t.name === 'notebook_edit')).toBe(false)
        expect(result.some(t => t.name === 'agent')).toBe(false)
        expect(result.some(t => t.name === 'bash')).toBe(true) // bash 允许（只读 git/测试）
    })

    it('Verification 限制经别名解析（bash 保留用于运行测试）', () => {
        const result = filterToolsByAgentType(POOL, getAgentToolRestrictions('Verification'))
        expect(result.some(t => t.name === 'file_write')).toBe(false)
        expect(result.some(t => t.name === 'bash')).toBe(true)
    })

    it('allowed 通配符 * 且无 disallowed → 全部保留', () => {
        const result = filterToolsByAgentType(POOL, {allowed: ['*']})
        expect(result).toHaveLength(POOL.length)
    })

    it('无限制 → 全部保留', () => {
        const result = filterToolsByAgentType(POOL, {allowed: undefined, disallowed: undefined})
        expect(result).toHaveLength(POOL.length)
    })

    it('小写 write 同样解析为 file_write', () => {
        const result = filterToolsByAgentType(POOL, {disallowed: ['write']})
        expect(result.some(t => t.name === 'file_write')).toBe(false)
        expect(result.some(t => t.name === 'file_read')).toBe(true)
    })

    it('TaskWrite 无对应工具 → 丢弃，不误伤 file_write', () => {
        const result = filterToolsByAgentType(POOL, {disallowed: ['TaskWrite']})
        expect(result.map(t => t.name)).toEqual(POOL_NAMES)
    })

    it('不存在的禁用工具名被忽略', () => {
        const result = filterToolsByAgentType(POOL, {disallowed: ['nonexistent']})
        expect(result.map(t => t.name)).toEqual(POOL_NAMES)
    })
})
