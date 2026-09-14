// @vitest-environment jsdom
/**
 * data-name 缺名守护测试
 *
 * 对注册表中的每个组件逐个渲染，断言所有交互元素
 * （button / [role="button"] / input / textarea / select）均携带非空 data-name。
 * 未来新组件加入 dataNameGuard.registry.ts 的 GUARD_COMPONENTS 即自动纳入守护。
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { GUARD_COMPONENTS, WHITELIST } from '../../../src/renderer/components/dataNameGuard.registry'

// ── store mock：合并各组件所需最小字段（均为 selector 调用；agentStore 需兼容无 selector 调用）──
// 注意：state 与函数引用必须稳定（vi.hoisted），否则会触发无限重渲染
const agentState = vi.hoisted(() => ({
    permissionMode: 'auto',
    messageDisplayMode: 'detailed',
    convAgentStates: {
        'conv-1': {
            tasks: [
                {id: 't1', title: '任务一', status: 'running'},
                {id: 't2', title: '任务二', status: 'pending'},
            ],
            currentBatch: {id: 'batch-1', name: '重构登录', status: 'active'},
        },
    },
    hydrateActiveBatch: vi.fn(),
    pendingQuestion: {
        question: '请选择您的偏好？',
        options: ['选项A', '选项B'],
        multiSelect: false,
    } as { question: string; options?: string[]; multiSelect?: boolean } | null,
    agentState: {status: 'running', phase: 'streaming', mode: 'auto'},
    answerQuestion: vi.fn(),
    modelOverride: {endpointId: 'p1', modelId: 'm1'},
    setModelOverride: vi.fn(),
    // PermissionRulesPanel（无 selector 调用，解构 permissionRules + 增删查函数）
    // fix round 1：填充非空规则以激活「规则行」分支（删除按钮行级 data-name）
    permissionRules: [
        {tool: 'bash:git*', action: 'allow', createdAt: 2, pattern: 'git*'},
        {tool: 'read:src/**', action: 'allow', createdAt: 1},
    ] as Array<{ tool: string; action: string; createdAt?: number; pattern?: string }>,
    fetchPermissionRules: vi.fn(async () => {}),
    removePermissionRule: vi.fn(async () => {}),
    addPermissionRule: vi.fn(async () => {}),
    // PermissionConfirmModal（shouldShow 依赖 pendingPermissionConfirm.requestId）
    pendingPermissionConfirm: {
        requestId: 'req-1',
        question: '需要确认以下命令：\n\n- ls -la\n- git status\n\n',
    },
    respondQuestion: vi.fn(),
    abortAgent: vi.fn(async () => {}),
}))

vi.mock('../../../src/renderer/stores/agentStore', () => ({
    useAgentStore: (selector?: any) => (selector ? selector(agentState) : agentState),
}))
vi.mock('../../../src/renderer/stores/conversationStore', () => ({
    useConversationStore: (selector: any) =>
        selector({activeConversationId: 'conv-1'}),
}))
vi.mock('../../../src/renderer/stores/themeStore', () => ({
    useThemeStore: (selector?: any) => (selector ? selector({theme: 'light'}) : 'light'),
}))
vi.mock('../../../src/renderer/stores/llmStore', () => ({
    useLLMStore: (selector: any) =>
        selector({
            providers: [
                {id: 'p1', name: 'OpenAI', type: 'openai', enabled: true, models: [{id: 'm1', name: 'gpt-5', enabled: true}, {id: 'm2', name: 'gpt-4o', enabled: true}]},
            ],
        }),
}))
vi.mock('../../../src/renderer/stores/modelSchemeStore', () => {
    const activeScheme = {
        id: 'scheme-1',
        name: 'test-scheme',
        enabled: true,
        roles: [
            {role: 'primary', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'lightweight', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'reasoning', enabled: true, endpointId: 'p1', modelId: 'm1'},
            {role: 'image_understanding', enabled: false, endpointId: '', modelId: ''},
            {role: 'audio_understanding', enabled: false, endpointId: '', modelId: ''},
            {role: 'video_understanding', enabled: false, endpointId: '', modelId: ''},
        ],
    }
    // 稳定引用：无 selector 调用（ModelSchemeDialog / SchemeListItem）返回同一对象，
    // 避免每次渲染产生新引用触发 effect 无限重渲染
    const state = {
        schemes: [activeScheme],
        activeSchemeId: 'scheme-1',
        presetTemplates: [],
        addScheme: vi.fn(() => 'scheme-1'),
        updateScheme: vi.fn(() => true),
        removeScheme: vi.fn(async () => {}),
        createFromPreset: vi.fn(() => null),
        duplicateScheme: vi.fn(() => null),
    }
    return {
        useModelSchemeStore: Object.assign(
            vi.fn((selector?: any) => (selector ? selector(state) : state)),
            {getState: vi.fn(() => ({...state, getActiveScheme: () => activeScheme}))},
        ),
        switchActiveScheme: vi.fn(async () => ({})),
    }
})

// fix round 1：scheduleStore 仅在 ScheduleDialog 使用；填充 1 条任务以激活「任务卡片」分支
// （卡片内 switch / 立即执行 / 执行记录 / 编辑 / 删除 5 个交互元素）
vi.mock('../../../src/renderer/stores/scheduleStore', () => {
    const schedule = {
        id: 'sched-1',
        name: '每日构建',
        description: '构建并测试',
        cronExpression: '0 2 * * *',
        taskType: 'agent',
        taskTarget: 'build-agent',
        taskArgs: [],
        taskPrompt: '',
        enabled: true,
        paused: false,
        lastRunAt: Date.now(),
        lastRunStatus: 'success',
        lastRunConversationId: null,
        runCount: 3,
        createdAt: 1,
        updatedAt: 1,
        workspaceId: null,
    }
    // 稳定引用：无 selector 调用返回同一对象，避免 effect 无限重渲染
    const state = {
        schedules: [schedule],
        loading: false,
        loadSchedules: vi.fn(async () => {}),
        create: vi.fn(async () => ({success: true})),
        update: vi.fn(async () => ({success: true})),
        delete: vi.fn(async () => ({success: true})),
        stop: vi.fn(async () => {}),
        runNow: vi.fn(async () => ({success: true})),
    }
    return {useScheduleStore: (selector?: any) => (selector ? selector(state) : state)}
})

// ── 重组件 mock：jsdom 下成本高，与现有测试同策略 ──
vi.mock('../../../src/renderer/components/CacheRateTooltip', () => ({default: () => null}))
vi.mock('../../../src/renderer/components/ToolMenu', () => ({default: () => null}))
vi.mock('../../../src/renderer/components/message-list/MarkdownRenderer', () => ({
    default: ({children}: { children: string }) => <div>{children}</div>,
}))

const SELECTOR = 'button, [role="button"], input, textarea, select'
// 调试用：GUARD_ONLY=Name 过滤单组件（正常 CI 不设置，跑全量）
const GUARD_TARGET = process.env.GUARD_ONLY
const GUARD_RUN = GUARD_TARGET ? GUARD_COMPONENTS.filter((c) => c.name === GUARD_TARGET) : GUARD_COMPONENTS

describe('data-name guard', () => {
    it('GUARD_COMPONENTS 非空（防止注册表被清空导致守护失效）', () => {
        expect(GUARD_COMPONENTS.length).toBeGreaterThan(0)
    })

    GUARD_RUN.forEach(({ name, render: renderComp }) => {
        it(`${name}: 交互元素均有非空 data-name`, () => {
            const { container } = render(renderComp())
            const missing = Array.from(container.querySelectorAll(SELECTOR)).filter((el) => {
                const dn = el.getAttribute('data-name')
                return !dn || dn.trim() === ''
            })
            expect(missing.map((el) => el.outerHTML.slice(0, 120))).toEqual([])
        })
    })

    it('白名单条目必须注明 TODO 原因', () => {
        for (const w of WHITELIST) {
            expect(w.reason, `${w.component} 缺少原因`).toBeTruthy()
            expect(w.reason).toMatch(/TODO/)
        }
    })
})
