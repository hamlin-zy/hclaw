// data-name 缺名守护注册表
//
// 未来新组件加入 GUARD_COMPONENTS 即纳入守护：dataNameGuard.test.tsx 会逐个
// 渲染并断言所有交互元素（button/[role=button]/input/textarea/select）均有
// 非空 data-name。store / 重组件 mock 统一放在 dataNameGuard.test.tsx，
// 这里只负责组装最小可用 props（参照 tests/renderer/components/ 对应测试文件）。
import type { ReactElement } from 'react'
import InputToolbar from './InputToolbar'
import ConvModeSegs from './ConvModeSegs'
import ModelSelector from './ModelSelector'
import ThinkingEffortSelector from './ThinkingEffortSelector'
import TodoStrip from './TodoStrip'
import MetricBadge from './MetricBadge'
import AskUserModal from './AskUserModal'

const noop = () => {}

export interface GuardEntry {
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
]

export const WHITELIST: Array<{ component: string; reason: string }> = []
