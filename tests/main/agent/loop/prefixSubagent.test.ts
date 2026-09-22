/**
 * 子会话首轮请求体字节确定（组 C · P1-8 第三段）
 *
 * 契约：
 * - 子会话（agentTool 内联 loop）首轮 messages 恒为 `[{role:'user', content: args.task}]`
 *   （agentTool.ts:481-483；落库同源 agentTool.ts:367-373），**不含时间戳/日期**：
 *   同 task 两次派发必须得到同一请求体字节。
 * - 子会话 system = 主会话稳定 base **+ 常驻语言段**（resolveSubagentLanguageSection，
 *   仅子会话非 null；段文案不含时间戳，见 languageGuardPublish.ts:86 注释「相同母语 →
 *   相同字节；禁止时间戳/轮次/计数」）。主会话该段恒 null → 主会话 system 字节不受影响。
 *
 * 判别力：
 * - 语言段若被塞入时间戳/轮次/nativeLocale 以外的变量 → 字节确定用例红；
 * - 若段只在"首次运行"注入（而非常驻）→ 「两次构建 system 相等」仍绿，但
 *   「子会话 system = 主会话 base + 段」的装配断言会红（说明装配点被改）。
 * - 若有人把时间戳拼进子会话首轮 user content（如 `[2026-09-22 15:00] task`）→ 护栏命中。
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({getHclawDir: () => '/tmp/hclaw-test'}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

import {buildSystemPrompt} from '@/main/agent/loop/setup'
import {
    resolveSubagentLanguageSection,
    renderLanguageSystemSection,
} from '@/main/agent/loop/languageGuardPublish'
import type {SystemSettings} from '@shared/types'

const settings = {language: {strategy: 'guard', nativeLocale: 'zh-CN'}} as unknown as SystemSettings

const baseSystemParams = {
    commandContext: null,
    agentDefinition: undefined,
    workingDir: 'E:/ws',
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    customInstructions: undefined,
    agentType: 'General',
    agentTemplates: undefined,
}

/** 复刻 agentTool 的子会话首轮消息构造（agentTool.ts:481-483） */
const subagentFirstMessages = (task: string) => [{role: 'user', content: task}] as const

const TASK = '调研 hclaw 注入管线并输出报告'

describe('子会话首轮请求体字节确定', () => {
    it('同 task 两次派发 → 首轮 messages 序列化完全相等，且不含日期/毫秒戳/相对时间词', () => {
        const a = subagentFirstMessages(TASK)
        const b = subagentFirstMessages(TASK)
        expect(JSON.stringify(a)).toBe(JSON.stringify(b))
        expect(a[0].content).toBe(TASK)
        expect(a[0].content).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(a[0].content).not.toMatch(/\b1[0-9]{12}\b/)
        expect(a[0].content).not.toMatch(/刚刚|今天|昨天|上周/)
    })

    it('子会话常驻语言段：同母语两次产出逐字节相等，且无时间戳类漂移源', () => {
        const s1 = resolveSubagentLanguageSection(true, settings)
        const s2 = resolveSubagentLanguageSection(true, settings)
        expect(s1).toBeTruthy()
        expect(s1).toBe(s2)                       // 常量文案（纯函数）
        expect(s1).toBe(renderLanguageSystemSection('简体中文'))
        expect(s1!).not.toMatch(/\d{4}-\d{2}-\d{2}/)
        expect(s1!).not.toMatch(/\b1[0-9]{12}\b/)
        expect(s1!).not.toMatch(/刚刚|今天|昨天|上周/)
    })

    it('主会话该段恒为 null（system 字节不受子会话特性影响）', () => {
        expect(resolveSubagentLanguageSection(false, settings)).toBeNull()
    })

    it('子会话 system = 主会话稳定 base + 常驻语言段；两次构建逐字节相等', async () => {
        const section = resolveSubagentLanguageSection(true, settings)
        const sub1 = await buildSystemPrompt({...baseSystemParams, languageSection: section})
        const sub2 = await buildSystemPrompt({...baseSystemParams, languageSection: section})
        const main = await buildSystemPrompt({...baseSystemParams, languageSection: null})

        expect(sub1).toBe(sub2)                                   // 首轮 system 字节确定
        expect(sub1).toContain(section!)                          // 段确实进了 system
        // 除该段外，子会话 system 与主会话 base 相同（段是唯一差异项；仅相邻空白不同）
        const normalize = (s: string) => s.replace(section!, '').replace(/\s+/g, ' ').trim()
        expect(normalize(sub1)).toBe(normalize(main))
        expect(sub1).not.toBe(main)
        expect(main).not.toContain('## 语言要求')
        // 子会话 system 同样不得含日期（日期走 env 注入消息，不进 system）
        expect(sub1).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    })
})
