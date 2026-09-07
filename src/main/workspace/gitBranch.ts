/**
 * Git 分支感知（纯只读，不做任何 git 写操作）
 *
 * - getGitBranch(cwd): 读取当前分支名；detached HEAD 返回短 SHA（前 7 位）；非 git 目录返回 null
 * - startGitBranchWatch / stopGitBranchWatch: 监听 <cwd>/.git/HEAD 变化
 *   （fs.watch + 300ms 防抖），变化后重读分支名并广播 workspace:git-branch-changed；
 *   watch 失败降级为 3s 轮询（HEAD 内容变化才广播）
 */

import * as fs from 'fs'
import * as path from 'path'
import {broadcastToAllWindows} from '../utils/windowBroadcast'

const GIT_BRANCH_CHANNEL = 'workspace:git-branch-changed'

/** HEAD 文件内容 → 分支名 | 短 SHA | null（非 git 目录） */
function parseHeadContent(content: string | null): string | null {
    if (!content) return null
    const trimmed = content.trim()
    // 符号引用: ref: refs/heads/main → main
    if (trimmed.startsWith('ref:')) {
        const ref = trimmed.slice(4).trim()
        return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    }
    // detached HEAD: 直接是 SHA，取前 7 位
    if (trimmed.length >= 7) return trimmed.slice(0, 7)
    return trimmed || null
}

/**
 * 读取 cwd 的 git 分支名。
 * 优先 simple-git；失败时回退为直接读 .git/HEAD（git 未装等场景仍可用）。
 */
export async function getGitBranch(cwd: string): Promise<string | null> {
    const headPath = path.join(cwd, '.git', 'HEAD')
    try {
        const {default: simpleGit} = await import('simple-git')
        // CJS/ESM interop 兼容：default 可能是 simpleGit 函数或整个命名空间
        const gitFactory = typeof simpleGit === 'function'
            ? simpleGit
            : (simpleGit as any)?.simpleGit
        const git = gitFactory({baseDir: cwd})
        const isRepo = await git.checkIsRepo()
        if (!isRepo) return null
        const branch = await git.revparse(['--abbrev-ref', 'HEAD'])
        if (branch && branch.trim() && branch.trim() !== 'HEAD') return branch.trim()
        // detached HEAD → 短 SHA
        const sha = await git.revparse(['HEAD'])
        return sha ? sha.trim().slice(0, 7) : null
    } catch {
        // 回退：直接读 .git/HEAD（worktree/.git 文件指向他处的场景不保证准确，尽力而为）
        try {
            const content = fs.readFileSync(headPath, 'utf8')
            return parseHeadContent(content)
        } catch {
            return null
        }
    }
}

// ── watch 状态（全局单例，同一时间只监听当前工作区） ──────────────

let fsWatcher: fs.FSWatcher | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let watchCwd: string | null = null
/** 防抖窗口内记录的待处理 HEAD 内容（null 表示未知，直接重读） */
let lastHeadContent: string | null = null

async function emitBranchChanged(cwd: string, headContent: string | null): Promise<void> {
    const branch = await getGitBranch(cwd)
    broadcastToAllWindows(GIT_BRANCH_CHANNEL, branch)
    void headContent
}

function clearAll(): void {
    if (fsWatcher) { fsWatcher.close(); fsWatcher = null }
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    watchCwd = null
    lastHeadContent = null
}

/**
 * 开始监听 cwd 的 .git/HEAD 变化（先关闭旧的 watch）。
 * fs.watch 失败（如 .git 不存在、权限不足）时降级为 3s 轮询。
 */
export function startGitBranchWatch(cwd: string): void {
    stopGitBranchWatch()
    watchCwd = cwd

    const headPath = path.join(cwd, '.git', 'HEAD')
    try { lastHeadContent = fs.readFileSync(headPath, 'utf8') } catch { lastHeadContent = null }

    const onHeadChanged = () => {
        if (debounceTimer) clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
            debounceTimer = null
            if (!watchCwd) return
            let content: string | null = null
            try { content = fs.readFileSync(path.join(watchCwd, '.git', 'HEAD'), 'utf8') } catch { content = null }
            // 内容未变（如 delete→recreate 瞬态）不广播
            if (content !== null && content === lastHeadContent) return
            lastHeadContent = content
            void emitBranchChanged(watchCwd, content)
        }, 300)
    }

    try {
        fsWatcher = fs.watch(headPath, onHeadChanged)
        fsWatcher.on('error', () => startPolling())
    } catch {
        startPolling()
    }

    function startPolling() {
        if (fsWatcher) { fsWatcher.close(); fsWatcher = null }
        if (pollTimer) clearInterval(pollTimer)
        // 3s 轮询：比较 HEAD 内容变化才广播
        pollTimer = setInterval(() => {
            if (!watchCwd) return
            let content: string | null = null
            try { content = fs.readFileSync(path.join(watchCwd, '.git', 'HEAD'), 'utf8') } catch { content = null }
            if (content === lastHeadContent) return
            lastHeadContent = content
            void emitBranchChanged(watchCwd, content)
        }, 3000)
    }
}

/** 停止监听（工作区关闭/切换前调用） */
export function stopGitBranchWatch(): void {
    clearAll()
}
