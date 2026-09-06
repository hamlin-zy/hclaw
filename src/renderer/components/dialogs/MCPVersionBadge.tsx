import ThemedSelect from '../ThemedSelect'

const BADGE_BASE = 'inline-flex items-center gap-1 text-[9px] px-1 py-0.5 rounded font-medium border leading-none tabular-nums'

/**
 * MCP 服务器版本徽章（统一三种形态，供 User/Plugin 卡片共用）
 * - availableVersions 非空 → 版本切换下拉框
 * - npm/pip 包管理 → current → latest 文本
 * - 其他 → v{version} 徽章（有更新时橙色高亮）
 */
export function MCPVersionBadge({
    current,
    latest,
    hasUpdate,
    availableVersions,
    pkgManager,
    disabled,
    onSwitch,
}: {
    current: string | null
    latest: string | null
    hasUpdate: boolean
    availableVersions: string[]
    pkgManager?: string
    disabled?: boolean
    onSwitch?: (v: string) => void
}) {
    if (availableVersions.length > 0) {
        return (
            <div className="relative inline-flex items-center" onClick={(e) => e.stopPropagation()}>
                <ThemedSelect
                    value={current || ''}
                    disabled={disabled}
                    ariaLabel="切换版本"
                    onChange={(v) => onSwitch?.(v)}
                    className="text-[9px] px-1.5 py-0.5"
                    options={availableVersions.map(v => ({
                        value: v,
                        label: v === latest ? `${v} (latest)` : v,
                    }))}
                />
                {hasUpdate && (
                    <span
                        className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-orange-400 pointer-events-none"
                        aria-label="有新版本可用"
                        title="有新版本可用"
                    />
                )}
            </div>
        )
    }

    if (!current && !latest) return null

    // npm/pip 包管理器：显示 current → latest（有更新时）或仅 current
    if (pkgManager === 'npm' || pkgManager === 'pip') {
        return (
            <span className={`text-[9px] font-normal tabular-nums ${hasUpdate ? 'text-orange-500' : 'text-gray-400'}`}>
                {hasUpdate ? `${current || '—'} → ${latest || '—'}` : (current || '—')}
                {hasUpdate && <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400 align-middle ml-1" title="有新版本可用"/>}
            </span>
        )
    }

    // 普通徽章：有更新时橙色高亮
    return (
        <span
            className={`${BADGE_BASE} ${hasUpdate
                ? 'bg-orange-50 text-orange-500 border-orange-100'
                : 'bg-gray-50 text-gray-400 border-gray-100'}`}
            title={hasUpdate ? `有新版本 ${latest || ''}` : undefined}
        >
            v{current || latest}
            {hasUpdate && <span className="w-1 h-1 rounded-full bg-orange-400" aria-hidden="true"/>}
        </span>
    )
}
