/** 启动时机：before = 所有能力加载前，after = HClaw 完全就绪后 */
export type LaunchTiming = 'before' | 'after'

/** 单个跟随启动项 */
export interface CompanionApp {
    /** 唯一 ID，由 name 派生（hash，与 mcpConfig 同策略），新增时由主进程生成并回传 */
    id: string
    /** 显示名称（来自 .lnk 的 BaseName 或用户输入） */
    name: string
    /** 可执行文件完整路径 */
    exePath: string
    /** 启动参数 */
    args: string[]
    /** 进程名（用于检测是否已运行，如 "Obsidian.exe"） */
    processName: string
    launchTiming: LaunchTiming
    /** 是否等待应用就绪后再继续（仅 before 项有意义） */
    waitForReady: boolean
    /** 等待超时（毫秒），默认 10000 */
    waitTimeoutMs?: number
    /** 是否启用（false = 跳过，不删除配置） */
    enabled: boolean
}

/** 配置文件根结构（~/.hclaw/companion-apps.json） */
export interface CompanionAppsConfig {
    apps: CompanionApp[]
}

/** 枚举到的应用条目（供 UI 选择） */
export interface EnumeratedApp {
    name: string
    exePath: string
    /** 启动参数（来自 .lnk，原始字符串） */
    args: string
    /** 快捷方式路径（浏览选择时为空串） */
    shortcutPath: string
}

/** companion:save 返回值 */
export interface CompanionSaveResult {
    success: boolean
    /** 新增时主进程生成并回传；更新时不回传 */
    id?: string
    error?: string
}

/** companion:get-icon 返回值（无效路径返回 null） */
export type CompanionIconResult = {iconDataUrl: string} | null

/**
 * args string → string[]。空格分割的刻意简化（spec YAGNI）：
 * 不支持带空格的路径参数，复杂参数场景用户手编 companion-apps.json。
 */
export function parseArgs(raw: string): string[] {
    if (!raw || !raw.trim()) return []
    return raw.trim().split(/\s+/)
}
