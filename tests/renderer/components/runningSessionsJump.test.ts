import {describe, expect, it} from 'vitest'
import {resolveRunningSessionJumpPlan} from '@/renderer/lib/runningSessionsJump'

const A = 'E:/proj-a'
const B = 'E:/proj-b'
const C = 'E:/proj-c'
const D = 'E:/proj-d'

const group1 = {
    id: 'g1',
    name: '组一',
    sortOrder: 0,
    createdAt: 0,
    updatedAt: 0,
    members: [
        {projectPath: B, groupOrder: 0},
        {projectPath: C, groupOrder: 1},
    ],
}

const base = {
    scopeProjectPaths: [A],
    groups: [group1],
}

describe('resolveRunningSessionJumpPlan（视图跟随矩阵）', () => {
    it('单项目视图内：目标可见 → stay（不写 viewScope）', () => {
        expect(resolveRunningSessionJumpPlan({...base, viewScope: {type: 'project', path: A}, targetWorkspacePath: A}))
            .toEqual({kind: 'stay'})
    })

    it('组视图内：目标为组成员 → stay（组内换会话 ≠ 离开组视图）', () => {
        expect(resolveRunningSessionJumpPlan({
            scopeProjectPaths: [B, C],
            groups: [group1],
            viewScope: {type: 'group', groupId: 'g1'},
            targetWorkspacePath: C,
        })).toEqual({kind: 'stay'})
    })

    it('目标不在视图内但已入组 → group（切组视图 + 定位）', () => {
        expect(resolveRunningSessionJumpPlan({...base, viewScope: {type: 'project', path: A}, targetWorkspacePath: B}))
            .toEqual({kind: 'group', groupId: 'g1'})
    })

    it('目标不在视图内且未入组 → project（单项目视图跟随）', () => {
        expect(resolveRunningSessionJumpPlan({...base, viewScope: {type: 'project', path: A}, targetWorkspacePath: D}))
            .toEqual({kind: 'project'})
    })

    it('组视图内跨目录到成员项目：归一化等价路径也算 stay', () => {
        expect(resolveRunningSessionJumpPlan({
            scopeProjectPaths: [B, C],
            groups: [group1],
            viewScope: {type: 'group', groupId: 'g1'},
            targetWorkspacePath: 'E:/proj-c/',
        })).toEqual({kind: 'stay'})
    })

    it('未归属（无工作目录）→ activate-only（只激活，不动视图）', () => {
        expect(resolveRunningSessionJumpPlan({...base, viewScope: {type: 'project', path: A}, targetWorkspacePath: null}))
            .toEqual({kind: 'activate-only'})
        // 组视图的未归属段同样只激活——视图已含该段，无需任何视图操作
        expect(resolveRunningSessionJumpPlan({
            scopeProjectPaths: [B, C],
            groups: [group1],
            viewScope: {type: 'group', groupId: 'g1'},
            targetWorkspacePath: null,
        })).toEqual({kind: 'activate-only'})
    })
})
