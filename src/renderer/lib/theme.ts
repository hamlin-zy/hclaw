import {useEffect} from 'react'

/** index.html 内联脚本注入的 CSS 变量（与 globals.css 选择器对应，需清除） */
const ROOT_CSS_VARS = [
  '--surface', '--surface-muted', '--surface-elevated', '--surface-overlay',
  '--text-primary', '--text-secondary', '--text-muted', '--text-inverse',
  '--border', '--border-muted', '--border-emphasis',
  '--brand-primary', '--brand-hover', '--brand-muted',
  '--success', '--warning', '--error', '--info',
]

/** 应用主题：切换 html class + 清除内联 CSS 变量，让 globals.css 选择器接管 */
export function applyThemeClass(theme: string): void {
  const el = document.documentElement
  el.classList.remove('dark', 'yuanshandai', 'shiyangjin')
  if (theme === 'dark') el.classList.add('dark')
  else if (theme === 'yuanshandai') el.classList.add('yuanshandai')
  else if (theme === 'shiyangjin') el.classList.add('shiyangjin')
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
