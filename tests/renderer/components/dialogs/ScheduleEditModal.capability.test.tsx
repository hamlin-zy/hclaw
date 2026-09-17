// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {render, screen, fireEvent, waitFor} from '@testing-library/react'
import {ScheduleEditModal} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'
import type {ScheduleFormData} from '../../../../src/renderer/components/dialogs/ScheduleEditModal'

// ── 依赖 mock ──────────────────────────────────────────
// ScheduleEditModal 内嵌 CapabilityPicker 的能力列表来自 CapabilityHub 投影
// （electronAPI.capability.query 一次往返）；ScheduleEditModal 自身另需
// electronAPI.getPlatform / workspace.getCurrent。

/** Hub 投影条目（CapabilityEntry 的最小可用形状） */
const capEntry = (name: string, type: 'skill' | 'agent' | 'command', description: string) => ({
    id: name,
    name,
    description,
    type,
    source: type === 'command' ? 'user' : 'builtin',
    enabled: true,
    searchText: name.toLowerCase(),
})

const {capabilityQuery} = vi.hoisted(() => ({capabilityQuery: vi.fn()}))

beforeEach(() => {
    capabilityQuery.mockReset()
    capabilityQuery.mockImplementation(async () => [
        capEntry('code-reviewer', 'agent', '代码审查'),
        capEntry('brain-taxonomist', 'skill', '知识分类'),
        capEntry('cover-gen', 'skill', '封面生成'),
        capEntry('deploy', 'command', '部署'),
    ])
    vi.stubGlobal('electronAPI', {
        getPlatform: vi.fn().mockResolvedValue('win32'),
        // 新建任务默认落在**当前工作目录**上：票 11 起工作目录必填，新建路径靠这个默认值成立
        // list 同理必须给足（复核 B1：「列表未就绪」不再放行保存）
        workspace: {
            getCurrent: vi.fn().mockResolvedValue({id: 'ws-1', name: '主工作区', path: 'E:/ws1'}),
            list: vi.fn().mockResolvedValue([{id: 'ws-1', name: '主工作区', path: 'E:/ws1'}]),
        },
        capability: {query: capabilityQuery, onCapabilityChanged: vi.fn(() => () => {})},
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

        // 默认即 capability 模式，等待 Hub 取数返回（无固定时长等待）且能力列表渲染
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
