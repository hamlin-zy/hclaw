/**
 * MCP Stdio Transport — 基于官方 SDK StdioClientTransport 的薄适配
 *
 * 创建跨平台 stdio transport，替换自实现的 JSON-RPC 解析和进程管理。
 * 保留 killProcessTree() 作为 Windows 进程树杀的兜底。
 *
 * macOS / Linux PATH 修复：
 * 桌面环境（Finder、GNOME、KDE 等）启动的 Electron 应用 PATH 通常不完整，
 * 缺少通过 shell rc 文件注入的路径（nvm、Homebrew、Volta 等）。
 * 这导致 spawn('npx') 报 ENOENT 或超时。
 *
 * 此处：
 *   1. 预先用完整 PATH 解析命令的绝对路径
 *   2. 将常用安装路径注入子进程 env.PATH，确保 npx/node 可被找到
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { execSync } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'

// Re-export 进程工具函数（来自 processUtils.ts）
export { isProcessRunning, waitForProcessExit } from './processUtils'

// ─── 共享 POSIX 路径（macOS + Linux 通用） ──────────

const HOME = os.homedir()

/** 版本管理器路径（macOS / Linux 通用） */
const VERSION_MANAGER_DIRS = [
  path.join(HOME, '.nvm/versions/node'),   // nvm
  path.join(HOME, '.volta/bin'),            // Volta
  path.join(HOME, '.fnm'),                  // fnm
  path.join(HOME, '.bun/bin'),              // Bun
]

/** 用户级二进制目录（macOS / Linux 通用） */
const USER_BIN_DIRS = [
  path.join(HOME, '.local/bin'),            // pipx / XDG 规范 / 手动编译安装
]

// ─── 平台专属路径 ───────────────────────────────────

const PLATFORM_PATH_DIRS: string[] = (() => {
  switch (process.platform) {
    case 'darwin':
      return [
        '/opt/homebrew/bin',                // Apple Silicon Homebrew
        '/opt/homebrew/sbin',
        '/usr/local/bin',                   // Intel Homebrew + 手动安装
        '/usr/local/sbin',
        path.join(HOME, 'Library/pnpm'),    // pnpm (macOS)
      ]
    case 'linux':
      return [
        '/usr/local/bin',                   // 手动编译 / make install
        '/usr/local/sbin',
        '/snap/bin',                        // Ubuntu Snap
        path.join(HOME, '.cargo/bin'),      // Rust/Cargo
        path.join(HOME, '.npm-global/bin'), // npm -g (非 nvm 用户)
        '/home/linuxbrew/.linuxbrew/bin',   // Linuxbrew
      ]
    default:
      return []  // Windows — 不需要 PATH 修复（默认 PATH 已包含常见位置）
  }
})()

/**
 * 完整 PATH 候选目录（去重 + 去重后合并）
 */
function getAllCandidateDirs(): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const dir of [...PLATFORM_PATH_DIRS, ...USER_BIN_DIRS, ...VERSION_MANAGER_DIRS]) {
    if (!seen.has(dir)) {
      seen.add(dir)
      result.push(dir)
    }
  }
  return result
}

/**
 * 构建完整 PATH 字符串
 * 合并 process.env.PATH + 所有存在的候选目录
 */
function buildPosixPath(): string {
  const existing = process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'
  const parts = new Set(existing.split(path.delimiter).filter(Boolean))

  for (const dir of getAllCandidateDirs()) {
    if (!fs.existsSync(dir)) continue

    // nvm 是多版本目录，需展开子目录
    if (dir.includes('nvm/versions/node')) {
      try {
        const versions = fs.readdirSync(dir)
        for (const version of versions) {
          const binDir = path.join(dir, version, 'bin')
          if (fs.existsSync(binDir)) parts.add(binDir)
        }
      } catch { /* nvm 可能无版本 */ }
    } else {
      parts.add(dir)
    }
  }

  return [...parts].join(path.delimiter)
}

/**
 * 解析命令的绝对路径（macOS / Linux 上使用完整 PATH 调用 which）
 * 避免 spawn 时 ENOENT
 */
function resolveCommandPath(command: string, posixPath?: string): string {
  // 已经是路径，直接返回
  if (command.includes('/') || command.includes('\\')) {
    return command
  }
  // Windows: PATH 通常足够，不做解析
  if (process.platform === 'win32') {
    return command
  }
  const effectivePath = posixPath ?? buildPosixPath()
  try {
    const fullPath = execSync(
      `PATH="${effectivePath}" /usr/bin/which "${command}"`,
      { encoding: 'utf-8', timeout: 3000 },
    ).trim()
    if (fullPath && fs.existsSync(fullPath)) {
      return fullPath
    }
  } catch {
    // which 失败 → 返回原始命令，让 spawn 报清晰的 ENOENT
  }
  return command
}

/**
 * 将完整 PATH 注入子进程环境变量（macOS / Linux）
 * 确保 spawn 子进程能找到 npx/node 等工具
 */
function enrichEnvPath(env?: Record<string, string>, posixPath?: string): Record<string, string> {
  const merged = { ...env }
  // Windows 不需要 PATH 扩充
  if (process.platform === 'win32') {
    return merged
  }
  const effectivePath = posixPath ?? buildPosixPath()
  merged.PATH = merged.PATH
    ? `${merged.PATH}${path.delimiter}${effectivePath}`
    : effectivePath
  return merged
}

/**
 * 创建 SDK StdioClientTransport 实例
 *
 * 在 macOS / Linux 上自动：
 *   1. 将 npx/node 等命令解析为绝对路径（避免 ENOENT）
 *   2. 注入完整的 PATH 到子进程环境变量（避免超时 / 静默失败）
 */
export function createStdioTransport(server: {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  stderr?: 'pipe' | 'inherit' | 'overlapped'
}): StdioClientTransport {
  const posixPath = process.platform !== 'win32' ? buildPosixPath() : undefined
  const resolvedCommand = resolveCommandPath(server.command, posixPath)
  const enrichedEnv = enrichEnvPath(server.env, posixPath)

  return new StdioClientTransport({
    ...server,
    command: resolvedCommand,
    env: enrichedEnv,
  })
}

/**
 * 递归杀掉 Windows 进程树
 *
 * SDK StdioClientTransport.close() 使用 stdin.end() → SIGTERM → SIGKILL 链，
 * 但对于 npx 等可能 spawn 孙进程的场景，taskkill /T 确保整棵树被清理。
 * 作为 MCPClient.stopServer() 中的兜底调用。
 */
export function killProcessTree(pid: number): void {
  try {
    execSync(`taskkill /F /T /PID ${pid} 2>nul`, {
      timeout: 2000,
      windowsHide: true,
    })
  } catch {
    // taskkill 在进程已退出时返回非 0，静默忽略
  }
}
