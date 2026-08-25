import {useAgentStore} from '../stores/agentStore'
import {useConversationStore} from '../stores/conversationStore'
import type {RunMode} from '@shared/types'
import type {DisplayMode} from '../lib/displayMode'

const PERM_MODES: Array<{id: RunMode; label: string}> = [
    {id: 'auto', label: '自动'},
    {id: 'safe', label: '安全'},
]

const DISP_MODES: Array<{id: DisplayMode; label: string}> = [
    {id: 'detailed', label: '详细'},
    {id: 'compact', label: '简洁'},
    {id: 'ultra-compact', label: '紧凑'},
]

/**
 * 会话级控件：安全模式 + 显示模式 segmented control。
 * 经 InputToolbar.extraActions 插槽注入 input-toolbar-actions 最左侧。
 * 安全模式走会话级链路（meta + 广播目标 worker）；显示模式纯渲染层（meta + 顶层开关）。
 */
export default function ConvModeSegs() {
    const permissionMode = useAgentStore((s) => s.permissionMode)
    const messageDisplayMode = useAgentStore((s) => s.messageDisplayMode)
    const setConvPermissionMode = useAgentStore((s) => s.setConvPermissionMode)
    const setConvDisplayMode = useAgentStore((s) => s.setConvDisplayMode)
    const activeConversationId = useConversationStore((s) => s.activeConversationId)

    if (!activeConversationId) return null

    return (
        <>
            <div className="seg perm" role="group" aria-label="安全模式">
                {PERM_MODES.map((m) => (
                    <button
                        key={m.id}
                        data-v={m.id}
                        className={permissionMode === m.id ? 'active' : ''}
                        onClick={() => setConvPermissionMode(activeConversationId, m.id)}
                        title={m.id === 'auto' ? '自动模式：全程自动执行' : '安全模式：破坏性操作需确认'}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <div className="seg" role="group" aria-label="显示模式">
                {DISP_MODES.map((m) => (
                    <button
                        key={m.id}
                        className={messageDisplayMode === m.id ? 'active' : ''}
                        onClick={() => setConvDisplayMode(activeConversationId, m.id)}
                        title={m.id === 'detailed' ? '详细模式' : m.id === 'compact' ? '简洁模式：思考块折叠' : '紧凑模式：工具汇总行'}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            <span className="tb-sep" aria-hidden="true"/>
        </>
    )
}
