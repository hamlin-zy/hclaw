/** 模型价格纯函数（USD/token 存储 ↔ $/1M 录入换算） */

/** USD/token 存储下的 4 维价格（缺省 = 未配置） */
export interface ModelPricing {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
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
