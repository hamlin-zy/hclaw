import {describe, it, expect} from 'vitest'
import {StreamRepetitionDetector} from '../../../../src/main/agent/loop/streamRepetitionDetector'
import {DEFAULT_SETTINGS} from '../../../../src/shared/settingsDefaults'

describe('StreamRepetitionDetector', () => {
    it('不触发：短文本无重复', () => {
        const d = new StreamRepetitionDetector({shingleSize: 50, threshold: 3, checkInterval: 20})
        d.append('这是一段简短的文本，不会触发重复检测。')
        expect(d.isDetected).toBe(false)
        expect(d.getTruncatedContent()).toBe('这是一段简短的文本，不会触发重复检测。')
    })

    it('触发：同一段文本重复多次', () => {
        const d = new StreamRepetitionDetector({shingleSize: 50, threshold: 3, checkInterval: 20})
        // segment 长于 shingleSize，确保完整覆盖一个窗口
        const segment = '请检查文件内容并确认路径是否正确，然后继续执行下一步操作流程，确保所有步骤都已完成后才能退出。'
        // 重复 8 次：segment ~40 字符 × 8 = 320 字符，足够同 shingle 出现 ≥3 次
        d.append(segment.repeat(8))
        expect(d.isDetected).toBe(true)
        const truncated = d.getTruncatedContent()
        expect(truncated.length).toBeLessThan(segment.repeat(8).length)
        expect(truncated.length).toBeGreaterThanOrEqual(segment.length)
    })

    it('不触发：相似但不完全相同的内容', () => {
        const d = new StreamRepetitionDetector({shingleSize: 50, threshold: 3, checkInterval: 20})
        d.append('第一步：读取文件内容并解析配置项。')
        d.append('第二步：检查数据库连接是否正常。')
        d.append('第三步：验证用户权限并执行操作。')
        expect(d.isDetected).toBe(false)
    })

    it('触发后 append 不再处理', () => {
        const d = new StreamRepetitionDetector({shingleSize: 50, threshold: 3, checkInterval: 20})
        const segment = '这是一个需要重复检测的测试文本片段，长度超过窗口大小阈值，确保能覆盖完整 shingle。'
        d.append(segment.repeat(8))
        expect(d.isDetected).toBe(true)
        const truncated = d.getTruncatedContent()
        d.append('更多重复内容' + segment.repeat(10))
        expect(d.getTruncatedContent()).toBe(truncated)
    })

    it('参数钳制：低于下限的参数被提升', () => {
        const d = new StreamRepetitionDetector({shingleSize: 1, threshold: 1, checkInterval: 1})
        // threshold 钳到 2，shingleSize 钳到 50：短文本不足一个窗口
        d.append('任意文本任意文本任意文本')
        expect(d.isDetected).toBe(false)
    })

    it('未触发时 getTruncatedContent 返回完整 buffer', () => {
        const d = new StreamRepetitionDetector()
        d.append('普通文本内容')
        expect(d.isDetected).toBe(false)
        expect(d.getTruncatedContent()).toBe('普通文本内容')
    })

    // 落点说明：该断言跨「detector 构造默认」与「shared settingsDefaults 单一真源」两侧；
    // 纯 shared 侧无法观测 detector 的构造默认值，故留在本文件以锁定两侧一致。
    it('构造默认参数与 settingsDefaults 默认值一致（缺省 ⇒ 开启）', () => {
        const defaults = DEFAULT_SETTINGS.agent.streamRepetitionDetection!
        expect(defaults).toEqual({enabled: true, shingleSize: 120, threshold: 3, checkInterval: 60})

        // detector 的 opts 为运行时私有字段，经类型断言读取以校验构造默认值
        const detector = new StreamRepetitionDetector()
        const opts = (detector as unknown as {
            opts: {shingleSize: number; threshold: number; checkInterval: number}
        }).opts
        expect(opts).toEqual({
            shingleSize: defaults.shingleSize,
            threshold: defaults.threshold,
            checkInterval: defaults.checkInterval,
        })
    })
})
