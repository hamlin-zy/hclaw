// @vitest-environment jsdom
/**
 * ConversationSectionHeader「未归属」段头：隐藏「新建会话」与项目管理按钮，
 * 无分支徽章。
 */
import {describe, expect, it} from 'vitest'
import {render, screen} from '@testing-library/react'
import {ConversationSectionHeader} from '../../../src/renderer/components/ConversationSectionHeader'
import {UNASSIGNED_WORKSPACE_KEY} from '../../../src/renderer/lib/workspacePath'

function renderHeader(projectPath: string, props: Partial<Parameters<typeof ConversationSectionHeader>[0]> = {}) {
    const utils = render(
        <ConversationSectionHeader
            section={{
                key: projectPath,
                projectPath,
                projectName: projectPath === UNASSIGNED_WORKSPACE_KEY ? '未归属' : 'proj',
                gitBranch: null,
                collapsed: false,
                count: 1,
                hasMore: false,
                totalRoots: 1,
                rows: [],
            }}
            onToggleCollapsed={() => {}}
            onOpenProjectManager={() => {}}
            onNewConversation={() => {}}
            {...props}
        />,
    )
    // 组件用 data-name（非 data-testid）标注，统一走 querySelector
    const byName = (name: string) => utils.container.querySelector(`[data-name="${name}"]`)
    return {...utils, byName}
}

describe('ConversationSectionHeader — 未归属段', () => {
    it('未归属段不渲染「新建会话」与项目管理按钮，显示「未归属」名称', () => {
        const {byName} = renderHeader(UNASSIGNED_WORKSPACE_KEY)
        expect(screen.getByText('未归属')).toBeTruthy()
        expect(byName('section-new-conversation')).toBeNull()
        expect(byName('section-pm-button')).toBeNull()
        // 操作列是 fit-content(46px)：没有按钮时轨道塌陷，省下的宽度归项目名（2026-09-24 拍板）
        expect((byName('conversation-section-header') as HTMLElement).className).toContain('fit-content(46px)')
    })

    it('真实项目段仍渲染两个操作按钮', () => {
        const {byName} = renderHeader('/ws/a')
        expect(byName('section-new-conversation')).toBeTruthy()
        expect(byName('section-pm-button')).toBeTruthy()
    })
})
