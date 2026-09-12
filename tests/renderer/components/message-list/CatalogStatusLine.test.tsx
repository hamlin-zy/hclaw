// @vitest-environment jsdom
/**
 * CatalogStatusLine 纯 props 组件测试
 * - 显示条数且默认收起
 * - 点击展开列出条目，再点击收起
 */
import {describe, it, expect} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {CatalogStatusLine, parseCatalogEntriesFromContent} from '../../../../src/renderer/components/message-list/CatalogStatusLine'

describe('parseCatalogEntriesFromContent', () => {
    it('full 模式：从 <available_skills> 行解析 name/description', () => {
        const content = `<system-reminder>\n\n<available_skills>\n- [skill] \`alpha\`: Do A | when A\n- [skill] \`beta\`: Do B\n</available_skills>\n</system-reminder>`
        const entries = parseCatalogEntriesFromContent(content)
        expect(entries.map(e => e.name)).toEqual(['alpha', 'beta'])
        expect(entries[0].description).toBe('Do A | when A')
        expect(entries[1].description).toBe('Do B')
    })

    it('names 模式：解析逗号分隔索引', () => {
        const content = '<available_skills>\nalpha, beta, gamma\n</available_skills>'
        const entries = parseCatalogEntriesFromContent(content)
        expect(entries.map(e => e.name)).toEqual(['alpha', 'beta', 'gamma'])
    })

    it('空目录/无块时返回 []', () => {
        expect(parseCatalogEntriesFromContent('No skills are currently available.')).toEqual([])
        expect(parseCatalogEntriesFromContent('<available_skills>\n</available_skills>')).toEqual([])
    })

    it('MCP 目录：从 <available_mcp_tools> 解析 name/description（type=mcp）', () => {
        const content = `<system-reminder>
The following MCP tools are available in this session:

<available_mcp_tools>
- m_github_create_issue: create_issue args: {repo:string*, title:string*}
- m_playwright_navigate: navigate args: {url:string*}
</available_mcp_tools>

MCP tools are not declared natively. Call them via the \`call_mcp_tool\` tool:
</system-reminder>`
        const entries = parseCatalogEntriesFromContent(content)
        expect(entries.map(e => e.name)).toEqual(['m_github_create_issue', 'm_playwright_navigate'])
        expect(entries.every(e => e.type === 'mcp')).toBe(true)
        expect(entries[0].description).toContain('args: {repo:string*')
        // 引导段落（含冒号的行）不得被误解析为条目
        expect(entries).toHaveLength(2)
    })

    it('两类目录块同时存在 → 合并返回', () => {
        const content = `<available_skills>
alpha
</available_skills>
<available_mcp_tools>
- m_a_b: d
</available_mcp_tools>`
        const entries = parseCatalogEntriesFromContent(content)
        expect(entries.map(e => `${e.type}:${e.name}`)).toEqual(['skill:alpha', 'mcp:m_a_b'])
    })

    it('MCP 空目录（empty 文案）→ 返回 []', () => {
        expect(parseCatalogEntriesFromContent('No MCP tools are currently available. Do not use MCP tool names from earlier catalogs.')).toEqual([])
        expect(parseCatalogEntriesFromContent('<available_mcp_tools>\n</available_mcp_tools>')).toEqual([])
    })
})

describe('CatalogStatusLine', () => {
    it('显示条数且默认收起', () => {
        render(<CatalogStatusLine entries={[{name: 'a', type: 'skill', description: 'd'}]} />)
        expect(screen.getByText(/已加载能力目录（1 项）/)).toBeTruthy()
        expect(screen.queryByText('a')).toBeNull()
    })

    it('点击展开列出条目，再点击收起', () => {
        render(
            <CatalogStatusLine
                entries={[
                    {name: 'a', type: 'skill', description: 'd'},
                    {name: 'b', type: 'command', description: 'e'},
                ]}
            />,
        )
        const toggle = screen.getByText(/已加载能力目录（2 项）/)
        fireEvent.click(toggle)
        expect(screen.getByText('a')).toBeTruthy()
        expect(screen.getByText('b')).toBeTruthy()
        fireEvent.click(toggle)
        expect(screen.queryByText('a')).toBeNull()
        expect(screen.queryByText('b')).toBeNull()
    })

    it('entries 为空数组时显示 0 项（计数来自解析 fallback，由 MessageList 传入）', () => {
        render(<CatalogStatusLine entries={[]} />)
        expect(screen.getByText(/已加载能力目录（0 项）/)).toBeTruthy()
    })
})
