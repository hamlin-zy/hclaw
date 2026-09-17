// data-name 缺名守护注册表
//
// 未来新组件加入 GUARD_COMPONENTS 即纳入守护：dataNameGuard.test.tsx 会逐个
// 渲染并断言所有交互元素（button/[role=button]/input/textarea/select）均有
// 非空 data-name。store / 重组件 mock 统一放在 dataNameGuard.test.tsx，
// 这里只负责组装最小可用 props（参照 tests/renderer/components/ 对应测试文件）。
import { useEffect, useRef } from 'react'
import type { ReactElement } from 'react'
import InputToolbar from './InputToolbar'
import ConvModeSegs from './ConvModeSegs'
import ModelSelector from './ModelSelector'
import ThinkingEffortSelector from './ThinkingEffortSelector'
import TodoStrip from './TodoStrip'
import MetricBadge from './MetricBadge'
import AskUserModal from './AskUserModal'
import AgentsDialog from './dialogs/AgentsDialog'
import CommandsDialog from './dialogs/CommandsDialog'
import SkillsDialog from './dialogs/SkillsDialog'
import PluginDialog from './dialogs/PluginDialog'
import ModelSchemeDialog from './dialogs/ModelSchemeDialog'
import ScheduleDialog from './dialogs/ScheduleDialog'
import {ScheduleEditModal} from './dialogs/ScheduleEditModal'
import PermissionConfirmModal from './PermissionConfirmModal'
import PermissionRulesPanel from './PermissionRulesPanel'

const noop = () => {}

/**
 * 编辑弹窗的**展开态**外壳。
 *
 * `ScheduleEditModal` 由 `ScheduleDialog` 的 `editModalOpen` 才挂载，故注册 `ScheduleDialog`
 * 扫不到它；而弹窗里 ui-06 新增的 31 个日期网格 button 又只在「Cron 区展开 + 每月」下才渲染
 * （默认为收起）。这里两件事各做一半：用 `initial.cronExpression` 给一条每月表达式让月份网格
 * 可达，再在挂载后点一次折叠开关把它真的展开——否则「取月 15 日的表达式」也仍是一份空扫描。
 * 用 `useEffect` 而非直接渲染展开态，是为了不改动生产组件的 props 契约（不为测试开洞）。
 */
function ExpandedScheduleEditModal() {
    const boxRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        boxRef.current
            ?.querySelector<HTMLButtonElement>('[data-name="schedule-edit-modal-toggle-cron-button"]')
            ?.click()
    }, [])
    return (
        <div ref={boxRef}>
            <ScheduleEditModal
                initial={{
                    id: 'sched-1',
                    name: '每月构建',
                    description: '构建并测试',
                    taskType: 'agent',
                    taskTarget: 'build-agent',
                    taskPrompt: '',
                    cronExpression: '0 9 15 * *',
                    enabled: true,
                    workspaceId: 'ws-1',
                }}
                onSave={async () => ({ok: true, data: null})}
                onClose={noop}
            />
        </div>
    )
}

interface GuardEntry {
    name: string
    render: () => ReactElement
}

export const GUARD_COMPONENTS: GuardEntry[] = [
    {
        name: 'InputToolbar',
        render: () => (
            <InputToolbar
                isRunning={false}
                needsSession={false}
                needsModel={false}
                pendingMessagesCount={0}
                canSend={true}
                onSubmit={noop}
                onAbort={noop}
                onUploadFile={noop}
                onOpenCommandPalette={noop}
            />
        ),
    },
    {
        name: 'ConvModeSegs',
        render: () => <ConvModeSegs />,
    },
    {
        name: 'ModelSelector',
        render: () => <ModelSelector conversationId="conv-1" />,
    },
    {
        name: 'ThinkingEffortSelector',
        render: () => <ThinkingEffortSelector conversationId="conv-1" />,
    },
    {
        name: 'TodoStrip',
        render: () => <TodoStrip />,
    },
    {
        name: 'MetricBadge',
        render: () => <MetricBadge pct={42}>缓存 42%</MetricBadge>,
    },
    {
        name: 'AskUserModal',
        render: () => <AskUserModal />,
    },
    {
        name: 'AgentsDialog',
        render: () => <AgentsDialog />,
    },
    {
        name: 'CommandsDialog',
        render: () => <CommandsDialog />,
    },
    {
        name: 'SkillsDialog',
        render: () => <SkillsDialog />,
    },
    {
        name: 'PluginDialog',
        render: () => <PluginDialog />,
    },
    {
        name: 'ScheduleDialog',
        render: () => <ScheduleDialog />,
    },
    {
        // ui-06 那批日期网格 button 在 ScheduleDialog 的扫描面之外（弹窗需 editModalOpen 才挂载），
        // 故单列一条：覆盖编辑弹窗本体 + 展开态的 31 个日期 button（见 ExpandedScheduleEditModal）。
        name: 'ScheduleEditModal',
        render: () => <ExpandedScheduleEditModal />,
    },
    {
        name: 'ModelSchemeDialog',
        render: () => <ModelSchemeDialog />,
    },
    {
        name: 'PermissionConfirmModal',
        render: () => <PermissionConfirmModal />,
    },
    {
        name: 'PermissionRulesPanel',
        render: () => <PermissionRulesPanel />,
    },
]

export const WHITELIST: Array<{ component: string; reason: string }> = []
