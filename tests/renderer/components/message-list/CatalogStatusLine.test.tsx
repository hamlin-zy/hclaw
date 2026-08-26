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
