/**
 * AgentManager 正常完成提醒回归测试 — done(reason completed) 触发任务栏/托盘提醒
 *
 * 背景：权限确认、ask_user、循环检测警告均有任务栏闪烁/托盘角标提醒（attention.ts），
 * 但「正常完成」此前不提醒。本测试验证：done(reason completed) 的 worker 正常退出时
 * 会调用 notifyUserAttention()，而 aborted/error/崩溃退出不触发。
 *
 * 2026-09-15 追加：done(reason max_turns_reached)（跑满轮数上限被截断）同样触发提醒——
 * 窗口隐藏时用户无从得知任务停在了上限处。notifyUserAttention 只闪烁、不带文案，不会误报「完成」。
 *
 * 环境搭建：electron 空壳 + attention 模块 mock + config 隔离，直接驱动
 * handleDoneEvent（标记完成）→ onWorkerExit（消费标记触发提醒）的生产路径。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

// ── attention 模块 mock：拦截 notifyUserAttention / stopUserAttention ──
const attentionMocks = vi.hoisted(() => ({
    notifyUserAttention: vi.fn(),
    stopUserAttention: vi.fn(),
}))

vi.mock('@/main/attention', () => attentionMocks)

// ── config 重定向到临时目录（避免触碰真实 ~/.hclaw）──
vi.mock('@/main/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const os = require('os')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-completion-attention-' + Date.now())
    return {
        getHclawDir: () => testDir,
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
    }
})
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw

// ── electron 空壳 ──
vi.mock('electron', () => ({
    BrowserWindow: class {
        static getAllWindows() { return [] }
    },
    app: {getPath: () => '/tmp', isReady: () => true},
    dialog: {showErrorBox: vi.fn()},
    ipcMain: {handle: vi.fn(), on: vi.fn()},
}))

import {AgentManager} from '@/main/agent/manager.impl'

let manager: AgentManager

beforeEach(() => {
    vi.clearAllMocks()
    manager = new AgentManager()
})

/** 经生产路径驱动：handleDoneEvent 标记完成 → onWorkerExit 消费标记 */
async function driveCompletion(reason: 'completed' | 'aborted' | 'error' | 'max_turns_reached'): Promise<void> {
    await (manager as any).handleDoneEvent('conv-1', {type: 'done', reason})
    ;(manager as any).onWorkerExit('conv-1', {} as unknown, 0)
}

describe('正常完成提醒 — done(reason completed)', () => {
    it('completed 正常退出触发 notifyUserAttention（且先 stop 释放旧引用）', async () => {
        await driveCompletion('completed')

        expect(attentionMocks.notifyUserAttention).toHaveBeenCalledTimes(1)
        // onWorkerExit 首行始终释放退出 worker 的引用（既有安全网，回归断言）
        expect(attentionMocks.stopUserAttention).toHaveBeenCalledTimes(1)
    })

    it('aborted 退出不触发完成提醒', async () => {
        await driveCompletion('aborted')
        expect(attentionMocks.notifyUserAttention).not.toHaveBeenCalled()
    })

    it('max_turns_reached 截断退出触发提醒（窗口隐藏时用户需得知任务停在上限处）', async () => {
        await driveCompletion('max_turns_reached')

        expect(attentionMocks.notifyUserAttention).toHaveBeenCalledTimes(1)
        expect(attentionMocks.stopUserAttention).toHaveBeenCalledTimes(1)
    })

    it('max_turns_reached 标记同样一次性消费：重复退出不重复提醒', async () => {
        await driveCompletion('max_turns_reached')
        ;(manager as any).onWorkerExit('conv-1', {} as unknown, 0)
        expect(attentionMocks.notifyUserAttention).toHaveBeenCalledTimes(1)
    })

    it('error 退出不触发完成提醒', async () => {
        await driveCompletion('error')
        expect(attentionMocks.notifyUserAttention).not.toHaveBeenCalled()
    })

    it('completed 标记一次性消费：同一会话重复退出不重复提醒', async () => {
        await driveCompletion('completed')
        // 第二次退出：标记已被 delete，不再触发
        ;(manager as any).onWorkerExit('conv-1', {} as unknown, 0)
        expect(attentionMocks.notifyUserAttention).toHaveBeenCalledTimes(1)
    })
})
