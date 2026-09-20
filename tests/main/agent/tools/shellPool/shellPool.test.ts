/**
 * 持久化 Shell 会话池 测试 — 真实子进程，不 mock
 *
 * 覆盖：
 * - run 基本执行 / PID 一致性（同会话进程复用）
 * - nonce 判定不串包（长输出后紧跟短输出）
 * - cd 双向追踪 / 不同 workingDir 独立会话
 * - 超时销毁后下条命令重建
 * - exit 污染后重建
 * - 同 key 并发串行有序
 * - 中文编码无乱码
 * - bashTool 集成：cd 漂移、重建
 */
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'
import {acquireSession, disposeAllShellSessions, disposeAllShellSessionsAsync} from '@/main/agent/tools/shellPool/pool'
import {bashTool, getShellInfo} from '@/main/agent/tools/builtin/bashTool'
import {PersistentShellSession} from '@/main/agent/tools/shellPool/session'

const shellInfo = getShellInfo()

function makeContext(tmpDir: string, abortSignal?: AbortSignal): any {
    return {
        workingDir: tmpDir,
        abortSignal: abortSignal ?? new AbortController().signal,
        sendMessage: vi.fn(),
    }
}

afterAll(async () => {
    await disposeAllShellSessionsAsync()
})

// 每个测试后销毁会话：常驻 shell 进程持有 tmpDir 句柄，否则 rmSync 会 EPERM
afterEach(async () => {
    await disposeAllShellSessionsAsync()
})

describe('shellPool — 会话基本行为', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'shell-pool-test-'))
    })

    afterEach(async () => {
        await disposeAllShellSessionsAsync()
        fsSync.rmSync(tmpDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
    })

    it('run("echo hello") 正确返回', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const res = await session.run({command: 'echo hello', timeout: 15000})

        expect(res.status).toBe('ok')
        expect(res.exitCode).toBe(0)
        expect(res.output.toString('utf8')).toContain('hello')
    })

    it('连续两条命令进程 PID 一致（会话复用）', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        // Windows: $PID；bash: $$ — 统一用 shell 语法分支
        const isPwsh = shellInfo.name === 'powershell'
        const pidCmd = isPwsh ? '$PID' : '$$'

        const r1 = await session.run({command: `echo PID=${pidCmd}`, timeout: 15000})
        const r2 = await session.run({command: `echo PID=${pidCmd}`, timeout: 15000})

        expect(r1.status).toBe('ok')
        expect(r2.status).toBe('ok')
        const pid1 = r1.output.toString('utf8').match(/PID=(\d+)/)?.[1]
        const pid2 = r2.output.toString('utf8').match(/PID=(\d+)/)?.[1]
        expect(pid1).toBeTruthy()
        expect(pid1).toBe(pid2)
    })

    it('nonce 判定不串包：长输出后紧跟短输出，结果不混淆', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const longCmd = shellInfo.name === 'powershell'
            ? '1..2000 | % { "x$_" }'
            : 'seq 1 2000 | sed "s/^/x/"'

        const r1 = await session.run({command: longCmd, timeout: 15000})
        const r2 = await session.run({command: 'echo SHORT_MARKER_OK', timeout: 15000})

        expect(r1.status).toBe('ok')
        expect(r2.status).toBe('ok')
        expect(r1.output.toString('utf8')).toContain('x1')
        expect(r1.output.toString('utf8')).toContain('x2000')
        expect(r1.output.toString('utf8')).not.toContain('SHORT_MARKER_OK')
        expect(r2.output.toString('utf8')).toContain('SHORT_MARKER_OK')
        // r2 中不应残留 r1 的尾部内容
        expect(r2.output.toString('utf8')).not.toContain('x2000')
    })

    it('cd 双向追踪：cd sub 后会话 cwd 更新，pwd 显示 sub', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const isPwsh = shellInfo.name === 'powershell'

        const mkdirCmd = isPwsh
            ? 'New-Item -ItemType Directory -Path sub | Out-Null; Set-Location sub'
            : 'mkdir -p sub && cd sub'
        const r1 = await session.run({command: mkdirCmd, timeout: 15000})
        expect(r1.status).toBe('ok')
        expect(session.currentCwd).toContain('sub')

        const r2 = await session.run({command: isPwsh ? '(Get-Location).Path' : 'pwd', timeout: 15000})
        expect(r2.output.toString('utf8')).toContain('sub')
    })

    it('不同 workingDir 独立会话（互不串扰）', async () => {
        const dirA = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pool-a-'))
        const dirB = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pool-b-'))
        try {
            const sA = await acquireSession({workingDir: dirA, shellInfo})
            const sB = await acquireSession({workingDir: dirB, shellInfo})
            expect(sA).not.toBe(sB)

            const isPwsh = shellInfo.name === 'powershell'
            const pwdCmd = isPwsh ? '(Get-Location).Path' : 'pwd'
            const rA = await sA.run({command: pwdCmd, timeout: 15000})
            const rB = await sB.run({command: pwdCmd, timeout: 15000})
            expect(rA.output.toString('utf8')).toContain(path.basename(dirA))
            expect(rB.output.toString('utf8')).toContain(path.basename(dirB))
        } finally {
            await disposeAllShellSessionsAsync()
            fsSync.rmSync(dirA, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
            fsSync.rmSync(dirB, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
        }
    })

    it('超时销毁后下条命令重建成功', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const sleepCmd = shellInfo.name === 'powershell' ? 'Start-Sleep -Seconds 5' : 'sleep 5'

        const r1 = await session.run({command: sleepCmd, timeout: 1000})
        expect(r1.status).toBe('timeout')
        expect(session.alive).toBe(false)

        // 超时杀掉会话后，acquire 应重建新会话
        const session2 = await acquireSession({workingDir: tmpDir, shellInfo})
        expect(session2.alive).toBe(true)
        const r2 = await session2.run({command: 'echo REBUILT_OK', timeout: 15000})
        expect(r2.status).toBe('ok')
        expect(r2.output.toString('utf8')).toContain('REBUILT_OK')
    })

    it('exit 污染后重建成功', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})

        // 用户命令含 exit → shell 退出 → dead
        const r1 = await session.run({command: 'exit 7', timeout: 15000})
        expect(r1.status).toBe('dead')
        expect(r1.exitCode).toBe(7)

        const session2 = await acquireSession({workingDir: tmpDir, shellInfo})
        const r2 = await session2.run({command: 'echo AFTER_EXIT_OK', timeout: 15000})
        expect(r2.status).toBe('ok')
        expect(r2.output.toString('utf8')).toContain('AFTER_EXIT_OK')
    })

    it('同 key 并发串行有序（第二条命令在第一条完成后才执行）', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const isPwsh = shellInfo.name === 'powershell'
        const markerFile = path.join(tmpDir, 'serial-marker.txt')

        // 命令 1：先写 start，睡 500ms，再追加 end
        const cmd1 = isPwsh
            ? `Set-Content -Path '${markerFile}' -Value 'start'; Start-Sleep -Milliseconds 500; Add-Content -Path '${markerFile}' -Value 'end'`
            : `printf 'start\\n' > '${markerFile}'; sleep 0.5; printf 'end\\n' >> '${markerFile}'`
        // 命令 2：读取标记文件 — 若串行，必能看到 start 和 end
        const cmd2 = isPwsh ? `Get-Content -Path '${markerFile}'` : `cat '${markerFile}'`

        const [r1, r2] = await Promise.all([
            session.run({command: cmd1, timeout: 15000}),
            session.run({command: cmd2, timeout: 15000}),
        ])

        expect(r1.status).toBe('ok')
        expect(r2.status).toBe('ok')
        const content = r2.output.toString('utf8')
        expect(content).toContain('start')
        expect(content).toContain('end')
    })

    it('中文编码无乱码', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const r = await session.run({command: "echo '中文内容测试-特殊字符✓'", timeout: 15000})
        expect(r.status).toBe('ok')
        expect(r.output.toString('utf8')).toContain('中文内容测试-特殊字符✓')
    })

    it('输出超过 2MB 触发截断：含截断标记，END 仍命中、exitCode 正确', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        // 输出约 3MB，超过 2MB 硬上限
        const bigCmd = shellInfo.name === 'powershell'
            ? 'Write-Output ([string]::new("a", 3000000))'
            : 'head -c 3000000 /dev/zero | tr "\\0" "a"'

        const res = await session.run({command: bigCmd, timeout: 30000})

        expect(res.status).toBe('ok')
        expect(res.exitCode).toBe(0)
        const text = res.output.toString('utf8')
        expect(text.length).toBeLessThanOrEqual(2 * 1024 * 1024 + 200)
        expect(text).toContain('[输出已截断')
    })

    it('T3：截断后同一会话第二条命令 stdout 正常返回（修复前恒空）', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const bigCmd = shellInfo.name === 'powershell'
            ? 'Write-Output ([string]::new("a", 3000000))'
            : 'head -c 3000000 /dev/zero | tr "\\0" "a"'

        const r1 = await session.run({command: bigCmd, timeout: 30000})
        expect(r1.status).toBe('ok')

        const r2 = await session.run({command: 'echo SECOND_AFTER_TRUNCATE_OK', timeout: 15000})
        expect(r2.status).toBe('ok')
        expect(r2.output.toString('utf8')).toContain('SECOND_AFTER_TRUNCATE_OK')
    })

    // ── fake proc 单元测试：runLocked 分支的截断态复位 ──
    // 真实子进程下 timeout/abort 后 close 事件会立即复位（close 回调兜底），
    // 脏态窗口不可观察；用 fake proc（无 close 事件）直接驱动分支验证复位行为。
    // Object.create 绕开 constructor，避免 spawn 真实进程。
    function makeFakeSession(): any {
        const session: any = Object.create(PersistentShellSession.prototype)
        session.key = 'fake-key'
        session.cwd = '.'
        session.pending = Buffer.alloc(0)
        session.pendingTruncated = {value: false}
        session.scanWindow = Buffer.alloc(0)
        session.waiter = null
        session.dead = false
        session.queue = Promise.resolve()
        session.proc = {pid: undefined, exitCode: 0, kill: () => {}, stdin: {write: () => {}}} as any
        return session
    }

    function makeTruncated(session: any): void {
        // 模拟已截断状态：pending 冻结在 2MB + 截断标记，扫描窗口非空
        session.pending = Buffer.alloc(2 * 1024 * 1024, 0x61)
        session.pendingTruncated.value = true
        session.scanWindow = Buffer.alloc(100, 0x62)
    }

    it('fake proc：截断态下命令超时，timeout 分支复位截断标志与扫描窗口', async () => {
        const session = makeFakeSession()
        makeTruncated(session)

        const r = await session.runLocked({command: 'hang', timeout: 20})
        expect(r.status).toBe('timeout')
        expect(session.pendingTruncated.value).toBe(false)
        expect(session.scanWindow.length).toBe(0)
    })

    it('fake proc：截断态下命令中途 abort，abort 分支复位截断标志与扫描窗口', async () => {
        const session = makeFakeSession()
        makeTruncated(session)

        const ac = new AbortController()
        setTimeout(() => ac.abort(), 10)
        const r = await session.runLocked({command: 'hang', timeout: 30000, abortSignal: ac.signal})
        expect(r.status).toBe('aborted')
        expect(session.pendingTruncated.value).toBe(false)
        expect(session.scanWindow.length).toBe(0)
    })

    it('截断命令超时后：截断态复位 + 同会话下一条命令输出正常', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})
        const bigCmd = shellInfo.name === 'powershell'
            ? 'Write-Output ([string]::new("a", 3000000)); Start-Sleep -Seconds 30'
            : 'head -c 3000000 /dev/zero | tr "\\0" "a"; sleep 30'

        // 输出超 2MB 触发截断，随后命令挂起走 timeout 路径（杀会话）
        const r1 = await session.run({command: bigCmd, timeout: 3000})
        expect(r1.status).toBe('timeout')

        // close 事件尚未分发（await 续体是微任务，先于 I/O 事件回调）：
        // 此刻断言 timeout 分支已复位截断标志与扫描窗口
        expect((session as any).pendingTruncated.value).toBe(false)
        expect((session as any).scanWindow.length).toBe(0)

        // reap 窗口内同 key 下一条命令（池重建会话）输出正常
        const session2 = await acquireSession({workingDir: tmpDir, shellInfo})
        const r2 = await session2.run({command: 'echo AFTER_TRUNCATE_TIMEOUT_OK', timeout: 15000})
        expect(r2.status).toBe('ok')
        expect(r2.output.toString('utf8')).toContain('AFTER_TRUNCATE_TIMEOUT_OK')
    })

    it('性能：同会话第二条简单命令延迟显著低于首次（日志量化）', async () => {
        const session = await acquireSession({workingDir: tmpDir, shellInfo})

        const t0 = Date.now()
        await session.run({command: 'echo first', timeout: 15000})
        const firstMs = Date.now() - t0

        const t1 = Date.now()
        await session.run({command: 'echo second', timeout: 15000})
        const secondMs = Date.now() - t1

        console.log(`[shellPool perf] 首条命令 ${firstMs}ms（含会话初始化），第二条 ${secondMs}ms`)
        // 宽松断言防止 CI 抖动：第二条应远小于旧 spawn 路径的 0.5-3s 启动税
        expect(secondMs).toBeLessThan(2000)
    })
})

describe('bashTool × shellPool 集成', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bash-pool-test-'))
    })

    afterEach(async () => {
        await disposeAllShellSessionsAsync()
        fsSync.rmSync(tmpDir, {recursive: true, force: true, maxRetries: 10, retryDelay: 100})
    })

    it('cd 漂移：bashTool 执行 cd sub 后，会话 cwd 双向追踪生效', async () => {
        const isPwsh = shellInfo.name === 'powershell'
        const mkdirCmd = isPwsh
            ? 'New-Item -ItemType Directory -Path sub | Out-Null; Set-Location sub'
            : 'mkdir -p sub && cd sub'

        const r1 = await bashTool.execute({command: mkdirCmd}, makeContext(tmpDir))
        expect(r1.success).toBe(true)

        // 同 workingDir 的下一条命令：会话仍在 sub（cd 持久化）
        const pwdCmd = isPwsh ? '(Get-Location).Path' : 'pwd'
        const r2 = await bashTool.execute({command: pwdCmd}, makeContext(tmpDir))
        expect(r2.success).toBe(true)
        expect(r2.output).toContain('sub')
    })

    it('bashTool 执行 exit 后，下条命令自动重建成功', async () => {
        const r1 = await bashTool.execute({command: 'exit 0'}, makeContext(tmpDir))
        expect(r1.success).toBe(true)

        const r2 = await bashTool.execute({command: 'echo REBUILT_VIA_TOOL'}, makeContext(tmpDir))
        expect(r2.success).toBe(true)
        expect(r2.output).toContain('REBUILT_VIA_TOOL')
    })

    it('bashTool 执行中文命令无乱码', async () => {
        const r = await bashTool.execute({command: "echo '集成中文测试通过'"}, makeContext(tmpDir))
        expect(r.success).toBe(true)
        expect(r.output).toContain('集成中文测试通过')
    })

    it('回退开关：HCLAW_PERSISTENT_SHELL=0 走旧 spawn 路径仍可用', async () => {
        process.env.HCLAW_PERSISTENT_SHELL = '0'
        try {
            const r = await bashTool.execute({command: 'echo LEGACY_PATH_OK'}, makeContext(tmpDir))
            expect(r.success).toBe(true)
            expect(r.output).toContain('LEGACY_PATH_OK')
        } finally {
            delete process.env.HCLAW_PERSISTENT_SHELL
        }
    })
})
