/**
 * task_update 入参别名归一化测试
 *
 * 背景：LLM 常用自然语言同义词描述状态（in_progress / done / 已完成 / 进行中），
 * 被 Zod enum 拦截后需多一次往返。normalizeArgs 钩子在 Zod 校验前把别名收敛为合法枚举。
 */
import {describe, expect, it} from 'vitest'
import {taskUpdateTool} from '../../../../../src/main/agent/tools/builtin/taskUpdateTool'

const normalize = (status: unknown) => taskUpdateTool.normalizeArgs!({status})

describe('taskUpdateTool.normalizeArgs', () => {
    it('in_progress → running', () => {
        expect(normalize('in_progress')).toEqual({status: 'running'})
    })

    it('进行中 → running', () => {
        expect(normalize('进行中')).toEqual({status: 'running'})
    })

    it('执行中 → running', () => {
        expect(normalize('执行中')).toEqual({status: 'running'})
    })

    it('done → completed', () => {
        expect(normalize('done')).toEqual({status: 'completed'})
    })

    it('已完成 → completed', () => {
        expect(normalize('已完成')).toEqual({status: 'completed'})
    })

    it('合法枚举原样保留', () => {
        expect(normalize('completed')).toEqual({status: 'completed'})
        expect(normalize('pending')).toEqual({status: 'pending'})
    })

    it('未识别值原样透传（交由 Zod 报错）', () => {
        expect(normalize('cancelled')).toEqual({status: 'cancelled'})
    })

    it('非字符串 status 原样透传', () => {
        expect(normalize(undefined)).toEqual({status: undefined})
        expect(taskUpdateTool.normalizeArgs!({taskId: 'x'})).toEqual({taskId: 'x'})
    })

    it('归一化后可通过 inputSchema 校验（端到端语义）', () => {
        const parsed = taskUpdateTool.inputSchema.safeParse(normalize('in_progress'))
        expect(parsed.success).toBe(true)
        expect(parsed.success && parsed.data.status).toBe('running')
    })

    it('输入对象不被原地修改', () => {
        const input = {status: 'in_progress'}
        taskUpdateTool.normalizeArgs!(input)
        expect(input.status).toBe('in_progress')
    })

    it('原型链键（toString / constructor）不被误映射', () => {
        expect(normalize('toString')).toEqual({status: 'toString'})
        expect(normalize('constructor')).toEqual({status: 'constructor'})
    })
})
