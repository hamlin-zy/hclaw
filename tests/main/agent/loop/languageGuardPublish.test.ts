/**
 * 语言守卫纯函数单测（spec §9 T1 / T2）
 *
 * T1 判定器：逐条对齐 §5.6 冻结剥离正则 + 阈值边界 + 真实样本回归
 * T2 英文意图豁免：§5.5 冻结串字面断言 + 防"交替分支含空格"回归
 *
 * 剥离类用例是**故意做锋利**的：断言两侧的字母数经过配平，若某条剥离规则
 * 失效（字母计入统计），H/(H+L) 会掉到 0.15 以下 → 断言立刻翻转。
 */
import {describe, it, expect, vi} from 'vitest'
import {
    detectDrift,
    matchLanguageExemption,
    renderLanguageGuardContent,
} from '@/main/agent/loop/languageGuardPublish'

/** 60 个汉字（4 字 × 15） */
const CJK60 = '中文说明'.repeat(15)

import {
    isLanguageGuardIteration,
    restoreLanguageGuardState,
    runLanguageGuardPreStep,
    type LanguageGuardState,
} from '@/main/agent/loop/languageGuardPublish'
import {createLoopState, type LoopState} from '@/main/agent/state'
import type {ChatMessage} from '@/main/agent/state'
import {SOURCE_KIND_CATALOG, SOURCE_KIND_LANGUAGE_GUARD} from '@shared/types/message'
import type {SystemSettings} from '@shared/types'
import type {IConversationRepository} from '@/main/repositories/interfaces'

const CONV_ID = 'conv-lg'

/** 漂移样本：0 汉字、纯拉丁字母（≥ DRIFT_MIN_SAMPLE） */
const DRIFT_TEXT = 'This answer drifted into English and the reasoning is English as well.'

/**
 * 正常中文样本：38 个汉字、0 拉丁字母。
 * ★ 长度必须 ≥ DRIFT_MIN_SAMPLE(30)：否则 detectDrift 走样本不足分支直接返回 false，
 *   门 4 的比例路径根本不会被执行 —— 用例会以"错误的理由"通过。
 */
const NORMAL_TEXT = '本次修改已完成，相关测试全部通过，覆盖了新增的边界场景，稍后我会补充更多说明与示例。'

let seq = 0
const nextId = () => `id-${++seq}`

function userMsg(content: ChatMessage['content'], metadata?: Record<string, unknown>): ChatMessage {
    return {id: nextId(), role: 'user', content, ...(metadata ? {metadata} : {})}
}

function assistantMsg(content: string, thinking?: string): ChatMessage {
    return {id: nextId(), role: 'assistant', content, ...(thinking ? {thinking} : {})}
}

/** settings 只填 language 段；其余字段与本任务无关 */
function settingsWith(language: SystemSettings['language']): SystemSettings {
    return {language} as SystemSettings
}

function repoMock() {
    return {writeMessagesDelta: vi.fn(() => true)} as unknown as
        IConversationRepository & {writeMessagesDelta: ReturnType<typeof vi.fn>}
}

function lgMessages(state: LoopState): ChatMessage[] {
    return state.messages.filter(m =>
        (m.metadata as Record<string, unknown> | undefined)?.sourceKind === SOURCE_KIND_LANGUAGE_GUARD)
}

const CN = settingsWith({nativeLocale: 'zh-CN', strategy: 'first-and-drift', correctionLimit: 3})
const SEEDED: LanguageGuardState = {seeded: true, injectedCount: 1, localeDigest: 'zh-CN'}

describe('detectDrift（spec §9-T1）', () => {
    it('剥离围栏代码块：代码字母不计入统计', () => {
        // 样本：H=120（CJK60 ×2）；代码 60 行 × 15 字母 = 900，加语言标注 "ts" 共 L=902。
        // 剥离生效：代码块被整段剥离 → L=0 → 120/120 = 1.00 → 不判漂移。
        // 若围栏规则失效：L=902 → 120/1022 ≈ 0.117 < 0.15 → 立刻判漂移（断言翻转）。
        const code = 'let value = compute();\n'.repeat(60)   // 900 个字母
        const text = `${CJK60}\n\`\`\`ts\n${code}\`\`\`\n${CJK60}`
        expect(detectDrift(text)).toBe(false)
    })

    it('剥离行内代码 / URL / 两种路径 / snake / :: / 扩展名 / 驼峰', () => {
        const noise = [
            'https://example.com/docs/getting-started',
            'C:\\Users\\demo\\projects\\sample\\main.ts',
            '/usr/local/share/doc/readme.md',
            'snake_case_name',
            'Class::method',
            'config.yaml',
            'camelCaseIdentifier',
            '`npm install`',
        ].join(' ')
        // 样本：H=120（CJK60 ×2）；单份 noise = 150 个字母，重复 6 份 → 未剥离时 L=900。
        // 剥离生效：全部噪声被剥光 → L=0 → 120/120 = 1.00 → 不判漂移。
        // 若剥离规则整体失效：L=900 → 120/1020 ≈ 0.118 < 0.15 → 立刻判漂移（断言翻转）。
        const text = `${CJK60} ${[noise, noise, noise, noise, noise, noise].join(' ')} ${CJK60}`
        expect(detectDrift(text)).toBe(false)
    })

    it('逐条剥离规则各自承重：只删一条规则也会让对应用例翻转', () => {
        // 每条规则配一份"专属噪声"（复用本文件已列出的 token，一条规则一行）。
        // 全量规则下该噪声被完全剥离 → L=0 → 120/120 = 1.00 → 不判漂移（false）。
        // 但**只**移除该条规则时，残留字母 > 680 → H/(H+L) < 0.15 → 立刻判漂移（true）。
        // repeat 为该规则的字母密度配平：删单条规则后残留 L≈830（≈0.12 < 0.15），
        // 留有安全余量，故任何一条规则失效都会被本用例当场抓到（失败行名即坏掉的规则）。
        const rows: Array<{label: string; token: string; repeat: number}> = [
            {label: '围栏代码块 ``` ... ```', token: '```ts\nlet value = compute();\n```', repeat: 50},
            {label: '行内代码 `` ` ... ` ``', token: '`npm install`', repeat: 83},
            {label: 'URL http(s)://', token: 'https://example.com/docs/getting-started', repeat: 36},
            {label: 'Windows 路径', token: 'C:\\Users\\demo\\projects\\sample\\main.ts', repeat: 35},
            {label: 'Unix 路径 /usr|home|var|etc|tmp|opt|bin', token: '/usr/local/share/doc/readme.md', repeat: 52},
            {label: '标识符 snake_case', token: 'snake_case_name', repeat: 64},
            {label: '驼峰标识符', token: 'camelCaseIdentifier', repeat: 44},
        ]
        for (const {label, token, repeat} of rows) {
            const text = `${CJK60} ${Array(repeat).fill(token).join(' ')} ${CJK60}`
            expect(detectDrift(text), label).toBe(false)
        }
    })

    it('样本不足（H+L=29）不判漂移', () => {
        // H=4（中文测试），L=25
        expect(detectDrift('中文测试' + 'a'.repeat(25))).toBe(false)
    })

    it('样本恰好 30 且 H/(H+L)=0.133 < 0.15 → 判漂移', () => {
        expect(detectDrift('中文测试' + 'a'.repeat(26))).toBe(true)
    })

    it('H/(H+L)=0.158 >= 0.15 → 不判漂移（阈值上侧）', () => {
        // H=6（这是六个汉字），L=32 → 6/38 = 0.158
        expect(detectDrift('这是六个汉字' + 'b'.repeat(32))).toBe(false)
    })

    it('H/(H+L)=0.140 < 0.15 → 判漂移（阈值下侧，样本充足）', () => {
        // H=6，L=37 → 6/43 = 0.1395
        expect(detectDrift('这是六个汉字' + 'b'.repeat(37))).toBe(true)
    })

    it('真实样本：中英混排技术中文（汉字占比≈0.5）不判漂移', () => {
        const text = '这次改动把 token 计数提到了 pre-step，避免 prefix cache 失效。'
            + '我顺手补了三个 case，跑完 vitest 全部通过。'
            + '注意 build 之后要手动重启 worker，否则旧 settings 还留在内存里。'
        expect(detectDrift(text)).toBe(false)
    })

    it('真实样本：纯英文判漂移', () => {
        expect(detectDrift('I have refactored the module and all tests pass now.')).toBe(true)
    })

    it('空文本不判漂移（纯 tool_calls 轮的兜底）', () => {
        expect(detectDrift('')).toBe(false)
    })
})

describe('matchLanguageExemption（spec §9-T2）', () => {
    it('命中：中英文意图表达（含"英文后无空格"与"English 单独出现"两个回归守卫）', () => {
        for (const s of [
            '用英文写',                        // ★ 交替分支若含空格（'英文 | English'）此例不命中
            '请翻译成英文',
            'English',                         // ★ 正则若写成 ' English'（前置空格）此例不命中
            'please answer in English',
            'translate to English',
            'translate into English',
        ]) {
            expect(matchLanguageExemption(s), s).toBe(true)
        }
    })

    it('不命中：普通中文请求', () => {
        for (const s of ['顺便看看日志', '这个函数为什么返回空', '继续']) {
            expect(matchLanguageExemption(s), s).toBe(false)
        }
    })

    it('无 /g 状态残留：同一输入连续两次调用结果一致', () => {
        // 带 /g 的 test() 会因 lastIndex 残留第二次返回 false
        expect(matchLanguageExemption('用英文写')).toBe(true)
        expect(matchLanguageExemption('用英文写')).toBe(true)
    })

    it('记录宽豁免的已知代价（spec §5.5）', () => {
        expect(matchLanguageExemption('这个单词 English 是什么意思')).toBe(true)
    })
})

describe('renderLanguageGuardContent（spec §5.7）', () => {
    it('逐字对齐冻结文案；同参数两次渲染字节相等（纯函数产物）', () => {
        const expected = '<system-reminder>\n'
            + '无论何时都必须使用简体中文书写，包括面向用户的回复、你的思考过程（reasoning）和工具调用规划。\n'
            + '这条要求覆盖此前上下文中的任何语言习惯。\n'
            + '</system-reminder>'
        expect(renderLanguageGuardContent('简体中文')).toBe(expected)
        expect(renderLanguageGuardContent('简体中文')).toBe(expected)
    })

    it('不含时间戳/轮次等可变信息（§3.3 确定性要求）', () => {
        const content = renderLanguageGuardContent('English')
        expect(content).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(content).not.toMatch(/turn \d/i)
        expect(content.startsWith('<system-reminder>\n')).toBe(true)
        expect(content.endsWith('</system-reminder>')).toBe(true)
    })
})

describe('restoreLanguageGuardState（spec §5.2）', () => {
    it('无注入消息 → {seeded:false, injectedCount:0}', () => {
        expect(restoreLanguageGuardState([userMsg('你好')])).toEqual({seeded: false, injectedCount: 0})
    })

    it('倒序取最后一条 language-guard 消息', () => {
        const messages = [
            userMsg('<system-reminder>old</system-reminder>',
                {sourceKind: SOURCE_KIND_LANGUAGE_GUARD, languageGuardCount: 1, languageGuardDigest: 'en'}),
            assistantMsg('ok'),
            userMsg('<system-reminder>new</system-reminder>',
                {sourceKind: SOURCE_KIND_LANGUAGE_GUARD, languageGuardCount: 3, languageGuardDigest: 'zh-CN'}),
        ]
        expect(restoreLanguageGuardState(messages)).toEqual(
            {seeded: true, injectedCount: 3, localeDigest: 'zh-CN'})
    })

    it('字段缺失兜底：count 缺失按 1、digest 缺失为 undefined', () => {
        const messages = [userMsg('<system-reminder>x</system-reminder>', {sourceKind: SOURCE_KIND_LANGUAGE_GUARD})]
        expect(restoreLanguageGuardState(messages)).toEqual({seeded: true, injectedCount: 1, localeDigest: undefined})
    })
})

describe('isLanguageGuardIteration（spec §3.2 门槛载体 / §9-T7）', () => {
    it('仅 run 首次迭代为 true', () => {
        expect(isLanguageGuardIteration(1)).toBe(true)
        expect(isLanguageGuardIteration(0)).toBe(false)
        expect(isLanguageGuardIteration(2)).toBe(false)
        expect(isLanguageGuardIteration(3)).toBe(false)
    })
})

describe('runLanguageGuardPreStep（spec §9-T3 触发矩阵）', () => {
    it('first-and-drift：seeded=false 注入预防消息（count=1），追加在末尾且落库一次', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('帮我看下这个报错')])
        const r = runLanguageGuardPreStep(state, {seeded: false, injectedCount: 0}, repo, CONV_ID, CN)

        const injected = lgMessages(r.state)
        expect(injected).toHaveLength(1)
        expect(injected[0].role).toBe('user')
        expect(injected[0].metadata).toMatchObject({
            sourceKind: SOURCE_KIND_LANGUAGE_GUARD,
            languageGuardCount: 1,
            languageGuardDigest: 'zh-CN',
        })
        expect(String(injected[0].content)).toContain('简体中文')
        expect(r.languageGuardState).toEqual({seeded: true, injectedCount: 1, localeDigest: 'zh-CN'})
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(1)
        // 追加式：前部逐项不动
        expect(r.state.messages.slice(0, state.messages.length)).toEqual(state.messages)
    })

    it('first-only：seeded=false 仍注入 seed；seed 之后即使漂移也不注入', () => {
        const repo = repoMock()
        const cfg = settingsWith({nativeLocale: 'zh-CN', strategy: 'first-only', correctionLimit: 3})
        const r1 = runLanguageGuardPreStep(
            createLoopState([userMsg('你好')]), {seeded: false, injectedCount: 0}, repo, CONV_ID, cfg)
        expect(lgMessages(r1.state)).toHaveLength(1)

        const driftState = createLoopState([userMsg('继续'), assistantMsg(DRIFT_TEXT)])
        const r2 = runLanguageGuardPreStep(driftState, r1.languageGuardState, repo, CONV_ID, cfg)
        expect(lgMessages(r2.state)).toHaveLength(0)
        expect(repo.writeMessagesDelta).toHaveBeenCalledTimes(1)
    })

    it('first-and-drift：seeded=true 且检测到漂移 → 注入 count+1', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('继续'), assistantMsg(DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(1)
        expect(r.languageGuardState.injectedCount).toBe(2)
        expect((lgMessages(r.state)[0].metadata as Record<string, unknown>).languageGuardCount).toBe(2)
    })

    it('熔断：limit=3 且已注入 3 次 → 明确漂移也不注入', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('继续'), assistantMsg(DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(
            state, {seeded: true, injectedCount: 3, localeDigest: 'zh-CN'}, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(0)
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
    })

    it("'always'：不设上限，计数继续递增", () => {
        const repo = repoMock()
        const cfg = settingsWith({nativeLocale: 'zh-CN', strategy: 'first-and-drift', correctionLimit: 'always'})
        const state = createLoopState([userMsg('继续'), assistantMsg(DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(
            state, {seeded: true, injectedCount: 99, localeDigest: 'zh-CN'}, repo, CONV_ID, cfg)
        expect(r.languageGuardState.injectedCount).toBe(100)
    })

    it('退化配置 limit=0：不注入，但登记 seed 与母语（不重复判定）', () => {
        const repo = repoMock()
        const cfg = settingsWith({nativeLocale: 'zh-CN', strategy: 'first-and-drift', correctionLimit: 0})
        const r = runLanguageGuardPreStep(
            createLoopState([userMsg('你好')]), {seeded: false, injectedCount: 0}, repo, CONV_ID, cfg)
        expect(lgMessages(r.state)).toHaveLength(0)
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
        expect(r.languageGuardState).toEqual({seeded: true, injectedCount: 0, localeDigest: 'zh-CN'})
    })

    it('母语变更：localeDigest 与当前 nativeLocale 不同 → 计数与 seed 重置（每母语独立配额）', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('你好')])
        const r = runLanguageGuardPreStep(
            state, {seeded: true, injectedCount: 3, localeDigest: 'en'}, repo, CONV_ID, CN)
        expect(r.languageGuardState).toEqual({seeded: true, injectedCount: 1, localeDigest: 'zh-CN'})
        expect((lgMessages(r.state)[0].metadata as Record<string, unknown>).languageGuardDigest).toBe('zh-CN')
    })

    it('同轮 seed 优先：seed 与漂移同时成立时只注入一条（每 run 至多注入一次）', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('继续'), assistantMsg(DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(state, {seeded: false, injectedCount: 0}, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(1)
        expect(r.languageGuardState.injectedCount).toBe(1)
    })

    it('前置条件：strategy=off 零副作用且原样返回入参引用', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('你好'), assistantMsg(DRIFT_TEXT)])
        const lg: LanguageGuardState = {seeded: true, injectedCount: 1, localeDigest: 'zh-CN'}
        const r = runLanguageGuardPreStep(state, lg, repo, CONV_ID, settingsWith({nativeLocale: 'zh-CN', strategy: 'off'}))
        expect(r.state).toBe(state)
        expect(r.languageGuardState).toBe(lg)
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
    })

    it('前置条件：settings 缺失 / nativeLocale 缺失 → 零副作用，绝不渲染 undefined 文案', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('你好')])
        const lg: LanguageGuardState = {seeded: false, injectedCount: 0}
        for (const s of [
            undefined,
            settingsWith(undefined),
            settingsWith({strategy: 'first-and-drift'}),
            settingsWith({nativeLocale: '', strategy: 'first-and-drift'}),
            settingsWith({nativeLocale: '   ', strategy: 'first-and-drift'}),
        ]) {
            const r = runLanguageGuardPreStep(state, lg, repo, CONV_ID, s)
            expect(lgMessages(r.state), String(s && (s.language?.nativeLocale ?? 'no-locale'))).toHaveLength(0)
        }
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
    })

    it('会话首轮（无 assistant 消息）：seed 照常注入（本用例在 seed 分支即返回，未触及门 1）', () => {
        const repo = repoMock()
        const r = runLanguageGuardPreStep(
            createLoopState([userMsg('你好')]), {seeded: false, injectedCount: 0}, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(1)   // 来自 seed，不是检测
    })

    it('门 1：纯 tool_calls 轮（正文与思考皆空）不注入', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('继续'), {id: nextId(), role: 'assistant', content: ''} as ChatMessage])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(0)
    })

    it('门 2：本轮最近 user 命中豁免 → 不注入', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('用英文写'), assistantMsg(DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(0)
    })

    it('门 2：只读真实用户消息 —— 内部注入消息含"英文"不得豁免本轮', () => {
        const repo = repoMock()
        const state = createLoopState([
            userMsg('把这段代码优化一下'),
            userMsg('<capability-catalog>英文能力目录</capability-catalog>', {sourceKind: SOURCE_KIND_CATALOG}),
            assistantMsg(DRIFT_TEXT),
        ])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        // 若误读内部消息内容 → 命中豁免 → 0 条
        expect(lgMessages(r.state)).toHaveLength(1)
    })

    it('门 2：多模态 user 消息（ContentPart[]）取 text part 匹配豁免', () => {
        const repo = repoMock()
        const state = createLoopState([{
            id: nextId(),
            role: 'user',
            content: [
                {type: 'text', text: '请用英文回答'},
                {type: 'image_url', image_url: {url: 'https://example.com/a.png'}},
            ],
        } as unknown as ChatMessage, assistantMsg(DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(0)
    })

    it('门 4：正文与思考分别判定 —— 正文中文但思考英文必须判漂移', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('继续'), assistantMsg(NORMAL_TEXT, DRIFT_TEXT)])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(1)
    })

    it('门 4：正文与思考皆母语 → 不注入', () => {
        const repo = repoMock()
        const state = createLoopState([userMsg('继续'), assistantMsg(NORMAL_TEXT, NORMAL_TEXT)])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(0)
    })

    it('门 4：冻结契约的第二个思考载体 —— reasoningContent 承载漂移文本同样触发注入', () => {
        const repo = repoMock()
        const state = createLoopState([
            userMsg('继续'),
            {id: nextId(), role: 'assistant', content: NORMAL_TEXT, reasoningContent: DRIFT_TEXT} as ChatMessage,
        ])
        const r = runLanguageGuardPreStep(state, SEEDED, repo, CONV_ID, CN)
        // 正文是母语样本（detectDrift 返回 false），唯一触发源是 reasoningContent 字段
        expect(lgMessages(r.state)).toHaveLength(1)
    })

    it('sessionId 为空：仅内存态，不落库但消息仍进入 state', () => {
        const repo = repoMock()
        const r = runLanguageGuardPreStep(
            createLoopState([userMsg('你好')]), {seeded: false, injectedCount: 0}, repo, undefined, CN)
        expect(repo.writeMessagesDelta).not.toHaveBeenCalled()
        expect(lgMessages(r.state)).toHaveLength(1)
    })

    it('conversationRepo 为 null：不落库、不抛异常', () => {
        const r = runLanguageGuardPreStep(
            createLoopState([userMsg('你好')]), {seeded: false, injectedCount: 0}, null, CONV_ID, CN)
        expect(lgMessages(r.state)).toHaveLength(1)
    })

    it('无变化时原样返回入参引用（与 env pre-step 惯例一致）', () => {
        const state = createLoopState([userMsg('继续'), assistantMsg(NORMAL_TEXT)])
        const lg: LanguageGuardState = {seeded: true, injectedCount: 1, localeDigest: 'zh-CN'}
        const r = runLanguageGuardPreStep(state, lg, repoMock(), CONV_ID, CN)
        expect(r.state).toBe(state)
        expect(r.languageGuardState).toBe(lg)
    })
})
