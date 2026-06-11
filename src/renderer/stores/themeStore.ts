import {create} from 'zustand'
import {useSettingsStore} from './settingsStore'

interface ThemeStore {
    theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin'
    toggleTheme: () => void
    setTheme: (theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin') => void
}

const THEME_CACHE_KEY = 'hclaw-theme'

/** 从 electronAPI.initialTheme 或 localStorage 获取初始主题（与 index.html 内联脚本保持同步） */
function getInitialTheme(): 'light' | 'dark' | 'yuanshandai' | 'shiyangjin' {
    try {
        const fromMain = window.electronAPI?.initialTheme
        if (fromMain === 'dark' || fromMain === 'light' || fromMain === 'yuanshandai' || fromMain === 'shiyangjin') return fromMain
    } catch { /* 安全兜底 */ }
    try {
        const cached = localStorage.getItem(THEME_CACHE_KEY)
        if (cached === 'dark' || cached === 'light' || cached === 'yuanshandai' || cached === 'shiyangjin') return cached
    } catch { /* 安全兜底 */ }
    return 'light'
}

/** 解析原始主题值（处理 'system' 模式）并应用到 themeStore */
export function resolveAndApplyTheme(theme: string): void {
    const resolved = theme === 'system'
        ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : theme
    // resolved 在 'system' 分支下返回字面量，否则就是 theme 本身
    // 运行时确保只传入有效值
    useThemeStore.getState().setTheme(resolved as ThemeStore['theme'])
}

/** localStorage 同步缓存，防止启动时主题闪烁 */
export function syncThemeToCache(theme: 'light' | 'dark' | 'yuanshandai' | 'shiyangjin'): void {
    try {
        localStorage.setItem(THEME_CACHE_KEY, theme)
    } catch { /* 安全兜底 */
    }
}

export const useThemeStore = create<ThemeStore>()((set, get) => ({
    theme: getInitialTheme(),
    toggleTheme: () => {
        // 循环切换：light → dark → yuanshandai → shiyangjin → light
        const themes: ThemeStore['theme'][] = ['light', 'dark', 'yuanshandai', 'shiyangjin']
        const current = get().theme
        const nextIndex = (themes.indexOf(current) + 1) % themes.length
        const newTheme = themes[nextIndex]
        set({theme: newTheme})
        syncThemeToCache(newTheme)

        // 持久化到 SQLite settings
        const {settings} = useSettingsStore.getState()
        useSettingsStore.getState().updateSettings({
            ui: {theme: newTheme, language: settings.ui.language}
        })
    },
    setTheme: (theme) => {
        set({theme})
        syncThemeToCache(theme)
    },
}))
