import {useCallback, useEffect, useMemo, useState} from 'react'
import NumberField from '../primitives/NumberField'
import {localeDisplayName, SELECTABLE_LOCALES, SYSTEM_LOCALE, systemLocaleLabel} from '@shared/localeNames'
import type {LanguageGuardStrategy} from '@shared/types'
import {Switch} from '../../common/Switch'
import ThemedSelect from '../../ThemedSelect'
import {confirm} from '../../ConfirmDialog'
import {useSettingsStore} from '../../../stores/settingsStore'
import {INPUT_FOCUS} from '../../../lib/inputFocus'
import {PAGE_FIELD_SETS} from '../primitives/fieldSets'
import FormRow from '../primitives/FormRow'
import {PageResetRow} from '../primitives/ResetButton'
import SectionHeader from '../primitives/SectionHeader'
import SelectRow from '../primitives/SelectRow'
import SwitchStatus from '../primitives/SwitchStatus'
import {DEFAULT_SETTINGS} from '@shared/settingsDefaults'

/**
 * 纠正次数上限的默认值（单一真源：@shared/settingsDefaults，不再散落魔法数 3）。
 * 该字段类型含 'always'，需窄化到数值；`1` 分支当前不可达，仅为类型收窄而存在。
 */
const DEFAULT_CORRECTION_LIMIT = typeof DEFAULT_SETTINGS.language?.correctionLimit === 'number'
    ? DEFAULT_SETTINGS.language.correctionLimit
    : 1

/**
 * 通用设置 Tab（spec §3.1）：分节「系统」（系统配置目录 / 链接打开方式 / 技能目录详细描述）
 * 与「新会话默认」（默认安全模式 / 默认显示模式）。
 *
 * 系统配置目录为「即改即存」特例（spec §5.5）：走既有 saveHclawDir 通道 + 重启提示，
 * **不并入 pending**；其余字段一律 updatePending（与旧 SettingsDialog 行为一致）。
 */
export default function GeneralTab() {
    const {settings, pendingSettings, updatePending, updateSettings} = useSettingsStore()
    // 系统配置目录：本地态（非 pending 字段），初值来自 IPC
    const [hclawDir, setHclawDir] = useState('')
    const [origHclawDir, setOrigHclawDir] = useState('')
    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings

    const language = current.language
    const languageStrategy: LanguageGuardStrategy = language?.strategy ?? 'first-and-drift'
    const correctionLimit = language?.correctionLimit ?? DEFAULT_CORRECTION_LIMIT
    // 数值形态的纠正上限（'always' 或缺失时回落默认值）；NumberField 与「始终」开关共用
    const numericCorrectionLimit = typeof correctionLimit === 'number' ? correctionLimit : DEFAULT_CORRECTION_LIMIT
    // 母语来源：仅 manual 且值非空才算手选；其余（含缺省/老数据）一律落回「跟随系统」，
    // 避免出现 value='' 时下拉无匹配项而显示空白
    const manualLocale = language?.nativeLocaleMode === 'manual' ? language?.nativeLocale : undefined
    const isManualLocale = !!manualLocale
    const localeValue = manualLocale || SYSTEM_LOCALE

    // 系统语言（主进程经窗口 argv 同步传入，零 IPC 往返）：跟随系统标签的真源。
    // nativeLocale 只作回退 —— 它同时承担「当前生效母语」，从手选切回跟随时要到下次启动才刷新，
    // 若直接用它做标签，会短暂显示成刚被放弃的旧语言。
    const systemLocale = window.electronAPI?.systemLocale || undefined

    // 母语下拉：跟随系统（标签带当前系统语言）+ 手选项（手选到表外 locale，如老数据 ja，追加动态项）
    const localeOptions = useMemo(() => {
        const opts: {value: string; label: string}[] = [
            {value: SYSTEM_LOCALE, label: systemLocaleLabel(systemLocale ?? language?.nativeLocale)},
            ...SELECTABLE_LOCALES.map(o => ({value: o.value, label: o.label})),
        ]
        if (manualLocale && !opts.some(o => o.value === manualLocale)) {
            opts.push({value: manualLocale, label: localeDisplayName(manualLocale) ?? manualLocale})
        }
        return opts
    }, [language?.nativeLocale, manualLocale, systemLocale])

    // 加载当前系统配置目录（可选调用：无该 IPC 通道的环境下静默跳过）
    useEffect(() => {
        window.electronAPI?.configGetHclawDir?.().then((dir) => {
            setHclawDir(dir)
            setOrigHclawDir(dir)
        })
    }, [])

    const saveHclawDir = useCallback(async (dir: string) => {
        setOrigHclawDir(dir)
        await window.electronAPI?.configSetHclawDir(dir)
        // 重启动作在 onConfirm 内处理（确认时执行，取消时不执行），无需检查返回值
        await confirm({
            title: '需要重启应用',
            message: '系统配置目录已更改，重启后才能生效。是否立即重启？',
            confirmText: '立即重启',
            cancelText: '稍后重启',
            confirmVariant: 'warning',
            onConfirm: async () => {
                await window.electronAPI?.invoke('app-restart')
            },
        })
    }, [])

    return (
        <div className="space-y-[var(--space-spacious)]">
            <PageResetRow paths={PAGE_FIELD_SETS.general}/>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>系统</SectionHeader>
                <div className="space-y-1">
                    <label className="text-xs text-[var(--text-secondary)]">系统配置目录</label>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            className={`flex-1 bg-[var(--surface-muted)] border border-[var(--border)] rounded px-3 py-1.5 text-xs outline-none ${INPUT_FOCUS} font-mono`}
                            value={hclawDir}
                            onChange={(e) => setHclawDir(e.target.value)}
                            onBlur={() => {
                                if (hclawDir !== origHclawDir) {
                                    saveHclawDir(hclawDir)
                                }
                            }}
                            placeholder="默认：~/.hclaw"
                            aria-label="系统配置目录"
                            data-name="settings-general-hclaw-dir-input"/>
                        <button
                            className="px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-muted)] rounded border border-[var(--border)] transition-colors whitespace-nowrap"
                            onClick={async () => {
                                const dir = await window.electronAPI?.openFolderDialog()
                                if (dir) {
                                    setHclawDir(dir)
                                    saveHclawDir(dir)
                                }
                            }}
                            title="选择目录"
                            data-name="settings-general-pick-dir-button">
                            浏览
                        </button>
                        <button
                            className="px-2.5 py-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--surface-muted)] rounded border border-[var(--border)] transition-colors"
                            onClick={() => {
                                setHclawDir('')
                                saveHclawDir('')
                            }}
                            title="重置为默认值"
                            data-name="settings-general-reset-dir-button">
                            重置
                        </button>
                    </div>
                    <p className="text-[10px] text-[var(--text-secondary)]">修改后重启应用生效。留空表示使用默认路径 ~/.hclaw</p>
                </div>
                <div className="space-y-1">
                    <label className="text-xs text-[var(--text-secondary)]">链接打开方式</label>
                    <ThemedSelect
                        fullWidth
                        value={current.linkOpening?.mode ?? 'ask'}
                        onChange={(v) => updatePending('linkOpening', {mode: v as 'builtin' | 'system' | 'ask'})}
                        options={[{value: 'ask', label: '每次询问'}, {value: 'builtin', label: '内置浏览器'}, {value: 'system', label: '系统浏览器'}]}
                        ariaLabel="链接打开方式"
                    />
                </div>
                <FormRow label="技能目录详细描述" tip="开启=完整描述，关闭=仅名称索引，省 token">
                    <div className="flex items-center gap-2">
                        <Switch
                            checked={current.fullSkillDescriptions ?? false}
                            onChange={(checked) => updatePending('fullSkillDescriptions', checked)}
                            ariaLabel="技能目录详细描述"
                        />
                        <SwitchStatus on={!!current.fullSkillDescriptions} className="ml-2"/>
                    </div>
                </FormRow>
                {/* 用户习惯记忆：即改即存（走 updateSettings，主进程 controller 读 settings.memory?.enabled），
                    不并入 pending —— 与「系统配置目录」同类的即时生效口径 */}
                <FormRow label="用户习惯记忆" tip="会话首次请求时自动注入你的使用习惯和项目经验。由「记忆沉淀」定时任务自动维护。">
                    <div className="flex items-center gap-2">
                        <Switch
                            checked={current.memory?.enabled ?? true}
                            onChange={(checked) => void updateSettings({memory: {enabled: checked}})}
                            ariaLabel="用户习惯记忆"
                        />
                        <SwitchStatus on={current.memory?.enabled ?? true} className="ml-2"/>
                    </div>
                </FormRow>
            </section>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>语言</SectionHeader>
                <SelectRow
                    label="母语"
                    tip="模型输出漂移成英文时，追加一条对用户不可见的纠正消息，让后续回复回到母语"
                    hint={isManualLocale
                        ? `已指定：${localeDisplayName(manualLocale) ?? manualLocale}（系统语言变化后不再自动跟随）`
                        : '跟随系统语言，每次启动自动更新'}
                    value={localeValue}
                    onChange={(v) => {
                        if (v === SYSTEM_LOCALE) {
                            // 切回跟随：立即把母语对齐到系统语言，否则本会话内母语会停留在刚被放弃的旧值
                            // （worker 读的是 nativeLocale），要等下次启动兜底刷新才生效
                            updatePending('language', {
                                nativeLocaleMode: 'system',
                                ...(systemLocale ? {nativeLocale: systemLocale} : {}),
                            })
                        } else {
                            updatePending('language', {nativeLocaleMode: 'manual', nativeLocale: v})
                        }
                    }}
                    options={localeOptions}
                />
                <SelectRow
                    label="语言纠正"
                    tip="仅首次=会话首轮预防注入一次；首次+漂移纠正=检测到英文输出时补一条纠正"
                    value={languageStrategy}
                    onChange={(v) => updatePending('language', {strategy: v as LanguageGuardStrategy})}
                    options={[
                        {value: 'first-and-drift', label: '首次 + 漂移纠正（推荐）'},
                        {value: 'first-only', label: '仅首次'},
                        {value: 'off', label: '关闭'},
                    ]}
                />
                <div className="flex items-end gap-2">
                    <div className="flex-1">
                        <NumberField
                            label="会话内累计纠正次数上限"
                            tip="含首次预防注入；达到上限后本次会话不再纠正"
                            value={numericCorrectionLimit}
                            min={1}
                            fallback={DEFAULT_CORRECTION_LIMIT}
                            disabled={correctionLimit === 'always' || languageStrategy === 'off'}
                            onChange={(v) => updatePending('language', {correctionLimit: v})}
                        />
                    </div>
                    <div className="flex items-center gap-2 pb-1.5">
                        <Switch
                            checked={correctionLimit === 'always'}
                            disabled={languageStrategy === 'off'}
                            onChange={(checked) => updatePending('language', {correctionLimit: checked ? 'always' : DEFAULT_CORRECTION_LIMIT})}
                            ariaLabel="始终纠正"
                        />
                        <span className="text-xs text-[var(--text-secondary)]">始终</span>
                    </div>
                </div>
            </section>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>新会话默认</SectionHeader>
                {/* 数据仍存 agent 分类（SystemSettings.agent.defaultPermissionMode 等） */}
                <SelectRow
                    label="新会话默认安全模式"
                    tip="无会话级覆盖时回退此值"
                    value={current.agent.defaultPermissionMode ?? 'safe'}
                    onChange={(v) => updatePending('agent', {defaultPermissionMode: v as 'safe' | 'auto'})}
                    options={[{value: 'auto', label: '自动模式（全程自动执行）'}, {value: 'safe', label: '安全模式（破坏性操作需确认）'}]}
                />
                <SelectRow
                    label="新会话默认显示模式"
                    tip="无会话级覆盖时回退此值；新会话生效"
                    value={current.agent.defaultDisplayMode ?? 'detailed'}
                    onChange={(v) => updatePending('agent', {defaultDisplayMode: v as 'detailed' | 'compact' | 'ultra-compact'})}
                    options={[{value: 'detailed', label: '详细模式'}, {value: 'compact', label: '简洁模式'}, {value: 'ultra-compact', label: '极简模式'}]}
                />
            </section>
        </div>
    )
}
