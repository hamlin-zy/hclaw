/**
 * 主题标识 — 唯一权威
 *
 * 四套视觉世界（与 globals.css 的 4 个主题块一一对应）+ 设置层的 'system'。
 *
 * 不要在别处再手写这份联合类型。主题名散成多份时，新增一套主题必然漏改某处，
 * 症状与 `--surface-chrome` 事故同类：类型检查通过，但某个窗口静默停在旧主题。
 */

/** 四套视觉世界（顺序即 Ctrl+Shift+T 之类循环切换的顺序） */
export const THEME_NAMES = ['light', 'dark', 'yuanshandai', 'shiyangjin'] as const

export type ThemeName = (typeof THEME_NAMES)[number]

/** 设置层可选值：多一个 'system'（跟随系统） */
export const THEME_SETTINGS = [...THEME_NAMES, 'system'] as const

export type ThemeSetting = (typeof THEME_SETTINGS)[number]

/** 深色系主题：决定 titleBarOverlay、毛玻璃透明度区间、Markdown 代码高亮等分支 */
export const DARK_THEMES: readonly ThemeName[] = ['dark', 'yuanshandai']

/** 运行时收窄：值来自 localStorage / IPC / 用户输入时用它，别写 `=== 'dark' || === 'light' || …` 长串 */
export function isThemeName(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEME_NAMES as readonly string[]).includes(v)
}

/** 是否深色系（含远山黛） */
export function isDarkTheme(v: string): boolean {
  return (DARK_THEMES as readonly string[]).includes(v)
}
