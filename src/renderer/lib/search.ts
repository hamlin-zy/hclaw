/**
 * 通用模糊搜索工具
 *
 * 所有搜索组件统一使用此模块，避免重复的 includes 样板代码。
 * 支持：
 *   - 模糊子序列匹配（codesim → code-simplifier）
 *   - 大小写不敏感
 *   - 数组字段（tags）自动展开匹配
 *   - 可选/嵌套字段安全处理
 *   - 按相关度评分排序
 */

// ─── 评分常量 ─────────────────────────────────────────
export const SEARCH_RANK = {
    NAME_PREFIX: 100,     // 名称前缀匹配
    NAME_SUBSTRING: 80,   // 名称包含匹配
    NAME_FUZZY: 60,       // 名称模糊子序列匹配
    DESC_PREFIX: 50,      // 描述前缀匹配
    DESC_SUBSTRING: 30,   // 描述包含匹配
    DESC_FUZZY: 10,       // 描述模糊子序列匹配
} as const

// ─── 工具函数 ─────────────────────────────────────────

/**
 * 模糊子序列匹配：检查 query 所有字符是否按顺序出现在 target 中
 *
 * ```ts
 * fuzzyMatch("codesim", "code-simplifier") // true — 字符按序存在
 * fuzzyMatch("csim",   "code-simplifier")  // true
 * fuzzyMatch("cxsim",  "code-simplifier")  // false
 * fuzzyMatch("sim",    "code-simplifier")  // true
 * ```
 */
export function fuzzyMatch(query: string, target: string): boolean {
  if (!query) return true
  if (!target) return false

  const q = query.toLowerCase()
  const t = target.toLowerCase()
  let qi = 0

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++
  }

  return qi === q.length
}

/**
 * 计算单个文本的搜索评分
 * @param text 待匹配文本
 * @param query 搜索词
 * @returns 评分分数（0 表示不匹配）
 */
export function calcSearchScore(text: string, query: string): number {
    if (!query.trim() || !text) return 0
    const t = text.toLowerCase()
    const q = query.toLowerCase().trim()

    if (t.startsWith(q)) return SEARCH_RANK.NAME_PREFIX
    if (t.includes(q)) return SEARCH_RANK.NAME_SUBSTRING
    if (fuzzyMatch(q, t)) return SEARCH_RANK.NAME_FUZZY
    return 0
}

/**
 * 通用模糊过滤
 *
 * @param items  要过滤的对象数组
 * @param query  搜索词（空字符串/空白字符串返回原数组）
 * @param keys   要搜索的字段名数组（自动处理 null/undefined/数组）
 *
 * ```ts
 * fuzzyFilter(skills, "codesim", ["name", "description"])
 * fuzzyFilter(commands, "git", ["name", "description", "content", "tags"])
 * ```
 */
export function fuzzyFilter<T extends Record<string, any>>(
  items: T[],
  query: string,
  keys: (keyof T)[],
): T[] {
  if (!query.trim()) return items

  const q = query.trim()

  return items.filter(item =>
    keys.some(key => {
      const value = item[key]
      if (value == null) return false
      if (Array.isArray(value)) {
        return value.some((v: unknown) => fuzzyMatch(q, String(v)))
      }
      return fuzzyMatch(q, String(value))
    }),
  )
}

/**
 * 模糊过滤 + 相关度排序
 *
 * 对每个字段进行评分，取最高分作为 item 的最终评分，按评分降序排列。
 * 用于搜索框的排序匹配（如 CommandList、CapabilityPicker）。
 *
 * @param items  要过滤的对象数组
 * @param query  搜索词（空字符串返回原数组）
 * @param keys   要搜索的字段名数组，格式为 [字段名, 基础分数倍率] 或直接字段名
 *               字段名不带倍率时默认 NAME 字段用 SEARCH_RANK.NAME_*，其他用 SEARCH_RANK.DESC_*
 *
 * ```ts
 * // 基础用法：名称用 NAME 权重，描述用 DESC 权重
 * fuzzyFilterWithRank(commands, "git", ["name", "description"])
 *
 * // 指定权重倍率
 * fuzzyFilterWithRank(skills, "code", [["name", 2], ["tags", 1.5], ["description", 1]])
 * ```
 */
export function fuzzyFilterWithRank<T extends Record<string, any>>(
  items: T[],
  query: string,
  keys: (keyof T | [keyof T, number])[],
): { item: T; score: number }[] {
  if (!query.trim()) return items.map(item => ({ item, score: 0 }))

  const results: { item: T; score: number }[] = []

  for (const item of items) {
    let bestScore = 0

    for (const keyInfo of keys) {
      // 解析字段配置
      const [key, multiplier = key === 'name' ? 1 : 0.5] = Array.isArray(keyInfo)
        ? keyInfo as [keyof T, number]
        : [keyInfo as keyof T, keyInfo === 'name' ? 1 : 0.5]

      const value = item[key]
      if (value == null) continue

      // 处理数组字段
      const textArray: string[] = Array.isArray(value)
        ? value.map(String)
        : [String(value)]

      for (const text of textArray) {
        const score = calcSearchScore(text, query)
        if (score > 0) {
          const finalScore = score * multiplier
          if (finalScore > bestScore) {
            bestScore = finalScore
          }
        }
      }
    }

    if (bestScore > 0) {
      results.push({ item, score: bestScore })
    }
  }

  // 按评分降序排列
  return results.sort((a, b) => b.score - a.score)
}
