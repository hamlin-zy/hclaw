/**
 * 窗口主题读取（主进程）
 *
 * 从 createWindow 内联逻辑提取（window.ts 原 203-229 行），供主窗口/独立窗口复用。
 * - backgroundColor：映射后的 light/dark，仅用于 BrowserWindow backgroundColor（防首绘闪白）
 * - rawTheme：原始主题名（经 --hclaw-theme 注入渲染进程）
 */
import {nativeTheme} from 'electron'
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {isDarkTheme, isThemeName, type ThemeName} from '@shared/types'

export interface WindowTheme {
  backgroundColor: 'light' | 'dark'
  rawTheme: ThemeName
}

export function readThemeSetting(): WindowTheme {
  try {
    const settings = systemSettingsRepo.getJson<{ui?: {theme?: string}}>('settings')
    const themeSetting = settings?.ui?.theme
    // 四套主题名 → 按深/浅映射；'system' / 未设置 / 未知值 一律回落到系统偏好
    if (isThemeName(themeSetting)) {
      return {backgroundColor: isDarkTheme(themeSetting) ? 'dark' : 'light', rawTheme: themeSetting}
    }
    const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
    return {backgroundColor: resolved, rawTheme: resolved}
  } catch {
    // SQLite 未就绪 → 默认浅色
    return {backgroundColor: 'light', rawTheme: 'light'}
  }
}
