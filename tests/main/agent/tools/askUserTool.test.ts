/**
 * askUserTool 弱模型容错增强单元测试
 *
 * 覆盖（spec: docs/superpowers/specs/2026-08-06-ask-user-robustness-design.md）：
 * - question：数字转字符串 / 空串报错 / 纯空白报错 / 超长截断 / trim
 * - options：标准数组 / 逗号串 / 顿号串 / 分号串 / 带序号串 / 对象取 label/name/value/text
 *            / 混入 null 与数字 / 超10个截断 / 单选项超60截断 / 全垃圾→undefined / 空串过滤
 * - multiSelect：true/yes/1/on → true；false/no/0/off → false；未知→false；缺省→false
 * - 回归：DeepSeek 标准格式不被改动
 */
import {describe, expect, it, vi} from 'vitest'
import type {ToolContext} from '@/main/agent/tools/types'
import {
    askUserTool,
    normalizeMultiSelect,
    normalizeOptions,
    normalizeQuestion,
} from '@/main/agent/tools/builtin/askUserTool'
import type {RawOption} from '@/main/agent/tools/builtin/askUserTool'

describe('normalizeQuestion', () => {
    it('正常字符串原样返回', () => {
        expect(normalizeQuestion('你想做什么？')).toEqual({ok: true, value: '你想做什么？'})
    })

    it('数字转为字符串', () => {
        expect(normalizeQuestion(123)).toEqual({ok: true, value: '123'})
    })

    it('前后空白被 trim', () => {
        expect(normalizeQuestion('  你好  ')).toEqual({ok: true, value: '你好'})
    })

    it('空串返回错误且错误信息含正确用法示例', () => {
        const r = normalizeQuestion('')
        expect(r.ok).toBe(false)
        if (!r.ok) {
            expect(r.error).toContain('ask_user')
            expect(r.error).toContain('question')
        }
    })

    it('纯空白返回错误', () => {
        const r = normalizeQuestion('   \n ')
        expect(r.ok).toBe(false)
    })

    it('超 500 字符截断到 500', () => {
        const r = normalizeQuestion('x'.repeat(600))
        expect(r.ok).toBe(true)
        if (r.ok) expect(r.value.length).toBe(500)
    })
})

describe('normalizeOptions', () => {
    it('标准字符串数组原样返回', () => {
        expect(normalizeOptions(['A', 'B', 'C'])).toEqual(['A', 'B', 'C'])
    })

    it('英文逗号分隔字符串拆分', () => {
        expect(normalizeOptions('A,B,C')).toEqual(['A', 'B', 'C'])
    })

    it('顿号分隔字符串拆分', () => {
        expect(normalizeOptions('跑步、游泳、打球')).toEqual(['跑步', '游泳', '打球'])
    })

    it('中文逗号与分号分隔拆分', () => {
        expect(normalizeOptions('甲；乙；丙')).toEqual(['甲', '乙', '丙'])
    })

    it('带序号字符串按序号拆分并去序号', () => {
        expect(normalizeOptions('1. 跑步 2. 游泳 3. 打球')).toEqual(['跑步', '游泳', '打球'])
    })

    it('中文序号字符串拆分', () => {
        expect(normalizeOptions('一、苹果 二、香蕉')).toEqual(['苹果', '香蕉'])
    })

    it('对象元素优先取 label', () => {
        expect(normalizeOptions([{label: '跑步', value: 'run'}, {label: '游泳', value: 'swim'}])).toEqual(['跑步', '游泳'])
    })

    it('对象元素按 name/value/text 依次兜底', () => {
        expect(normalizeOptions([{value: 'run'}, {text: '游泳'}])).toEqual(['run', '游泳'])
    })

    it('无有效字段的对象被丢弃', () => {
        expect(normalizeOptions([{foo: 'bar'}, '有效'])).toEqual(['有效'])
    })

    it('混入 null 与数字布尔元素转为字符串', () => {
        expect(normalizeOptions([null as unknown as RawOption, 1, true])).toEqual(['1', 'true'])
    })

    it('过滤空串与纯空白', () => {
        expect(normalizeOptions(['A', '', '   '])).toEqual(['A'])
    })

    it('超过 10 个选项截断到 10', () => {
        const opts = Array.from({length: 15}, (_, i) => `选项${i + 1}`)
        expect(normalizeOptions(opts)?.length).toBe(10)
    })

    it('单选项超过 60 字符截断到 60', () => {
        expect(normalizeOptions(['x'.repeat(80)])?.[0].length).toBe(60)
    })

    it('全部垃圾过滤后返回 undefined', () => {
        expect(normalizeOptions([{foo: 'bar'}])).toBeUndefined()
    })

    it('undefined 原样返回 undefined', () => {
        expect(normalizeOptions(undefined)).toBeUndefined()
    })

    it('不可拆分的单个字符串作为单选项', () => {
        expect(normalizeOptions('这是一个完整的说明文字')).toEqual(['这是一个完整的说明文字'])
    })
})

describe('normalizeMultiSelect', () => {
    it.each(['true', 'yes', 'y', '1', 'on', 1, true])('%s → true', (v) => {
        expect(normalizeMultiSelect(v as boolean | string | number)).toBe(true)
    })

    it.each(['false', 'no', '0', 'off', 0, false])('%s → false', (v) => {
        expect(normalizeMultiSelect(v as boolean | string | number)).toBe(false)
    })

    it('未知值回退 false', () => {
        expect(normalizeMultiSelect('maybe')).toBe(false)
    })

    it('缺省回退 false', () => {
        expect(normalizeMultiSelect(undefined)).toBe(false)
    })

    it('字符串大小写不敏感', () => {
        expect(normalizeMultiSelect('YES')).toBe(true)
        expect(normalizeMultiSelect('False')).toBe(false)
    })
})

/** 构造最小 ToolContext：mock askUserQuestion 捕获清洗后的参数 */
function createContext() {
    const askUserQuestion = vi.fn().mockResolvedValue('用户回答')
    const context = {
        askUserQuestion,
        workingDir: 'C:\\test',
        abortSignal: new AbortController().signal,
        sendMessage: () => {},
    } as unknown as ToolContext
    return {askUserQuestion, context}
}

describe('execute 弱模型容错集成', () => {
    it('数字 question / 字符串 options / 布尔变体 multiSelect 清洗后传给 askUserQuestion', async () => {
        const {askUserQuestion, context} = createContext()
        const result = await askUserTool.execute(
            {question: 123, options: 'A、B', multiSelect: 'yes'},
            context,
        )
        expect(askUserQuestion).toHaveBeenCalledWith('123', ['A', 'B'], true)
        expect(result.success).toBe(true)
    })

    it('output 包含问题与用户回答', async () => {
        const {context} = createContext()
        const result = await askUserTool.execute({question: '你好'}, context)
        expect(result.success).toBe(true)
        expect(result.output).toContain('问题: 你好')
        expect(result.output).toContain('用户回答: 用户回答')
    })

    it('空/纯空白 question 返回失败且不调用 askUserQuestion', async () => {
        const {askUserQuestion, context} = createContext()
        const result = await askUserTool.execute({question: '   '}, context)
        expect(result.success).toBe(false)
        expect(askUserQuestion).not.toHaveBeenCalled()
    })

    it('无 askUserQuestion 时返回错误', async () => {
        const context = {
            workingDir: 'C:\\test',
            abortSignal: new AbortController().signal,
            sendMessage: () => {},
        } as unknown as ToolContext
        const result = await askUserTool.execute({question: '你好'}, context)
        expect(result.success).toBe(false)
        expect(result.error).toBe('askUserQuestion not available')
    })

    it('回归：DeepSeek 标准格式不被改动', async () => {
        const {askUserQuestion, context} = createContext()
        const result = await askUserTool.execute(
            {question: '选择哪个？', options: ['A', 'B'], multiSelect: true},
            context,
        )
        expect(askUserQuestion).toHaveBeenCalledWith('选择哪个？', ['A', 'B'], true)
        expect(result.success).toBe(true)
        expect(result.output).toContain('选项: A、B')
    })
})
