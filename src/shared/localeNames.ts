/**
 * locale → 母语显示名映射（shared 侧单一真源，spec §6.4）
 *
 * 两处消费方：
 * - agent worker：渲染注入文案（"Reply to the user in 简体中文"）。worker 禁引
 *   electron（tests/main/deps/workerNoElectron.test.ts 边界），拿不到 app.getLocale()，
 *   只读启动兜底写入的 settings.language.nativeLocale。
 * - 渲染端设置页：母语下拉的选项标签。
 *
 * 未命中时的回退链：精确命中 → 主语言子标签（'en-GB' → 'en'）→ 原始 locale 串。
 * 空值返回 undefined 是**有语义的**：pre-step 据此跳过注入（宁可不注入，
 * 也不注入 "Reply to the user in undefined"）。
 *
 * 「跟随系统」是 UI 层的哨兵值（SYSTEM_LOCALE），**不落进 nativeLocale**：
 * 跟随模式下 nativeLocale 始终由启动兜底刷新为当前系统语言（见 main/settings/defaultLocale.ts），
 * 因此 worker 读到的永远是可注入的真实 locale。
 */
// 字面量中的 __proto__: null 等价于 Object.create(null)：原型为空，查表不会命中原型链
// （'constructor'/'__proto__' 等），从而保证未命中时一定走完回退链，
// 而不是把 Object.prototype 上的成员当作 locale 名返回。
const LOCALE_NAMES: Record<string, string> = {
    __proto__: null,
    'zh-CN': '简体中文',
    'zh-TW': '繁體中文',
    'zh-HK': '繁體中文',
    zh: '简体中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어',
    fr: 'Français',
    de: 'Deutsch',
    es: 'Español',
    pt: 'Português',
    ru: 'Русский',
    it: 'Italiano',
} as unknown as Record<string, string>   // 断言仅为类型层：__proto__: null 在 TS 里被当普通属性，运行时是置空原型

/**
 * 「跟随系统」下拉项的哨兵 value。不等于任何真实 locale，
 * 只存在于渲染端下拉（UI value ↔ language.nativeLocaleMode 的映射键）。
 */
export const SYSTEM_LOCALE = 'system'

/** 返回母语显示名；locale 为空/空白时返回 undefined（调用方据此跳过注入） */
export function localeDisplayName(locale: string | undefined | null): string | undefined {
    if (typeof locale !== 'string') return undefined
    const trimmed = locale.trim()
    if (!trimmed) return undefined
    // 哨兵绝非 locale：缺失时宁可不注入，也不注入 "Reply to the user in system"
    if (trimmed === SYSTEM_LOCALE) return undefined
    return LOCALE_NAMES[trimmed] ?? LOCALE_NAMES[trimmed.split('-')[0]] ?? trimmed
}

/**
 * 「跟随系统」下拉项标签：`跟随系统(简体中文)`。
 *
 * 名字取自 nativeLocale —— 跟随模式下它由启动兜底刷新为**当前系统语言**；
 * 取不到（首启尚未写入 / 系统 locale 为空）时退化为纯 `跟随系统`，
 * 不渲染 "跟随系统(undefined)"。
 */
export function systemLocaleLabel(nativeLocale: string | undefined | null): string {
    const name = localeDisplayName(nativeLocale)
    return name ? `跟随系统(${name})` : '跟随系统'
}

/** 设置页母语下拉的手选项（跟随系统另由哨兵项提供；当前值为表外 locale 时由 UI 追加动态项） */
export const SELECTABLE_LOCALES: ReadonlyArray<{value: string; label: string}> = (
    ['zh-CN', 'en'] as const
).map(value => ({value, label: LOCALE_NAMES[value]}))
