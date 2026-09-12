/**
 * 工作区根 + 工作区相对路径 → 绝对路径。
 * 连接符恒为 '/'（与 data-path / statusMap 的 POSIX 相对路径域一致）；
 * 根目录/空相对路径返回去除尾分隔符的工作区根。
 */
export function absPath(workspace: string, relPath: string): string {
  const root = workspace.replace(/[\\/]+$/, '')
  if (relPath === '' || relPath === '.') return root
  return `${root}/${relPath}`
}
