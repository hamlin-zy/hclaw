/**
 * 工作区根 + 工作区相对路径 → 绝对路径（OS 原生分隔符）。
 * 内部 data-path / statusMap 使用 POSIX 相对路径域（'/'）；
 * 拼接时检测 workspace 的分隔符风格，relPath 跟随统一：
 * - Windows workspace（含 '\\'）→ 输出全 '\\'
 * - POSIX workspace → 输出全 '/'
 * 根目录/空相对路径返回去除尾分隔符的工作区根。
 */
export function absPath(workspace: string, relPath: string): string {
  const root = workspace.replace(/[\\/]+$/, '')
  if (relPath === '' || relPath === '.') return root
  const sep = root.includes('\\') ? '\\' : '/'
  return root + sep + relPath.replace(/\//g, sep)
}
