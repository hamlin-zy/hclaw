/**
 * 变更日志展示工具 — 更新通知弹窗（UpdateNoticeDialog）与关于页（AboutDialog）共用。
 *
 * 抽出原因：两处的「跨 N 个版本」文案与「首条 / 余项」切分逻辑必须逐字一致，
 * 此前各写一份，任一处改动都会漂移。
 */
import type { ChangelogEntry } from '../../shared/types/updater'

/**
 * 跨版本升级文案：仅当跨越 >1 个版本时返回，否则返回 null
 * （调用方回退为单版本号展示）。latestVersion 允许缺省以保持原模板字面量行为。
 */
export function formatVersionRange(
  currentVersion: string,
  latestVersion: string | undefined,
  entryCount: number
): string | null {
  if (entryCount <= 1) return null
  return `v${currentVersion} → v${latestVersion} · 跨越 ${entryCount} 个版本`
}

/**
 * 切分变更日志：latest 为最新条目（默认展开展示），older 为更早版本（折叠区）。
 * changelog 为空时 latest 为 undefined（调用方据此不渲染展示区）。
 */
export function splitChangelog(changelog: ChangelogEntry[]): {
  latest: ChangelogEntry | undefined
  older: ChangelogEntry[]
} {
  return { latest: changelog[0], older: changelog.slice(1) }
}
