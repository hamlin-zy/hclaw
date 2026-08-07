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

    // ── v2 防误拆（2026-08-07）：括号保护 + 强分隔符优先 ──

    it('括号内顿号不参与拆分（防 "（重构、调优）" 被拆断）', () => {
        expect(normalizeOptions('方案A、方案B（重构、调优）、方案C')).toEqual([
            '方案A',
            '方案B（重构、调优）',
            '方案C',
        ])
    })

    it('全角/半角括号内逗号同样受保护', () => {
        expect(normalizeOptions('A（1,2）、B')).toEqual(['A（1,2）', 'B'])
        expect(normalizeOptions('C(3,4)、D')).toEqual(['C(3,4)', 'D'])
    })

    it('换行强分隔符优先，顿号不参与拆分', () => {
        expect(normalizeOptions('方案A\n方案B、方案C')).toEqual(['方案A', '方案B、方案C'])
    })

    it('竖线强分隔符优先', () => {
        expect(normalizeOptions('A|B、C')).toEqual(['A', 'B、C'])
    })

    it('字母序号误判降级：顿号列表 "A、B、C" 拆为三项，不被当序号删掉', () => {
        expect(normalizeOptions('A、B、C')).toEqual(['A', 'B', 'C'])
    })

    it('括号内唯一顿号拆不出多段时整串保留（回退单选项）', () => {
        expect(normalizeOptions('方案（重构、调优）')).toEqual(['方案（重构、调优）'])
    })

    it('回归：截图场景——选项内括号并列短语不再被拆断', () => {
        const raw =
            '方案 A：阶段边界落库 + checkpoint 空闲化 + 隐藏冻结渲染、' +
            '方案 B：主进程统一落库（彻底重构、改动最大）、' +
            '方案 C：参数调优（最小改动、治标）'
        expect(normalizeOptions(raw)).toEqual([
            '方案 A：阶段边界落库 + checkpoint 空闲化 + 隐藏冻结渲染',
            '方案 B：主进程统一落库（彻底重构、改动最大）',
            '方案 C：参数调优（最小改动、治标）',
        ])
    })

    // ── v3 JSON 数组字符串检测（2026-08-07） ──

    it('v3: JSON 数组字符串自动解析（防 PAIRED_BRACKET_RE 误吞 [...]）', () => {
        expect(normalizeOptions('["A","B","C"]')).toEqual(['A', 'B', 'C'])
    })

    it('v3: JSON 数组字符串含中文', () => {
        expect(normalizeOptions('["我一个人开发","有协作者在 main 分支","有协作者也在 develop"]'))
            .toEqual(['我一个人开发', '有协作者在 main 分支', '有协作者也在 develop'])
    })

    it('v3: JSON 数组元素为对象时取 label', () => {
        expect(normalizeOptions('[{"label":"跑步"},{"label":"游泳"}]'))
            .toEqual(['跑步', '游泳'])
    })

    it('v3: 混合元素类型的 JSON 数组', () => {
        expect(normalizeOptions('["跑步",{"label":"游泳"},42,true,null,{"foo":"bar"}]'))
            .toEqual(['跑步', '游泳', '42', 'true'])
    })

    it('v3: 合法 JSON 但非数组 → fall through 到字符串拆分', () => {
        expect(normalizeOptions('"just a string"')).toEqual(['"just a string"'])
    })

    it('v3: 空 JSON 数组 → undefined', () => {
        expect(normalizeOptions('[]')).toBeUndefined()
    })

    it('v3: 非法 JSON（不闭合括号）→ fall through', () => {
        expect(normalizeOptions('["A","B"')).toEqual(['["A"', '"B"'])
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
