// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleFormData} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'

// ── 依赖 mock ──────────────────────────────────────────
// ScheduleEditModal 内嵌 CapabilityPicker 依赖三个 store（通过 .getState() 读取）
// 与 electronAPI（getPlatform / workspace.getCurrent / plugin.getCommands）。
// 沿用 MCPDialog.toggle.test.tsx 的 mock 模式：hook + 挂载 getState。

const {mockAgentState, mockSkillState, mockCmdState} = vi.hoisted(() => {
    return {
        mockAgentState: {
            templates: [
                {name: 'code-reviewer', description: '代码审查', userDescription: ''},
            ],
            syncFromDisk: vi.fn().mockResolvedValue({success: true}),
        },
        mockSkillState: {
            skills: [
                {name: 'brain-taxonomist', description: '知识分类'},
                {name: 'cover-gen', description: '封面生成'},
            ],
            loadSkills: vi.fn().mockResolvedValue(undefined),
        },
        mockCmdState: {
            commands: [
                {name: 'deploy', description: '部署'},
            ],
            loadCommands: vi.fn().mockResolvedValue(undefined),
        },
    }
})

function mockZustandStore(state: Record<string, unknown>) {
    const hook = (selector?: (s: any) => unknown) => (selector ? selector(state) : state)
    ;(hook as any).getState = () => state
    return hook
}

vi.mock('../../../../src/renderer/stores/agentTemplateStore', () => ({
    useAgentTemplateStore: mockZustandStore(mockAgentState),
}))
vi.mock('../../../../src/renderer/stores/skillStore', () => ({
    useSkillStore: mockZustandStore(mockSkillState),
}))
vi.mock('../../../../src/renderer/stores/userCommandStore', () => ({
    useUserCommandStore: mockZustandStore(mockCmdState),
}))

beforeEach(() => {
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        workspace: {getCurrent: vi.fn().mockResolvedValue(null)},
        plugin: {getCommands: vi.fn().mockResolvedValue(null)},
    })
})

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('ScheduleEditModal 冒烟：能力选择流程', () => {
    it('渲染 modal → capability 模式 → 搜索 brain → 选中 skill → taskType=skill', async () => {
        const onSave = vi.fn()
        const onClose = vi.fn()
        render(<ScheduleEditModal onSave={onSave} onClose={onClose}/>)

        // 默认即 capability 模式，等待加载完成（内含 200ms 延迟）且能力列表渲染
        await waitFor(
            () => expect(screen.getByText('brain-taxonomist')).toBeTruthy(),
            {timeout: 3000},
        )
        expect(screen.getByText('code-reviewer')).toBeTruthy()
        expect(screen.getByText('cover-gen')).toBeTruthy()
        expect(screen.getByText('deploy')).toBeTruthy()

        // 搜索 'brain'
        const searchInput = screen.getByPlaceholderText('搜索可用能力...')
        fireEvent.change(searchInput, {target: {value: 'brain'}})
        await waitFor(() => expect(screen.queryByText('cover-gen')).toBeNull())
        expect(screen.getByText('brain-taxonomist')).toBeTruthy()

        // 选中 skill 项
        fireEvent.click(screen.getByText('brain-taxonomist'))

        // 选中后 chip 显示，且 onSelect→taskType/skill 体现在保存结果中
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '每日分类'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        const data: ScheduleFormData = onSave.mock.calls[0][0]
        expect(data.taskType).toBe('skill')
        expect(data.taskTarget).toBe('brain-taxonomist')
        expect(data.name).toBe('每日分类')
    })

    it('选中 Agent 项 → taskType=agent', async () => {
        const onSave = vi.fn()
        render(<ScheduleEditModal onSave={onSave} onClose={vi.fn()}/>)

        await waitFor(() => expect(screen.getByText('code-reviewer')).toBeTruthy(), {timeout: 3000})
        fireEvent.click(screen.getByText('code-reviewer'))
        fireEvent.change(screen.getByPlaceholderText('例如: 每日代码审查'), {target: {value: '审查'}})
        fireEvent.click(screen.getByText('保存'))

        await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
        expect(onSave.mock.calls[0][0].taskType).toBe('agent')
    })
})
