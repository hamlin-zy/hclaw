/**
 * 持久化 Shell 会话 — 单个常驻 shell 进程
 *
 * 核心机制：
 * 1. nonce 完成判定 — 每条命令包装后输出 `__HCLAW_BEGIN_<nonce>__` / `__HCLAW_END_<nonce>__:<exitCode>`，
 *    stdout 流式扫描 END 行即判定完成，不依赖 prompt 文本
 * 2. Windows pwsh — spawn `pwsh -NoProfile -NonInteractive -Command <bootstrap>`：
 *    编码初始化通过 argv 传入（UTF-16 命令行，绕过 stdin 码页问题），
 *    引导脚本自建 UTF-8 StreamReader 读取命令协议，IEX 执行并回显标记
 * 3. Unix bash/zsh — spawn `shell -s` 常驻，通过 stdin 写入读取循环 + 命令协议
 * 4. cd 防漂移 — 每条命令注入 Set-Location/cd 到会话 cwd，命令结束后 pwd 探针回写更新（双向追踪）
 * 5. 超时/abort/进程意外退出 → killProcessTree 杀 shell + 标记 dead，由池负责销毁重建
 * 6. 每会话内部 promise 链 mutex — 同一会话的命令严格串行
 */

import {execSync, spawn, type ChildProcess, type SpawnOptions} from 'child_process'
import {randomUUID} from 'crypto'

// ─── 常量 ──────────────────────────────────

/** 输出硬性上限 2MB（与 bashTool 主流程一致） */
const MAX_OUTPUT_SIZE = 2 * 1024 * 1024
const TRUNCATION_NOTE = '\n\n[输出已截断 — 超过 2MB 限制]'

/** 命令协议：nonce 行 + cwd 行 + 命令行们 + 哨兵行 */
const CMD_END_SENTINEL = '__HCLAW_CMD_END__'
/** 会话初始化探针使用的固定 nonce */
const INIT_NONCE = 'INIT'
/** 初始化探针超时（ms） */
const INIT_TIMEOUT = 15000
/** 初始化探针回显的中文样例（验证 UTF-8 编码链路生效） */
const INIT_PROBE_TEXT = '中文探针 中文输出编码验证'
/** 截断模式下滚动扫描窗口大小（字节） */
const SCAN_WINDOW_SIZE = 8192

// ─── 进程树清理 ──────────────────────────────────

/**
 * 终止进程及其所有子进程（Windows 使用 taskkill /T）
 */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, {
        stdio: 'pipe',
        windowsHide: true,
        timeout: 5000,
      })
    } catch {
      // 进程可能已退出，忽略
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // 进程可能已退出
      }
    }
  }
}

// ─── 输出截断 ──────────────────────────────────

/** 同步 sleep（利用 Atomics.wait 阻塞，不阻塞事件循环以外的副作用） */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    // 环境不支持时退化为忙等（极短场景）
    const end = Date.now() + ms
    while (Date.now() < end) {
      // spin
    }
  }
}

/** 安全追加输出，超限则截断（与 bashTool.safeAppend 行为一致） */
function safeAppend(buffer: Buffer, chunk: Buffer, truncated: {value: boolean}): Buffer {
  if (truncated.value) return buffer

  const newLength = buffer.length + chunk.length
  if (newLength > MAX_OUTPUT_SIZE) {
    const remaining = MAX_OUTPUT_SIZE - buffer.length
    if (remaining > 0) {
      buffer = Buffer.concat([buffer, chunk.slice(0, remaining)])
    }
    buffer = Buffer.concat([buffer, Buffer.from(TRUNCATION_NOTE, 'utf8')])
    truncated.value = true
    return buffer
  }

  return Buffer.concat([buffer, chunk])
}

// ─── 类型 ──────────────────────────────────

/** 池所需的 shell 信息（与 bashTool.ShellInfo 结构兼容，避免循环依赖） */
export interface PoolShellInfo {
  shell: string
  name: string
  os: string
  codePage?: string
  shellArgs: string[]
}

export interface SessionRunOptions {
  command: string
  timeout: number
  abortSignal?: AbortSignal | null
}

export type SessionRunStatus = 'ok' | 'timeout' | 'aborted' | 'dead'

export interface SessionRunResult {
  /** ok=END 标记正常返回；timeout/abort/dead 时 output 为已收到的部分输出 */
  status: SessionRunStatus
  /** ok=协议回传的退出码；dead=进程 close 退出码 */
  exitCode: number | null
  signal: string | null
  /** 原始合并输出（stdout+stderr 有序合并，未解码） */
  output: Buffer
}

interface PendingWaiter {
  nonce: string
  resolve: (result: SessionRunResult) => void
  timer: NodeJS.Timeout | null
}

// ─── Windows PowerShell 引导脚本 ──────────────────────────────────

/**
 * Windows PowerShell 引导脚本（纯 ASCII 协议 + UTF-8 自建流）
 *
 * 通过 -Command argv 传入（CreateProcessW UTF-16LE，无编码损耗）：
 * - 设置 Console/Output/PSDefaultParameterValues 为 UTF-8
 * - 自建 UTF-8 StreamReader/StreamWriter 读写协议（绕过启动时按系统码页创建的默认 stdin 读取器）
 * - 回显中文探针验证编码链路
 * - 主循环：读 nonce/cwd/命令行 → Set-Location 防漂移 → IEX 执行（2>&1 | Out-String -Width 4096）→ 回显 END/PWD 标记
 */
const WINDOWS_BOOTSTRAP = [
  "$ErrorActionPreference = 'Continue'",
  "$__enc = [System.Text.Encoding]::UTF8",
  "[Console]::OutputEncoding = $__enc",
  "$OutputEncoding = $__enc",
  "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
  "$__out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object System.Text.UTF8Encoding($false)))",
  "$__out.AutoFlush = $true",
  "$__in = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $__enc)",
  "$__out.WriteLine('__HCLAW_BEGIN_INIT__')",
  "$__out.WriteLine('" + INIT_PROBE_TEXT + "')",
  "$__out.WriteLine('__HCLAW_END_INIT__:0')",
  'while ($true) {',
  '  $__nonce = $__in.ReadLine()',
  '  if ($null -eq $__nonce) { break }',
  '  $__cwd = $__in.ReadLine()',
  '  if ($null -eq $__cwd) { break }',
  '  $__lines = New-Object System.Collections.Generic.List[string]',
  '  while ($true) {',
  '    $__l = $__in.ReadLine()',
  '    if ($null -eq $__l) { exit }',
  "    if ($__l -eq '" + CMD_END_SENTINEL + "') { break }",
  '    $__lines.Add($__l)',
  '  }',
  '  $__cmd = [string]::Join([char]10, $__lines)',
  '  $global:LASTEXITCODE = 0',
  '  $__ec = 0',
  "  $__out.WriteLine(('__HCLAW_BEGIN_{0}__' -f $__nonce))",
  "  if ($__cmd -ne '') {",
  '    try {',
  '      & {',
  '        Set-Location -LiteralPath $__cwd -ErrorAction SilentlyContinue',
  '        Invoke-Expression $__cmd',
  '      } 2>&1 | Out-String -Width 4096',
  '    } catch {',
  '      Write-Output ($_ | Out-String)',
  '      $__ec = 1',
  '    }',
  '    if ($global:LASTEXITCODE) { $__ec = $global:LASTEXITCODE }',
  '  }',
  "  $__out.WriteLine(('__HCLAW_END_{0}__:{1}' -f $__nonce, $__ec))",
  "  $__out.WriteLine(('__HCLAW_PWD_{0}__:{1}' -f $__nonce, (Get-Location).Path))",
  '}',
].join('\n')

// ─── Unix 引导脚本 ──────────────────────────────────

/**
 * Unix bash/zsh 引导循环（写入常驻 shell 的 stdin）
 * 协议与 Windows 一致；命令经 eval 执行，2>&1 有序合并
 */
const UNIX_BOOTSTRAP = [
  'while IFS= read -r __nonce; do',
  '  IFS= read -r __cwd || break',
  "  __cmd=''",
  '  while IFS= read -r __l; do',
    '    [ "$__l" = "' + CMD_END_SENTINEL + '" ] && break',
  '    __cmd="$__cmd$__l',
  '"',
  '  done',
  '  cd "$__cwd" 2>/dev/null',
  "  printf '__HCLAW_BEGIN_%s__\\n' \"$__nonce\"",
  '  eval "$__cmd" 2>&1',
  '  __ec=$?',
  "  printf '__HCLAW_END_%s__:%d\\n' \"$__nonce\" \"$__ec\"",
  "  printf '__HCLAW_PWD_%s__:%s\\n' \"$__nonce\" \"$PWD\"",
  'done',
].join('\n')

// ─── 会话实现 ──────────────────────────────────

export class PersistentShellSession {
  /** 池 key（workingDir::shell），用于诊断 */
  readonly key: string

  private proc: ChildProcess
  private shellInfo: PoolShellInfo
  private cwd: string
  private onDead?: () => void

  private pending: Buffer = Buffer.alloc(0)
  private pendingTruncated = {value: false}
  /** 截断后仍持续更新的滚动扫描窗口（latin1），保证 END 标记仍可判定 */
  private scanWindow = ''
  private waiter: PendingWaiter | null = null
  private dead = false
  /** 每会话 promise 链 mutex：同一会话的命令严格串行 */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(key: string, shellInfo: PoolShellInfo, env: NodeJS.ProcessEnv, startCwd: string, onDead?: () => void) {
    this.key = key
    this.shellInfo = shellInfo
    this.cwd = startCwd
    this.onDead = onDead

    const spawnOpts: SpawnOptions = {
      cwd: startCwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }

    if (process.platform === 'win32') {
      // Windows PowerShell：bootstrap 经 argv 传入（UTF-16 命令行），stdin 留给命令协议
      this.proc = spawn(shellInfo.shell, ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOTSTRAP], spawnOpts)
    } else {
      // Unix：常驻 shell，stdin 先写引导循环再写命令协议
      this.proc = spawn(shellInfo.shell, shellInfo.shellArgs, spawnOpts)
    }

    this.proc.stdout!.on('data', (chunk: Buffer) => this.handleChunk(chunk))
    this.proc.stderr!.on('data', (chunk: Buffer) => this.handleChunk(chunk))
    // EPIPE 是正常现象：进程已退出导致管道断裂，close 事件负责收尾
    this.proc.stdin!.on('error', () => {})

    this.proc.on('error', () => {
      this.markDead('进程启动失败')
    })

    this.proc.on('close', (exitCode, signal) => {
      const waiter = this.waiter
      this.dead = true
      // 注意：先 resolve 再清 waiter — resolve 内部校验 this.waiter === waiter
      if (waiter) {
        waiter.resolve({
          status: 'dead',
          exitCode,
          signal: signal ?? null,
          output: this.pending,
        })
      }
      this.waiter = null
      this.pending = Buffer.alloc(0)
      this.onDead?.()
    })
  }

  /** 会话是否存活（dead 的条目应由池销毁重建） */
  get alive(): boolean {
    return !this.dead
  }

  /** 会话当前工作目录（由 pwd 探针双向追踪更新） */
  get currentCwd(): string {
    return this.cwd
  }

  /**
   * 会话初始化：等待引导脚本就绪并验证 UTF-8 编码探针
   * 失败时销毁进程并抛出异常（由调用方回退/重建）
   */
  async init(): Promise<void> {
    if (process.platform !== 'win32') {
      const probe = `${INIT_NONCE}\n${this.cwd}\nprintf '%s' '${INIT_PROBE_TEXT}'\n${CMD_END_SENTINEL}\n`
      this.proc.stdin!.write(UNIX_BOOTSTRAP + '\n' + probe)
    }

    const ok = await this.waitForMarker(INIT_NONCE, INIT_TIMEOUT)
    if (!ok) {
      this.dispose()
      throw new Error(`Shell 会话初始化失败 (${this.shellInfo.shell})`)
    }
    // 验证中文探针：UTF-8 编码链路（init → 子进程输出 → 解码）生效
    const decoded = this.pending.toString('utf8')
    if (!decoded.includes(INIT_PROBE_TEXT)) {
      this.dispose()
      throw new Error(`Shell 会话编码探针验证失败 (${this.shellInfo.shell})`)
    }
    this.pending = Buffer.alloc(0)
    this.pendingTruncated.value = false
    this.scanWindow = ''
  }

  /**
   * 执行一条命令（同会话内严格串行）
   * 从不 reject：异常情况以 status=dead 返回
   */
  run(opts: SessionRunOptions): Promise<SessionRunResult> {
    const exec = this.queue.then(
      () => this.runLocked(opts),
      () => this.runLocked(opts),
    )
    this.queue = exec.then(() => undefined, () => undefined)
    return exec
  }

  /** 销毁会话：杀进程树 + 标记 dead */
  dispose(): void {
    if (this.dead) return
    this.dead = true
    const waiter = this.waiter
    if (waiter) {
      waiter.resolve({status: 'dead', exitCode: null, signal: null, output: this.pending})
    }
    this.waiter = null
    if (this.proc.pid) {
      killProcessTree(this.proc.pid)
      // 同步等待进程完全退出（Windows 上进程句柄/工作目录句柄释放略滞后于 taskkill 返回，
      // 不等待会导致测试环境 rmSync 工作目录时 EPERM）
      const pid = this.proc.pid
      const start = Date.now()
      while (Date.now() - start < 2000) {
        let exited = false
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
        }
        if (exited) break
        sleepSync(20)
      }
    }
    try {
      this.proc.kill()
    } catch {
      // 进程可能已退出
    }
    this.onDead?.()
  }

  // ─── 内部实现 ──────────────────────────────────

  /**
   * 等待进程 close 事件（Node reap 子进程后 OS 句柄才真正释放）
   * 超时兜底返回，不抛错
   */
  waitClosed(timeoutMs = 3000): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.proc.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private runLocked(opts: SessionRunOptions): Promise<SessionRunResult> {
    if (this.dead) {
      return Promise.resolve({status: 'dead', exitCode: null, signal: null, output: Buffer.alloc(0)})
    }

    // abort 已触发：直接杀会话返回（与超时一致的销毁语义）
    if (opts.abortSignal?.aborted) {
      this.dispose()
      return Promise.resolve({status: 'aborted', exitCode: null, signal: null, output: Buffer.alloc(0)})
    }

    const nonce = randomUUID()

    return new Promise<SessionRunResult>((resolve) => {
      const waiter: PendingWaiter = {
        nonce,
        resolve: (result) => {
          if (this.waiter !== waiter) return
          this.waiter = null
          if (waiter.timer) clearTimeout(waiter.timer)
          if (opts.abortSignal) {
            opts.abortSignal.removeEventListener('abort', onAbort)
          }
          resolve(result)
        },
        timer: null,
      }

      const onAbort = () => {
        if (this.waiter !== waiter) return
        // 超时/abort/退出未见 END → 杀 shell + 条目销毁，下次 acquire 重建
        this.dead = true
        this.onDead?.()
        if (this.proc.pid) killProcessTree(this.proc.pid)
        waiter.resolve({status: 'aborted', exitCode: null, signal: null, output: this.pending})
        this.pending = Buffer.alloc(0)
      }

      waiter.timer = setTimeout(() => {
        if (this.waiter !== waiter) return
        this.dead = true
        this.onDead?.()
        if (this.proc.pid) killProcessTree(this.proc.pid)
        waiter.resolve({status: 'timeout', exitCode: null, signal: null, output: this.pending})
        this.pending = Buffer.alloc(0)
      }, opts.timeout)

      this.waiter = waiter

      if (opts.abortSignal) {
        opts.abortSignal.addEventListener('abort', onAbort, {once: true})
      }

      // 命令协议：nonce / cwd / 命令行们 / 哨兵
      const payload = `${nonce}\n${this.cwd}\n${opts.command}\n${CMD_END_SENTINEL}\n`
      this.proc.stdin!.write(payload)
    })
  }

  private handleChunk(chunk: Buffer): void {
    if (this.dead && !this.waiter) {
      // 会话已终止且无等待者：丢弃数据
      return
    }
    this.pending = safeAppend(this.pending, chunk, this.pendingTruncated)
    if (this.pendingTruncated.value) {
      // 截断后输出缓冲冻结，但标记扫描必须继续（END 标记可能落在截断点之后），
      // 维护一个滚动扫描窗口兜底
      this.scanWindow = (this.scanWindow + chunk.toString('latin1')).slice(-SCAN_WINDOW_SIZE)
    }
    this.tryComplete()
  }

  /** 流式扫描 END 标记（nonce 纯 ASCII，可安全按 latin1 扫描字节） */
  private tryComplete(): void {
    const waiter = this.waiter
    if (!waiter) return

    const endToken = `__HCLAW_END_${waiter.nonce}__`
    let codeMatch: RegExpExecArray | null
    let outputBuf: Buffer
    let pwdValue: string | null = null

    if (this.pendingTruncated.value) {
      // 截断模式：输出取冻结的 pending（已含截断标记），在滚动窗口中找标记
      codeMatch = new RegExp(`${endToken}:(-?\\d+)\\r?\\n`).exec(this.scanWindow)
      if (!codeMatch) return
      const pwdMatch = new RegExp(`__HCLAW_PWD_${waiter.nonce}__:(.*)\\r?\\n`).exec(this.scanWindow)
      if (pwdMatch) pwdValue = pwdMatch[1]
      outputBuf = Buffer.from(this.pending)
      this.pending = Buffer.alloc(0)
    } else {
      const s = this.pending.toString('latin1')
      const endIdx = s.indexOf(endToken + ':')
      if (endIdx < 0) return

      codeMatch = new RegExp(`${endToken}:(-?\\d+)\\r?\\n`).exec(s)
      if (!codeMatch) return

      // 提取 pwd 探针，更新会话 cwd（双向追踪）
      // 注意：PWD 行在 END 行之后，若尚未到达则等待下一个数据块，避免误消费缓冲区
      const pwdToken = `__HCLAW_PWD_${waiter.nonce}__`
      const pwdIdx = s.indexOf(pwdToken)
      if (pwdIdx < 0) return
      const pwdLineEnd = s.indexOf('\n', pwdIdx)
      if (pwdLineEnd < 0) return

      pwdValue = s.slice(pwdIdx + pwdToken.length + 1, pwdLineEnd).replace(/\r$/, '')
      outputBuf = Buffer.from(this.pending.subarray(0, endIdx))
      this.pending = Buffer.from(this.pending.subarray(pwdLineEnd + 1))
    }

    if (pwdValue) this.cwd = pwdValue

    waiter.resolve({
      status: 'ok',
      exitCode: parseInt(codeMatch[1], 10),
      signal: null,
      output: outputBuf,
    })
  }

  /** 等待指定 nonce 的 END 标记出现（仅用于初始化探针） */
  private waitForMarker(nonce: string, timeoutMs: number): Promise<boolean> {
    const token = `__HCLAW_END_${nonce}__:`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.proc.stdout!.off('data', onData)
        resolve(false)
      }, timeoutMs)

      const onData = () => {
        if (this.pending.toString('latin1').includes(token)) {
          clearTimeout(timer)
          this.proc.stdout!.off('data', onData)
          resolve(true)
        }
      }

      this.proc.stdout!.on('data', onData)
      if (this.pending.toString('latin1').includes(token)) {
        clearTimeout(timer)
        this.proc.stdout!.off('data', onData)
        resolve(true)
      }
    })
  }

  private markDead(_reason: string): void {
    // error/close 事件统一由 close 处理器收尾；此处仅兜底标记
    this.dead = true
    this.onDead?.()
  }
}
