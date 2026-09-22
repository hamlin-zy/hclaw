// @vitest-environment jsdom
/**
 * ToolCallHeader agent 卡片图标回归测试
 *
 * 缺陷场景：详细模式与简洁模式下，agentTool 工具卡片中 agent 名称前显示的是
 * 纯文本「Agent」，而非 AgentIcon 机器人图标（skill 分支已有 SkillIcon）。
 *
 * 根因：ToolCallHeader 是 compact / normal 两种显示模式共用的头部组件，
 * 其 agent 分支（解析出显示名与兜底两条）自建立起就只有文本 span，
 * 未同步其余三个 agent 卡片出口（ToolCallRenderer 组合卡片、compact-popup、
 * SubAgentViewer）都已使用的 AgentIcon。
 */
import {describe, it, expect, vi} from 'vitest'
import {render} from '@testing-library/react'
import ToolCallHeader from '../../../../src/renderer/components/message-list/ToolCallHeader'
import {SuccessIcon} from '../../../../src/renderer/components/icons'

/** AgentIcon 特征图形：机器人头部的 rect(x=4,y=8,rx=2) */
const hasAgentIcon = (root: HTMLElement) =>
    !!root.querySelector('svg rect[x="4"][y="8"][rx="2"]')

const baseCfg = {
    color: 'text-[var(--success)]',
    bg: 'bg-[var(--success-muted)]',
    icon: SuccessIcon,
    label: '完成',
}

function renderHeader(overrides: Record<string, unknown> = {}, isCompact = false) {
    const props: any = {
        toolCall: {id: 'tc-1', name: 'agent', arguments: '{}', status: 'success'},
        expanded: true,
        onToggleExpanded: vi.fn(),
        onOpenViewer: vi.fn(),
        cfg: baseCfg,
        isRunning: false,
        hasProgress: false,
        progressPercent: 0,
        effectiveStatus: 'success',
        agentDisplayName: 'Implementer Agent',
        agentTypeLabel: null,
        skillDisplayName: null,
        mcpDisplayName: null,
        summary: null,
        terminalDisplay: null,
        isSubAgent: true,
        hasOutput: true,
        isCompact,
        ...overrides,
    }
    return render(<ToolCallHeader {...props}/>)
}

describe('ToolCallHeader — agent 卡片类型标识', () => {
    it('详细模式（normal）渲染 AgentIcon，且不再显示纯文本「Agent」类型词', () => {
        const {container, queryAllByText} = renderHeader({}, false)
        expect(hasAgentIcon(container)).toBe(true)
        expect(queryAllByText('Agent')).toHaveLength(0)
    })

    it('简洁模式（compact）渲染 AgentIcon，且不再显示纯文本「Agent」类型词', () => {
        const {container, queryAllByText} = renderHeader({}, true)
        expect(hasAgentIcon(container)).toBe(true)
        expect(queryAllByText('Agent')).toHaveLength(0)
    })

    it('兜底分支（未解析出 agent 显示名）同样带 AgentIcon', () => {
        const {container, getByText} = renderHeader({agentDisplayName: null})
        expect(hasAgentIcon(container)).toBe(true)
        // 兜底文案保留（无名称可显示时仍需可读标识）
        expect(getByText('Agent')).toBeTruthy()
    })

    it('skill 卡片沿用 SkillIcon，不受本次改动影响', () => {
        const {container} = renderHeader({
            toolCall: {id: 'tc-2', name: 'skill', arguments: '{}', status: 'success'},
            skillDisplayName: 'systematic-debugging',
            agentDisplayName: null,
        })
        expect(hasAgentIcon(container)).toBe(false)
        expect(container.querySelector('svg')).toBeTruthy()
    })
})
