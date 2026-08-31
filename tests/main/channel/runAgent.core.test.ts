/**
 * runAgent — channel 迁移到统一启动入口 startAgentCore
 *
 * runAgent 不再直接调用 agentManager.start，而是先经 startAgentCore
 * （origin='channel'，suppressUserMessage=true，不传 messages），
 * 再进入 stream listener 等待直至 done/error。
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'

vi.mock('@/main/agent/startAgentCore', () => ({
    startAgentCore: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/main/agent/manager', () => ({
    agentManager: {addStreamListener: vi.fn()},
}))
vi.mock('@/main/agent/logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))
vi.mock('@/main/services/mcpService', () => ({mcpService: {list: vi.fn(() => [])}}))
vi.mock('@/main/window', () => ({getMainWindow: vi.fn(() => null)}))
vi.mock('@/main/channel/utils', () => ({
    hasAudioAttachment: vi.fn(() => false),
    isAttachmentOnlyMarker: vi.fn(() => false),
}))
// 抑制模块加载侧的定时器副作用（积压附件 TTL 清理）
vi.stubGlobal('setInterval', vi.fn(() => 0))

import {agentManager} from '@/main/agent/manager'
import {startAgentCore} from '@/main/agent/startAgentCore'
import {runAgent} from '@/main/channel/messageHandler'

let emitDone: () => void = () => {}
let emitText: (t: string) => void = () => {}
let emitError: (e: string) => void = () => {}

function captureStream() {
    let cb: ((event: any) => void) | undefined
    vi.mocked(agentManager.addStreamListener).mockImplementation((_id: string, listener: (event: any) => void) => {
        cb = listener
        return () => {}
    })
    emitDone = () => cb?.({type: 'done', reason: 'end'})
    emitText = (t: string) => cb?.({type: 'text', content: t})
    emitError = (e: string) => cb?.({type: 'error', error: e})
}

describe('runAgent — channel 统一启动入口契约', () => {
    beforeEach(() => {
        vi.mocked(startAgentCore).mockClear().mockResolvedValue(undefined)
        vi.mocked(agentManager.addStreamListener).mockClear()
    })

    it('先调 startAgentCore：origin=channel、suppressUserMessage=true、不传 messages', async () => {
        captureStream()
        const p = runAgent({
            conversationId: 'conv-1',
            message: '分析附件',
            messageAttachments: [{path: 'E:/a.png', name: 'a.png'}],
            workingDir: 'E:/ws',
        })
        expect(startAgentCore).toHaveBeenCalledTimes(1)
        expect(vi.mocked(startAgentCore).mock.calls[0][1]).toBe('channel')
        const params = vi.mocked(startAgentCore).mock.calls[0][0] as any
        expect(params.conversationId).toBe('conv-1')
        expect(params.message).toBe('分析附件')
        expect(params.suppressUserMessage).toBe(true)
        expect(params.messageAttachments).toEqual([{path: 'E:/a.png', name: 'a.png'}])
        expect('messages' in params).toBe(false)
        expect(agentManager.addStreamListener).toHaveBeenCalledTimes(1)
        // 等待 core mock resolve 后，runAgent 仍在监听流 → emit done 收尾
        await Promise.resolve()
        emitDone()
        await p
    })

    it('startAgentCore 失败时 runAgent reject', async () => {
        vi.mocked(startAgentCore).mockRejectedValueOnce(new Error('scheme empty'))
        await expect(runAgent({conversationId: 'c', message: 'm', workingDir: ''}))
            .rejects.toThrow('scheme empty')
    })

    it('core 成功后进入流监听，done 时 resolve 累积文本', async () => {
        captureStream()
        const p = runAgent({conversationId: 'c', message: 'hi', workingDir: ''})
        emitText('你好')
        emitDone()
        await expect(p).resolves.toBe('你好')
    })

    it('流 error 事件时 reject', async () => {
        captureStream()
        const p = runAgent({conversationId: 'c', message: 'hi', workingDir: ''})
        emitError('boom')
        await expect(p).rejects.toThrow('boom')
    })
})
