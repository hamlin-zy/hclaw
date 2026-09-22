// @vitest-environment jsdom
/**
 * CommandPalette 组件测试
 *
 * 覆盖：
 * 1. 选中命令后调用 onSelectCapability 新签名（commandId, type, name）
 * 2. 选中后不再打开 ParamInputModal（不再渲染参数弹窗）
 * 3. 键盘 Enter 选中当前高亮项
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, cleanup, waitFor} from '@testing-library/react'

// Mock CommandList 以避免 IPC 调用，直接渲染测试命令
vi.mock('@/renderer/components/plugin/CommandList', () => ({
    CommandList: ({onCommandClick, onCommandsLoaded, onFilteredCommandsChange}: {
        onCommandClick: (cmd: any) => void
        onCommandsLoaded?: (cmds: any[]) => void
        onFilteredCommandsChange?: (cmds: any[]) => void
    }) => {
        // 模拟命令列表
        const commands = [
            {id: 'cmd:deploy', name: 'deploy', description: '部署命令', hasArgs: true, source: 'user'},
            {id: 'tdd', name: 'tdd', description: 'TDD', hasArgs: false, source: 'skill'},
            {id: 'Implementer', name: 'Implementer', description: '实现代理', hasArgs: false, source: 'agent'},
        ]
        React.useEffect(() => {
            onCommandsLoaded?.(commands)
            onFilteredCommandsChange?.(commands)
        }, [])
        return (
            <div>
                {commands.map((cmd, i) => (
                    <button
                        key={cmd.id}
                        data-name={`command-list-command-item-${i}`}
                        onClick={() => onCommandClick(cmd)}
                    >
                        {cmd.name}
                    </button>
                ))}
            </div>
        )
    },
}))

// Mock framer-motion（jsdom 环境不支持动画）
vi.mock('framer-motion', () => ({
    motion: {
        div: ({children, className, onClick, ...props}: any) => (
            <div className={className} onClick={onClick} {...props}>{children}</div>
        ),
    },
    AnimatePresence: ({children}: any) => <>{children}</>,
}))

import React from 'react'
import {CommandPalette} from '@/renderer/components/plugin/CommandPalette'

beforeEach(() => {})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('CommandPalette onSelectCapability 新签名', () => {
    it('点击命令调用 onSelectCapability(commandId, type, name)', async () => {
        const onSelectCapability = vi.fn()
        const onClose = vi.fn()
        render(<CommandPalette isOpen={true} onClose={onClose} onSelectCapability={onSelectCapability} />)

        await waitFor(() => expect(screen.getByText('deploy')).toBeTruthy())

        // 点击 deploy 命令（source='user' → 归一化为 type='command'）
        fireEvent.click(screen.getByText('deploy'))
        expect(onSelectCapability).toHaveBeenCalledWith('cmd:deploy', 'command', 'deploy')
        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('点击 skill 类型命令传递 type="skill"', async () => {
        const onSelectCapability = vi.fn()
        const onClose = vi.fn()
        render(<CommandPalette isOpen={true} onClose={onClose} onSelectCapability={onSelectCapability} />)

        await waitFor(() => expect(screen.getByText('tdd')).toBeTruthy())
        fireEvent.click(screen.getByText('tdd'))
        expect(onSelectCapability).toHaveBeenCalledWith('tdd', 'skill', 'tdd')
    })

    it('点击 agent 类型命令传递 type="agent"', async () => {
        const onSelectCapability = vi.fn()
        const onClose = vi.fn()
        render(<CommandPalette isOpen={true} onClose={onClose} onSelectCapability={onSelectCapability} />)

        await waitFor(() => expect(screen.getByText('Implementer')).toBeTruthy())
        fireEvent.click(screen.getByText('Implementer'))
        expect(onSelectCapability).toHaveBeenCalledWith('Implementer', 'agent', 'Implementer')
    })

    it('不再渲染 ParamInputModal', async () => {
        render(<CommandPalette isOpen={true} onClose={vi.fn()} onSelectCapability={vi.fn()} />)
        await waitFor(() => expect(screen.getByText('deploy')).toBeTruthy())
        // 不应有参数输入弹窗的任何痕迹（ParamInputModal 通常含 placeholder 或特定文案）
        expect(screen.queryByPlaceholderText(/参数|输入参数/)).toBeNull()
    })

    it('键盘 Enter 选中当前高亮项并调用 onSelectCapability', async () => {
        const onSelectCapability = vi.fn()
        const onClose = vi.fn()
        render(<CommandPalette isOpen={true} onClose={onClose} onSelectCapability={onSelectCapability} />)

        await waitFor(() => expect(screen.getByText('deploy')).toBeTruthy())

        // 弹窗通过 createPortal 渲染到 document.body，用 screen 查找
        // 找到 overlay（含 bg-black 的 div）并触发 Enter
        const overlay = document.body.querySelector('[class*="bg-black"]') as HTMLElement
        expect(overlay).toBeTruthy()
        fireEvent.keyDown(overlay, {key: 'Enter'})
        // 默认高亮首项（deploy, source='user' → 归一化为 type='command'）
        expect(onSelectCapability).toHaveBeenCalledWith('cmd:deploy', 'command', 'deploy')
        expect(onClose).toHaveBeenCalledTimes(1)
    })
})
