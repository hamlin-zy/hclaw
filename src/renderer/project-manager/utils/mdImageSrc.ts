import {toMediaUrl} from '../../utils/mediaUrl'

/**
 * 把 Markdown 图片 src 解析为渲染进程可直接加载的 URL。
 *
 * 为什么要保留「相对于 md 文件目录」的语义：
 * CommonMark / 各类 markdown 渲染器的惯例就是相对路径相对当前文档所在目录解析，
 * `README.md` 里的 `![x](images/home_sample.png)` 指的是与 README 同级的 images 目录。
 * 而 pm 窗口的预览器拿不到这个语义 —— 浏览器会把相对 src 按 `projectManager.html`
 * 所在 URL 解析，dev 下落到 `http://localhost:5173/images/...`、prod 下落到
 * `dist/renderer/.../images/...`，全是 404。因此这里显式用 basePath（当前 md 文件
 * 的绝对路径）的目录部分补全相对路径。
 *
 * 本地文件最终交给 `toMediaUrl` 转成 `hclaw-media://`（主进程已注册特权协议，
 * 且 CSP 已放行），渲染进程无法直接加载 `file://` 或裸盘符路径。
 *
 * 纯函数、无副作用、不依赖 Node `path`（渲染进程不可用），Windows/POSIX 分隔符都处理。
 */

/** 判定「已带 scheme」，如 data: / http: / https: / blob: / file: / hclaw-media: */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+\-]*:/
/** Windows 绝对路径，如 C:\ 或 C:/ */
const WINDOWS_ABS_RE = /^[a-zA-Z]:[\\/]/

/**
 * 结掉本地路径上的 ?query / #hash。
 * 本地文件走 hclaw-media://，query/hash 无意义且会被当成文件名一部分；远程 URL 不在此处理。
 */
function stripQueryHash(src: string): string {
  return src.split(/[?#]/)[0]
}

/** 本地绝对路径：Windows 盘符（`C:\` / `C:/`）、POSIX 根（`/`）、UNC（`\\server`） */
function isAbsoluteLocalPath(p: string): boolean {
  return WINDOWS_ABS_RE.test(p) || p.startsWith('/') || p.startsWith('\\\\')
}

/**
 * 把相对路径 rel 解析到绝对文件 baseFile 所在目录下，并规范化 `.` / `..`。
 * `..` 到达根（盘符或 POSIX 根）后钳制，不回退。
 */
function resolveAgainstBase(baseFile: string, rel: string): string {
  const normalizedBase = baseFile.replace(/\\/g, '/')
  const slash = normalizedBase.lastIndexOf('/')
  const dir = slash >= 0 ? normalizedBase.slice(0, slash) : ''
  const relNormalized = rel.replace(/\\/g, '/')
  const combined = dir ? `${dir}/${relNormalized}` : relNormalized

  // 锚点：Windows 盘符 / POSIX 根。锚点段不参与 `..` 回退，作为钳制边界。
  const drive = /^([a-zA-Z]:)(?=\/|$)/.exec(combined)
  const anchored = drive !== null || combined.startsWith('/')
  const rest = drive ? combined.slice(drive[1].length) : combined

  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (!anchored) {
        // 没有锚点（纯相对）时保留 ..；有锚点说明已到根，钳制忽略
        out.push('..')
      }
      continue
    }
    out.push(seg)
  }

  const tail = out.join('/')
  if (drive) return out.length ? `${drive[1]}/${tail}` : `${drive[1]}/`
  if (combined.startsWith('/')) return `/${tail}`
  return tail
}

/**
 * 把 tab 的 `filePath` 归一化成绝对路径。
 *
 * 为什么需要这一步（实测结论，别被 `filePath` 这个名字骗了）：
 * pm 窗口的 `EditorTabState.filePath` 是**工作区相对路径**，不是绝对路径。
 *   fileSystem.ts:126  DirEntry.path = prefix + item.name   （如 `docs/README.md`）
 *   FileTree.tsx:163   openFileTab(toOpenFileTabInput(e.path, ...))
 *   editorTabStore.ts:58  filePath: input.path
 * 整条链没有任何环节把它转成绝对路径。若拿这种相对路径当 basePath，
 * `resolveAgainstBase` 只能算出 `docs/images/a.png` 这样的**相对**结果，
 * 交给浏览器依然 404 —— 修复等于没做。所以必须显式拼上工作区根。
 *
 * @param filePath      tab 里的 filePath（相对或绝对）
 * @param workspacePath 工作区根（绝对路径，workspaceStore 提供）
 * @returns 绝对路径；无法确定（filePath 为空 / 无工作区根）时返回 ''
 */
export function toAbsoluteFilePath(filePath: string, workspacePath: string): string {
  if (!filePath) return ''
  // 已是绝对路径（Windows 盘符 / POSIX 根 / UNC）→ 原样返回
  if (isAbsoluteLocalPath(filePath)) return filePath
  if (!workspacePath) return ''
  return `${workspacePath.replace(/[\\/]+$/, '')}/${filePath.replace(/^[\\/]+/, '')}`
}

/**
 * 解析 Markdown 图片 src。
 *
 * @param src      图片原始 src
 * @param basePath 当前 md 文件的**绝对路径**（如 `E:\ws\docs\README.md`），
 *                 由 `toAbsoluteFilePath(filePath, workspacePath)` 得到
 */
export function resolveMarkdownImageSrc(src: string, basePath?: string): string {
  if (!src) return ''

  // 协议相对 URL（//host/path）必须**直接原样返回**，不能过 toMediaUrl：
  // 后者用 startsWith('/') 判 POSIX 绝对路径，会把 `//cdn/a.png` 拼成
  // `hclaw-media:////cdn/a.png` 而彻底失效。留给浏览器按当前协议（https）解析即可。
  if (src.startsWith('//')) return src

  // 已带 scheme / 纯锚点 # → 不参与本地路径拼接，交给 toMediaUrl 原样放行
  if (SCHEME_RE.test(src) || src.startsWith('#')) {
    return toMediaUrl(src)
  }

  // 绝对本地路径 → 直接转换（`//host/path` 已在上面原样返回）
  if (isAbsoluteLocalPath(src)) {
    return toMediaUrl(stripQueryHash(src))
  }

  // 相对路径：有 basePath 就按 md 文件所在目录补全，否则退化为原行为（不破坏既有调用）
  const clean = stripQueryHash(src)
  if (!basePath) return toMediaUrl(clean)
  return toMediaUrl(resolveAgainstBase(basePath, clean))
}
