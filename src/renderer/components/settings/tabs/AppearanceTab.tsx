import {useCallback, useEffect, useState} from 'react'
import {Switch} from '../../common/Switch'
import ImagePreviewModal from '../../common/ImagePreviewModal'
import ThemedSelect from '../../ThemedSelect'
import {confirm} from '../../ConfirmDialog'
import {isDarkTheme, type ThemeSetting} from '@shared/types'
import {useSettingsStore} from '../../../stores/settingsStore'
import {PAGE_FIELD_SETS} from '../primitives/fieldSets'
import FormRow from '../primitives/FormRow'
import {PageResetRow} from '../primitives/ResetButton'
import SectionHeader from '../primitives/SectionHeader'
import SwitchStatus from '../primitives/SwitchStatus'

/** 历史背景图渲染上限（spec §6.5）：仅渲染层截断，state 与删除/替补语义保持全量 */
const HISTORY_RENDER_CAP = 50

/** 历史背景图列表项（`background-list` 通道形状） */
type HistoryImage = {path: string; name: string; size: number; mtime: number}

/**
 * 外观与显示 Tab（spec §3.1）：分节「主题」（主题下拉 + 背景开启时的浅色系禁用/警告）
 * 与「背景」（本地图片背景启用 / 选图 / 历史缩略图 / 遮罩 / 模糊）。
 *
 * 迁移自旧 `dialogs/SettingsDialog.tsx`（主题 L670-688、背景 L726-898、历史图加载 L115-123、
 * 删除替补链 L129-161）：行为语义不动，字段一律 updatePending，不落盘。
 * 渲染层瘦身（spec §6.5）：历史图仅渲染最近 50 张 + 计数提示；state 保持全量。
 */
export default function AppearanceTab() {
    const {settings, pendingSettings, updatePending} = useSettingsStore()
    // ── 历史背景图 ──
    const [historyImages, setHistoryImages] = useState<HistoryImage[]>([])
    const [previewSrc, setPreviewSrc] = useState<string | null>(null)
    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings
    const backgroundEnabled = current.ui.background?.enabled ?? false

    // 拉取历史背景图列表（可选链：无该 IPC 通道的环境静默保持旧列表，不置空）
    const reloadHistory = useCallback(async () => {
        const list = await window.electronAPI?.backgroundList?.()
        if (list) setHistoryImages(list)
    }, [])

    // 背景启用时加载历史图片列表（数据目录 data/backgrounds/ 下的图片）
    // 可选链：无该 IPC 通道的环境下静默跳过（与旧壳一致）
    useEffect(() => {
        if (!backgroundEnabled) {
            setHistoryImages([])
            return
        }
        void reloadHistory()
    }, [backgroundEnabled, reloadHistory])

    // ── 删除历史背景图 ──
    // 删除文件后刷新列表；若删除的是当前背景，则自动切换：
    // 优先切到列表中的"下一个"（被删项在原列表的后一位），
    // 没有下一个则切到第一个；无候选图则清空背景设置。
    // 注意：替补基于**全量** state 计算（渲染层 cap 不影响此语义）。
    const handleDeleteHistoryImage = useCallback(async (img: {path: string; name: string}) => {
        const confirmed = await confirm({
            title: '删除背景图',
            message: `确定删除这张背景图吗？\n${img.name}`,
            confirmText: '删除',
            cancelText: '取消',
            confirmVariant: 'danger',
        })
        if (!confirmed) return

        const deletedCurrent = current.ui.background?.imagePath === img.path
        const oldIdx = historyImages.findIndex(h => h.path === img.path)

        await window.electronAPI?.backgroundRemove(img.path)
        const list = (await window.electronAPI?.backgroundList?.()) ?? []
        setHistoryImages(list)

        if (deletedCurrent) {
            const bg = current.ui.background!
            if (list.length > 0) {
                // 被删项在原列表的"后一位"（删除后整体前移）优先；越界则第一个
                const next = list[Math.min(oldIdx, list.length - 1)] ?? list[0]
                updatePending('ui', {
                    background: {...bg, imagePath: next.path, enabled: true},
                })
            } else {
                // 无候选图 → 清空背景设置
                updatePending('ui', {
                    background: {...bg, enabled: false, imagePath: ''},
                })
            }
        }
    }, [current.ui.background, historyImages, updatePending])

    return (
        <div className="space-y-[var(--space-spacious)]">
            <PageResetRow paths={PAGE_FIELD_SETS.appearance}/>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>主题</SectionHeader>
                <div className="space-y-1">
                    <label className="text-xs text-[var(--text-secondary)]">外观</label>
                    <ThemedSelect
                        fullWidth
                        value={current.ui.theme}
                        onChange={(v) => updatePending('ui', {theme: v as ThemeSetting})}
                        options={[
                            {value: 'system', label: '跟随系统'},
                            {value: 'light', label: `浅色模式${backgroundEnabled ? '（背景开启时不可用）' : ''}`, disabled: backgroundEnabled},
                            {value: 'dark', label: '深色模式'},
                            {value: 'yuanshandai', label: '远山黛'},
                            {value: 'shiyangjin', label: `十样锦${backgroundEnabled ? '（背景开启时不可用）' : ''}`, disabled: backgroundEnabled},
                        ]}
                        ariaLabel="外观主题"
                    />
                    {backgroundEnabled && (current.ui.theme === 'light' || current.ui.theme === 'shiyangjin') && (
                        <p className="text-2xs text-[var(--warning)]">图片背景开启时使用浅色系主题，保存后将自动切换为深色模式</p>
                    )}
                </div>
            </section>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>背景</SectionHeader>
                <div className="space-y-3">
                    <FormRow label="本地图片背景" tip="将本地图片作为整个窗口背景，内容层毛玻璃显示">
                        <div className="flex items-center gap-2">
                            <Switch
                                checked={backgroundEnabled}
                                onChange={(checked) => updatePending('ui', {
                                    background: {
                                        enabled: checked,
                                        imagePath: current.ui.background?.imagePath ?? '',
                                        overlay: current.ui.background?.overlay ?? (isDarkTheme(current.ui.theme) ? 50 : 30),
                                        blur: current.ui.background?.blur ?? 16,
                                    }
                                })}
                                ariaLabel="本地图片背景"
                            />
                            <SwitchStatus on={backgroundEnabled} className="ml-2"/>
                        </div>
                    </FormRow>

                    {current.ui.background?.enabled && (
                        <div className="space-y-3">
                            {/* 选图 + 预览 */}
                            <div className="flex items-center gap-3">
                                {current.ui.background.imagePath ? (
                                    <div
                                        className="w-24 h-14 rounded border border-[var(--border)] bg-cover bg-center shrink-0 cursor-zoom-in"
                                        style={{backgroundImage: `url(${current.ui.background.imagePath})`}}
                                        onClick={() => setPreviewSrc(current.ui.background!.imagePath)}
                                        title="点击放大查看"
                                        data-name="settings-appearance-background-preview"/>
                                ) : (
                                    <div className="w-24 h-14 rounded border border-dashed border-[var(--border)] flex items-center justify-center text-2xs text-[var(--text-muted)] shrink-0">
                                        未选择图片
                                    </div>
                                )}
                                <div className="flex flex-col gap-1.5">
                                    <button
                                        className="px-2.5 py-1.5 text-xs bg-[var(--surface-muted)] border border-[var(--border-muted)] rounded text-[var(--text-primary)] hover:border-[var(--border-emphasis)] transition-colors"
                                        onClick={async () => {
                                            const result = await window.electronAPI?.backgroundPick()
                                            if (result?.path) {
                                                updatePending('ui', {
                                                    background: {
                                                        ...current.ui.background!,
                                                        imagePath: result.path,
                                                    }
                                                })
                                                // 刷新历史列表（新图已拷入 backgrounds 目录）
                                                await reloadHistory()
                                            }
                                        }}
                                        data-name="settings-appearance-pick-background-button">
                                        选择图片
                                    </button>
                                    {current.ui.background.imagePath && (
                                        <button
                                            className="px-2.5 py-1.5 text-xs text-[var(--error)] hover:bg-[var(--surface-muted)] rounded transition-colors"
                                            onClick={async () => {
                                                const bg = current.ui.background!
                                                await window.electronAPI?.backgroundRemove(bg.imagePath)
                                                updatePending('ui', {
                                                    background: {
                                                        ...bg,
                                                        enabled: false,
                                                        imagePath: '',
                                                    }
                                                })
                                                await reloadHistory()
                                            }}
                                            data-name="settings-appearance-clear-background-button">
                                            清除背景
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* 历史图片缩略图条（仅渲染最近 50 张；state 全量） */}
                            {historyImages.length > 0 && (
                                <div className="space-y-1.5">
                                    <label className="text-xs text-[var(--text-secondary)]">历史图片</label>
                                    <div className="flex gap-2 overflow-x-auto pb-1">
                                        {historyImages.slice(0, HISTORY_RENDER_CAP).map((img, i) => {
                                            const isActive = current.ui.background?.imagePath === img.path
                                            return (
                                                <div key={img.path} className="relative group shrink-0">
                                                    <img
                                                        src={img.path}
                                                        alt={img.name}
                                                        loading="lazy"
                                                        decoding="async"
                                                        data-testid="bg-thumb"
                                                        className={`w-16 h-10 rounded border object-cover cursor-pointer transition-all ${
                                                            isActive
                                                                ? 'border-[var(--border-emphasis)] ring-2 ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)]'
                                                                : 'border-[var(--border)] hover:border-[var(--border-emphasis)]'
                                                        }`}
                                                        onClick={() => updatePending('ui', {
                                                            background: {...current.ui.background!, imagePath: img.path}
                                                        })}
                                                        title={img.name}
                                                        data-name={`settings-appearance-background-thumb-${i}`}/>
                                                    {/* 放大查看按钮（hover 显示） */}
                                                    <button
                                                        className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow text-[var(--text-muted)] hover:[color:var(--brand-primary)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            setPreviewSrc(img.path)
                                                        }}
                                                        title="放大查看"
                                                        data-name={`settings-appearance-background-preview-${i}`}>
                                                        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                            <circle cx="11" cy="11" r="8"/>
                                                            <path d="m21 21-4.3-4.3"/>
                                                        </svg>
                                                    </button>
                                                    {/* 删除按钮（hover 显示，位于放大镜下方） */}
                                                    <button
                                                        className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-[var(--surface-elevated)] border border-[var(--border)] shadow text-[var(--text-muted)] hover:text-[var(--error)] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            handleDeleteHistoryImage(img)
                                                        }}
                                                        title="删除"
                                                        data-name={`settings-appearance-background-delete-${i}`}>
                                                        <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                            <polyline points="3 6 5 6 21 6"/>
                                                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                                            <line x1="10" y1="11" x2="10" y2="17"/>
                                                            <line x1="14" y1="11" x2="14" y2="17"/>
                                                        </svg>
                                                    </button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                    {historyImages.length > HISTORY_RENDER_CAP && (
                                        <p className="text-2xs text-[var(--text-secondary)]">共 {historyImages.length} 张，仅显示最近 {HISTORY_RENDER_CAP}</p>
                                    )}
                                </div>
                            )}

                            {/* 遮罩强度 */}
                            <div className="space-y-1">
                                <div className="flex justify-between">
                                    <label className="text-xs text-[var(--text-secondary)]">遮罩强度</label>
                                    <span className="text-xs text-[var(--text-secondary)]">{current.ui.background.overlay}%</span>
                                </div>
                                <input
                                    type="range" min={0} max={100} value={current.ui.background.overlay}
                                    aria-label="遮罩强度"
                                    aria-valuetext={`${current.ui.background.overlay}%`}
                                    onChange={(e) => updatePending('ui', {
                                        background: {...current.ui.background!, overlay: Number(e.target.value)}
                                    })}
                                    className="w-full accent-[var(--brand-primary)]"
                                    data-name="settings-appearance-overlay-input"/>
                            </div>

                            {/* 模糊强度 */}
                            <div className="space-y-1">
                                <div className="flex justify-between">
                                    <label className="text-xs text-[var(--text-secondary)]">模糊强度</label>
                                    <span className="text-xs text-[var(--text-secondary)]">{current.ui.background.blur}px</span>
                                </div>
                                <input
                                    type="range" min={0} max={40} value={current.ui.background.blur}
                                    aria-label="模糊强度"
                                    aria-valuetext={`${current.ui.background.blur}px`}
                                    onChange={(e) => updatePending('ui', {
                                        background: {...current.ui.background!, blur: Number(e.target.value)}
                                    })}
                                    className="w-full accent-[var(--brand-primary)]"
                                    data-name="settings-appearance-blur-input"/>
                            </div>
                        </div>
                    )}
                </div>
            </section>

            {/* 历史图片放大预览（复用项目看图组件：缩放/拖动/旋转） */}
            {previewSrc && (
                <ImagePreviewModal
                    src={previewSrc}
                    alt="背景图片预览"
                    onClose={() => setPreviewSrc(null)}
                />
            )}
        </div>
    )
}
