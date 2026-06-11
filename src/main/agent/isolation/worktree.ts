/**
 * Worktree 管理器
 * 实现临时 git worktree 隔离机制
 */

import * as fs from 'fs'
import {spawnSync} from 'child_process'
import * as path from 'path'
import {randomUUID} from 'crypto'

/** Git 未安装时的错误提示 */
function gitNotFoundHint(): string {
  if (process.platform === 'win32') {
    return 'Git 未安装或不在 PATH 中。请安装 Git for Windows: https://git-scm.com/download/win'
  }
  if (process.platform === 'darwin') {
    return 'Git 未安装。请通过 Xcode Command Line Tools 安装：xcode-select --install，或通过 Homebrew：brew install git'
  }
  return 'Git 未安装。请通过包管理器安装：apt install git / yum install git'
}

/**
 * Worktree 管理器
 */
export class WorktreeManager {
  private worktrees: Map<string, string> = new Map()

  /**
   * 执行 git 命令（跨平台兼容）
   * Windows 上需要 shell: true 以正确解析 git.exe 路径
   */
  private git(
    args: string[],
    options: { cwd: string; encoding?: BufferEncoding; stdio?: 'pipe' },
  ): ReturnType<typeof spawnSync> {
    const result = spawnSync('git', args, {
      ...options,
      shell: process.platform === 'win32',
    })
    return result
  }

  /**
   * 创建临时 worktree
   */
  async createWorktree(sourceDir: string, taskId: string): Promise<string> {
      const worktreeId = `hclaw-${randomUUID().slice(0, 8)}`
      const worktreeDir = path.join(path.dirname(sourceDir), '.hclaw-worktrees')
    const worktreePath = path.join(worktreeDir, worktreeId)

      // 创建 .hclaw-worktrees 目录
    if (!fs.existsSync(worktreeDir)) {
      fs.mkdirSync(worktreeDir, { recursive: true })
    }

    // 创建 worktree
    const result = this.git(['worktree', 'add', worktreePath, '-b', worktreeId], {
      cwd: sourceDir,
      stdio: 'pipe',
    })
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() || ''
      if (result.error || stderr.includes('not found') || stderr.includes('not recognized')) {
        throw new Error(gitNotFoundHint())
      }
      throw new Error(`Failed to create worktree: ${stderr || 'Unknown error'}`)
    }

    this.worktrees.set(taskId, worktreePath)
    return worktreePath
  }

  /**
   * 检查 worktree 中是否有变更
   */
  hasChanges(taskId: string): boolean {
    const worktreePath = this.worktrees.get(taskId)
    if (!worktreePath) return false

    const result = this.git(['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    })
    if (result.status !== 0 || result.error) {
      return false
    }
    return (String(result.stdout || '').trim()).length > 0
  }

  /**
   * 获取 worktree 变更摘要
   */
  getChangesSummary(taskId: string): string {
    const worktreePath = this.worktrees.get(taskId)
    if (!worktreePath) return ''

    const result = this.git(['diff', '--stat'], {
      cwd: worktreePath,
      encoding: 'utf-8',
    })
    if (result.status !== 0 || result.error) {
      return ''
    }
    return result.stdout?.toString() || ''
  }

  /**
   * 删除 worktree
   */
  async removeWorktree(taskId: string): Promise<void> {
    const worktreePath = this.worktrees.get(taskId)
    if (!worktreePath) return

    const parentDir = path.dirname(worktreePath)

    // 移除 worktree（忽略结果 — 目录可能已不存在）
    this.git(['worktree', 'remove', worktreePath], {
      cwd: parentDir,
      stdio: 'pipe',
    })

    // 删除分支（忽略结果 — 分支可能已被删除）
    this.git(['branch', '-D', path.basename(worktreePath)], {
      cwd: parentDir,
      stdio: 'pipe',
    })

    this.worktrees.delete(taskId)
  }

  /**
   * 清理所有 worktrees
   */
  async cleanup(): Promise<void> {
    const taskIds = Array.from(this.worktrees.keys())
    for (const taskId of taskIds) {
      await this.removeWorktree(taskId)
    }
  }
}

/**
 * 全局单例
 */
export const worktreeManager = new WorktreeManager()
