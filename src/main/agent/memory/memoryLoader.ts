import {existsSync, statSync, readFileSync, writeFileSync, mkdirSync} from 'fs'
import {join} from 'path'
import type {MemoryContent, MemoryIndex} from '@shared/types/memory'

/** mtime 缓存条目 */
interface CacheEntry {
  mtimeMs: number
  content: string
}

/** 文件内容缓存，按绝对路径索引，避免每轮重复读盘 */
const fileCache = new Map<string, CacheEntry>()

export function getMemDir(hclawDir: string): string {
  return join(hclawDir, 'mem')
}

export function getRefDir(hclawDir: string): string {
  return join(getMemDir(hclawDir), 'ref')
}

/**
 * 带缓存的文本读取：mtime 未变化时返回缓存内容
 */
export function readTextCached(filePath: string): string | null {
  if (!existsSync(filePath)) {
    // 文件已删除 → 清除陈旧缓存，防止重建后读到旧 mtime+content
    fileCache.delete(filePath)
    return null
  }
  const mtimeMs = statSync(filePath).mtimeMs
  const cached = fileCache.get(filePath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.content
  const content = readFileSync(filePath, 'utf8')
  fileCache.set(filePath, {mtimeMs, content})
  return content
}

/** 读取 index.json，不存在或解析失败返回 null */
export function readIndex(hclawDir: string): MemoryIndex | null {
  const raw = readTextCached(join(getRefDir(hclawDir), 'index.json'))
  if (raw === null) return null
  try {
    return JSON.parse(raw) as MemoryIndex
  } catch {
    return null
  }
}

/**
 * 加载记忆内容：
 * - mem/SKILL.md（可选）
 * - mem/ref/_user/preferences.md（可选）
 * - index.json 命中当前 workspace 时加载 mem/ref/<dir>/memory.md
 */
export function loadMemory(hclawDir: string, workspacePath: string | null): MemoryContent | null {
  const memDir = getMemDir(hclawDir)
  if (!existsSync(memDir)) return null

  const skillMd = readTextCached(join(memDir, 'SKILL.md'))
  const preferencesMd = readTextCached(join(memDir, 'ref', '_user', 'preferences.md'))

  let projectMemoryMd: string | null = null
  let projectName: string | null = null
  const index = readIndex(hclawDir)
  const entry = workspacePath ? index?.[workspacePath] : undefined
  if (entry) {
    projectMemoryMd = readTextCached(join(getRefDir(hclawDir), entry.dir, 'memory.md'))
    projectName = entry.projectName
  }

  return {skillMd, preferencesMd, projectMemoryMd, projectName}
}

/** 创建 mem/ 目录结构（幂等） */
export function ensureMemoryDir(hclawDir: string): void {
  const memDir = getMemDir(hclawDir)
  mkdirSync(join(memDir, 'ref', '_user'), {recursive: true})
}

/** 确保 index.json 存在（不存在则写入空对象） */
export function ensureIndex(hclawDir: string): void {
  ensureMemoryDir(hclawDir)
  const indexPath = join(getRefDir(hclawDir), 'index.json')
  if (!existsSync(indexPath)) {
    writeFileSync(indexPath, '{}\n', 'utf8')
  }
}
