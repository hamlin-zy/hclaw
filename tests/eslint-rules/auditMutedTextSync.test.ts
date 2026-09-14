import { describe, it, expect } from 'vitest'
import { SMALL_SIZE } from '../../eslint-rules/muted-text-informative'
import { SMALL_SIZES } from '../../scripts/audit-muted-text.mjs'

/**
 * 钉住「审计脚本 vs ESLint 规则」的小字号常量口径。
 *
 * ⚠️ 断言 b 描述的是**有意差异，不是缺陷**：
 *   - ESLint 规则 muted-text/informative 的 `SMALL_SIZE` 额外匹配 `text-[<=13px]`
 *     （正则字面量，见 eslint-rules/muted-text-informative.ts 头部注释）；
 *   - 审计脚本 scripts/audit-muted-text.mjs 的 `SMALL_SIZES` 只认具名字号
 *     text-xs/sm/base，text-[Npx] 一律记 UNKNOWN。
 *
 * 若任一侧口径被单方面修改，此测试即红——改动前请先对齐两侧，再同步更新本测试。
 */
describe('audit-muted-text ↔ muted-text-informative 小字号口径同步', () => {
  it('a. 具名字号 xs/sm/base 两侧一致认同', () => {
    for (const size of ['text-xs', 'text-sm', 'text-base']) {
      expect(SMALL_SIZE.test(size)).toBe(true)
      expect(SMALL_SIZES.has(size)).toBe(true)
    }
  })

  it('b. 已文档化差异：规则认 text-[<=13px]，脚本不认', () => {
    for (const size of ['text-[13px]', 'text-[11px]', 'text-[12.5px]']) {
      expect(SMALL_SIZE.test(size)).toBe(true)
      expect(SMALL_SIZES.has(size)).toBe(false)
    }
  })

  it('c. 大字号两侧都不认', () => {
    for (const size of ['text-lg', 'text-[14px]']) {
      expect(SMALL_SIZE.test(size)).toBe(false)
      expect(SMALL_SIZES.has(size)).toBe(false)
    }
  })
})
