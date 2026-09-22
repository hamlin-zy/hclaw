// @vitest-environment jsdom
/**
 * CapabilityBadge 组件测试
 *
 * 覆盖：
 * 1. 渲染：类型标签 + 名称正确显示
 * 2. × 清除按钮：点击后调用 onClear
 * 3. 点击徽标本体：调用 onClick（重开 CommandPalette）
 * 4. × 点击不冒泡到本体 onClick
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup} from '@testing-library/react'
import CapabilityBadge from '@/renderer/components/common/CapabilityBadge'
import type {SelectedCapability} from '@/renderer/components/InputArea'

const cmdCap: SelectedCapability = {commandId: 'cmd:deploy', type: 'command', name: 'deploy'}
const skillCap: SelectedCapability = {commandId: 'tdd', type: 'skill', name: 'tdd'}
const agentCap: SelectedCapability = {commandId: 'Implementer', type: 'agent', name: 'Implementer'}
const pluginCap: SelectedCapability = {commandId: 'plugin:foo:bar', type: 'plugin', name: 'bar'}

beforeEach(() => {})
afterEach(() => { cleanup() })

describe('CapabilityBadge 渲染', () => {
    it('命令类型显示「命令」标签 + 名称', () => {
        render(<CapabilityBadge capability={cmdCap} onClear={vi.fn()} onClick={vi.fn()} />)
        expect(screen.getByText('命令')).toBeTruthy()
        expect(screen.getByText('deploy')).toBeTruthy()
    })

    it('Skill 类型显示「Skill」标签', () => {
        render(<CapabilityBadge capability={skillCap} onClear={vi.fn()} onClick={vi.fn()} />)
        expect(screen.getByText('Skill')).toBeTruthy()
        expect(screen.getByText('tdd')).toBeTruthy()
    })

    it('Agent 类型显示「Agent」标签', () => {
        render(<CapabilityBadge capability={agentCap} onClear={vi.fn()} onClick={vi.fn()} />)
        expect(screen.getByText('Agent')).toBeTruthy()
        expect(screen.getByText('Implementer')).toBeTruthy()
    })

    it('插件命令类型显示「插件命令」标签', () => {
        render(<CapabilityBadge capability={pluginCap} onClear={vi.fn()} onClick={vi.fn()} />)
        expect(screen.getByText('插件命令')).toBeTruthy()
        expect(screen.getByText('bar')).toBeTruthy()
    })
})

describe('CapabilityBadge 交互', () => {
    it('点击 × 调用 onClear', () => {
        const onClear = vi.fn()
        render(<CapabilityBadge capability={cmdCap} onClear={onClear} onClick={vi.fn()} />)
        fireEvent.click(screen.getByLabelText('清除已选能力 deploy'))
        expect(onClear).toHaveBeenCalledTimes(1)
    })

    it('点击徽标本体调用 onClick', () => {
        const onClick = vi.fn()
        render(<CapabilityBadge capability={cmdCap} onClear={vi.fn()} onClick={onClick} />)
        fireEvent.click(screen.getByText('deploy'))
        expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('× 点击不冒泡到 onClick', () => {
        const onClick = vi.fn()
        const onClear = vi.fn()
        render(<CapabilityBadge capability={cmdCap} onClear={onClear} onClick={onClick} />)
        fireEvent.click(screen.getByLabelText('清除已选能力 deploy'))
        expect(onClear).toHaveBeenCalledTimes(1)
        expect(onClick).not.toHaveBeenCalled()
    })
})
