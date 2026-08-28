import {describe, it, expect} from 'vitest'
import {LoopDetector, buildTurnToolCalls, silenceLoopPattern, isLoopPatternSilenced} from '../../../../src/main/agent/loop/loopDetector'

const call = (name: string, args: Record<string, unknown> = {path: 'a.txt'}, result = 'content-v1') =>
    [{name, args, resultPreview: result}]

describe('LoopDetector', () => {
    it('不足 threshold 轮不触发', () => {
        const d = new LoopDetector(3)
        expect(d.recordTurn(call('Read'))).toBeNull()
        expect(d.recordTurn(call('Read'))).toBeNull()
    })

    it('连续 threshold 轮相同签名触发 consecutive', () => {
        const d = new LoopDetector(3)
        d.recordTurn(call('Read'))
        d.recordTurn(call('Read'))
        const v = d.recordTurn(call('Read'))
        expect(v?.kind).toBe('consecutive')
        expect(v?.repeatCount).toBe(3)
    })

    it('签名任何差异即重置（参数或结果不同）', () => {
        const d = new LoopDetector(3)
        d.recordTurn(call('Read'))
        d.recordTurn(call('Read'))
        d.recordTurn(call('Read', {path: 'a.txt'}, 'content-v2'))  // 结果变了
        expect(d.recordTurn(call('Read', {path: 'a.txt'}, 'content-v2'))).toBeNull()
        d.recordTurn(call('Read', {path: 'b.txt'}, 'content-v2'))  // 参数变了
        expect(d.recordTurn(call('Read', {path: 'b.txt'}, 'content-v2'))).toBeNull()
    })

    it('reason 元信息参数差异不参与签名（模型每次措辞不同不应逃逸检测）', () => {
        const d = new LoopDetector(3)
        d.recordTurn(call('bash', {command: 'Get-Date', reason: '第1次调用'}))
        d.recordTurn(call('bash', {command: 'Get-Date', reason: '第2次调用'}))
        const v = d.recordTurn(call('bash', {command: 'Get-Date', reason: '第3次调用'}))
        expect(v?.kind).toBe('consecutive')
        expect(v?.repeatCount).toBe(3)
    })

    it('reason 之外的真实参数差异仍重置签名', () => {
        const d = new LoopDetector(3)
        d.recordTurn(call('bash', {command: 'Get-Date', reason: '第1次'}))
        d.recordTurn(call('bash', {command: 'Get-Date', reason: '第2次'}))
        expect(d.recordTurn(call('bash', {command: 'Get-Date -Format o', reason: '第3次'}))).toBeNull()
    })

    it('A,B,A,B 周期 2 触发 period2', () => {
        const d = new LoopDetector(3)
        d.recordTurn(call('Read'))
        d.recordTurn(call('Write', {path: 'a.txt'}))
        d.recordTurn(call('Read'))
        const v = d.recordTurn(call('Write', {path: 'a.txt'}))
        expect(v?.kind).toBe('period2')
        expect(v?.repeatCount).toBe(4)
    })

    it('多工具轮：调用集合不同则签名不同', () => {
        const d = new LoopDetector(3)
        d.recordTurn([{name: 'Read', args: {}, resultPreview: 'x'}, {name: 'Bash', args: {}, resultPreview: 'y'}])
        d.recordTurn([{name: 'Read', args: {}, resultPreview: 'x'}])
        expect(d.recordTurn([{name: 'Read', args: {}, resultPreview: 'x'}])).toBeNull()
    })

    it('长参数截断哈希：超长结果仅影响截断内一致', () => {
        const d = new LoopDetector(3)
        const long = 'x'.repeat(5000)
        d.recordTurn(call('Read', {path: 'a'}, long.slice(0, 2000) + 'A'))
        d.recordTurn(call('Read', {path: 'a'}, long.slice(0, 2000) + 'A'))
        const v = d.recordTurn(call('Read', {path: 'a'}, long.slice(0, 2000) + 'A'))
        expect(v).not.toBeNull()
    })

    it('静默后不再返回该指纹的 verdict，新模式不受影响', () => {
        const d = new LoopDetector(3)
        d.recordTurn(call('Read')); d.recordTurn(call('Read'))
        const v = d.recordTurn(call('Read'))
        // 第一次检测：modeTurns 累计 3 < threshold*2，未升级（repeatCount 仍为模式游程长度）
        expect(v?.repeatCount).toBe(3)
        expect(d.isEscalationReached(v!.fingerprint)).toBe(false)
        // 继续记录同一循环模式，再次触发 verdict，modeTurns 累计达到 threshold*2
        const v2 = d.recordTurn(call('Read'))
        expect(v2).not.toBeNull()
        expect(d.isEscalationReached(v!.fingerprint)).toBe(true)
        // 静默后不再返回该指纹的 verdict，新模式不受影响
        d.silence(v!.fingerprint)
        d.recordTurn(call('Write'))
        expect(d.recordTurn(call('Read'))).toBeNull()
    })

    it('threshold 低于 2 时被钳制为 2', () => {
        const d = new LoopDetector(1)
        expect(d.recordTurn(call('Read'))).toBeNull()
        const v = d.recordTurn(call('Read'))
        expect(v?.kind).toBe('consecutive')
        expect(v?.repeatCount).toBe(2)
    })

    it('模块级静默名单按 sessionId 隔离', () => {
        silenceLoopPattern('s1', 'fp1')
        expect(isLoopPatternSilenced('s1', 'fp1')).toBe(true)
        expect(isLoopPatternSilenced('s2', 'fp1')).toBe(false)
    })
})
