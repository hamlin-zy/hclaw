/**
 * @joplin/turndown-plugin-gfm 类型声明
 *
 * 该包未随包发布 .d.ts（files 仅含 lib/dist），此处补充最小可用声明。
 */
declare module '@joplin/turndown-plugin-gfm' {
  import type TurndownService from 'turndown'

  /** GFM 全量插件（表格 / 删除线 / 任务列表 / 高亮代码块） */
  export const gfm: TurndownService.Plugin
  export const tables: TurndownService.Plugin
  export const strikethrough: TurndownService.Plugin
  export const taskListItems: TurndownService.Plugin
  export const highlightedCodeBlock: TurndownService.Plugin
}
