/**
 * 颜色工具函数 — Hex/HSL 转换、品牌色派生
 */

/** Hex → { h, s, l } */
export function hexToHsl(hex: string): { h: number; s: number; l: number } {
    let r = 0, g = 0, b = 0
    const clean = hex.replace('#', '')
    if (clean.length === 3) {
        r = parseInt(clean[0] + clean[0], 16) / 255
        g = parseInt(clean[1] + clean[1], 16) / 255
        b = parseInt(clean[2] + clean[2], 16) / 255
    } else if (clean.length === 6) {
        r = parseInt(clean.slice(0, 2), 16) / 255
        g = parseInt(clean.slice(2, 4), 16) / 255
        b = parseInt(clean.slice(4, 6), 16) / 255
    }
    const max = Math.max(r, g, b), min = Math.min(r, g, b)
    let h = 0, s = 0, l = (max + min) / 2
    if (max !== min) {
        const d = max - min
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
        switch (max) {
            case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break
            case g: h = ((b - r) / d + 2) / 6; break
            case b: h = ((r - g) / d + 4) / 6; break
        }
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) }
}

/** { h, s, l } → Hex */
export function hslToHex(h: number, s: number, l: number): string {
    s /= 100; l /= 100
    const a = s * Math.min(l, 1 - l)
    const f = (n: number) => {
        const k = (n + h / 30) % 12
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
        return Math.round(255 * color).toString(16).padStart(2, '0')
    }
    return `#${f(0)}${f(8)}${f(4)}`
}

/** Hex → rgba 字符串 */
export function hexToRgba(hex: string, alpha: number): string {
    const clean = hex.replace('#', '')
    const r = parseInt(clean.slice(0, 2), 16)
    const g = parseInt(clean.slice(2, 4), 16)
    const b = parseInt(clean.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/** 从主色派生完整的品牌色变量键值对 */
export interface BrandColors {
    '--brand-primary': string
    '--brand-hover': string
    '--brand-muted': string
    '--glow-subtle': string
    '--glow-active': string
}

/** verify that a color is dark (is used in dark themes) */
export function isDarkColor(hex: string): boolean {
    const { l } = hexToHsl(hex)
    return l < 50
}

export function deriveBrandColors(hex: string): BrandColors {
    const { h, s, l } = hexToHsl(hex)

    // hover: 暗色主题提亮 12%，浅色主题压暗 8%
    const hoverL = l < 40 ? Math.min(l + 12, 95) : Math.max(l - 8, 8)
    const hover = hslToHex(h, s, hoverL)

    return {
        '--brand-primary': hex,
        '--brand-hover': hover,
        '--brand-muted': hexToRgba(hex, 0.12),
        '--glow-subtle': hexToRgba(hex, 0.25),
        '--glow-active': hexToRgba(hex, 0.40),
    }
}
