/**
 * 回归测试：spawn 参数传递方式修复（DEP0190）
 *
 * 1. worktree.git — Windows 上不再使用 shell（避免用户路径被拼接转义，
 *    防止空格断裂/特殊字符注入），args 数组原样传递。
 * 2. scriptExecutor 的命令检测（detectPython）—
 *    Windows: shell:true + 单字符串（PATHEXT 解析需要 shell，DEP0190 要求
 *    shell 模式不得传 args 数组）；非 Windows: 无 shell + args 数组
 *    （引号字符串在无 shell 时会被当作含引号的文件名导致 ENOENT）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import type {SpawnSyncOptions} from 'child_process'

const spawnSyncMock = vi.fn()
const spawnMock = vi.fn()

vi.mock('child_process', () => ({
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
    default: {
        spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
        spawn: (...args: unknown[]) => spawnMock(...args),
    },
}))
vi.mock('node:child_process', () => ({
    spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
    default: {
        spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
        spawn: (...args: unknown[]) => spawnMock(...args),
    },
}))

import {WorktreeManager} from '@/main/agent/isolation/worktree'

describe('worktree.git spawn 参数（DEP0190 回归）', () => {
    beforeEach(() => spawnSyncMock.mockReset())

    it('不使用 shell，git 与 args 数组原样传递', () => {
        spawnSyncMock.mockReturnValue({status: 0, stdout: Buffer.from(''), stderr: Buffer.from('')})
        const mgr = new WorktreeManager()
        mgr['git'](['worktree', 'add', 'E:/dir with space/.hclaw-worktrees/w1', '-b', 'hclaw-abcd1234'], {
            cwd: 'E:/dir with space',
            stdio: 'pipe',
        })

        expect(spawnSyncMock).toHaveBeenCalledTimes(1)
        const [cmd, args, opts] = spawnSyncMock.mock.calls[0] as [string, string[], SpawnSyncOptions]
        expect(cmd).toBe('git')
        expect(args).toEqual(['worktree', 'add', 'E:/dir with space/.hclaw-worktrees/w1', '-b', 'hclaw-abcd1234'])
        expect(opts.shell).toBeUndefined()
    })
})

describe('commandExists 平台分支（经 detectPython 验证）', () => {
    const origPlatform = process.platform

    afterEach(() => {
        Object.defineProperty(process, 'platform', {value: origPlatform, configurable: true})
    })

    function setPlatform(p: string) {
        Object.defineProperty(process, 'platform', {value: p, configurable: true})
    }

    beforeEach(() => {
        spawnMock.mockReset()
        spawnMock.mockImplementation(() => {
            const listeners: Record<string, Array<(code: number) => void>> = {}
            const proc = {
                on: (ev: string, cb: (code: number) => void) => {
                    (listeners[ev] ||= []).push(cb)
                    return undefined
                },
                kill: () => undefined,
            }
            // 异步触发 close(0) 模拟命令存在
            setTimeout(() => listeners['close']?.forEach(cb => cb(0)), 0)
            return proc
        })
    })

    it('Windows：shell:true 且命令为带引号的单字符串（不得传 args 数组）', async () => {
        setPlatform('win32')
        const {checkScriptDependencies} = await import('@/main/agent/skills/scriptExecutor')
        // python 分支必经 commandExists（'python3'/'python'）+ shell 参数检查
        await checkScriptDependencies([{name: 't.py', language: 'python'} as any])

        expect(spawnMock).toHaveBeenCalled()
        for (const call of spawnMock.mock.calls) {
            const [command, argsOrOpts, opts] = call as [string, unknown, {shell?: boolean}]
            // 无 shell 分支不允许出现在 Windows
            expect(Array.isArray(argsOrOpts)).toBe(false)
            const options = (opts || argsOrOpts) as {shell?: boolean}
            expect(options.shell).toBe(true)
            // 单字符串命令：引号包裹 + --version，无未转义拼接风险
            expect(command).toMatch(/^"[^"]+" --version$/)
        }
    })

    it('Linux/macOS：无 shell，命令名与 args 数组分离（不带引号）', async () => {
        setPlatform('linux')
        const {checkScriptDependencies} = await import('@/main/agent/skills/scriptExecutor')
        await checkScriptDependencies([{name: 't.py', language: 'python'} as any])

        expect(spawnMock).toHaveBeenCalled()
        for (const call of spawnMock.mock.calls) {
            const [command, argsOrOpts, opts] = call as [string, unknown, {shell?: boolean}]
            expect(Array.isArray(argsOrOpts)).toBe(true)
            expect(argsOrOpts).toEqual(['--version'])
            expect(command).not.toContain('"')
            const options = (opts || {}) as {shell?: boolean}
            expect(options.shell).toBeFalsy()
        }
    })
})
