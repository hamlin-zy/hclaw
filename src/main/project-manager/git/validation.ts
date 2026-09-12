// IPC 边界 ref/hash 校验：防止注入恶意参数

/** hash 格式：4-64 位十六进制字符 */
export function isValidHash(hash: string): boolean {
  return /^[0-9a-fA-F]{4,64}$/.test(hash)
}

/** ref/branch：禁止前导 `-`，只允许安全字符（字母数字 / . _ - / + ^ { } ~），不含空白 */
export function isValidRef(ref: string): boolean {
  if (!ref || ref.startsWith('-')) return false
  return /^[a-zA-Z0-9._\-/+^{}~]+$/.test(ref)
}

export function assertValidHash(hash: string): void {
  if (!isValidHash(hash)) throw new Error(`无效的 commit hash: ${hash}`)
}

export function assertValidRef(ref: string): void {
  if (!isValidRef(ref)) throw new Error(`无效的 git ref: ${ref}`)
}
