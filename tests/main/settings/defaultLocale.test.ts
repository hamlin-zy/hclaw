/**
 * 启动兜底写入母语（spec §6.4）
 *
 * 本模块刻意不 import electron：`getLocale` 由调用方（主进程 index.ts）注入，
 * 单测可在 node 环境直接跑，也不必进 workerNoElectron 白名单。
 */
import {describe, it, expect, vi} from 'vitest'
import {readFileSync} from 'fs'
import {resolve} from 'path'
import {ensureDefaultLocale, type LocaleSettingsRepo} from '@/main/settings/defaultLocale'
import {logger} from '@/main/agent/logger'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'
import type {SystemSettings} from '@shared/types'

function makeRepo(initial: SystemSettings | null) {
    const store: {value: SystemSettings | null} = {value: initial}
    const repo: LocaleSettingsRepo = {
        getJson: <T,>(key: string) => (key === 'settings' ? (store.value as T | null) : null),
        setJson: <T,>(key: string, value: T) => {
            if (key === 'settings') store.value = value as unknown as SystemSettings
            return true
        },
    }
    return {store, repo}
}

describe('ensureDefaultLocale（spec §6.4）', () => {
    it('nativeLocale 缺失时写入系统语言，且保留其它字段', () => {
        const {store, repo} = makeRepo({agent: {maxTurns: 42}} as SystemSettings)
        ensureDefaultLocale({repo, getLocale: () => 'zh-CN'})
        expect(store.value?.language?.nativeLocale).toBe('zh-CN')
        expect(store.value?.agent?.maxTurns).toBe(42)
    })

    it('手选模式（manual）不覆盖用户值且零写库', () => {
        const {store, repo} = makeRepo({language: {nativeLocaleMode: 'manual', nativeLocale: 'en', strategy: 'off'}} as SystemSettings)
        const setJson = vi.fn(repo.setJson)
        ensureDefaultLocale({repo: {...repo, setJson}, getLocale: () => 'zh-CN'})
        expect(store.value?.language?.nativeLocale).toBe('en')
        expect(setJson).not.toHaveBeenCalled()
    })

    it('跟随系统（mode 缺省）每次启动刷新为当前系统语言 —— 老数据（无 mode）同此路径', () => {
        const {store, repo} = makeRepo({language: {nativeLocale: 'ja', strategy: 'off'}} as SystemSettings)
        ensureDefaultLocale({repo, getLocale: () => 'zh-CN'})
        expect(store.value?.language?.nativeLocale).toBe('zh-CN')
        expect(store.value?.language?.strategy).toBe('off')   // 同分类其它字段不被冲掉
    })

    it('显式 system 模式同样刷新（不只认「缺省」）', () => {
        const {store, repo} = makeRepo({language: {nativeLocaleMode: 'system', nativeLocale: 'ja'}} as SystemSettings)
        ensureDefaultLocale({repo, getLocale: () => 'en-US'})
        expect(store.value?.language?.nativeLocale).toBe('en-US')
        expect(store.value?.language?.nativeLocaleMode).toBe('system')  // 刷新不改 mode
    })

    it('跟随系统且系统语言未变 → 零写库（启动期不做无谓 IO）', () => {
        const {store, repo} = makeRepo({language: {nativeLocaleMode: 'system', nativeLocale: 'zh-CN'}} as SystemSettings)
        const setJson = vi.fn(repo.setJson)
        ensureDefaultLocale({repo: {...repo, setJson}, getLocale: () => 'zh-CN'})
        expect(store.value?.language?.nativeLocale).toBe('zh-CN')
        expect(setJson).not.toHaveBeenCalled()
    })

    it('settings 键不存在（首次启动）时以 DEFAULT_SETTINGS 为底写入', () => {
        const {store, repo} = makeRepo(null)
        ensureDefaultLocale({repo, getLocale: () => 'ja-JP'})
        expect(store.value?.language?.nativeLocale).toBe('ja-JP')
        expect(store.value?.language?.strategy).toBe(DEFAULT_SETTINGS.language!.strategy)
        expect(store.value?.agent?.maxTurns).toBe(DEFAULT_SETTINGS.agent.maxTurns)
    })

    it('getLocale 返回空串 / 抛错 → 不写库、不抛异常', () => {
        const empty = makeRepo(null)
        ensureDefaultLocale({repo: empty.repo, getLocale: () => ''})
        expect(empty.store.value).toBeNull()

        const boom = makeRepo(null)
        expect(() => ensureDefaultLocale({
            repo: boom.repo,
            getLocale: () => { throw new Error('no locale') },
        })).not.toThrow()
        expect(boom.store.value).toBeNull()
    })

    it('setJson 返回 false（写库失败）→ 不打 refreshed，改打 write failed 告警', () => {
        const {store, repo} = makeRepo(null)
        const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
        const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)
        try {
            const setJson = vi.fn(() => false)
            ensureDefaultLocale({repo: {...repo, setJson}, getLocale: () => 'zh-CN'})
            expect(infoSpy).not.toHaveBeenCalledWith(
                '[defaultLocale] nativeLocale refreshed', expect.anything(),
            )
            expect(warnSpy).toHaveBeenCalledWith(
                '[defaultLocale] nativeLocale write failed', {locale: 'zh-CN'},
            )
            expect(store.value).toBeNull() // 失败时不落库
        } finally {
            infoSpy.mockRestore()
            warnSpy.mockRestore()
        }
    })

    it('源码级接线断言：index.ts 在 app ready 回调内调用', () => {
        const src = readFileSync(resolve(process.cwd(), 'src/main/index.ts'), 'utf8')
        const readyIdx = src.indexOf("app.on('ready', async () => {")
        const callIdx = src.indexOf('ensureDefaultLocale(')
        const willQuitIdx = src.indexOf("app.on('will-quit'")
        expect(src).toContain("from './settings/defaultLocale'")
        expect(readyIdx).toBeGreaterThan(-1)
        expect(callIdx).toBeGreaterThan(readyIdx)
        expect(callIdx).toBeLessThan(willQuitIdx)
    })
})
