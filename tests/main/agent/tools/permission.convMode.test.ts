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

describe('PermissionEngine.check（modeOverride 作用域覆盖，不写回引擎状态）', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('引擎为 safe 时，传入 auto 覆盖使破坏性工具放行（覆盖生效）', async () => {
        const engine = new PermissionEngine()
        await engine.getMode() // ensureInit：mock 上下文 mode 为 safe
        const tool = makeTool('deleteFile', {isDestructive: true})
        const result = engine.check(tool, {}, 'auto')
        expect(result.allowed).toBe(true)
    })

    it('不传覆盖时仍按引擎原 safe 判定（未回归，override 未污染状态）', async () => {
        const engine = new PermissionEngine()
        await engine.getMode()
        const tool = makeTool('deleteFile', {isDestructive: true})
        const result = engine.check(tool, {})
        expect(result.allowed).toBe(false)
    })

    it('先带 auto 覆盖调用，再不带覆盖调用，判定仍基于原 safe（check 未写 this.mode）', async () => {
        const engine = new PermissionEngine()
        await engine.getMode()
        const tool = makeTool('deleteFile', {isDestructive: true})
        engine.check(tool, {}, 'auto')
        const result = engine.check(tool, {})
        expect(result.allowed).toBe(false)
        expect(await engine.getMode()).toBe('safe')
    })
})
