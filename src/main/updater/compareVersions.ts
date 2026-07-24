/**
 * 轻量级 semver 比较函数。
 *
 * 为什么手写而不引入 `semver` 包？
 *   - 项目当前依赖已 35 个，避免新增 1 个 ~100KB 的依赖
 *   - 只用到了 major/minor/patch 三段比较 + 忽略 build metadata 的能力
 *   - 约 50 行代码，单测可覆盖所有边界情况
 *
 * 设计要点：
 *   - 支持 'v' 前缀（GitHub tag 通常是 `v0.2.87`）
 *   - 忽略 build metadata（`0.2.87+sha.abc` → `0.2.87`）
 *   - 数值比较而非字典序（避免 `0.10.0 < 0.2.0` 的陷阱）
 *   - 不处理 pre-release 标签（pre-release 已被 GitHub `/releases/latest` 端点过滤）
 *
 * @returns 正数表示 a > b，0 表示相等，负数表示 a < b；任一版本无法解析时返回 null
 */
export function compareVersions(a: string, b: string): number | null {
  const parsedA = parseSemver(a)
  const parsedB = parseSemver(b)
  if (!parsedA || !parsedB) return null

  for (let i = 0; i < 3; i++) {
    const diff = parsedA[i] - parsedB[i]
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 将版本字符串解析为 [major, minor, patch] 数字数组。
 * 解析失败（如 `garbage`、`1.0` 缺段）返回 null。
 */
function parseSemver(v: string): number[] | null {
  // 1. 去掉 'v' 前缀
  // 2. 去掉 build metadata（+xxx）
  const cleaned = v.replace(/^v/, '').split('+')[0]
  const parts = cleaned.split('.')
  if (parts.length !== 3) return null

  const nums: (number | null)[] = parts.map((p) => {
    // 空字符串、非数字、负数都视为无效
    if (p === '') return null
    const n = Number(p)
    return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : null
  })

  return nums.every((n): n is number => n !== null) ? nums : null
}