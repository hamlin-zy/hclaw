// @vitest-environment jsdom
/** 会话图标规格（spec §5.1 / V2） */
import {describe, it, expect, afterEach} from 'vitest'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {render, cleanup} from '@testing-library/react'
import {SessionIcon} from '../../../src/renderer/components/ConversationSidebar'

afterEach(cleanup)

const svgOf = (c: HTMLElement) => c.querySelector('svg')!

describe('SessionIcon 规格', () => {
    it('统一 14px 画布 + stroke 1.5 纯描边（微信与定时同理）', () => {
        for (const channel of ['wechat', 'feishu', 'default', 'schedule'] as const) {
            const {container} = render(<SessionIcon channel={channel} isActive={false}/>)
            const svg = svgOf(container)
            expect(svg.getAttribute('width')).toBe('14')
            expect(svg.getAttribute('height')).toBe('14')
            expect(svg.getAttribute('stroke-width')).toBe('1.5')
            cleanup()
        }
    })

    it('置顶不再替换类型剪影（类型信息不丢）', () => {
        const a = render(<SessionIcon channel="feishu" isActive={false}/>)
        const silhouette = svgOf(a.container).innerHTML
        cleanup()
        const b = render(<SessionIcon channel="feishu" pinned isActive={false}/>)
        expect(svgOf(b.container).innerHTML).toBe(silhouette)
    })

    it('未选中用 --text-muted，选中用 currentColor', () => {
        const off = render(<SessionIcon channel="default" isActive={false}/>)
        // jsdom 下 SVGElement.className 是 SVGAnimatedString（非字符串），按 class 属性读取
        expect(svgOf(off.container).getAttribute('class')).toContain('--text-muted')
        cleanup()
        const on = render(<SessionIcon channel="default" isActive/>)
        expect(svgOf(on.container).getAttribute('class')).toContain('currentColor')
    })

    it('--act-bg 令牌在 4 个主题块内均有定义（浅色主题不沿用白色叠加）', () => {
        const css = readFileSync(resolve(process.cwd(), 'src/renderer/styles/globals.css'), 'utf8')
        /** 按主题选择器切出块体：从行首 `选择器 {` 到其后的首个行首 `}`（块内只有缩进的嵌套闭合） */
        const blockOf = (selector: string): string => {
            const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const m = new RegExp(`^${escaped} \\{[\\s\\S]*?^\\}`, 'm').exec(css)
            expect(m, `未找到主题块 ${selector}`).not.toBeNull()
            return m![0]
        }
        for (const selector of [':root', '.dark', '.yuanshandai', '.shiyangjin']) {
            const block = blockOf(selector)
            // 切片必须是完整块，否则断言可能在读到别的主题块时假绿
            expect(block.endsWith('}'), `${selector} 切片不是完整块`).toBe(true)
            expect(block, `${selector} 缺少 --act-bg`).toContain('--act-bg')
        }
    })
})
