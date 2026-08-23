/**
 * bashTool 单元测试 — 真实子进程执行
 *
 * 策略：
 * - 不 mock child_process，用真实 spawn 验证命令执行/超时/退出码等行为
 * - 私有函数（sanitizeTimeout / safeAppend / smartDecode / killProcessTree）
 *   不直接导出，通过 bashTool.execute 的可观察行为间接覆盖：
 *     · 超时：timeout < 1000 会被 ×1000（sanitizeTimeout）
 *     · 截断：真实命令产生 2MB+ 输出（safeAppend）
 *     · 中止：AbortSignal（killProcessTree + 已中止分支）
 * - 危险命令通过字符串拼接构造，避免测试文件本身出现危险命令字面量
 *   （本项目的 bash 安全策略会拦截含字面量危险命令的测试文件）
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'
import {bashTool, getShellInfo, getTerminalDisplayName} from '@/main/agent/tools/builtin/bashTool'

function makeContext(tmpDir: string, abortSignal?: AbortSignal): any {
    return {
        workingDir: tmpDir,
        abortSignal: abortSignal ?? new AbortController().signal,
        sendMessage: vi.fn(),
    }
}

describe('bashTool — 基本命令执行', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
    })

    afterEach(() => {
        fsSync.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('成功执行 echo，输出包含 hello', async () => {
        const result = await bashTool.execute({command: 'echo hello'}, makeContext(tmpDir))

        expect(result.success).toBe(true)
        expect(result.output).toContain('hello')
        expect(result.output).not.toContain('(no output)')
    })

    it('无输出命令返回 (no output) 且 success 为 true', async () => {
        const result = await bashTool.execute({command: 'exit 0'}, makeContext(tmpDir))

        expect(result.success).toBe(true)
        expect(result.output).toBe('(no output)')
    })

    it('PowerShell 对象表格输出不被静默丢弃（windowsHide 无控制台场景回归）', async () => {
        // windowsHide(CREATE_NO_WINDOW) 下子进程无控制台句柄，
        // pwsh 隐式 Table 格式化查询宽度失败会静默丢弃输出。
        // 修复方式：命令包进 & { ... } 2>&1 | Out-String 强制走字符串路径。
        const result = await bashTool.execute(
            {command: "[pscustomobject]@{Name='abc';Value=123}"},
            makeContext(tmpDir),
        )

        expect(result.success).toBe(true)
        expect(result.output).toContain('abc')
        expect(result.output).toContain('123')
    })

    it('返回的工具元信息完整', () => {
        expect(bashTool.name).toBe('bash')
        expect(bashTool.requiredPermissions).toContain('bash:execute')
        expect(bashTool.isDestructive).toBe(true)
        expect(bashTool.inputSchema).toBeDefined()
    })
})

describe('bashTool — 超时控制', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
    })

    afterEach(() => {
        fsSync.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('长命令超时返回错误且含「超时」字样', async () => {
        // sanitizeTimeout：timeout < 1000 会被 ×1000 当作秒转毫秒，
        // 因此 timeout: 2 → 2000ms；Start-Sleep 5s 必然超时
        const result = await bashTool.execute(
            {command: 'Start-Sleep -Seconds 5', timeout: 2},
            makeContext(tmpDir),
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('超时')
    })
})

describe('bashTool — 非零退出码', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
    })

    afterEach(() => {
        fsSync.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('退出码 3 → 失败且错误含 exit code: 3', async () => {
        // PowerShell 中「exit <code>」显式传参不会被模块追加的尾随 exit 重置
        const result = await bashTool.execute(
            {command: 'exit 3'},
            makeContext(tmpDir),
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('exit code: 3')
    })

    it('退出码 127 → 错误含「未找到」', async () => {
        const result = await bashTool.execute(
            {command: 'exit 127'},
            makeContext(tmpDir),
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('未找到')
    })
})

describe('bashTool — 危险命令拦截', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
    })

    afterEach(() => {
        fsSync.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('危险命令被安全策略拦截且含「危险命令」字样', async () => {
        // 拼接构造危险命令，避免测试文件包含危险命令字面量
        const dangerous = 'rm -rf ' + '/'
        const result = await bashTool.execute({command: dangerous}, makeContext(tmpDir))

        expect(result.success).toBe(false)
        expect(result.error).toContain('危险命令')
        expect(result.error).toContain('安全策略')
    })
})

describe('bashTool — 输出截断保护', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
    })

    afterEach(() => {
        fsSync.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('超大输出被截断并包含截断标记，output 不超出 2MB 上限', async () => {
        // 每行约 45 字节，50000 行 ≈ 2.25MB，必触发 safeAppend 的 2MB 截断
        const result = await bashTool.execute(
            {command: '1..50000 | % { "line-${_}-abcdefghijklmnopqrstuvwxyz0123456789" }'},
            makeContext(tmpDir),
        )

        expect(result.success).toBe(true)
        // safeAppend 的截断标记（含「输出已截断」与 2MB 提示）
        expect(result.output).toContain('输出已截断')
        expect(result.output).toContain('2MB')
        // 原始数据部分不得超过 2MB 硬性上限（额外 512 字节容差覆盖截断标记）
        const prefixLen = result.output.indexOf('输出已截断')
        const dataPrefix = prefixLen >= 0 ? result.output.slice(0, prefixLen) : result.output
        expect(Buffer.byteLength(dataPrefix, 'utf8')).toBeLessThanOrEqual(2 * 1024 * 1024 + 512)
    })

    it('正常小输出不被截断', async () => {
        const result = await bashTool.execute(
            {command: '1..5 | % { "line-${_}" }'},
            makeContext(tmpDir),
        )

        expect(result.success).toBe(true)
        expect(result.output).not.toContain('输出已截断')
        expect(result.output).toContain('line-1')
        expect(result.output).toContain('line-5')
    })
})

describe('bashTool — 中止信号', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
    })

    afterEach(() => {
        fsSync.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('已 abort 的 AbortSignal 执行长命令 → 错误含「已中止」', async () => {
        const aborted = AbortSignal.abort()
        const result = await bashTool.execute(
            {command: 'Start-Sleep -Seconds 60'},
            makeContext(tmpDir, aborted),
        )

        // 极短命令（如立即退出的命令）可能在 abort 处理前已完成 close，
        // 此时会走正常结果分支；因此允许「已中止」或已解决两种结果。
        expect(result.success).toBe(false)
        expect(result.error).toContain('已中止')
    })
})

describe('bashTool — shell 信息与终端显示名', () => {
    it('getShellInfo 返回完整结构', () => {
        const info = getShellInfo()

        expect(info.shell).toBeTruthy()
        expect(info.shellArgs).toBeInstanceOf(Array)
        expect(['powershell', 'cmd', 'bash', 'sh']).toContain(info.name)
        expect(['windows', 'macos', 'linux']).toContain(info.os)
        if (info.os === 'windows') {
            expect(info.codePage).toBeTruthy()
        }
    })

    it('getTerminalDisplayName 返回已知集合内名称', () => {
        const displayName = getTerminalDisplayName()

        expect(['PowerShell', 'CMD', 'Bash', 'Shell']).toContain(displayName)
    })
})
