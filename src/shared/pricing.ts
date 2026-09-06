/** 模型价格纯函数（USD/token 存储 ↔ $/1M 录入换算） */

/** USD/token 存储下的 4 维价格（缺省 = 未配置） */
export interface ModelPricing {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  /**
   * 录入真相（录入即真，WYSIWYG）：用户实际录入的币种与数值快照。
   * 回显优先逐字使用 entered（不随汇率漂移）；USD/token 4 字段仍是保存时
   * 按「录入值 ÷ 汇率」固化的快照，供用量成本计算消费（语义不变）。
   * 旧数据（无 entered）继续按 USD/token × 汇率折算展示（向后兼容）。
   */
  entered?: {
    currency: Currency
    values: Partial<Record<'input' | 'output' | 'cacheRead' | 'cacheWrite', number>>
  }
}

export type Currency = 'USD' | 'CNY'

export const USD_PER_MILLION = 1_000_000

/** $/1M → USD/token */
export function perMtoToken(v: number): number {
  return v / USD_PER_MILLION
}

/** USD/token → $/1M */
export function tokenToPerM(v: number): number {
  return v * USD_PER_MILLION
}
