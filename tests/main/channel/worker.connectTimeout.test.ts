// @vitest-environment node
/**
 * ChannelWorker 连接超时定时器清理（B 批 · channel 侧防泄漏）。
 *
 * 竞态/泄漏点：connect 分支用 Promise.race([connect, timeout]) 兜超时，
 * 但成功路径从不 clearTimeout —— 连接建立后超时定时器仍在事件循环上挂着，
 * 直到 connectionTimeout 到期才释放（默认 30s，worker 线程被拖住）。
 *
 * 隔离：worker.ts 静态 import 了 worker_threads / 两个真适配器（会走真实网络），
 * 这里全部以最小替身注入，只驱动 parentPort.on('message') 的 connect 分支。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'

const fake = vi.hoisted(() => ({
    posted: [] as Array<Record<string, unknown>>,
    handler: null as null | ((msg: unknown) => Promise<void>),
    /** 由用例控制的 connect 行为：resolve = 连接成功；'never' = 永不返回（走超时） */
    connectBehavior: 'resolve' as 'resolve' | 'never',
}))

vi.mock('worker_threads', () => ({
    parentPort: {
        on: (_event: string, handler: (msg: unknown) => Promise<void>) => {
            fake.handler = handler
        },
        postMessage: (msg: Record<string, unknown>) => {
            fake.posted.push(msg)
        },
        close: () => {},
    },
}))

function adapterStub() {
    return class {
        async connect() {
            if (fake.connectBehavior === 'never') await new Promise(() => {})
        }

        async disconnect() {}
    }
}

vi.mock('../../../src/main/channel/adapters/feishuAdapter', () => ({FeishuAdapter: adapterStub()}))
vi.mock('../../../src/main/channel/adapters/wechatAdapter', () => ({WeChatAdapter: adapterStub()}))

// 导入即注册 parentPort message 处理器
await import('../../../src/main/channel/worker')

/** 每个用例用独立 channelId：同 id 二次 connect 会先 await existing.disconnect()，多一次微任务跳变 */
function connect(channelId: string, connectionTimeout = 30) {
    return fake.handler!({cmd: 'connect', channelId, channelType: 'feishu', config: {}, connectionTimeout})
}

beforeEach(() => {
    fake.posted = []
    fake.connectBehavior = 'resolve'
})

afterEach(() => {
    vi.useRealTimers()
})

describe('connect 超时定时器清理', () => {
    it('连接成功（远早于超时）→ 定时器即刻清理，不残留挂起定时器', async () => {
        vi.useFakeTimers()
        await connect('c1')

        // 成功路径：定时器必须已 clearTimeout（修复前残留 1 个 → 挂到 30s 才释放）
        expect(vi.getTimerCount()).toBe(0)
        expect(fake.posted).toContainEqual(expect.objectContaining({type: 'status', status: 'connected'}))
    })

    it('连接超时 → 仍按原语义报错，且定时器随后不再留存', async () => {
        vi.useFakeTimers()
        fake.connectBehavior = 'never'
        const pending = connect('c2')
        expect(vi.getTimerCount()).toBe(1)   // 未 settle 前定时器在等

        await vi.advanceTimersByTimeAsync(30_000)
        await pending
        expect(fake.posted).toContainEqual(
            expect.objectContaining({type: 'status', status: 'error', message: expect.stringContaining('连接超时')}),
        )
        expect(vi.getTimerCount()).toBe(0)
    })
})
