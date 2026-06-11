/**
 * 显示模式相关工具函数
 */

/** 显示模式类型 */
export type DisplayMode = 'detailed' | 'compact' | 'ultra-compact'

/**
 * 是否为紧凑模式（compact 或 ultra-compact）
 */
export function isCompactMode(mode: DisplayMode): boolean {
    return mode === 'compact' || mode === 'ultra-compact'
}

/**
 * 是否为超紧凑模式
 */
export function isUltraCompactMode(mode: DisplayMode): boolean {
    return mode === 'ultra-compact'
}

/**
 * 是否为详细模式
 */
export function isDetailedMode(mode: DisplayMode): boolean {
    return mode === 'detailed'
}