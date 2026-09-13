/**
 * 交接阈值统一解析（纯函数，零 electron/node 依赖）
 *
 * 全应用唯一入口：loop 级溢出门（execute.ts）与发送前引导（InputArea）一律经此取值，
 * 消费「token 阈值」，不再各自复刻「按比例 / 按窗口大小」的分支逻辑。
 * 返回 0 = 关闭（ratio=0 为跨模式全局关闭哨兵）。
 */
import type {SystemSettings} from './types/settings'

export const DEFAULT_HANDOFF_THRESHOLD_TOKENS = 200_000
export const MIN_HANDOFF_THRESHOLD_TOKENS = 50_000

type HandoffAgentSettings = Pick<
  SystemSettings['agent'],
  'handoffThresholdRatio' | 'handoffThresholdMode' | 'handoffThresholdTokens'
>

/**
 * 解析交接触发的 token 阈值。
 * - ratio=0 → 0（关闭，无视模式）
 * - mode='tokens' → 配置的固定 token 数（下限 50K 运行时兜底）
 * - mode='ratio'（默认）→ ratio × 当前模型窗口
 */
export function resolveHandoffThresholdTokens(
  agent: HandoffAgentSettings | undefined,
  windowTokens: number,
): number {
  const ratio = agent?.handoffThresholdRatio ?? 0.5
  if (!(ratio > 0)) return 0 // 0 = 关闭 loop 级保护（用户自担超窗风险）
  if ((agent?.handoffThresholdMode ?? 'ratio') === 'tokens') {
    const tokens = agent?.handoffThresholdTokens ?? DEFAULT_HANDOFF_THRESHOLD_TOKENS
    return tokens > 0 ? Math.max(MIN_HANDOFF_THRESHOLD_TOKENS, tokens) : 0
  }
  return ratio * windowTokens
}
