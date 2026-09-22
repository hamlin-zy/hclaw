// 官网时间线数据源：单一真相为仓库根 CHANGELOG.json（与升级弹窗共用）
// 命名沿用官网「时间线」组件（components/Timeline.astro）；字段形状与主程序 shared/types/updater.ts 的 ChangelogEntry 一致
import changelogData from '../../../CHANGELOG.json'

export interface TimelineItem {
  version: string
  date: string
  tag?: string
  title: string
  items: string[]
}

export const timelineItems: TimelineItem[] = changelogData as TimelineItem[]
