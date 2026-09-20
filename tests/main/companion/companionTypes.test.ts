import {describe, it, expect} from 'vitest'
import {parseArgs} from '../../../src/shared/types/companion'

describe('parseArgs（EnumeratedApp.args string → CompanionApp.args string[]）', () => {
    it('空字符串返回空数组', () => {
        expect(parseArgs('')).toEqual([])
    })
    it('纯空白返回空数组', () => {
        expect(parseArgs('   ')).toEqual([])
    })
    it('单参数', () => {
        expect(parseArgs('--minimized')).toEqual(['--minimized'])
    })
    it('多参数按空白分割', () => {
        expect(parseArgs('--arg1 value1 --arg2')).toEqual(['--arg1', 'value1', '--arg2'])
    })
    it('前后空白被 trim', () => {
        expect(parseArgs('  --minimized  ')).toEqual(['--minimized'])
    })
    it('【已知限制文档化】带空格的路径参数会被错误切分（spec YAGNI，不引入 shell-quote）', () => {
        expect(parseArgs('--config "C:\\Program Files\\x\\a.json"')).toEqual([
            '--config', '"C:\\Program', 'Files\\x\\a.json"',
        ])
    })
})

describe('类型形状（编译期契约，运行时仅抽查可构造性）', () => {
    it('CompanionApp 默认值构造', () => {
        const app = {
            id: 'companion-1', name: 'Obsidian', exePath: 'C:\\a\\Obsidian.exe',
            args: [], processName: 'Obsidian.exe', launchTiming: 'after' as const,
            waitForReady: false, enabled: true,
        }
        expect('waitTimeoutMs' in app).toBe(false)
    })
})
