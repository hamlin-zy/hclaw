import {create} from 'zustand'
import {useSettingsStore} from './settingsStore'
import {THEME_NAMES, isThemeName, type ThemeName} from '@shared/types'

interface ThemeStore {
    theme: ThemeName
    toggleTheme: () => void
    setTheme: (theme: ThemeName) => void
}

const THEME_CACHE_KEY = 'hclaw-theme'

/** 从 electronAPI.initialTheme 或 localStorage 获取初始主题（与 index.html 内联脚本保持同步） */
function getInitialTheme(): ThemeName {
    try {
        const fromMain = window.electronAPI?.initialTheme
        if (isThemeName(fromMain)) return fromMain
    } catch { /* 安全兜底 */ }
    try {
        const cached = localStorage.getItem(THEME_CACHE_KEY)
        if (isThemeName(cached)) return cached
    } catch { /* 安全兜底 */ }
    return 'light'
}

/** 解析原始主题值（处理 'system' 模式）并应用到 themeStore */
export function resolveAndApplyTheme(theme: string): void {
    let resolved = theme
    if (theme === 'system') {
        // 图片背景启用时 system 强制解析为深色：
        // 浅色白色毛玻璃叠在背景图上会变白雾，浅色系主题在背景开启时被禁用。
        const bgEnabled = useSettingsStore.getState().settings.ui.background?.enabled
        resolved = (bgEnabled || window.matchMedia?.('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light'
    }
    // 运行时确保只传入有效值
    useThemeStore.getState().setTheme(resolved as ThemeStore['theme'])
}

/** localStorage 同步缓存，防止启动时主题闪烁 */
export function syncThemeToCache(theme: ThemeName): void {
    try {
        localStorage.setItem(THEME_CACHE_KEY, theme)
    } catch { /* 安全兜底 */
    }
}

export const useThemeStore = create<ThemeStore>()((set, get) => ({
    theme: getInitialTheme(),
    toggleTheme: () => {
        // 循环切换：light → dark → yuanshandai → shiyangjin → light（顺序取自 THEME_NAMES）
        const current = get().theme
        let nextIndex = (THEME_NAMES.indexOf(current) + 1) % THEME_NAMES.length
        // 图片背景开启时跳过浅色系主题（浅色白色毛玻璃叠在背景图上变白雾）
        const {settings} = useSettingsStore.getState()
        if (settings.ui.background?.enabled) {
            while (nextIndex !== THEME_NAMES.indexOf(current) &&
                   (THEME_NAMES[nextIndex] === 'light' || THEME_NAMES[nextIndex] === 'shiyangjin')) {
                nextIndex = (nextIndex + 1) % THEME_NAMES.length
            }
        }
        const newTheme = THEME_NAMES[nextIndex]
        set({theme: newTheme})
        syncThemeToCache(newTheme)

        // 持久化到 SQLite settings
        useSettingsStore.getState().updateSettings({
            ui: {theme: newTheme}
        })
    },
    setTheme: (theme) => {
        set({theme})
        syncThemeToCache(theme)
    },
}))
