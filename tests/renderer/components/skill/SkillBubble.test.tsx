// @vitest-environment jsdom
/**
 * SkillBubble 渲染测试（Task 0.7，C14 简化前置回归网）
 *
 * 断言目标（每条均绑定具体值/结构，删掉对应实现即变红）：
 * 1. 传入 skillName + status 时不崩，且 skillName 与状态标签文案照实渲染
 *    —— 依赖 getStatusConfig(STATUS_CONFIGS) 的 label 映射。
 * 2. 头部交互容器恒有非空且等于固定值的 data-name="skill-bubble-div"
 *    —— 依赖 <div ... data-name="skill-bubble-div">。
 * 3. logs 非空时出现交互 button，其 data-name 非空且恒等于 "skill-bubble-button"，
 *    点击后展开渲染日志 message —— 依赖 LogsSection 的 button 与其 data-name。
 */
import {describe, it, expect} from 'vitest'
import {render, screen, fireEvent} from '@testing-library/react'
import {SkillBubble} from '../../../../src/renderer/components/skill/SkillBubble'

describe('SkillBubble 渲染', () => {
    it('渲染 skillName 与状态标签文案（status=executing → 执行中）', () => {
        render(<SkillBubble skillName="weather" status="executing" />)
        // skillName 照实渲染
        expect(screen.getByText('weather')).toBeTruthy()
        // 状态标签来自 STATUS_CONFIGS[executing].label
        expect(screen.getByText('执行中')).toBeTruthy()
    })

    it('头部交互容器带非空且为固定值的 data-name', () => {
        const {container} = render(<SkillBubble skillName="weather" status="matched" />)
        const header = container.querySelector('[data-name="skill-bubble-div"]') as HTMLElement | null
        expect(header).not.toBeNull()
        // 绑定具体值，而非仅断言非空
        expect(header!.getAttribute('data-name')).toBe('skill-bubble-div')
    })

    it('logs 非空时出现 button，其 data-name 为固定值，点击后展开渲染日志', () => {
        render(
            <SkillBubble
                skillName="weather"
                status="executing"
                logs={[{timestamp: 1700000000000, type: 'output', message: 'hello-log'}]}
            />,
        )
        const btn = screen.getByText('执行日志 (1)').closest('button') as HTMLButtonElement | null
        expect(btn).not.toBeNull()
        expect(btn!.getAttribute('data-name')).toBe('skill-bubble-button')
        // 初始收起：日志 message 不可见
        expect(screen.queryByText('hello-log')).toBeNull()
        // 点击展开：message 出现
        fireEvent.click(btn!)
        expect(screen.getByText('hello-log')).toBeTruthy()
    })

    it('status=done 且有 result 时渲染结果内容（formatContent 转义后落入 DOM）', () => {
        render(
            <SkillBubble
                skillName="weather"
                status="done"
                result={{type: 'inline', content: '**ok**'}}
            />,
        )
        // formatContent 将 **ok** 转为 <strong>ok</strong>
        const strong = document.querySelector('strong')
        expect(strong).not.toBeNull()
        expect(strong!.textContent).toBe('ok')
    })
})
