/**
 * PermissionEngine.applyModeFromMain 单元测试
 *
 * 会话级模式下发（主进程 → worker）：与 setMode 的差异是
 * applyModeFromMain 调用 permissionRulesManager.applyUpdateNoPersist（仅内存），
 * 绝不写全局 system_settings.permission_mode。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {PermissionEngine} from '@/main/agent/tools/permission'
import {z} from 'zod'
import type {Tool} from '@/main/agent/tools/types'

const {applyNoPersistMock} = vi.hoisted(() => ({
    applyNoPersistMock: vi.fn(async (update: any) => ({
        mode: update.mode,
        rules: [],
        strippedDangerousRules: undefined,
        additionalWorkingDirectories: [],
        isBypassPermissionsModeAvailable: false,
        isAutoModeAvailable: true,
    })),
}))

vi.mock('@/main/agent/permissions/permissionRule', () => ({
    permissionRulesManager: {
        getContext: vi.fn(async () => ({
            mode: 'safe', rules: [], strippedDangerousRules: undefined,
            additionalWorkingDirectories: [], isBypassPermissionsModeAvailable: false, isAutoModeAvailable: true,
        })),
        getMode: vi.fn(async () => 'safe'),
        getRules: vi.fn(async () => []),
        applyUpdate: vi.fn(async () => ({mode: 'safe', rules: []})),
        applyUpdateNoPersist: applyNoPersistMock,
        getDangerousPermissions: vi.fn(async () => []),
        reload: vi.fn(async () => {}),
    },
}))

function makeTool(name: string, opts: {isDestructive?: boolean} = {}): Tool {
    return {
        name, description: name, inputSchema: z.object({}),
        execute: async () => ({success: true, output: ''}),
        requiredPermissions: [], isDestructive: opts.isDestructive,
    }
}

describe('PermissionEngine.applyModeFromMain（会话级模式下发，仅内存）', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('切换 mode 且调用 applyUpdateNoPersist（而非 applyUpdate）', async () => {
        const engine = new PermissionEngine()
        await engine.getMode() // 触发 ensureInit
        await engine.applyModeFromMain('auto')
        expect(applyNoPersistMock).toHaveBeenCalledWith({type: 'setMode', mode: 'auto'})
        expect((await engine.getMode())).toBe('auto')
    })

    it('auto 模式下破坏性工具直接放行（check 同步生效）', async () => {
        const engine = new PermissionEngine()
        await engine.getMode()
        await engine.applyModeFromMain('auto')
        const result = engine.check(makeTool('edit', {isDestructive: true}), {})
        expect(result.allowed).toBe(true)
    })

    it('safe 模式下破坏性工具需确认（check 同步生效）', async () => {
        const engine = new PermissionEngine()
        await engine.getMode()
        await engine.applyModeFromMain('safe')
        const result = engine.check(makeTool('deleteFile', {isDestructive: true}), {})
        expect(result.allowed).toBe(false)
    })
})
