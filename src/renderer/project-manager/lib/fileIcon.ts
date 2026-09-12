// 文件树 / 变更列表 / Commit 详情共用的图标表（spec §6.1）
// 原则：lucide 单色图标 + 按类别着色；颜色一律走令牌，零新依赖。
import {Braces, File, FileCode, FileImage, FileText, FileType, Folder, FolderOpen, Settings} from 'lucide-react'
import type {LucideIcon} from 'lucide-react'

export type FileIconKind = 'code' | 'style' | 'markup' | 'data' | 'image' | 'config' | 'unknown'

export interface FileIconSpec {
  Icon: LucideIcon
  /** CSS 颜色令牌，形如 `var(--code-ident)` */
  color: string
}

/** 类别 → 图标 + 颜色令牌（spec §6.1 表） */
export const KIND_SPEC: Record<FileIconKind, FileIconSpec> = {
  code:    {Icon: FileCode,  color: 'var(--code-ident)'},
  style:   {Icon: FileType,  color: 'var(--code-type)'},
  markup:  {Icon: FileText,  color: 'var(--code-function)'},
  data:    {Icon: Braces,    color: 'var(--code-number)'},
  image:   {Icon: FileImage, color: 'var(--code-string)'},
  config:  {Icon: Settings,  color: 'var(--text-secondary)'},
  unknown: {Icon: File,      color: 'var(--text-secondary)'},
}

/** 扩展名（小写，不含点）→ 类别 */
export const EXT_KIND: Record<string, FileIconKind> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', go: 'code', rs: 'code', java: 'code',
  css: 'style', scss: 'style', less: 'style',
  md: 'markup', mdx: 'markup', txt: 'markup', rst: 'markup',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
}

/** 无扩展名的点文件按完整文件名精确匹配 */
export const NAME_KIND: Record<string, FileIconKind> = {
  '.gitignore': 'config',
  '.env': 'config',
  '.editorconfig': 'config',
  '.npmrc': 'config',
}

export const FOLDER_SPEC: FileIconSpec = {Icon: Folder, color: 'var(--icon-folder)'}
/** 根节点：展开态文件夹 + 品牌色（由调用方加粗） */
export const ROOT_SPEC: FileIconSpec = {Icon: FolderOpen, color: 'var(--icon-folder)'}

/** 展开的普通目录与根节点视觉一致（都用 FolderOpen） */
export const FOLDER_OPEN_SPEC: FileIconSpec = {Icon: FolderOpen, color: 'var(--icon-folder)'}

/** 文件名 → 图标规格。先按完整文件名匹配点文件，再退回扩展名，最后 unknown。 */
export function fileIcon(name: string): FileIconSpec {
  const lower = name.toLowerCase()
  const byName = NAME_KIND[lower]
  if (byName) return KIND_SPEC[byName]
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  return KIND_SPEC[EXT_KIND[ext] ?? 'unknown']
}
