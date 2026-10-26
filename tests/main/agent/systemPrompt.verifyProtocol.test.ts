/**
 * system.verify（知识边界查证协议）节点契约。
 *
 * 依据：
 * - src/shared/prompts.ts：SYSTEM_PROMPT_NODES 中 system.verify 定义（system.rules 之后、system.workflow 之前）
 * - src/main/agent/systemPrompt.ts：渲染 push 顺序同上（buildSystemPrompt 输出顺序即数组顺序）
 *
 * ⇒ 契约：该段常驻 system 前缀，默认值逐字进入渲染结果，且不含具体 MCP 工具注册名。
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('../../../src/main/config', () => ({getHclawDir: () => '/tmp/hclaw-test'}))
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))

import {buildSystemPrompt} from '../../../src/main/agent/systemPrompt'
import {getPromptNodeByKey} from '../../../src/shared/prompts'

const CTX = {workingDir: '/x', tools: [], permissionMode: 'safe', agentType: 'General' as const}

describe('system.verify（知识边界查证协议）', () => {
    it('默认值逐字出现在渲染结果中（不 trim / 不截断）', async () => {
        const node = getPromptNodeByKey('system.verify')
        expect(node).toBeDefined()
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain(node!.defaultValue)
    })

    it('位于核心规则之后、工作流程之前', async () => {
        const p = await buildSystemPrompt(CTX)
        expect(p.indexOf('## 知识边界查证')).toBeGreaterThan(p.indexOf('## 核心规则'))
        expect(p.indexOf('## 知识边界查证')).toBeLessThan(p.indexOf('## 工作流程'))
    })

    it('默认值 ≤ 900 字符', () => {
        expect(getPromptNodeByKey('system.verify')!.defaultValue.length).toBeLessThanOrEqual(900)
    })

    it('不写死 MCP 工具注册名（未安装 Context7 的用户不应拿到死链）', () => {
        expect(getPromptNodeByKey('system.verify')!.defaultValue).not.toMatch(/m_context7_\w+/)
    })

    it('子会话（带 languageSection）同样渲染该段（C8：只跳过 schedule 的记忆注入，不跳过 system 段）', async () => {
        const p = await buildSystemPrompt({...CTX, languageSection: '必须使用简体中文书写'})
        expect(p).toContain('## 知识边界查证')
    })
})

describe('system.workflow（工具分工规则）', () => {
    it('渲染结果包含工具分工规则（默认值逐字进入 system 前缀）', async () => {
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain('6. **工具分工** — 读文件用 file_read')
        // 原 6-8 条顺延为 7-9，防止插入时编号错位
        expect(p).toContain('7. **确认存在**')
        expect(p).toContain('9. **追踪遗留**')
    })
})
