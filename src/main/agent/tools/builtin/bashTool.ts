/**
 * Bash 工具 — 执行 shell 命令（增强版）
 *
 * 核心改进：
 * 1. 使用 spawn 替代 exec — 无 maxBuffer 限制，支持流式输出
 * 2. 智能错误处理 — 区分超时/信号/退出码，输出与错误分离
 * 3. 安全命令包装 — PowerShell UTF-8 设置不再破坏命令语法
 * 4. 健壮编码回退 — 多层编码尝试 + 乱码检测
 * 5. 进程树清理 — 超时时终止子进程树，防止孤儿进程
 * 6. 输出截断保护 — 防止极端输出撑爆内存
 */

import {z} from 'zod'
import {execSync, spawn} from 'child_process'
import iconv from 'iconv-lite'
import type {Tool, ToolContext, ToolResult} from '../types'
import {isDangerousCommandPattern, isSafeCommandPrefix} from '../../permissions/dangerousPatterns'
import {parseFileWriteTargets, detectFileEncoding, alignFileEncoding} from './encodingGuard'
import * as fsSync from 'fs'
import path from 'path'

// 默认超时
const DEFAULT_TIMEOUT = 30000

/**
 * 处理 LLM 传入的超时参数
 *
 * LLM 经常误将秒当作毫秒传入（如 `timeout: 30` 表示 30 秒），
 * 而任何 bash 命令的有意超时都不可能低于 1 秒，
 * 因此对于 < 1000 的值，视为秒并自动转换为毫秒。
 */
function sanitizeTimeout(argsTimeout: number | undefined, defaultTimeout: number): number {
    if (argsTimeout === undefined) return defaultTimeout
    return argsTimeout < 1000 ? argsTimeout * 1000 : argsTimeout
}

// ─── Shell 检测 ──────────────────────────────────

export interface ShellInfo {
  shell: string
  name: string      // 'powershell' | 'cmd' | 'bash' | 'sh'
  os: string        // 'windows' | 'macos' | 'linux'
  codePage?: string // Windows 代码页（如 '936', '65001'）
  shellArgs: string[] // 执行单条命令时的 shell 参数
}

/** 检测当前平台可用的最佳 shell */
function detectShell(): ShellInfo {
  const platform = process.platform

  if (platform === 'win32') {
    let codePage = '65001'
    try {
      const raw = execSync('chcp', {windowsHide: true})
      const match = raw.toString('ascii').match(/(\d+)\s*$/)
      if (match) codePage = match[1]
    } catch {
          }

    if (commandExists('pwsh')) {
      return {
        shell: 'pwsh',
        name: 'powershell',
        os: 'windows',
        codePage,
        shellArgs: ['-NoProfile', '-Command', '-'],
      }
    }
    if (commandExists('powershell')) {
      return {
        shell: 'powershell',
        name: 'powershell',
        os: 'windows',
        codePage,
        shellArgs: ['-NoProfile', '-Command', '-'],
      }
    }
    return {
      shell: 'cmd.exe',
      name: 'cmd',
      os: 'windows',
      codePage,
      shellArgs: ['/d', '/s', '/c'],
    }
  }

  if (platform === 'darwin') {
    // macOS: 使用 $SHELL 环境变量检测用户默认 shell，
    // 回退 /bin/bash（macOS 始终存在）
    const userShell = process.env.SHELL || '/bin/bash'
    const shellName = userShell.includes('zsh') ? 'zsh' : 'bash'
    return {
      shell: userShell,
      name: shellName,
      os: 'macos',
      // -s 表示从 stdin 读取命令（与 proc.stdin.write 的流程匹配）
      shellArgs: ['-s'],
    }
  }

  return {
    shell: '/bin/bash',
    name: 'bash',
    os: 'linux',
    // -s 表示从 stdin 读取命令（与 proc.stdin.write 的流程匹配）
    shellArgs: ['-s'],
  }
}

/** 检测命令是否存在（仅用于 Windows 上检测 PowerShell） */
function commandExists(cmd: string): boolean {
  try {
    execSync(`${cmd} -NoProfile -Command "exit 0"`, {
      timeout: 3000,
      stdio: 'pipe',
      windowsHide: true,
    })
    return true
  } catch {
    return false
  }
}

// 启动时检测一次，缓存结果
const shellInfo = detectShell()

// ─── 编码处理 ──────────────────────────────────

/** 编码回退链 */
function getEncodingFallbackChain(codePage: string): string[] {
  const chain: string[] = []

  // 主编码
  if (codePage !== '65001') {
    chain.push(`cp${codePage}`)
  }
  // UTF-8 通用回退
  chain.push('utf8')
  // 中文环境常见编码
  if (codePage === '936') {
    chain.push('gbk')
  } else if (codePage === '950') {
    chain.push('big5')
  } else if (codePage === '932') {
    chain.push('shiftjis')
  }

  return chain
}

/**
 * 智能解码：尝试多种编码，选择最佳结果
 * 评估标准：\uFFFD（替换字符）数量最少
 */
function smartDecode(buf: Buffer | null, codePage: string): string {
  if (!buf || buf.length === 0) return ''

  const encodings = getEncodingFallbackChain(codePage)
  let bestResult = ''
  let bestScore = Infinity

  for (const encoding of encodings) {
    try {
      const result = iconv.decode(buf, encoding)
      const score = (result.match(/\uFFFD/g) || []).length
      if (score < bestScore) {
        bestScore = score
        bestResult = result
      }
      // 完美解码，提前返回
      if (score === 0) return result
    } catch {
      // 编码不支持，跳过
      continue
    }
  }

  return bestResult || buf.toString('utf8')
}

// ─── 环境构建 ──────────────────────────────────

function buildExecEnv(): NodeJS.ProcessEnv {
  const env = {...process.env}

  // 强制 Python 和常见工具使用 UTF-8
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  env.LANG = 'en_US.UTF-8'
  env.LC_ALL = 'en_US.UTF-8'

  // Windows PowerShell 编码设置
  if (shellInfo.os === 'windows' && shellInfo.name === 'powershell') {
    env.PSExecutionPolicyPreference = 'Bypass'
  }

  return env
}

/**
 * PowerShell UTF-8 初始化命令
 * 拼接在用户命令之前，确保 PowerShell 会话以 UTF-8 编码运行
 */
function getPowerShellUtf8Init(): string {
  return '$PSDefaultParameterValues["Out-File:Encoding"]="utf8"; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;'
}

// ─── 输出截断 ──────────────────────────────────

const MAX_OUTPUT_SIZE = 2 * 1024 * 1024 // 2MB 硬性上限
const TRUNCATION_NOTE = '\n\n[输出已截断 — 超过 2MB 限制]'

/** 安全追加输出，超限则截断 */
function safeAppend(
    buffer: Buffer,
    chunk: Buffer,
    truncated: { value: boolean },
): Buffer {
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
      // Unix: 发送 SIGTERM 到进程组
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

// ─── 工具定义 ──────────────────────────────────

const inputSchema = z.object({
  command: z.string().describe('要执行的 shell 命令'),
  reason: z
      .string()
      .optional()
      .describe('执行此命令的原因（必填）：简要说明为什么要执行这个命令'),
  timeout: z.coerce
      .number()
      .optional()
      .describe('超时时间（毫秒，必须是数字，非秒数），默认 30000'),
})

type BashInput = z.infer<typeof inputSchema>

/** 退出信号映射 */
const SIGNAL_NAMES: Record<number, string> = {
  1: 'SIGHUP',
  2: 'SIGINT',
  3: 'SIGQUIT',
  6: 'SIGABRT',
  9: 'SIGKILL',
  15: 'SIGTERM',
}

export const bashTool: Tool<BashInput, string> = {
  name: 'bash',
  description: `在用户的工作目录中执行 shell 命令。

当前终端环境:
- Shell: ${shellInfo.name} (${shellInfo.shell})
- 平台: ${shellInfo.os}

命令规范（必须严格遵循）:
${
  shellInfo.name === 'powershell' ? `PowerShell 语法:
- 列出文件: \`Get-ChildItem\` (别名 \`ls\`/\`dir\`)
- 查找文本: \`Select-String\`
- 环境变量: \`$env:VARIABLE_NAME\` (如 \`$env:PATH\`)
- 管道: \`|\`
- 路径分隔符: \\\`\\\`
- 组合命令: \`Get-ChildItem | Where-Object { $_.Name -like "*.ts" }\`` :
  shellInfo.name === 'cmd' ? `CMD 语法:
- 列出文件: \`dir\`
- 查找文本: \`findstr\`
- 环境变量: \`%VARIABLE_NAME%\` (如 \`%PATH%\`)
- 管道: \`|\`
- 路径分隔符: \\\`\\\`` :
  `Bash 语法:
- 列出文件: \`ls -la\`
- 查找文本: \`grep\`
- 环境变量: \`$VARIABLE_NAME\` (如 \`$PATH\`)
- 管道: \`|\`
- 路径分隔符: /\` `
}
重要: 生成命令时必须使用对应 Shell 的语法，禁止混用！
${
  shellInfo.os === 'windows' && shellInfo.name === 'powershell'
    ? 'Windows 编码提示：写文件推荐使用 node -e "require(\'fs\').writeFileSync(\'path\', \'content\', \'utf8\')"（无 BOM）或 [System.IO.File]::WriteAllText(\'path\', \'content\', [System.Text.UTF8Encoding]::new($false)) 以避免默认代码页导致的乱码问题和 UTF-8 BOM 注入。'
    : ''
}
注意：下载任务请使用后台执行指令（如 PowerShell 的 Start-Job / Start-Process、Bash 的 nohup / &），避免长时间阻塞交互通道。`,
  inputSchema,
  requiredPermissions: ['bash:execute'],
  isDestructive: true,

  async execute(
      args: BashInput,
      context: ToolContext,
  ): Promise<ToolResult<string>> {
    const {command} = args
    const timeout = sanitizeTimeout(args.timeout, DEFAULT_TIMEOUT)

    // 危险命令模式检测
    const isDangerous = isDangerousCommandPattern(command)
    const isSafe = isSafeCommandPrefix(command)

    // 如果命令匹配危险模式且不在安全白名单中，则拒绝执行
    if (isDangerous && !isSafe) {
      context.sendMessage({
        type: 'progress',
        message: `拒绝执行危险命令: ${command.slice(0, 50)}...`,
      })
      return {
        success: false,
        output: '',
        error: `危险命令检测: 该命令匹配危险模式，已被安全策略拦截。\n命令: ${command}\n如需执行，请联系管理员调整安全规则。`,
      }
    }

    // 发送进度
    context.sendMessage({
      type: 'progress',
      message: `执行: ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`,
    })

    const env = buildExecEnv()

      // ── 编码守卫：解析写文件目标并缓存原始编码 ──
      const writeTargets: string[] = []
      const originalEncodings = new Map<string, string>()
      if (shellInfo.os === 'windows' && shellInfo.name === 'powershell') {
        try {
          const targets = parseFileWriteTargets(command)
          for (const target of targets) {
            const absTarget = path.resolve(context.workingDir, target)
            writeTargets.push(absTarget)
            if (fsSync.existsSync(absTarget)) {
              const enc = await detectFileEncoding(absTarget)
              originalEncodings.set(absTarget, enc)
            }
          }
        } catch {
          // 解析失败不阻塞执行
        }
      }
    
    return new Promise((resolve) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const safeResolve = (result: ToolResult<string>) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        cleanup()
                resolve(result)
      }

      const cleanup = context.abortSignal
          ? () =>
              context.abortSignal!.removeEventListener('abort', onAbort)
          : () => {
          }

      // 启动子进程
      // Windows PowerShell: -Command 参数传脚本（CreateProcessW UTF-16LE），
      // 绕过 stdin 默认编码 (GB2312/936) 导致的中文乱码。
      // 注：不能用 stdin 方式 — init 和 command 在同一缓冲区，InputEncoding 来不及生效。
      const spawnOpts = { cwd: context.workingDir, env, stdio: ['pipe', 'pipe', 'pipe'] as const, windowsHide: true }
      let proc: ReturnType<typeof spawn>
      if (shellInfo.os === 'windows' && shellInfo.name === 'powershell') {
        proc = spawn(shellInfo.shell, ['-NoProfile', '-Command', `${getPowerShellUtf8Init()}\n${command}\nexit`], spawnOpts)
      } else {
        proc = spawn(shellInfo.shell, shellInfo.shellArgs, spawnOpts)
      }

      let stdoutBuf = Buffer.alloc(0) as Buffer
      let stderrBuf = Buffer.alloc(0) as Buffer
      const stdoutTruncated = {value: false}
      const stderrTruncated = {value: false}

      proc.stdout.on('data', (chunk: Buffer) => {
        stdoutBuf = safeAppend(stdoutBuf, chunk as Buffer, stdoutTruncated) as Buffer
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrBuf = safeAppend(stderrBuf, chunk as Buffer, stderrTruncated) as Buffer
      })

      proc.on('error', (err) => {
        safeResolve({
          success: false,
          output: '',
          error: `进程启动失败: ${err.message}`,
        })
      })

      proc.on('close', async (exitCode, signal) => {
        const stdoutStr = smartDecode(stdoutBuf, shellInfo.codePage || '65001')
        const stderrStr = smartDecode(stderrBuf, shellInfo.codePage || '65001')

        // ── 编码守卫：检测编码漂移并自动对齐 ──
        for (const targetPath of writeTargets) {
          const originalEnc = originalEncodings.get(targetPath)
          if (originalEnc && fsSync.existsSync(targetPath)) {
            try {
              await alignFileEncoding(targetPath, originalEnc)
            } catch {
              // 静默跳过
            }
          }
        }

        // 构建输出
        let output = ''
        if (stdoutStr) output += stdoutStr
        if (stderrStr) output += (output ? '\n' : '') + stderrStr

        // 详细错误分析
        if (exitCode === 0) {
          // 成功
          safeResolve({
            success: true,
            output: output || '(no output)',
          })
          return
        }

        // 分析失败原因
        let errorMessage: string
        let _success = false

        if (exitCode === null && signal) {
          // 被信号终止
          const sigName = SIGNAL_NAMES[signal as unknown as number] || `SIG${signal}`
          errorMessage = `进程被信号终止: ${sigName}`
        } else if (exitCode === 124) {
          // timeout 命令的退出码（如果命令内部使用了 timeout）
          errorMessage = `命令超时 (exit code: ${exitCode})`
        } else if (exitCode === 126) {
          errorMessage = `命令不可执行: 权限不足或文件不是可执行文件`
        } else if (exitCode === 127) {
          errorMessage = `命令未找到: 请检查命令拼写或确认程序已安装`
        } else {
          errorMessage = `命令执行失败 (exit code: ${exitCode})`
        }

        // 如果有 stderr 输出，附加到错误信息
        if (stderrStr) {
          errorMessage += `\n${stderrStr}`
        }

        // 有输出但退出码非零：视为部分成功
        // 关键修复：即使 exitCode !== 0，只要有输出就返回输出内容
        if (output) {
          safeResolve({
            success: false,
            output: output,
            error: errorMessage,
          })
          return
        }

        safeResolve({
          success: false,
          output: '',
          error: errorMessage,
        })
      })

      // 写入命令到 stdin（仅限非 Windows PowerShell 的 shell）
      // PowerShell on Windows 已通过 -Command 参数传参，无需 stdin
      if (shellInfo.os === 'windows' && shellInfo.name === 'powershell') {
        proc.stdin.end()
      } else {
        let commandToWrite = command

        // 确保命令以换行结尾
        if (!commandToWrite.endsWith('\n')) {
          commandToWrite += '\n'
        }

        // 写入命令并关闭 stdin
        // 添加 stdin 错误处理（防止 Linux/macOS 上的 EPIPE 异常）
        proc.stdin.on('error', (err) => {
          // EPIPE 是正常现象：进程已退出导致管道断裂，无需上报为错误
          // 后续 close 事件会处理结果
        })
        proc.stdin.write(commandToWrite)
        proc.stdin.end()
      }

      // 超时控制
      timer = setTimeout(() => {
        if (!settled && proc.pid) {
          killProcessTree(proc.pid)
          safeResolve({
            success: false,
            output: smartDecode(stdoutBuf, shellInfo.codePage || '65001') || '',
            error: `命令执行超时 (${timeout}ms)`,
          })
        }
      }, timeout)

      // 中止处理
      const onAbort = () => {
        if (!settled && proc.pid) {
          killProcessTree(proc.pid)
          safeResolve({
            success: false,
            output: smartDecode(stdoutBuf, shellInfo.codePage || '65001') || '',
            error: '已中止',
          })
        }
      }

      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          onAbort()
        } else {
          context.abortSignal.addEventListener('abort', onAbort, {once: true})
        }
      }
    })
  },
}

/** 导出 shell 信息供系统提示和前端使用 */
export function getShellInfo(): ShellInfo {
  return shellInfo
}

/** 获取终端显示名称 */
export function getTerminalDisplayName(): string {
  const names: Record<string, string> = {
    powershell: 'PowerShell',
    cmd: 'CMD',
    bash: 'Bash',
    sh: 'Shell',
  }
  return names[shellInfo.name] || shellInfo.name
}
