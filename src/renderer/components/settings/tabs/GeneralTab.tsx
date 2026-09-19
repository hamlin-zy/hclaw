import {useCallback, useEffect, useState} from 'react'
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
