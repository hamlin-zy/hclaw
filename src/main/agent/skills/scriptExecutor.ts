/**
 * 技能脚本执行器
 * 
 * 支持执行 skills/scripts/ 目录下的脚本文件。
 * 支持的语言：Node.js, Python, Bash, PowerShell
 */

import {spawn, SpawnOptions} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import type {ScriptFile, ScriptResult} from './types'
import {systemSettingsRepo} from '../../repositories/sqlite/systemSettingsRepository'

// ─── 常量 ──────────────────────────────────────────────

/** 脚本超时默认值（毫秒） */
export const DEFAULT_TIMEOUT = 60000

/**
 * 从 system_settings 读取脚本执行超时配置
 */
export function getScriptTimeout(): number {
    try {
        const settings = systemSettingsRepo.getJson<{ timeouts?: { scriptExecutionTimeout?: number } }>('settings')
        return settings?.timeouts?.scriptExecutionTimeout ?? DEFAULT_TIMEOUT
    } catch {
        return DEFAULT_TIMEOUT
    }
}

/** 最大输出大小（字节） */
const MAX_OUTPUT_SIZE = 10 * 1024 * 1024 // 10MB

// ─── 主执行函数 ────────────────────────────────────────

/**
 * 执行技能脚本
 * 
 * @param script 脚本信息
 * @param args 脚本参数（会序列化为 JSON 传入）
 * @param options 执行选项
 * @returns 脚本执行结果
 */
export async function executeScript(
  script: ScriptFile,
  args: Record<string, unknown>,
  options?: {
    cwd?: string
    timeout?: number
    env?: Record<string, string>
    onOutput?: (chunk: string) => void
  },
): Promise<ScriptResult> {
  const startTime = Date.now()
  const timeout = options?.timeout ?? getScriptTimeout()

  // 确定工作目录
  const scriptDir = path.dirname(script.fullPath)
  const cwd = options?.cwd || scriptDir

  // 构建命令和参数
  const {cmd, cmdArgs} = await buildCommand(script, args)

  return new Promise<ScriptResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let outputSize = 0
    let killed = false

    // 检查脚本文件是否存在
    if (!fs.existsSync(script.fullPath)) {
      resolve({
        success: false,
        error: `Script not found: ${script.fullPath}`,
        exitCode: -1,
        duration: Date.now() - startTime,
      })
      return
    }

    // 设置环境变量
    const env: Record<string, string> = {
      ...process.env,
      ...options?.env,
      // 传递参数作为环境变量（备用）
      SKILL_SCRIPT_ARGS: JSON.stringify(args),
    }

      // SECURITY: shell: false is used for security - we directly invoke interpreters
      // with script paths as arguments, no shell interpretation needed
    const spawnOptions: SpawnOptions = {
      cwd,
      env,
        shell: false,
      windowsHide: true,
    }

    const proc = spawn(cmd, cmdArgs, spawnOptions)

    // 设置超时
    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGTERM')
    }, timeout)

    // 处理 stdout
    proc.stdout?.on('data', (_data: Buffer) => {
      const chunk = _data.toString()
      outputSize += chunk.length

      if (outputSize > MAX_OUTPUT_SIZE) {
        stdout += chunk.slice(0, MAX_OUTPUT_SIZE - outputSize)
        stdout += '\n... [output truncated]'
        proc.kill('SIGTERM')
        return
      }

      stdout += chunk
      options?.onOutput?.(chunk)
    })

    // 处理 stderr
    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stderr += chunk
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      const duration = Date.now() - startTime

      const success = code === 0 && !killed
      const output = stdout.trim()

      resolve({
        success,
        output: output || undefined,
        error: stderr.trim() || (killed ? 'Script timed out' : undefined),
        exitCode: code ?? undefined,
        duration,
      })
    })

    proc.on('error', (err) => {
      clearTimeout(timer)

      resolve({
        success: false,
        error: err.message,
        exitCode: -1,
        duration: Date.now() - startTime,
      })
    })
  })
}

/**
 * 执行脚本并实时流式输出
 * 
 * @returns 生成器，每次 yield 输出片段
 */
export async function* executeScriptStream(
  script: ScriptFile,
  args: Record<string, unknown>,
  options?: {
    cwd?: string
    timeout?: number
    env?: Record<string, string>
  },
): AsyncGenerator<{type: 'stdout' | 'stderr' | 'done' | 'error'; data: string; result?: ScriptResult}> {
  const startTime = Date.now()
  const timeout = options?.timeout ?? getScriptTimeout()

  const scriptDir = path.dirname(script.fullPath)
  const cwd = options?.cwd || scriptDir
  const {cmd, cmdArgs} = await buildCommand(script, args)

  if (!fs.existsSync(script.fullPath)) {
    yield {type: 'error', data: `Script not found: ${script.fullPath}`}
    return
  }

  const env: Record<string, string> = {
    ...process.env,
    ...options?.env,
    SKILL_SCRIPT_ARGS: JSON.stringify(args),
  }

    // SECURITY: shell: false is used for security - we directly invoke interpreters
    // with script paths as arguments, no shell interpretation needed
  const proc = spawn(cmd, cmdArgs, {
    cwd,
    env,
      shell: false,
    windowsHide: true,
  })

  const timer = setTimeout(() => {
    proc.kill('SIGTERM')
  }, timeout)

  let resolved = false

  const waitForClose = new Promise<ScriptResult>((resolve) => {
    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stdout += chunk
      if (!resolved) {
        resolve({success: false, output: stdout, exitCode: undefined, duration: Date.now() - startTime})
        resolved = true
      }
    })

    proc.stderr?.on('data', (data: Buffer) => {
      const chunk = data.toString()
      stderr += chunk
      if (!resolved) {
        resolve({success: false, error: stderr, exitCode: undefined, duration: Date.now() - startTime})
        resolved = true
      }
    })

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (!resolved) {
        resolved = true
        resolve({
          success: code === 0,
          output: stdout.trim() || undefined,
          error: stderr.trim() || undefined,
          exitCode: code ?? undefined,
          duration: Date.now() - startTime,
        })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      if (!resolved) {
        resolved = true
        resolve({
          success: false,
          error: err.message,
          exitCode: -1,
          duration: Date.now() - startTime,
        })
      }
    })
  })

  // 使用事件监听来 yield 输出
  return new Promise<ScriptResult>((resolve) => {
    proc.stdout?.on('data', (data: Buffer) => {
      // 通过事件方式通知
    })

    // 等待完成
    waitForClose.then((result) => {
      resolve(result)
    })
  }) as unknown as ScriptResult
}

// ─── 命令构建 ─────────────────────────────────────────

/**
 * 构建脚本命令（异步，自动检测解释器可用性）
 *
 * 跨平台策略：
 * - python: 所有平台统一优先 python3，回退 python
 * - powershell: 优先 pwsh (PowerShell Core)，回退 powershell (Windows PowerShell 5.x)
 * - bash: Windows 上需要 Git Bash 或 WSL
 * - node: 所有平台统一 node
 *
 * 如果所需解释器未安装，抛出明确错误并提示安装方式。
 */
async function buildCommand(script: ScriptFile, args: Record<string, unknown>): Promise<{
  cmd: string
  cmdArgs: string[]
}> {
  const scriptPath = script.fullPath
  const argsJson = JSON.stringify(args)

  switch (script.language) {
    case 'node': {
      if (!(await commandExists('node'))) {
        throw new Error(
          'Node.js 未安装或不在 PATH 中。请安装 Node.js (>=18.0.0): https://nodejs.org'
        )
      }
      return {cmd: 'node', cmdArgs: [scriptPath, argsJson]}
    }

    case 'python': {
      const pythonBin = await detectPython()
      if (!pythonBin) {
        throw new Error(
          'Python 未安装或不在 PATH 中。请安装 Python (>=3.8): https://python.org'
        )
      }
      return {cmd: pythonBin, cmdArgs: [scriptPath, argsJson]}
    }

    case 'bash': {
      if (process.platform === 'win32') {
        if (!(await commandExists('bash'))) {
          throw new Error(
            'Bash 不可用。Windows 用户请安装 Git Bash 或 WSL: https://git-scm.com'
          )
        }
      }
      return {cmd: 'bash', cmdArgs: [scriptPath, argsJson]}
    }

    case 'powershell': {
      const psCmd = await detectPowerShell()
      if (!psCmd) {
        throw new Error(
          process.platform === 'win32'
            ? 'PowerShell 未安装。请安装 PowerShell: https://aka.ms/powershell'
            : 'PowerShell (pwsh) 未安装。请安装 PowerShell Core: https://aka.ms/powershell'
        )
      }
      return {cmd: psCmd, cmdArgs: ['-File', scriptPath, '-Args', argsJson]}
    }

    default:
      return {cmd: scriptPath, cmdArgs: []}
  }
}

/**
 * 检测可用的 Python 解释器
 * macOS/Linux 优先 python3（因为 python 可能指向 Python 2 或不存在）
 * Windows 上 python3 也可能存在（通过 Windows Store 安装），同样优先
 */
async function detectPython(): Promise<string | null> {
  if (await commandExists('python3')) return 'python3'
  if (await commandExists('python')) return 'python'
  return null
}

/**
 * 检测可用的 PowerShell 解释器
 * 优先 pwsh (PowerShell Core v6+)，回退 powershell (Windows PowerShell 5.x)
 */
async function detectPowerShell(): Promise<string | null> {
  if (await commandExists('pwsh')) return 'pwsh'
  if (await commandExists('powershell')) return 'powershell'
  return null
}

// ─── 依赖检查 ─────────────────────────────────────────

/**
 * 检查脚本依赖是否满足
 */
export async function checkScriptDependencies(scripts: ScriptFile[]): Promise<{
  satisfied: boolean
  missing: {script: string; dependency: string; required: string}[]
}> {
  const missing: {script: string; dependency: string; required: string}[] = []

  for (const script of scripts) {
    switch (script.language) {
      case 'node':
        if (!(await commandExists('node'))) {
          missing.push({script: script.name, dependency: 'node', required: '>=18.0.0'})
        }
        break

      case 'python':
        if (!(await detectPython())) {
          missing.push({script: script.name, dependency: 'python', required: '>=3.8'})
        }
        break

      case 'powershell':
        if (!(await detectPowerShell())) {
          missing.push({script: script.name, dependency: 'powershell', required: process.platform === 'win32' ? 'PowerShell 5.x+' : 'PowerShell Core 6+'})
        }
        break

      case 'bash':
        if (process.platform === 'win32') {
          // Windows 上需要 WSL 或 Git Bash
          if (!(await commandExists('bash'))) {
            missing.push({script: script.name, dependency: 'bash', required: 'Git Bash or WSL'})
          }
        }
        break
    }
  }

  return {
    satisfied: missing.length === 0,
    missing,
  }
}

/**
 * 检查命令是否存在
 * 使用 Promise 等待进程退出，避免竞态条件
 */
// On Windows, shell: true is required to find commands via PATHEXT resolution
// (e.g., python may resolve only as python.exe, pwsh may need pwsh.exe)
// --version check is safe: it only prints version and exits, no side effects
function commandExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, ['--version'], {
        shell: process.platform === 'win32',
        windowsHide: true,
      })
      
      // 进程启动失败（如命令不存在）
      proc.on('error', () => resolve(false))
      
      // 等待进程退出，根据退出码判断命令是否存在
      proc.on('close', (code) => {
        resolve(code === 0)
      })
      
      // 超时保护：2秒后强制结束检查
      setTimeout(() => {
        try {
          proc.kill()
        } catch {
          // 进程可能已结束，忽略错误
        }
        resolve(false)
      }, 2000)
    } catch {
      resolve(false)
    }
  })
}

// ─── 便捷函数 ─────────────────────────────────────────

/**
 * 从 SKILL.md 解析脚本调用并执行
 * 
 * @param skillDir 技能目录
 * @param scriptCall 脚本调用字符串，如 `node ./scripts/generate.js '{"type":"pie"}'`
 */
export async function executeInlineScript(
  skillDir: string,
  scriptCall: string,
): Promise<ScriptResult> {
  // 解析脚本调用字符串
  // 例如: node ./scripts/generate.js '{"type":"pie"}'
  const match = scriptCall.match(/\$?\s*(\w+)\s+\.\/scripts\/([^\s'"]+)(?:\s+(.+))?/)

  if (!match) {
    return {
      success: false,
      error: `Invalid script call format: ${scriptCall}`,
    }
  }

  const [, interpreter, scriptName, argsStr] = match
  const scriptPath = path.join(skillDir, 'scripts', scriptName)

  // 解析参数
  let scriptArgs: Record<string, unknown> = {}
  if (argsStr) {
    try {
      scriptArgs = parseScriptArgs(argsStr)
    } catch {
      scriptArgs = {input: argsStr.trim()}
    }
  }

  // 确定脚本语言
  const langMap: Record<string, ScriptFile['language']> = {
    node: 'node',
    python: 'python',
    py: 'python',
    bash: 'bash',
    sh: 'bash',
  }
  const language = langMap[interpreter.toLowerCase()] || 'bash'

  // 创建脚本文件信息
  const script: ScriptFile = {
    name: scriptName,
    path: `scripts/${scriptName}`,
    fullPath: scriptPath,
    language,
    executable: true,
  }

  return executeScript(script, scriptArgs)
}

/**
 * 解析脚本参数
 */
function parseScriptArgs(argsStr: string): Record<string, unknown> {
  // 尝试清理并解析 JSON
  let cleaned = argsStr.trim()

  // 移除首尾引号
  if ((cleaned.startsWith("'") && cleaned.endsWith("'")) ||
      (cleaned.startsWith('"') && cleaned.endsWith('"'))) {
    cleaned = cleaned.slice(1, -1)
  }

  // 尝试解析为 JSON
  try {
    return JSON.parse(cleaned)
  } catch {
    // 如果失败，返回原始字符串
    return {input: cleaned}
  }
}

/**
 * 创建测试脚本（用于测试执行器）
 */
export function createTestScript(dir: string, name: string, content: string): string {
  const scriptPath = path.join(dir, name)
  fs.writeFileSync(scriptPath, content, 'utf-8')
  
  // 设置可执行权限（Unix）
  if (process.platform !== 'win32') {
    fs.chmodSync(scriptPath, 0o755)
  }
  
  return scriptPath
}

/**
 * 清理测试脚本
 */
export function cleanupTestScript(scriptPath: string): void {
  if (fs.existsSync(scriptPath)) {
    fs.unlinkSync(scriptPath)
  }
}

// ─── 脚本信息提取 ─────────────────────────────────────

/**
 * 从脚本内容提取元信息
 */
export function extractScriptMetadata(scriptPath: string): {
  description?: string
  usage?: string
  args?: Array<{name: string; description: string; required: boolean}>
} {
  if (!fs.existsSync(scriptPath)) {
    return {}
  }

  const content = fs.readFileSync(scriptPath, 'utf-8')
  const lines = content.split('\n')

  let description: string | undefined
  let usage: string | undefined
  const args: Array<{name: string; description: string; required: boolean}> = []

  let inArgsSection = false

  for (const line of lines) {
    const trimmed = line.trim()

    // 跳过 shebang 和空行
    if (trimmed.startsWith('#!') || !trimmed) continue

    // 描述（第一个注释行）
    if (!description && trimmed.startsWith('#')) {
      description = trimmed.replace(/^#\s*/, '').replace(/^\*\s*/, '')
      continue
    }

    // Usage
    if (trimmed.startsWith('# Usage:') || trimmed.startsWith('# usage:')) {
      usage = trimmed.replace(/^#\s*(Usage:|usage:)\s*/, '')
      continue
    }

    // 参数部分
    if (trimmed.startsWith('# Args:') || trimmed.startsWith('# args:')) {
      inArgsSection = true
      continue
    }

    if (inArgsSection && trimmed.startsWith('#')) {
      const argMatch = trimmed.match(/^#\s*(?:\-?\-\-?)?(\w+):\s*(.+)/)
      if (argMatch) {
        args.push({
          name: argMatch[1],
          description: argMatch[2],
          required: false,
        })
      }
    }
  }

  return {description, usage, args: args.length > 0 ? args : undefined}
}
