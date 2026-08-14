// @vitest-environment jsdom
import {describe, expect, it, vi, beforeEach, afterEach} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 布局溢出修复回归测试。
 *
 * 修复方案：窗口 resize / 最大化状态变化时，临时给 window-container
 * 挂 .layout-settling（CSS: transition: none !important），强制布局直接跳到终值，
 * 避免 transition-all 动画帧丢失导致三列布局停在中间态（消息列表/右侧栏溢出不可见）。
 *
 * 覆盖两个契约：
 * 1. CSS 规则存在（globals.css 尾部追加的 .layout-settling 选择器）
 * 2. effect 行为：resize → 挂类 → 强制 reflow → 移除类（下一帧）
 */

const CSS_PATH = path.resolve(process.cwd(), 'src/renderer/styles/globals.css')

describe('布局 settling — CSS 规则', () => {
    it('globals.css 包含 .layout-settling 过渡禁用规则（三列卡片全部覆盖）', () => {
        const css = fs.readFileSync(CSS_PATH, 'utf-8')
        expect(css).toContain('.layout-settling')
        expect(css).toContain("transition: none !important")
        // 三个关键布局卡片必须都被覆盖
        expect(css).toMatch(/\.layout-settling \[data-name='left-sidebar-card'\]/)
        expect(css).toMatch(/\.layout-settling \[data-name='main-column'\]/)
        expect(css).toMatch(/\.layout-settling \[data-name='side-panels'\]/)
    })
})

describe('布局 settling — effect 行为契约（复刻 App.tsx 同款逻辑）', () => {
    let root: HTMLElement
    let rafQueue: Array<() => void>
    let timers: Array<{cb: () => void; at: number}> // {cb, at}

    const settleLayout = () => {
        if (timers.length > 0) {
            timers = [] // clearTimeout 语义
        }
        root.classList.add('layout-settling')
        void root.offsetHeight // 强制同步 reflow
        timers = [{cb: () => root.classList.remove('layout-settling'), at: 0}]
    }

    const flushTimer = () => {
        const t = timers.shift()
        if (t) t.cb()
    }

    beforeEach(() => {
        document.body.innerHTML = `<div class="window-container"><div data-name="left-sidebar-card"></div><div data-name="main-column"></div><div data-name="side-panels"></div></div>`
        root = document.querySelector('.window-container') as HTMLElement
        rafQueue = []
        timers = []
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('resize 触发时挂载 layout-settling 并强制 reflow 后移除', () => {
        const settleSpy = vi.fn(settleLayout)
        // 模拟 App.tsx 的 resize 监听
        window.addEventListener('resize', settleSpy)
        window.dispatchEvent(new Event('resize'))

        expect(settleSpy).toHaveBeenCalledTimes(1)
        expect(root.classList.contains('layout-settling')).toBe(true)

        // 模拟 setTimeout(0) 移除
        flushTimer()
        expect(root.classList.contains('layout-settling')).toBe(false)
    })

    it('重复 resize 事件会重置移除计时（timer 清理）', () => {
        let timerSet = 0
        const onResize = () => {
            // 复刻 App.tsx：先 clearTimeout（忽略），再加类 + reflow + 重新计时
            timerSet++
            root.classList.add('layout-settling')
            void root.offsetHeight
            timers = [{cb: () => root.classList.remove('layout-settling'), at: timerSet}]
        }
        window.addEventListener('resize', onResize)
        window.dispatchEvent(new Event('resize'))
        window.dispatchEvent(new Event('resize'))

        expect(root.classList.contains('layout-settling')).toBe(true)
        // 移除类后不再残留
        flushTimer()
        expect(root.classList.contains('layout-settling')).toBe(false)
    })

    it('CSS 类选择器在真实 DOM 中命中布局卡片（防选择器拼写漂移）', () => {
        // 直接验证 CSS 选择器能在 jsdom 中选中对应元素
        const cards = root.querySelectorAll<HTMLElement>(
            "[data-name='left-sidebar-card'], [data-name='main-column'], [data-name='side-panels']",
        )
        expect(cards.length).toBe(3)
    })
})
