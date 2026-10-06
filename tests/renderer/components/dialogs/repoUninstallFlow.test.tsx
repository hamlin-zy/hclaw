// @vitest-environment jsdom
/**
 * Task 9：技能/代理对话框的「仓库卸载」接线（二次确认 → IPC → toast → 三重刷新）。
 *
 * 覆盖：
 *  1. 成功路径：confirm(danger) → repo.uninstall → refreshSkills + refreshRepoList + refreshFromCache；
 *  2. 业务失败（{success:false,error}）：toast 展示 error，且不刷新技能列表（Review Focus #3 的 UI 侧落点）；
 *  3. IPC reject（Task 7 的 handler 未包 try/catch，rejection 是真实存在的错误通道）：
 *     toast 展示失败、不产生 unhandled rejection、组件不崩（可再次点击）；
 *  4. AgentsDialog：仅「仓库」tab 渲染卸载入口，成功后走 syncFromDisk 侧刷新。
 *
 * 渲染走真实 store（只替换 action 为 spy），避免 mock 掉 store 使接线被绕过。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {waitFor, cleanup, fireEvent, act} from '@testing-library/react'
import SkillsDialog from '../../../../src/renderer/components/dialogs/SkillsDialog'
import AgentsDialog from '../../../../src/renderer/components/dialogs/AgentsDialog'
import {useSkillStore} from '../../../../src/renderer/stores/skillStore'
import {useAgentTemplateStore} from '../../../../src/renderer/stores/agentTemplateStore'
import {useRepoUpdateStore} from '../../../../src/renderer/stores/repoUpdateStore'
import {createElectronApiMock, renderWithStores} from '../../helpers/renderWithStores'

const {confirmMock} = vi.hoisted(() => ({confirmMock: vi.fn(async (_options?: any): Promise<boolean> => true)}))
vi.mock('../../../../src/renderer/components/ConfirmDialog', () => ({
    confirm: confirmMock,
    default: () => null,
}))

const REPO = {
    id: 'hclaw/demo-repo',
    name: 'demo-repo',
    source: 'github',
    path: 'C:\\Users\\Hamlin\\.hclaw\\skills\\public\\demo-repo',
    capabilities: {skills: ['demo-skill'], agents: ['demo-agent'], plugins: []},
    hasEnabledCapability: false,
}

const SKILL = {
    id: 'demo-skill',
    name: '演示技能',
    description: '演示用技能',
    enabled: false,
    source: 'user',
    filePath: REPO.path + '\\demo-skill\\SKILL.md',
}

const AGENT = {
    id: 'demo-agent',
    name: '演示代理',
    description: '演示用代理',
    enabled: false,
    filePath: REPO.path + '\\demo-agent.md',
    tags: [],
    whenToUse: '',
    systemPrompt: '',
}

const UNINSTALL_BTN = '[data-name="repo-group-card-uninstall-button"]'
const GROUP_HEADER = '[data-name="repo-group-card-header"]'

type UninstallImpl = () => Promise<any>

function makeApi(uninstallImpl?: UninstallImpl) {
    return createElectronApiMock({
        repo: {
            list: vi.fn(async () => [REPO]),
            uninstall: vi.fn(uninstallImpl ?? (async () => ({success: true, removed: {skills: 1, agents: 0}}))),
            getVersions: vi.fn(async () => ({tags: [], branches: [], current: '', latest: '', loading: false})),
            getAllVersionMeta: vi.fn(async () => ({})),
            onRepoStatusUpdate: vi.fn(() => () => {}),
        },
    })
}

/** 渲染 SkillsDialog，并把 store 的刷新动作换成 spy（其余数据保持真实） */
function setupSkills(uninstallImpl?: UninstallImpl) {
    const refreshSkills = vi.fn(async () => {})
    const refreshFromCache = vi.fn(async () => {})
    useSkillStore.setState({
        skills: [SKILL] as any,
        matchedSkills: [],
        loadErrors: [],
        loading: false,
        initialized: true,
        refreshSkills,
        loadSkills: vi.fn(async () => {}),
        toggleSkill: vi.fn(async () => ({success: true, error: ''})),
        toggleSkillBatch: vi.fn(async () => ({success: true, error: ''})),
        installSkill: vi.fn(async () => ({success: true})),
    } as any)
    useRepoUpdateStore.setState({updateMap: {}, hasUpdate: false, versionMeta: {}, refreshFromCache} as any)
    const api = makeApi(uninstallImpl)
    const utils = renderWithStores(<SkillsDialog/>, {api: api.api})
    return {...utils, mockApi: api, refreshSkills, refreshFromCache}
}

/** 渲染 AgentsDialog，并把 syncFromDisk / refreshFromCache 换成 spy */
function setupAgents(uninstallImpl?: UninstallImpl) {
    const syncFromDisk = vi.fn(async () => {})
    const refreshFromCache = vi.fn(async () => {})
    useAgentTemplateStore.setState({
        templates: [AGENT] as any,
        loading: false,
        loadErrors: [],
        syncFromDisk,
        init: vi.fn(async () => {}),
        toggleTemplate: vi.fn(async () => ({success: true, error: ''})),
        toggleTemplateBatch: vi.fn(async () => ({success: true, error: ''})),
        removeTemplate: vi.fn(async () => ({success: true, error: ''})),
    } as any)
    useRepoUpdateStore.setState({updateMap: {}, hasUpdate: false, versionMeta: {}, refreshFromCache} as any)
    const api = makeApi(uninstallImpl)
    const utils = renderWithStores(<AgentsDialog/>, {api: api.api})
    return {...utils, mockApi: api, syncFromDisk, refreshFromCache}
}

/** 切 tab 后等到仓库分组卡片的卸载按钮出现 */
async function openRepoUninstall(container: HTMLElement, tabSelector: string) {
    fireEvent.click(container.querySelector(tabSelector) as HTMLElement)
    await waitFor(() => expect(container.querySelector(UNINSTALL_BTN)).toBeTruthy())
    return container.querySelector(UNINSTALL_BTN) as HTMLElement
}

beforeEach(() => {
    confirmMock.mockClear()
    confirmMock.mockResolvedValue(true)
})

afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('SkillsDialog 仓库卸载接线', () => {
    it('成功：confirm(danger) → uninstall → refreshSkills + refreshRepoList + refreshFromCache', async () => {
        const {mockApi: api, container, refreshSkills, refreshFromCache} = setupSkills()
        const list = api.api.repo.list as ReturnType<typeof vi.fn>
        await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

        const btn = await openRepoUninstall(container, '[data-name="skills-dialog-tab-1"]')
        const listBefore = list.mock.calls.length
        const cacheBefore = refreshFromCache.mock.calls.length

        await act(async () => { fireEvent.click(btn) })

        await waitFor(() => expect(refreshSkills).toHaveBeenCalledTimes(1))
        expect(api.api.repo.uninstall).toHaveBeenCalledWith(REPO.id)
        await waitFor(() => expect(list.mock.calls.length).toBe(listBefore + 1))
        await waitFor(() => expect(refreshFromCache.mock.calls.length).toBe(cacheBefore + 1))

        expect(confirmMock).toHaveBeenCalledTimes(1)
        const opts = confirmMock.mock.calls[0][0] as any
        expect(opts.title).toBe('确认卸载仓库')
        expect(opts.confirmVariant).toBe('danger')
        expect(opts.message).toContain(REPO.id)
        expect(opts.message).toContain(REPO.path)
        expect(opts.message).toContain('不可恢复')
        expect(opts.message).toContain('1 个技能')
    })

    it('业务失败（success:false）：toast 展示 error，且不刷新技能列表', async () => {
        const {container, refreshSkills, getByText} = setupSkills(async () => ({success: false, error: '目录被占用'}))

        const btn = await openRepoUninstall(container, '[data-name="skills-dialog-tab-1"]')
        await act(async () => { fireEvent.click(btn) })

        await waitFor(() => expect(getByText(/目录被占用/)).toBeTruthy())
        expect(refreshSkills).not.toHaveBeenCalled()
    })

    it('warnings 非空：提示「已卸载，但存在告警」，且仍完成三重刷新', async () => {
        const {container, refreshSkills, getByText} = setupSkills(async () => ({
            success: true,
            removed: {skills: 1, agents: 0},
            warnings: ['残留目录未删除'],
        }))

        const btn = await openRepoUninstall(container, '[data-name="skills-dialog-tab-1"]')
        await act(async () => { fireEvent.click(btn) })

        await waitFor(() => expect(getByText(/已卸载，但存在告警：.*残留目录未删除/)).toBeTruthy())
        expect(refreshSkills).toHaveBeenCalledTimes(1)
    })

    it('IPC reject：toast 展示失败、无 unhandled rejection、组件可再次点击', async () => {
        const rejections: unknown[] = []
        const onRejection = (r: unknown) => { rejections.push(r) }
        process.on('unhandledRejection', onRejection)
        try {
            const {mockApi: api, container, getByText} = setupSkills(async () => { throw new Error('IPC 通道异常') })

            const btn = await openRepoUninstall(container, '[data-name="skills-dialog-tab-1"]')
            await act(async () => { fireEvent.click(btn) })

            await waitFor(() => expect(getByText(/IPC 通道异常/)).toBeTruthy())
            // unhandled rejection 的投递发生在下一个 tick
            await act(async () => { await new Promise(r => setTimeout(r, 30)) })
            expect(rejections).toEqual([])

            // 组件未崩：按钮仍在且可再次触发
            const btnAgain = container.querySelector(UNINSTALL_BTN) as HTMLElement
            expect(btnAgain).toBeTruthy()
            await act(async () => { fireEvent.click(btnAgain) })
            await waitFor(() => expect(api.api.repo.uninstall).toHaveBeenCalledTimes(2))
        } finally {
            process.off('unhandledRejection', onRejection)
        }
    })
})

describe('AgentsDialog 仓库卸载接线', () => {
    it('仅仓库 tab 渲染卸载入口；成功后 syncFromDisk + refreshRepoList + refreshFromCache', async () => {
        const {mockApi: api, container, syncFromDisk, refreshFromCache} = setupAgents()
        const list = api.api.repo.list as ReturnType<typeof vi.fn>
        await waitFor(() => expect(list).toHaveBeenCalledTimes(1))

        // 本地 tab：分组卡片照常渲染（同一份仓库分组），但不含卸载入口
        await waitFor(() => expect(container.querySelectorAll(GROUP_HEADER).length).toBeGreaterThan(0))
        expect(container.querySelector(UNINSTALL_BTN)).toBeNull()

        const btn = await openRepoUninstall(container, '[data-name="agents-dialog-repo-tab-button"]')
        const listBefore = list.mock.calls.length
        const cacheBefore = refreshFromCache.mock.calls.length

        await act(async () => { fireEvent.click(btn) })

        await waitFor(() => expect(syncFromDisk).toHaveBeenCalledTimes(1))
        expect(api.api.repo.uninstall).toHaveBeenCalledWith(REPO.id)
        await waitFor(() => expect(list.mock.calls.length).toBe(listBefore + 1))
        await waitFor(() => expect(refreshFromCache.mock.calls.length).toBe(cacheBefore + 1))

        expect(confirmMock).toHaveBeenCalledTimes(1)
        const opts = confirmMock.mock.calls[0][0] as any
        expect(opts.title).toBe('确认卸载仓库')
        expect(opts.confirmVariant).toBe('danger')
        expect(opts.message).toContain(REPO.path)
        expect(opts.message).toContain('不可恢复')
        expect(opts.message).toContain('1 个代理')
        // 技能数取该仓库真实聚合（REPO.capabilities.skills = ['demo-skill']），不再硬编码 0
        expect(opts.message).toContain('1 个技能')
        expect(opts.message).not.toContain('0 个技能')
    })

    it('AgentsDialog 业务失败：toast 展示 error 且不刷新', async () => {
        const {container, syncFromDisk, getByText} = setupAgents(async () => ({success: false, error: '目录被占用'}))

        const btn = await openRepoUninstall(container, '[data-name="agents-dialog-repo-tab-button"]')
        await act(async () => { fireEvent.click(btn) })

        await waitFor(() => expect(getByText(/目录被占用/)).toBeTruthy())
        expect(syncFromDisk).not.toHaveBeenCalled()
    })
})
