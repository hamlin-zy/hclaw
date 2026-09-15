import {describe, it, expect} from 'vitest'
import {isValidCommandName, getCommandNameError} from '../../src/shared/commandName'

describe('isValidCommandName', () => {
    it('允许中文命令名', () => {
        expect(isValidCommandName('日报')).toBe(true)
        expect(isValidCommandName('每日报告')).toBe(true)
        expect(isValidCommandName('日报-2024')).toBe(true)
    })

    it('允许英文、数字、下划线、连字符', () => {
        expect(isValidCommandName('daily-report')).toBe(true)
        expect(isValidCommandName('explain')).toBe(true)
        expect(isValidCommandName('cmd_2')).toBe(true)
        expect(isValidCommandName('A1_b-2')).toBe(true)
        expect(isValidCommandName('日报2_v2')).toBe(true)
    })

    it('拒绝会破坏文件名的字符', () => {
        expect(isValidCommandName('daily report')).toBe(false)   // 空格
        expect(isValidCommandName('a/b')).toBe(false)            // 路径分隔符
        expect(isValidCommandName('a\\b')).toBe(false)
        expect(isValidCommandName('a:b')).toBe(false)
        expect(isValidCommandName('a*b')).toBe(false)
        expect(isValidCommandName('a?b')).toBe(false)
        expect(isValidCommandName('a"b')).toBe(false)
        expect(isValidCommandName('a<b')).toBe(false)
        expect(isValidCommandName('a>b')).toBe(false)
        expect(isValidCommandName('a|b')).toBe(false)
        expect(isValidCommandName('a.b')).toBe(false)            // 点号
    })

    it('拒绝空串与 . / ..', () => {
        expect(isValidCommandName('')).toBe(false)
        expect(isValidCommandName('.')).toBe(false)
        expect(isValidCommandName('..')).toBe(false)
    })

    it('拒绝 emoji 等非字母数字字符', () => {
        expect(isValidCommandName('日报🚀')).toBe(false)
        expect(isValidCommandName('日报！')).toBe(false)
    })

    it('拒绝 Windows 保留设备名（大小写不敏感）', () => {
        expect(isValidCommandName('CON')).toBe(false)
        expect(isValidCommandName('nul')).toBe(false)
        expect(isValidCommandName('Nul')).toBe(false)
        expect(isValidCommandName('Com1')).toBe(false)
        expect(isValidCommandName('LPT9')).toBe(false)
        expect(isValidCommandName('prn')).toBe(false)
        expect(isValidCommandName('aux')).toBe(false)
    })

    it('放行与保留名相似但非保留的名称', () => {
        expect(isValidCommandName('COM10')).toBe(true)
        expect(isValidCommandName('COM')).toBe(true)
        expect(isValidCommandName('CONT')).toBe(true)
        expect(isValidCommandName('LPT')).toBe(true)
        expect(isValidCommandName('COM0')).toBe(true)
    })
})

describe('getCommandNameError', () => {
    it('合法名称返回 null', () => {
        expect(getCommandNameError('日报')).toBeNull()
        expect(getCommandNameError('daily-report')).toBeNull()
        expect(getCommandNameError('COM10')).toBeNull()
    })

    it('空串返回「不能为空」', () => {
        expect(getCommandNameError('')).toBe('命令名称不能为空')
    })

    it('非法字符与保留名的文案可区分', () => {
        const charError = getCommandNameError('daily report')
        const reservedError = getCommandNameError('CON')
        expect(charError).toBe('命令名称只能包含中英文、数字、下划线或连字符')
        expect(reservedError).toContain('保留名')
        expect(reservedError).not.toBe(charError)
    })
})

describe('getCommandNameError 查重（existingNames）', () => {
    it('命中已有命令名 → 返回统一文案', () => {
        expect(getCommandNameError('daily', ['daily', 'other'])).toBe('已存在同名命令，请修改命令名')
    })

    it('查重大小写不敏感（Windows 文件名不区分大小写）', () => {
        expect(getCommandNameError('Daily', ['daily'])).toBe('已存在同名命令，请修改命令名')
        expect(getCommandNameError('DAILY', ['Daily'])).toBe('已存在同名命令，请修改命令名')
        expect(getCommandNameError('日报', ['日报'])).toBe('已存在同名命令，请修改命令名')
    })

    it('不命中 → 返回 null', () => {
        expect(getCommandNameError('fresh', ['daily', 'other'])).toBeNull()
        expect(getCommandNameError('fresh', [])).toBeNull()
    })

    it('existingNames 缺省时行为不变（只做语法校验）', () => {
        expect(getCommandNameError('daily')).toBeNull()
        expect(getCommandNameError('daily report')).toBe('命令名称只能包含中英文、数字、下划线或连字符')
    })

    it('语法错误优先于查重', () => {
        expect(getCommandNameError('daily report', ['daily report'])).toBe('命令名称只能包含中英文、数字、下划线或连字符')
        expect(getCommandNameError('', ['anything'])).toBe('命令名称不能为空')
    })

    it('isValidCommandName 同步支持查重', () => {
        expect(isValidCommandName('daily', ['daily'])).toBe(false)
        expect(isValidCommandName('daily', ['other'])).toBe(true)
        expect(isValidCommandName('daily')).toBe(true)
    })
})
