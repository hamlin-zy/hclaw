/**
 * 窗口主题读取（主进程）
 *
 * 从 createWindow 内联逻辑提取（window.ts 原 203-229 行），供主窗口/独立窗口复用。
 * - backgroundColor：映射后的 light/dark，仅用于 BrowserWindow backgroundColor（防首绘闪白）
 * - rawTheme：原始主题名（'light'/'dark'/'yuanshandai'/'shiyangjin'），经 --hclaw-theme 注入渲染进程
 */
import {nativeTheme} from 'electron'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'

export interface ThemeSetting {
  backgroundColor: 'light' | 'dark'
  rawTheme: string
}

export function readThemeSetting(): ThemeSetting {
  try {
    const settings = systemSettingsRepo.getJson<{ui?: {theme?: string}}>('settings')
    const themeSetting = settings?.ui?.theme
    if (themeSetting === 'dark') return {backgroundColor: 'dark', rawTheme: 'dark'}
    if (themeSetting === 'light') return {backgroundColor: 'light', rawTheme: 'light'}
    if (themeSetting === 'yuanshandai') return {backgroundColor: 'dark', rawTheme: 'yuanshandai'}
    if (themeSetting === 'shiyangjin') return {backgroundColor: 'light', rawTheme: 'shiyangjin'}
    const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    return {backgroundColor: resolved, rawTheme: resolved}
  } catch {
    // SQLite 未就绪 → 默认浅色
    return {backgroundColor: 'light', rawTheme: 'light'}
  }
}
