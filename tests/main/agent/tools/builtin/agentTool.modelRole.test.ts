import {describe, expect, it} from 'vitest'
import {z} from 'zod'
import {agentTool} from '../../../../../src/main/agent/tools/builtin/agentTool'

describe('agentTool modelRole 参数', () => {
    it('inputSchema 接受合法 modelRole（primary/lightweight/reasoning）', () => {
        const parsed = agentTool.inputSchema.parse({
            task: '完成重构',
            agent: 'Implementer Agent',
            modelRole: 'reasoning',
        })
        expect(parsed.modelRole).toBe('reasoning')
    })

    it('modelRole 可选（缺省 undefined）', () => {
        const parsed = agentTool.inputSchema.parse({
            task: '搜索代码',
            agent: 'Explore Agent',
        })
        expect(parsed.modelRole).toBeUndefined()
    })

    it('非法 modelRole（image_understanding / 乱写）→ zod 拒绝，LLM 需修正', () => {
        expect(() => agentTool.inputSchema.parse({
            task: 'x', agent: 'General Agent', modelRole: 'image_understanding',
        })).toThrow()
        expect(() => agentTool.inputSchema.parse({
            task: 'x', agent: 'General Agent', modelRole: 'garbage',
        })).toThrow()
    })
})
