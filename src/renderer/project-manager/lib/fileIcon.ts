// 文件树 / 变更列表 / Commit 详情共用的图标表（spec §6.1）
// 原则：lucide 单色图标；颜色一律走令牌，零新依赖。
//
// 按类别着色（IDEA 式）：颜色落在 **13px 图标 + 文件名** 两处，两者同色同源（--ft-*）。
// 类别色是「文字级」令牌：四主题各一份字面值，在 surface / surface-muted /
// surface-elevated / 选中层上均 ≥4.5:1（审计：`npm run audit:contrast` 的 INK_TOKENS）。
// config / unknown 不着色，退回 --text-secondary（图标）与正文色（文件名）。
// 目录图标不在此列，见 --icon-folder。
import {Braces, File, FileCode, FileImage, FileText, FileType, FlaskConical, Folder, FolderOpen, Settings} from 'lucide-react'
import type {LucideIcon} from 'lucide-react'

type FileIconKind = 'code' | 'test' | 'style' | 'markup' | 'data' | 'image' | 'config' | 'unknown'

interface FileIconSpec {
  Icon: LucideIcon
  /** CSS 颜色令牌，形如 `var(--ft-code)` */
  color: string
}

/** 类别 → 图标 + 颜色令牌（spec §6.1 表） */
export const KIND_SPEC: Record<FileIconKind, FileIconSpec> = {
  code:    {Icon: FileCode,    color: 'var(--ft-code)'},
  test:    {Icon: FlaskConical, color: 'var(--ft-test)'},
  style:   {Icon: FileType,    color: 'var(--ft-style)'},
  markup:  {Icon: FileText,    color: 'var(--ft-markup)'},
  data:    {Icon: Braces,      color: 'var(--ft-data)'},
  image:   {Icon: FileImage,   color: 'var(--ft-image)'},
  config:  {Icon: Settings,    color: 'var(--text-secondary)'},
  unknown: {Icon: File,        color: 'var(--text-secondary)'},
}

/**
 * 类别 → 文件名着色类（`.pm-ft--*`，与上面图标同色）。
 * config / unknown 返回空串：文件名保持正文色，不参与着色。
 * 注意：这些类必须与 `.pm-file-name` 同时挂在标签上（见 globals.css 的同特异性顺序约定）。
 */
const KIND_NAME_CLASS: Record<FileIconKind, string> = {
  code: 'pm-ft--code',
  test: 'pm-ft--test',
  style: 'pm-ft--style',
  markup: 'pm-ft--markup',
  data: 'pm-ft--data',
  image: 'pm-ft--image',
  config: '',
  unknown: '',
}


/** 扩展名（小写，不含点）→ 类别 */
const EXT_KIND: Record<string, FileIconKind> = {
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  py: 'code', go: 'code', rs: 'code', java: 'code',
  css: 'style', scss: 'style', less: 'style',
  md: 'markup', mdx: 'markup', txt: 'markup', rst: 'markup',
  json: 'data', yaml: 'data', yml: 'data', toml: 'data', xml: 'data',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image',
}

/** 无扩展名的点文件按完整文件名精确匹配 */
const NAME_KIND: Record<string, FileIconKind> = {
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
  return KIND_SPEC[fileKind(name)]
}

/** 测试文件（IDEA 式绿色）：`foo.test.tsx` / `foo.spec.mjs` 这类中缀命名。 */
const TEST_INFIX = /\.(test|spec)\.[^.]+$/

/** 文件名 → 类别。先按完整文件名匹配点文件，再退回扩展名，最后 unknown。 */
export function fileKind(name: string): FileIconKind {
  const lower = name.toLowerCase()
  const byName = NAME_KIND[lower]
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  const ext = dot > 0 ? lower.slice(dot + 1) : ''
  const kind = EXT_KIND[ext] ?? 'unknown'
  // 测试文件只在代码类里细分（.test.tsx 等），其余类别原样返回
  return kind === 'code' && TEST_INFIX.test(lower) ? 'test' : kind
}

/** 文件名 → 着色类（`.pm-ft--*`）；不着色的类别返回空串。 */
export function fileKindClass(name: string): string {
  return KIND_NAME_CLASS[fileKind(name)]
}
