/**
 * 子会话语言要求常驻 system 段（brief §2 / §3.1）
 *
 * 口径：
 * - 文案是纯函数产物（相同母语 → 相同字节，无时间戳/轮次）；
 * - 判定 resolveSubagentLanguageSection：主会话恒 null（system 字节与缓存签名不变，
 *   anthropicAdapter 唯一 cache_control 断点在 system 上）；
 * - system 注入的**装配点**在 controller / setup；languageGuardPublish 只提供
 *   文案与判定纯函数（不触碰 system prompt 标识符，见 controller.languageGuardWiring.test.ts）。
 *
 * mock 与 setup.cacheSignature.test.ts 同款（config / hclawPaths 桩）。
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({
    getHclawDir: () => '/tmp/hclaw-test',
}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

import {buildSystemPrompt} from '@/main/agent/loop/setup'
import {buildSystemSignature} from '@/main/agent/loop/controller'
import {
    renderLanguageSystemSection,
    resolveSubagentLanguageSection,
} from '@/main/agent/loop/languageGuardPublish'
import type {SystemSettings} from '@shared/types'

/** 语言设置桩：只填 language 段（其余字段与本用例无关，用断言绕过完整型别） */
function settings(language: SystemSettings['language']): SystemSettings {
    return {language} as unknown as SystemSettings
}

const ZH = {strategy: 'first-and-drift', nativeLocale: 'zh-CN'} as const

const baseParams = {
    commandContext: null,
    agentDefinition: undefined,
    workingDir: '/x',
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    customInstructions: undefined,
    agentType: 'General',
    agentTemplates: undefined,
}

describe('renderLanguageSystemSection（brief §2.1 冻结文案）', () => {
    it('逐字对齐；不带 <system-reminder> 包裹', () => {
        const expected = '## 语言要求\n\n'
            + '无论何时都必须使用简体中文书写，包括面向用户的回复、你的思考过程（reasoning）和工具调用规划。\n'
            + '这条要求覆盖此前上下文中的任何语言习惯。'
        expect(renderLanguageSystemSection('简体中文')).toBe(expected)
        expect(renderLanguageSystemSection('简体中文')).not.toContain('<system-reminder>')
    })
})

describe('resolveSubagentLanguageSection（brief §2.2）', () => {
    it('主会话（isSubagentRun=false）→ null：system 字节与缓存签名不变', () => {
        expect(resolveSubagentLanguageSection(false, settings(ZH))).toBe(null)
    })

    it('子会话 + 简体中文母语 → 含「## 语言要求」与冻结子串', () => {
        const section = resolveSubagentLanguageSection(true, settings(ZH))
        expect(section).toContain('## 语言要求')
        expect(section).toContain('必须使用简体中文书写')
    })

    it('strategy=off → null', () => {
        expect(resolveSubagentLanguageSection(true, settings({strategy: 'off', nativeLocale: 'zh-CN'}))).toBe(null)
    })

    it('nativeLocale 缺失 / settings 缺失 → null（宁可不注入，也不注入 undefined）', () => {
        expect(resolveSubagentLanguageSection(true, settings({strategy: 'first-and-drift'}))).toBe(null)
        expect(resolveSubagentLanguageSection(true, undefined)).toBe(null)
    })

    /**
     * ⚠ 契约冲突（待主会话裁决，已记入 report.md「契约偏离项」）：
     * brief 正文 §3.1-③ 要求「未知 locale（如 'xx-YY'）→ null」，但 §2.2 冻结代码块
     * 的实现链是 localeDisplayName(nativeLocale)，其回退链末端为「原始 locale 串」，
     * 故 'xx-YY' 非空 → 代码块返回文案。本文件按 brief 自述的
     * 「正文与代码块冲突时以代码块为准」实现并断言代码块行为。
     */
    it('未知 locale（xx-YY）→ 按冻结代码块走 localeDisplayName 回退为原始 locale 串', () => {
        const section = resolveSubagentLanguageSection(true, settings({strategy: 'first-and-drift', nativeLocale: 'xx-YY'}))
        expect(section).toContain('必须使用xx-YY书写')
    })

    it('确定性：同输入两次调用字节相等，不含时间戳/轮次', () => {
        const a = resolveSubagentLanguageSection(true, settings(ZH))
        const b = resolveSubagentLanguageSection(true, settings(ZH))
        expect(a).toBe(b)
        expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(a).not.toMatch(/turn \d/i)
    })
})

describe('buildSystemSignature 第 5 参 languageSection（brief §2.5-1）', () => {
    it('传入语言段 → 签名变化；未传 / undefined / null === 旧四参结果', () => {
        const noSection = buildSystemSignature('/x', 'General', undefined, undefined)
        const withSection = buildSystemSignature(
            '/x', 'General', undefined, undefined, renderLanguageSystemSection('简体中文'))
        expect(withSection).not.toBe(noSection)
        expect(buildSystemSignature('/x', 'General', undefined, undefined, undefined)).toBe(noSection)
        expect(buildSystemSignature('/x', 'General', undefined, undefined, null)).toBe(noSection)
    })

    /**
     * Fix 轮 2 · Fix-1：主会话语义下签名 JSON **必须逐字等于改动前的旧格式**。
     * 旧实现把 `languageSection: ''` 无条件写进 JSON → 存量会话（本机 636 条）
     * 下次运行全部"签名不匹配 → 重建 system 并写库一次"（system 内容 byte-equal，
     * 无 token 损失，但属可避免的全局副作用）。条件入键后此断言成立。
     */
    it('主会话语义（无语言段）签名逐字等于旧格式：不因"多一个空键"触发存量会话重建', () => {
        expect(buildSystemSignature('/x', 'General', undefined, undefined))
            .toBe('{"workingDir":"/x","agentType":"General","customInstructions":""}')
        expect(buildSystemSignature('/x', 'General', undefined, undefined, null))
            .toBe('{"workingDir":"/x","agentType":"General","customInstructions":""}')
        expect(buildSystemSignature('/x', 'General', undefined, undefined, undefined))
            .toBe('{"workingDir":"/x","agentType":"General","customInstructions":""}')
    })
})

describe('setup 版 buildSystemPrompt 透传 languageSection（brief §2.3 / §2.4）', () => {
    it('传 languageSection → 输出含语言要求段', async () => {
        const p = await buildSystemPrompt({...baseParams, languageSection: renderLanguageSystemSection('简体中文')})
        expect(p).toContain('必须使用简体中文书写')
    })

    it('不传 / 显式传 null → 输出字节等价；且与含语言段的结果不同（主会户口径，system 字节不变）', async () => {
        const noKey = await buildSystemPrompt({...baseParams})
        const explicitNull = await buildSystemPrompt({...baseParams, languageSection: null})
        // 字节等价：两条"无语言段"路径产出完全相同的字符串（不依赖文案子串）
        expect(noKey).toBe(explicitNull)
        // 佐证上一条非恒真：语言段确实参与装配（若 buildSystemPrompt 忽略该入参，本行必红）
        const withSection = await buildSystemPrompt({
            ...baseParams,
            languageSection: renderLanguageSystemSection('简体中文'),
        })
        expect(withSection).not.toBe(noKey)
    })

    it('缓存：languageSection 相同 → 原样复用；语言段变化 → 不复用并重建', async () => {
        const section = renderLanguageSystemSection('简体中文')
        const fresh = await buildSystemPrompt({...baseParams, languageSection: section})
        const sig = buildSystemSignature('/x', 'General', undefined, undefined, section)
        const reused = await buildSystemPrompt({
            ...baseParams,
            languageSection: section,
            cachedSystemPrompt: fresh,
            cacheSignature: sig,
            cachedSignature: sig,
        })
        expect(reused).toBe(fresh)

        const otherSection = renderLanguageSystemSection('English')
        const otherSig = buildSystemSignature('/x', 'General', undefined, undefined, otherSection)
        const rebuilt = await buildSystemPrompt({
            ...baseParams,
            languageSection: otherSection,
            cachedSystemPrompt: fresh,
            cacheSignature: otherSig,
            cachedSignature: sig,
        })
        expect(rebuilt).not.toBe(fresh)
        expect(rebuilt).toContain('必须使用English书写')
    })
})
