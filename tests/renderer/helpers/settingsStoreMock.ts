import {vi} from 'vitest'

/**
 * zustand store 的最小可用 mock：既可当 hook 调用（支持 selector 订阅），也带 `getState`。
 * 沿用 ScheduleEditModal.capability.test.tsx 的既有模式，供设置页各 Tab 的直渲染测试复用。
 */
export function mockZustandStore(getState: () => Record<string, unknown>) {
    const hook = (selector?: (s: Record<string, unknown>) => unknown) => {
        const s = getState()
        return selector ? selector(s) : s
    }
    return Object.assign(hook, {getState})
}

/** 设置页 Tab 测试共用的 electronAPI stub（目录读取 / 背景列表 / 主题 class 三通道） */
export function stubElectronAPI() {
    vi.stubGlobal('electronAPI', {
        configGetHclawDir: vi.fn().mockResolvedValue(''),
        backgroundList: vi.fn().mockResolvedValue([]),
        applyThemeClass: vi.fn(),
    })
}
