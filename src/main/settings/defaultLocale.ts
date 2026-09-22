/**
 * 系统语言默认值兜底（spec §6.4）
 *
 * app.getLocale() 只能在主进程、且 app ready 之后调用；agent worker 禁引 electron
 * （tests/main/deps/workerNoElectron.test.ts 边界），拿不到系统语言。因此启动时把系统语言
 * 写进 settings.language.nativeLocale，此后 settings 即单一真相源，worker 只读 settings。
 *
 * - 跟随系统（nativeLocaleMode 缺省 / 'system'）：**每次启动刷新** nativeLocale 为当前
 *   系统语言，值未变则零写库 —— 系统语言改了重启即自动跟随。
 * - 手选（nativeLocaleMode === 'manual'）：永不覆盖，系统语言变化也不跟随。
 * - settings 键尚不存在（首次启动）时以 DEFAULT_SETTINGS 为底写入 —— 否则语言守卫
 *   在用户第一次保存设置之前永久静默失效。
 * - 本模块不 import electron：locale 由调用方注入，避开 workerNoElectron 边界。
 */
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'
import type {SystemSettings} from '@shared/types'
import {logger} from '../agent/logger'

/** 最小依赖面（便于单测注入） */
export interface LocaleSettingsRepo {
    getJson<T>(key: string): T | null
    setJson<T>(key: string, value: T): boolean
}

export function ensureDefaultLocale(deps: {repo?: LocaleSettingsRepo; getLocale: () => string}): void {
    const repo = deps.repo ?? systemSettingsRepo
    try {
        const settings = repo.getJson<SystemSettings>('settings') ?? DEFAULT_SETTINGS
        // 手选模式：用户值优先，启动永不覆盖（系统语言变化也不跟随）
        if (settings.language?.nativeLocaleMode === 'manual') return
        const locale = deps.getLocale()
        if (!locale) return
        // 跟随系统：每次启动刷新；与已存值相同则零写库（启动期不做无谓 IO）
        if (settings.language?.nativeLocale === locale) return
        const ok = repo.setJson('settings', {
            ...settings,
            language: {...(settings.language ?? {}), nativeLocale: locale},
        })
        // 消费布尔返回值：只有真写进库才报 refreshed（写入失败时日志曾是唯一线索却说反话）
        if (ok) logger.info('[defaultLocale] nativeLocale refreshed', {locale})
        else logger.warn('[defaultLocale] nativeLocale write failed', {locale})
    } catch (err) {
        logger.warn('[defaultLocale] ensure failed', {error: String(err)})
    }
}
