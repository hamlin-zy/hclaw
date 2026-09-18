import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

const GROUP_A = {
    id: 'pg-a', name: '组A', sortOrder: 0, createdAt: 1, updatedAt: 1,
    members: [{projectPath: '/ws/a', groupOrder: 0}],
}
const GROUP_B = {
    id: 'pg-b', name: '组B', sortOrder: 1, createdAt: 1, updatedAt: 1,
    members: [] as Array<{projectPath: string; groupOrder: number}>,
}

const api = {
    list: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    dissolve: vi.fn(),
    remove: vi.fn(),
    assign: vi.fn(),
    reorderGroups: vi.fn(),
    reorderProjects: vi.fn(),
}

beforeEach(() => {
    vi.resetAllMocks()
    ;(globalThis as any).window = {electronAPI: {projectGroup: api}}
    api.list.mockResolvedValue([GROUP_A, GROUP_B])
})

afterEach(() => { delete (globalThis as any).window })

import {useProjectGroupStore, projectGroupOf} from '../../../src/renderer/stores/projectGroupStore'

describe('projectGroupStore — load', () => {
    it('load 填充 groups', async () => {
        await useProjectGroupStore.getState().load()
        expect(useProjectGroupStore.getState().groups).toEqual([GROUP_A, GROUP_B])
        expect(api.list).toHaveBeenCalledTimes(1)
    })

    it('load 失败置 error 且不抛', async () => {
        api.list.mockRejectedValue(new Error('boom'))
        await useProjectGroupStore.getState().load()
        expect(useProjectGroupStore.getState().error).toBeTruthy()
    })

    it('electronAPI 缺失（测试/降级环境）时 load 安全返回', async () => {
        ;(globalThis as any).window = {}
        await expect(useProjectGroupStore.getState().load()).resolves.toBeUndefined()
    })
})

describe('projectGroupStore — 乐观更新与回滚', () => {
    it('assign 成功：先本地改归属，再用服务端 list 对账', async () => {
        await useProjectGroupStore.getState().load()
        api.assign.mockResolvedValue(true)
        api.list.mockResolvedValue([GROUP_A, {...GROUP_B, members: [{projectPath: '/ws/a', groupOrder: 0}]}])
        await useProjectGroupStore.getState().assign('/ws/a', 'pg-b')
        expect(api.assign).toHaveBeenCalledWith('/ws/a', 'pg-b')
        expect(useProjectGroupStore.getState().groups[1].members).toEqual([{projectPath: '/ws/a', groupOrder: 0}])
    })

    it('assign 失败：回滚到操作前快照并置 error', async () => {
        await useProjectGroupStore.getState().load()
        api.assign.mockResolvedValue(false)
        await useProjectGroupStore.getState().assign('/ws/a', 'pg-b')
        expect(useProjectGroupStore.getState().groups).toEqual([GROUP_A, GROUP_B])
        expect(useProjectGroupStore.getState().error).toBeTruthy()
    })

    it('reorderGroups 失败：顺序回滚', async () => {
        await useProjectGroupStore.getState().load()
        api.reorderGroups.mockResolvedValue(false)
        await useProjectGroupStore.getState().reorderGroups(['pg-b', 'pg-a'])
        expect(useProjectGroupStore.getState().groups.map(g => g.id)).toEqual(['pg-a', 'pg-b'])
    })

    it('reorderProjects 成功：按新顺序重编号 groupOrder（0 起连续）', async () => {
        await useProjectGroupStore.getState().load()
        api.reorderProjects.mockResolvedValue(true)
        api.list.mockResolvedValue([{...GROUP_A, members: [
            {projectPath: '/ws/b', groupOrder: 0}, {projectPath: '/ws/a', groupOrder: 1},
        ]}, GROUP_B])
        await useProjectGroupStore.getState().reorderProjects('pg-a', ['/ws/b', '/ws/a'])
        const members = useProjectGroupStore.getState().groups[0].members
        expect(members.map(m => m.projectPath)).toEqual(['/ws/b', '/ws/a'])
        expect(members.map(m => m.groupOrder)).toEqual([0, 1])
    })

    it('dissolve 后该组从 groups 消失、成员归属推导返回 null', async () => {
        await useProjectGroupStore.getState().load()
        api.dissolve.mockResolvedValue(true)
        api.list.mockResolvedValue([GROUP_B])
        await useProjectGroupStore.getState().dissolve('pg-a')
        expect(useProjectGroupStore.getState().groups.map(g => g.id)).toEqual(['pg-b'])
        expect(projectGroupOf(useProjectGroupStore.getState().groups, '/ws/a')).toBeNull()
    })
})

describe('projectGroupOf — 纯函数归属推导', () => {
    it('路径命中成员则返回该组；未命中返回 null', () => {
        expect(projectGroupOf([GROUP_A, GROUP_B], '/ws/a')?.id).toBe('pg-a')
        expect(projectGroupOf([GROUP_A, GROUP_B], '/ws/zzz')).toBeNull()
    })
})
