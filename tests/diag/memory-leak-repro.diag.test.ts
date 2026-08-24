// tests/diag/memory-leak-repro.diag.test.ts
// spec §7.2 D2/D3：先用已知泄漏验证检测器（防假阴性），再跑干净场景（防假阳性）。
// 需 --expose-gc：npm run diag:memory。CI 不收集（vitest.config.ts exclude）。
// 标定记录：踩坑两连——①闭包只捕获 String.repeat 结果是惰性 rope 不占堆；
// ②Float64Array backing store 计入 external 不计入 heapUsed。最终采用普通
// number 数组 new Array(8192).fill()（FixedDoubleArray 在 JS 堆上）= 64KB/轮，
// 检测器稳定触发（2026-08-24 标定通过）。
import {describe, it, expect} from 'vitest'
import {EventEmitter} from 'events'
import {detectGrowthTrend} from './growthDetector'

const hasGC = typeof (globalThis as any).gc === 'function'
const d = hasGC ? describe : describe.skip

const WARMUP = 10
const ROUNDS = 60
const PAYLOAD = new Array(2048).fill('x').join('') // ~4KB 字符串

/** 干净负载：每轮分配即弃，gc 后应无残留趋势 */
function cleanRound(): void {
    const tmp = {buf: PAYLOAD.repeat(16), ts: Date.now()}
    if (tmp.buf.length < 0) throw new Error('unreachable')
}

/** 已知泄漏负载：每轮给常驻 emitter 挂一个闭包 listener，闭包持有堆内大数组永不解绑（模拟 spec §3.1 盯防对象） */
const leakingEmitter = new EventEmitter()
function leakyRound(round: number): void {
    // 注意：①String.repeat 是惰性 rope，未被读取前不占堆；②Float64Array 等
    // TypedArray 的 backing store 计入 external 不计入 heapUsed。
    // 普通 number 数组（FixedDoubleArray）在 JS 堆上，heapUsed 可见：8192×8B=64KB/轮。
    const ballast = new Array(8192).fill(round + 1)
    leakingEmitter.on('tick', () => {
        // 闭包捕获 ballast，阻止回收
        if (ballast[0] < 0 || round < 0) throw new Error('unreachable')
    })
}

async function sampleSeries(roundFn: (round: number) => void): Promise<number[]> {
    const gc = (globalThis as any).gc as () => void
    const samples: number[] = []
    for (let i = 0; i < WARMUP + ROUNDS; i++) {
        roundFn(i)
        if (i >= WARMUP) {
            gc()
            // 双 gc：第一遍回收新生代，第二遍提升后老生代计数稳定
            gc()
            samples.push(process.memoryUsage().heapUsed)
            await new Promise(r => setTimeout(r, 20)) // 给 finalization 一点时间
        }
    }
    return samples
}

d('内存泄漏复现（手动诊断）', () => {
    it('D3: 注入已知 listener 泄漏，检测器必须抓到', async () => {
        const samples = await sampleSeries(leakyRound)
        const verdict = detectGrowthTrend(samples)
        expect(verdict.leaked).toBe(true)
    }, 120_000)

    it('D2: 干净场景连续 3 轮均判未泄漏（确定性）', async () => {
        for (let trial = 0; trial < 3; trial++) {
            const samples = await sampleSeries(cleanRound)
            const verdict = detectGrowthTrend(samples)
            expect(verdict.leaked).toBe(false)
        }
    }, 180_000)
})
