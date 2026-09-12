// src/main/project-manager/fileSystem.ts
import {readdir, stat, readFile, realpath} from 'fs/promises'
import {join, resolve, relative, extname, sep} from 'path'
import {createHash} from 'crypto'
import {shell} from 'electron'
import type {DirEntry, FileContentResult, GitStatus} from '../../shared/types/project-manager'
import {gitExecResult} from './git/gitExec'

const BLACKLIST = new Set(['.git', 'node_modules', '.vite', '.cache', '.trash'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'])
const MAX_SIZE = 5 * 1024 * 1024

export function assertInWorkspace(workspace: string, relPath: string): string {
  const wsRoot = resolve(workspace)
  const resolved = resolve(workspace, relPath)
  if (resolved !== wsRoot && !resolved.startsWith(wsRoot + sep)) {
    throw new Error('路径超出工作目录')
  }
  return resolved
}

export function containsNullByte(buffer: Buffer): boolean {
  return buffer.includes(0)
}

// 解析 symlink 后再校验，防止词法校验被符号链接穿越（fail-closed）
async function assertRealInWorkspace(workspace: string, abs: string): Promise<void> {
  // realpath 对不存在的路径会抛 ENOENT——按原有错误路径处理，不回退词法判断
  const wsReal = await realpath(workspace)
  const absReal = await realpath(abs)
  if (absReal !== wsReal && !absReal.startsWith(wsReal + sep)) {
    throw new Error('路径超出工作目录')
  }
}

export function isImageExt(p: string): boolean {
  return IMAGE_EXTS.has(extname(p).toLowerCase())
}

export async function readFileText(workspace: string, relPath: string): Promise<string> {
  const abs = assertInWorkspace(workspace, relPath)
  await assertRealInWorkspace(workspace, abs)
  return readFile(abs, 'utf-8')
}

/**
 * 删除工作区内的文件/目录（走系统回收站）。
 *
 * - **必须拒绝工作区根**：relPath 规范化为空（'' / '.' / './' 等）时等价于删除整个工作区，
 *   回收站虽可恢复，但把整个项目误删的代价过高，故在入口直接拒绝。
 * - **用 shell.trashItem 而非 fs.rm**：删除是破坏性操作，回收站是可恢复的失败兜底；
 *   直接 rm 一旦路径判断出错即不可逆。
 */
export async function deletePath(workspace: string, relPath: string): Promise<void> {
  const abs = assertInWorkspace(workspace, relPath)
  if (relative(resolve(workspace), abs) === '') throw new Error('不能删除工作区根目录')
  await shell.trashItem(abs)
}

// ==== 被忽略标记（spec §6.3）====

/** workspace → 是否 git 仓库。避免每次 listDirectory 都起一个子进程探测。 */
const gitRepoCache = new Map<string, boolean>()

/** 测试用：清空仓库探测缓存 */
export function resetGitRepoCache(): void {
  gitRepoCache.clear()
}

/**
 * 按 workspace 回收仓库探测缓存（窗口关闭 / 工作区卸载时调用）。
 * 必须用 delete 而非 clear：其它已打开工作区的缓存条目仍然有效，不应被连带清空。
 */
export function deleteGitRepoCache(workspace: string): void {
  gitRepoCache.delete(workspace)
}

async function isGitRepo(workspace: string): Promise<boolean> {
  const cached = gitRepoCache.get(workspace)
  if (cached !== undefined) return cached
  // code 128 = 非 git 仓库；-1 = git 未安装（ENOENT）。两者都按"不是仓库"处理。
  const {code} = await gitExecResult(workspace, ['rev-parse', '--is-inside-work-tree'])
  const ok = code === 0
  gitRepoCache.set(workspace, ok)
  return ok
}

/**
 * 批量标记被忽略的条目。
 *
 * - 一次调用标记整层（`--stdin` 批量喂路径），不逐文件调用。
 * - **退出码语义**：0 = 有命中；1 = 没有任何路径被忽略（**正常结果，不是错误**）；
 *   128 = 非 git 仓库。因此必须用 `gitExecResult`——`gitExec` 会把退出码 1 当成失败抛错，
 *   从而把「全部未忽略」误判为「全部未知」。
 * - 非 git 仓库 / git 未安装 / 任何其它退出码一律返回空集合（= 全部未忽略），绝不抛错。
 */
async function collectIgnored(workspace: string, relPaths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (relPaths.length === 0) return ignored
  if (!(await isGitRepo(workspace))) return ignored

  const {code, stdout} = await gitExecResult(
    workspace,
    ['check-ignore', '--stdin', '-z'],
    relPaths.join('\0') + '\0',
  )
  if (code !== 0) return ignored

  for (const raw of stdout.split('\0')) {
    if (!raw) continue
    ignored.add(raw.replace(/\\/g, '/'))
  }
  return ignored
}

export async function listDirectory(workspace: string, relDir: string, statusMap: Record<string, GitStatus>): Promise<DirEntry[]> {
  const absDir = assertInWorkspace(workspace, relDir || '.')
  // 归一化相对路径（./sub、sub/../x 等），保证返回 path 与 statusMap 键一致
  const base = relative(resolve(workspace), absDir).replace(/\\/g, '/')
  const prefix = base === '' ? '' : base + '/'
  const items = await readdir(absDir, {withFileTypes: true})

  const visible = items.filter(item => !BLACKLIST.has(item.name))
  // 一次调用标记整层被忽略状态（spec §6.3）
  const ignored = await collectIgnored(workspace, visible.map(item => prefix + item.name))

  const entries: DirEntry[] = []
  for (const item of visible) {
    const relPath = prefix + item.name
    const isIgnored = ignored.has(relPath)
    if (item.isDirectory()) {
      let hasChildren = false
      try {
        const children = await readdir(join(absDir, item.name))
        hasChildren = children.some(c => !BLACKLIST.has(c))
      } catch { /* 无权限按空处理 */ }
      entries.push({
        name: item.name, path: relPath, isDir: true, size: 0,
        gitStatus: statusMap[relPath]?.status ?? 'none', hasChildren, ignored: isIgnored,
      })
    } else {
      let size = 0
      try { size = (await stat(join(absDir, item.name))).size } catch { /* 忽略 */ }
      entries.push({
        name: item.name, path: relPath, isDir: false, size,
        gitStatus: statusMap[relPath]?.status ?? 'none', hasChildren: false, ignored: isIgnored,
      })
    }
  }
  // 目录在前，各自按名排序
  return entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
}

export async function readFileForViewer(workspace: string, relPath: string): Promise<FileContentResult> {
  const abs = assertInWorkspace(workspace, relPath)
  await assertRealInWorkspace(workspace, abs)
  const st = await stat(abs)
  const isImage = isImageExt(relPath)
  const mimeType = isImage ? `image/${extname(relPath).slice(1).toLowerCase()}` : ''
  /** 超限统一返回：内容不读出（含 TOCTOU 复核——readFile 结果比前置 stat 更大时同样走此分支） */
  const oversizedResult = (size: number): FileContentResult => ({
    path: relPath, size, content: null, isBinary: true, isImage, decodeError: false, mimeType, truncated: false, mtime: st.mtimeMs, hash: '',
  })
  if (st.size > MAX_SIZE) return oversizedResult(st.size)
  const buffer = await readFile(abs)
  if (buffer.length > MAX_SIZE) return oversizedResult(buffer.length)
  const isBinary = containsNullByte(buffer)
  // 图片走 base64 管线（渲染端拼 data:image/...;base64, 交 ImageViewer；>5MB 已在上方拦截）
  const base64 = isImage ? buffer.toString('base64') : undefined
  let text: string | null = null
  let decodeError = false
  if (!isBinary) {
    const decoded = buffer.toString('utf-8')
    decodeError = decoded.includes('\uFFFD')
    text = decodeError ? null : decoded
  }
  return {
    path: relPath,
    size: st.size,
    content: isBinary ? null : text,
    isBinary,
    isImage,
    decodeError,
    mimeType,
    truncated: false,
    mtime: st.mtimeMs,
    hash: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
    base64,
  }
}
