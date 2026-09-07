/**
 * memo_tool 单元测试
 *
 * ⚠️ 隔离保证：vi.mock 把 getHclawDir() 重定向到 os.tmpdir() 独立临时目录，
 *    memoStore 落盘在 <testDir>/data/memo，绝不触碰真实 ~/.hclaw；
 *    electron 的 BrowserWindow mock 掉以验证广播调用。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const testDir = path.join(os.tmpdir(), 'hclaw-test-memo-tool-' + Date.now())

vi.mock('../../../../../src/main/config', () => ({
    getHclawDir: () => testDir,
}))

// electron mock：收集 memo_changed 广播，便于断言
const sentMessages: Record<string, Array<{ channel: string; payload: unknown }>> = {}
vi.mock('electron', () => ({
    BrowserWindow: {
        getAllWindows: () => [
            {
                isDestroyed: () => false,
                webContents: {
                    send: (channel: string, payload: unknown) => {
                        sentMessages[channel] = sentMessages[channel] || []
                        sentMessages[channel].push(payload)
                    },
                },
            },
        ],
    },
}))

import {memoTool} from '../../../../../src/main/agent/tools/builtin/memoTool'
import {memoStore} from '../../../../../src/main/memo/memoStore'
import type {ToolContext} from '../../../../../src/main/agent/tools/types'

/** 构造工具执行上下文（workingDir 指向临时工作区） */
function makeContext(): ToolContext {
    return {
        workingDir: path.join(testDir, 'workspace'),
        abortSignal: new AbortController().signal,
        sendMessage: vi.fn(),
    } as ToolContext
}

beforeEach(() => {
    fs.rmSync(path.join(testDir, 'data', 'memo'), {recursive: true, force: true})
    sentMessages['memo_changed'] = []
})

describe('memo_tool', () => {
    it('create 成功写入 memoStore 并广播 memo_changed', async () => {
        const ctx = makeContext()
        const result = await memoTool.execute(
            {action: 'create', title: '整理周报', content: '整理本周周报，包含进展与风险。'},
            ctx,
        )
        expect(result.success).toBe(true)
        const items = memoStore.list(ctx.workingDir)
        expect(items).toHaveLength(1)
        expect(items[0].title).toBe('整理周报')
        expect(items[0].workspacePath).toBe(ctx.workingDir)
        expect(sentMessages['memo_changed']).toEqual([{workspacePath: ctx.workingDir}])
    })

    it('create 传 priority 时补写成功', async () => {
        const ctx = makeContext()
        const result = await memoTool.execute(
            {action: 'create', title: '紧急修复', content: '线上问题回滚。', priority: 'urgent'},
            ctx,
        )
        expect(result.success).toBe(true)
        expect(memoStore.list(ctx.workingDir)[0].priority).toBe('urgent')
    })

    it.each([
        [{action: 'create' as const, content: '有内容'}, 'title'],
        [{action: 'create' as const, title: '有标题'}, 'content'],
        [{action: 'create' as const, title: '   ', content: '内容'}, 'title'],
        [{action: 'create' as const, title: '标题', content: '  '}, 'content'],
    ])('create 空标题/空内容 → 失败且错误信息明确', async (args, field) => {
        const result = await memoTool.execute(args, makeContext())
        expect(result.success).toBe(false)
        expect(result.error).toContain(field)
        expect(result.error).toContain('不能为空')
    })

    it('list 返回含 content 全量的条目', async () => {
        const ctx = makeContext()
        memoStore.create({workspacePath: ctx.workingDir, title: 'A', content: 'A 的完整任务描述'})
        memoStore.create({workspacePath: ctx.workingDir, title: 'B', content: 'B 的完整任务描述'})
        const result = await memoTool.execute({action: 'list'}, ctx)
        expect(result.success).toBe(true)
        expect(result.output).toContain('A 的完整任务描述')
        expect(result.output).toContain('B 的完整任务描述')
        expect(result.output).toContain('状态: active')
    })

    it('update 不存在的 id → 失败且错误明确', async () => {
        const result = await memoTool.execute(
            {action: 'update', id: 'memo-not-exist', status: 'processed'},
            makeContext(),
        )
        expect(result.success).toBe(false)
        expect(result.error).toContain('未找到')
        expect(result.error).toContain('memo-not-exist')
    })

    it('update 成功修改状态并广播（broadcast 用 MemoItem.workspacePath）', async () => {
        const ctx = makeContext()
        const item = memoStore.create({workspacePath: ctx.workingDir, title: 'T', content: 'C'})
        const result = await memoTool.execute(
            {action: 'update', id: item.id, status: 'processed', priority: 'low'},
            ctx,
        )
        expect(result.success).toBe(true)
        const updated = memoStore.findById(item.id)!
        expect(updated.status).toBe('processed')
        expect(updated.priority).toBe('low')
        expect(sentMessages['memo_changed']).toEqual([{workspacePath: ctx.workingDir}])
    })

    it('delete 不存在的 id → 失败', async () => {
        const result = await memoTool.execute({action: 'delete', id: 'memo-not-exist'}, makeContext())
        expect(result.success).toBe(false)
        expect(result.error).toContain('未找到')
    })

    it('delete 成功移除并广播', async () => {
        const ctx = makeContext()
        const item = memoStore.create({workspacePath: ctx.workingDir, title: 'T', content: 'C'})
        const result = await memoTool.execute({action: 'delete', id: item.id}, ctx)
        expect(result.success).toBe(true)
        expect(memoStore.findById(item.id)).toBeUndefined()
        expect(sentMessages['memo_changed']).toEqual([{workspacePath: ctx.workingDir}])
    })

    it('工具定义 isDestructive === true', () => {
        expect(memoTool.isDestructive).toBe(true)
    })

    it('workspacePath 使用 context.workingDir（不落其他工作区）', async () => {
        const ctx = makeContext()
        const otherDir = path.join(testDir, 'other-workspace')
        await memoTool.execute({action: 'create', title: 'T', content: 'C'}, ctx)
        expect(memoStore.list(otherDir)).toHaveLength(0)
        expect(memoStore.list(ctx.workingDir)).toHaveLength(1)
    })
})
