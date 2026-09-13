import {useEffect} from 'react'
import {THEME_NAMES, isThemeName} from '@shared/types'

/** index.html 内联脚本注入的 CSS 变量（与 globals.css 选择器对应，需清除）
 *  唯一权威：任何清除内联变量的地方都必须复用本列表，不得另建副本。
 *  漏一个键 ⇒ 该键的首帧内联值会被 inline 优先级永久钉住，压过 .dark/.yuanshandai */
export const ROOT_CSS_VARS = [
  '--surface', '--surface-muted', '--surface-elevated', '--surface-overlay', '--surface-chrome',
  '--text-primary', '--text-secondary', '--text-muted', '--text-inverse',
  '--border', '--border-muted', '--border-emphasis',
  '--chip-bg', '--chip-border', '--track', '--track-strong',
  '--brand-primary', '--brand-hover', '--brand-muted', '--brand-ink', '--brand-ink-hover',
  '--success', '--warning', '--error', '--info',
]

/** 应用主题：切换 html class + 清除内联 CSS 变量，让 globals.css 选择器接管。
 *  class 名与主题名同构（约定：主题名 === globals.css 的选择器名），
 *  故这里直接遍历 THEME_NAMES —— 新增主题无需再改本函数。'light' 无 class（即 :root 默认） */
export function applyThemeClass(theme: string): void {
  const el = document.documentElement
  el.classList.remove(...THEME_NAMES)
  if (isThemeName(theme) && theme !== 'light') el.classList.add(theme)
  for (const prop of ROOT_CSS_VARS) el.style.removeProperty(prop)
}

/** 独立窗口主题同步 hook：初始应用 + 订阅主进程广播 */
export function useThemeSync(): void {
  useEffect(() => {
    const init = window.electronAPI?.initialTheme
    if (init) applyThemeClass(init)
    return window.electronAPI?.onThemeChanged?.((t) => applyThemeClass(t))
  }, [])
}
