import {describe, it, expect} from 'vitest'
import {getPowerShellUtf8Init} from '../../../src/main/utils/powershellUtf8'

describe('getPowerShellUtf8Init（PowerShell UTF-8 初始化公共工具）', () => {
    it('声明 Console.OutputEncoding 为 UTF-8（PS 5.1 GBK 代码页乱码修复的关键行）', () => {
        expect(getPowerShellUtf8Init()).toContain('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8')
    })

    it('与 bashTool 既有初始化语义等价（含 Out-File/InputEncoding/$OutputEncoding）', () => {
        const init = getPowerShellUtf8Init()
        expect(init).toContain('$PSDefaultParameterValues["Out-File:Encoding"]="utf8"')
        expect(init).toContain('[Console]::InputEncoding=[System.Text.Encoding]::UTF8')
        expect(init).toContain('$OutputEncoding=[System.Text.Encoding]::UTF8')
    })

    it('幂等安全：PS 7+（默认 UTF-8）下重复声明无害——语句均为赋值而非重定向', () => {
        expect(getPowerShellUtf8Init()).not.toContain('>')
        expect(getPowerShellUtf8Init()).not.toContain('chcp')
    })
})
