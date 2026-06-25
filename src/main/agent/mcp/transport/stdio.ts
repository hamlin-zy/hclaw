/**
 * MCP Stdio Transport — 基于官方 SDK StdioClientTransport 的薄适配
 *
 * 跨平台子进程环境变量策略：
 * - 所有平台继承父进程的完整 process.env（确保 UV_CACHE_DIR、HTTP_PROXY 等全局变量正常传递）
 * - macOS/Linux 额外注入 nvm/Homebrew/etc 路径到 PATH（桌面 Electron 的 PATH 可能不完整）
 * - mcp.json 中显式配置的 env 拥有最高优先级
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
 * 完整 PATH 候选目录（三组路径不重叠，直接合并即可）
 */
function getAllCandidateDirs(): string[] {
  return [...PLATFORM_PATH_DIRS, ...USER_BIN_DIRS, ...VERSION_MANAGER_DIRS]
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
 * 构建完整的子进程环境变量
 *
 * MCP SDK 的 StdioClientTransport 默认只继承 12 个白名单环境变量（Windows），
 * 丢弃了用户全局设置的 UV_CACHE_DIR、HTTP_PROXY、NODE_EXTRA_CA_CERTS 等。
 *
 * 此处策略：
 *   1. 以父进程的完整 process.env 为基础（继承用户所有全局设置）
 *   2. macOS/Linux 上附加 nvm/Homebrew/bin 路径（桌面启动的 Electron 可能缺这些）
 *   3. mcp.json 中显式配置的 env 覆盖一切（用户显式声明的最高优先级）
 *
 * SDK 后续还会叠加它自己的 12 变量默认值：{...defaultEnv, ...ourEnv}
 * 所以 process.env 中的值会覆盖 SDK 默认值（正确），
 * SDK 的默认值仅作为兜底（如果某个核心变量在 process.env 中意外缺失）。
 */
function buildChildEnv(configEnv?: Record<string, string>, posixPath?: string): Record<string, string> {
  // Step 1: 从父进程完整环境变量开始
  const env: Record<string, string> = { ...process.env as Record<string, string> }

  // Step 2: macOS/Linux 附加版本管理器路径（桌面启动的 Electron 可能 PATH 不完整）
  if (process.platform !== 'win32') {
    const effectivePath = posixPath ?? buildPosixPath()
    if (effectivePath) {
      env.PATH = env.PATH
        ? `${env.PATH}${path.delimiter}${effectivePath}`
        : effectivePath
    }
  }

  // Step 3: mcp.json 中显式配置的 env 覆盖一切
  if (configEnv) {
    Object.assign(env, configEnv)
  }

  return env
}

/**
 * 创建 SDK StdioClientTransport 实例
 *
 * 继承父进程的完整环境变量 + 配置层覆盖，确保所有平台（Windows/Linux/macOS）
 * 上用户配置的全局环境变量（如 UV_CACHE_DIR、HTTP_PROXY 等）能正常传递到 MCP 子进程。
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
  const childEnv = buildChildEnv(server.env, posixPath)

  return new StdioClientTransport({
    ...server,
    command: resolvedCommand,
    env: childEnv,
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
