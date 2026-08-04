/**
 * executor 结果大小检查单元测试
 *
 * 覆盖本次修复（bash 工具输出截断）：
 * - bash 工具使用差异化阈值（2MB），不再被 15KB 通用阈值截断
 * - 其他工具维持通用阈值（15KB），超过仍截断
 * - 阈值内输出原样返回（不添加截断标记）
 * - 超过通用阈值但低于警告阈值时不截断
 */
import {describe, expect, it} from 'vitest'
import {checkResultSize} from '../../../../src/main/agent/tools/executor'

function okResult(output: string) {
    return {success: true, output}
}

describe('checkResultSize', () => {
    it('bash 工具输出超过 15KB 但不截断（差异化阈值 2MB）', () => {
        // 20KB > 通用 15KB 阈值，但 bash 应使用 2MB 阈值
        const big = 'x'.repeat(20 * 1024)
        const result = checkResultSize('bash', okResult(big))
        expect(result.output).toContain(big) // 完整内容保留
        expect(result.output).not.toContain('[结果已截断]')
    })

    it('bash 工具输出超过 2MB 时仍截断（内部上限兜底一致）', () => {
        // 2MB + 100 字符 > 2MB 阈值 → 应截断
        const huge = 'x'.repeat(2 * 1024 * 1024 + 100)
        const result = checkResultSize('bash', okResult(huge))
        expect(result.output).toContain('[结果已截断]')
        expect(result.output.length).toBeLessThan(huge.length)
    })

    it('非 bash 工具超过 15KB 仍按通用阈值截断', () => {
        const big = 'y'.repeat(20 * 1024)
        const result = checkResultSize('grep', okResult(big))
        expect(result.output).toContain('[结果已截断]')
        expect(result.output).toContain('超过 15000 字符限制')
    })

    it('输出为空时不处理', () => {
        const result = checkResultSize('bash', {success: true, output: ''})
        expect(result.output).toBe('')
    })

    it('输出在警告阈值内时原样返回', () => {
        const small = 'z'.repeat(1000)
        const result = checkResultSize('file_read', okResult(small))
        expect(result.output).toBe(small)
    })

    it('输出在警告与截断阈值之间时添加警告但不截断', () => {
        // 10KB > 5KB 警告阈值，但 < 15KB 截断阈值
        const mid = 'w'.repeat(10 * 1024)
        const result = checkResultSize('file_read', okResult(mid))
        expect(result.output).toContain('[警告] 结果较大')
        expect(result.output).not.toContain('[结果已截断]')
        expect(result.output).toContain(mid) // 完整内容保留
    })
})
